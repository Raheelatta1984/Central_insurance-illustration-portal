/** Typed application service: provider verification precedes the database lock; no I/O inside a leg. */
import type { FinancialStore } from '../../server/financial/store.js';
import { FinancialError, type CardProvider, type CardTokenEvidence, type CollectionEvidence, type FinancialRule, type PaymentEvidence, type PaymentVerifier, type VerifiedPayment } from './model.js';
import { financialPolicyPage, financialStatement } from './statement.js';
import { verifyCardToken, verifyPaymentEvidence } from './book.js';
import { reconcileFinancialState } from './book.js';
import type { DistributionEvidence } from '../policy-distribution.js';
import { evidenceDigest } from '../policy-distribution.js';

export interface FinancialPrincipal { readonly name: string; readonly roles: readonly string[] }
export interface SourceRecordReader { read(sourceRecordId: string, policyId: string): Promise<unknown | null> }
export interface FinancialServiceOptions {
  readonly store: FinancialStore; readonly now?: () => string; readonly paymentVerifier?: PaymentVerifier;
  readonly cardProvider?: CardProvider; readonly sourceReader?: SourceRecordReader; readonly designatedApprover?: string;
}
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinancialError('JSON object required', 400); return value as Record<string, unknown>; };
const text = (body: Record<string, unknown>, key: string): string => { const v = body[key]; if (typeof v !== 'string' || !v.trim() || v.length > 2000) throw new FinancialError(`${key} is required`, 400); return v.trim(); };
const has = (p: FinancialPrincipal, roles: string[]) => p.roles.includes('admin') || roles.some((r) => p.roles.includes(r));
export function financialAuthorization(p: FinancialPrincipal, method: string, path: string): void {
  if (p.roles.some((r) => r.startsWith('partner:') || r.startsWith('partner-'))) throw new FinancialError('partner principals cannot use the internal financial book', 403);
  if (method === 'GET') { if (!has(p, ['finance-auditor', 'finance-officer', 'finance-scheduler', 'servicing-officer', 'supervisor', 'configurator'])) throw new FinancialError('financial read role required', 403); return; }
  const role = path === '/rules/propose' ? ['configurator']
    : path === '/rules/approve' ? ['financial-approver', 'configurator']
    : path === '/monthly/run' ? ['finance-scheduler', 'finance-officer']
    : path === '/distribution/backfill' ? ['data-migration-officer']
    : path === '/nav' ? ['fund-configuration']
    : path.startsWith('/roundup/') ? ['servicing-officer', 'servicing-supervisor', 'finance-officer']
    : path === '/servicing' ? ['servicing-officer', 'servicing-supervisor']
    : ['/policies', '/payments'].includes(path) ? ['finance-officer', 'policy-issuance'] : [];
  if (!role.length || !has(p, role)) throw new FinancialError('explicit financial operation role required', 403);
}
export class FinancialService {
  readonly store: FinancialStore;
  private readonly now: () => string;
  constructor(private readonly options: FinancialServiceOptions) { this.store = options.store; this.now = options.now ?? (() => new Date().toISOString()); }
  async dispatch(principal: FinancialPrincipal, method: string, path: string, query: URLSearchParams, raw: unknown, key: string | undefined): Promise<{ status: number; body: unknown; replayed?: boolean; version?: number }> {
    financialAuthorization(principal, method, path);
    if (method === 'GET') {
      const { state, version } = await this.store.read();
      if (path === '/reconciliation') return { status: 200, body: { ...reconcileFinancialState(state), version, environment: state.environment, simulated: state.environment === 'demo' } };
      if (path === '/statement') return { status: 200, body: financialStatement(state, query.get('policyId') ?? '', this.now()), version };
      if (path === '/policies') return { status: 200, body: financialPolicyPage(state, query.get('after'), Number(query.get('limit') ?? 25)), version };
      if (path === '/configuration-requests') {
        const limit = Number(query.get('limit') ?? 25); const after = query.get('after');
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FinancialError('limit must be 1–100', 400);
        const rows = state.configurationRequests.filter((r) => after === null || r.id > after).sort((a, b) => a.id.localeCompare(b.id));
        return { status: 200, body: { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }, version };
      }
      if (path === '/roundup') {
        const policyId = query.get('policyId'); if (!policyId) throw new FinancialError('policyId required', 400);
        return { status: 200, body: { settings: state.roundUpSettings.find((s) => s.policyId === policyId) ?? null, cards: state.cards.filter((c) => c.policyId === policyId).map((c) => ({ id: c.id, provider: c.provider, last4: c.last4, status: c.status, mandateReference: c.mandateReference })), events: state.roundUpEvents.filter((e) => e.policyId === policyId).slice(-100), environment: state.environment }, version };
      }
      throw new FinancialError('financial endpoint not found', 404);
    }
    if (method !== 'POST') throw new FinancialError('method not allowed', 405);
    if (!key) throw new FinancialError('Idempotency-Key is required for every financial mutation', 400);
    const body = object(raw); const at = this.now(); const scope = `${principal.name}:${path}`;
    // Never trust a caller-supplied audit actor or approval identity.
    const request = { ...body }; delete request['by']; delete request['actor']; delete request['approvedBy']; delete request['__principal'];
    let verifiedPayment: VerifiedPayment | undefined; let verifiedCard: { verifiedAt: string } | undefined; let verifiedCollection: { verifiedAt: string } | undefined;
    if ((path === '/payments' || path === '/roundup/events') && !this.options.paymentVerifier) throw new FinancialError('payment verification is not configured; no cash or units posted', 503, 'PROVIDER_REQUIRED');
    if (path === '/roundup/events' && !this.options.cardProvider) throw new FinancialError('card provider verification is not configured', 503, 'PROVIDER_REQUIRED');
    if (path === '/payments' || path === '/roundup/events') {
      const evidence = object(body['evidence']) as unknown as PaymentEvidence;
      verifiedPayment = await verifyPaymentEvidence(evidence, this.options.paymentVerifier, at);
    }
    if (path === '/roundup/cards') verifiedCard = await verifyCardToken(object(body) as unknown as CardTokenEvidence, this.options.cardProvider);
    if (path === '/roundup/events') {
      if (!this.options.cardProvider) throw new FinancialError('card provider verification is not configured', 503, 'PROVIDER_REQUIRED');
      const collection = object(body) as unknown as CollectionEvidence;
      verifiedCollection = await this.options.cardProvider.verifyCollection(collection);
      if (verifiedPayment!.reference !== collection.eventId || verifiedPayment!.provider !== collection.provider || verifiedPayment!.amountMinor !== collection.collectedMinor || verifiedPayment!.policyId !== collection.policyId) throw new FinancialError('collection and cash verification disagree');
    }
    let source: { evidence: DistributionEvidence[]; sourceRecords: unknown[] } | undefined;
    if (path === '/distribution/backfill') {
      if (!this.options.sourceReader) throw new FinancialError('no authoritative source-record reader configured; backfill refused', 503, 'SOURCE_REQUIRED');
      const ids = body['sourceRecordIds']; if (!Array.isArray(ids) || ids.length > 100 || ids.some((x) => typeof x !== 'string')) throw new FinancialError('sourceRecordIds array required (maximum 100)', 400);
      const policyId = text(body, 'policyId'); const records = await Promise.all(ids.map((id) => this.options.sourceReader!.read(id, policyId)));
      const evidence: DistributionEvidence[] = []; const sourceRecords: unknown[] = [];
      records.forEach((record, i) => {
        if (record === null) return;
        const r = object(record); if (r['policyId'] !== policyId || !r['distribution']) throw new FinancialError('source record does not link exactly to the existing policy');
        const d = object(r['distribution']);
        sourceRecords.push(record); evidence.push({ sourcePolicyId: policyId, sourceRecordId: ids[i], sourceDigest: evidenceDigest(record), channelCode: d['channelCode'] as string, subChannelCode: d['subChannelCode'] as string | null, partnerId: d['partnerId'] as string | null });
      });
      source = { evidence, sourceRecords };
    }
    const result = await this.store.command({ scope, key, request, at, actor: principal.name }, (book) => {
      switch (path) {
        case '/policies': return book.issuePolicy(body as never);
        case '/nav': return book.recordNav(body as never);
        case '/rules/propose': return book.proposeRule(body as unknown as Omit<FinancialRule, 'version' | 'status' | 'proposedBy' | 'approval' | 'environment'>);
        case '/rules/approve': return book.approveRule({ ruleId: text(body, 'ruleId'), version: Number(body['version']), reference: text(body, 'reference'), designatedApprover: this.options.designatedApprover ?? '' });
        case '/payments': return book.invest({ ...(body as Record<string, unknown>), evidence: verifiedPayment! } as never, !!this.options.paymentVerifier);
        case '/servicing': {
          const kind = text(body, 'kind');
          if (kind === 'administration' || kind === 'mortality') return book.deduct(body as never);
          if (kind === 'switch') return book.switch(body as never);
          if (kind === 'withdrawal' || kind === 'surrender') return book.settle(body as never);
          throw new FinancialError('unsupported servicing operation', 400);
        }
        case '/monthly/run': {
          const policyId = text(body, 'policyId');
          return book.runMonthly({ policyId, fundId: text(body, 'fundId') });
        }
        case '/distribution/backfill': return book.backfillDistribution({ policyId: text(body, 'policyId'), ...source! });
        case '/roundup/cards': return book.attachVerifiedCard({ ...(body as Record<string, unknown>), verifiedAt: verifiedCard!.verifiedAt } as never);
        case '/roundup/settings': return book.configureRoundUp(body as never, !!this.options.cardProvider);
        case '/roundup/events': return book.processRoundUp({ ...(body as Record<string, unknown>), evidence: verifiedPayment! } as never, !!verifiedCollection);
        default: throw new FinancialError('financial endpoint not found', 404);
      }
    });
    return { ...result.result, replayed: result.replayed, version: result.version };
  }
}
