/**
 * Shared API dispatcher for both the Node HTTP server (`src/server/main.ts`) and the in-browser
 * runtime fallback (`src/ui/main.tsx`).
 *
 * Every endpoint is a thin, typed shell over the domain core (`World` + `ErpManager`), so whether
 * the console runs against the live Node process or as a self-contained static bundle on Vercel,
 * every creation, conversion, payment, alteration, claim decision, NAV injection and master setting
 * executes the exact same engine code.
 */
import {
  buildWorld, worldSnapshot, World, groupSnapshot, underwritingSnapshot, claimsSnapshot,
  reinsuranceSnapshot, extractSnapshot, uaeRuleSnapshot, wordingSnapshot, submissionSnapshot,
} from './demo.js';
import { money, formatAmount, parseAmount } from './money.js';
import { AE_PACK, preSaleCheck, comparisonMatrix } from './regulatory.js';
import { UaeRuleError } from './uae.js';
import { WordingError } from './wording.js';
import { SubmissionError } from './submission.js';
import {
  buildOutbox, compareOutboxes, openBooksTimeline, recordForEntry, REGISTER_STORE_LIMITATION,
  exportReporting, openReporting, restoreReporting, sealReporting, verifyOutbox,
} from './registerstore.js';
import { ReportingStore } from './reportingstore.js';
import { IdempotencyKeys } from './idempotency.js';
import { ocrDocument } from './onboarding.js';
import { unitsToDecimal } from './units.js';
import { ClaimCause, RecoveryType } from './claims.js';
import { exportLedger, importLedger, open, seal, snapshotText, LEDGER_SCHEMA_VERSION } from './persistence.js';
import { DecisionOutcome, OccupationClass, ProductLine } from './underwriting.js';
import { PRODUCT_COLUMN_LABELS, productExportCsv, productTemplateCsv, readProductSheet } from './product-config.js';
import type { RateRowInput } from './rating.js';
import { Basis, TreatyKind } from './reinsurance.js';
import { IdType, IdentityDocument } from './party.js';
import { FinancialAlterationKind, NonFinancialAlterationKind, PaymentFrequency, PolicyCategory, PolicyStatus } from './erp.js';
import { Locale } from './labels.js';
import { RiskClass } from './ai.js';
import { productCatalogue, serialiseJourneyProgress } from './journeydesk.js';
import { Mailer } from './mailer.js';
import { buildIllustration, illustrationView } from './illustration.js';
import { randomTokenHex } from './hash.js';
import { JourneyStageId } from './journey.js';
import type { AccountingStandard, FundLifeCycleEvent } from './funds-accounting.js';
import type { SuperFundId, SuperProductVariant } from './super-funds.js';
import type { WarehouseDatasetId, WarehouseFormat } from './warehouse.js';
import type { ThemeScope } from './theme.js';
import { batchSubjectsFromWorld, type BatchEventType } from './batch.js';
import { RequestValidationError, reqString, reqEnum, reqInt, optBool } from './validate.js';
import type { WarehouseConnectionKind } from './warehouse.js';
import type { CommitLike, WhatsNewEntry } from './whatsnew.js';

export interface RuntimeState {
  world: World;
  version: number;
  /** The runtime clock. Injectable so tests/drills are reproducible; defaults to wall time. */
  now: () => string;
  store: ReportingStore;
  storeError?: string;
  keys: IdempotencyKeys;
  /**
   * The mail desk, chosen from the environment the process started with. It is what makes "email the
   * quotation to the customer" a delivery rather than a record of an intention to deliver.
   */
  mailer: Mailer;
  /** The same environment, kept only so the status screen can say which settings are present. */
  mailEnv: Record<string, string | undefined>;
  takafulApprovals: { actuary?: { recommended: boolean; by: string; at: string }; shariah?: { approved: boolean; by: string; at: string }; board?: { endorsed: boolean; by: string; at: string } };
}

export function createRuntimeState(
  version = 1,
  now: () => string = () => new Date().toISOString(),
  env: Record<string, string | undefined> = {},
): RuntimeState {
  const world = buildWorld();
  const mailer = Mailer.fromEnv(env);
  world.journey.attachMailer(mailer);
  return {
    world,
    version,
    now,
    store: new ReportingStore(),
    keys: new IdempotencyKeys(),
    mailer,
    mailEnv: env,
    takafulApprovals: {},
  };
}

export function syncReportingStore(state: RuntimeState): {
  head: ReturnType<ReportingStore['headReport']>;
  tail: ReturnType<ReportingStore['verifySinceCheckpoint']>;
  written: number;
  rebased: boolean;
  note?: string;
  error?: string;
} {
  try {
    const write = state.store.appendFrom(exportReporting(state.world));
    state.storeError = undefined;
    return {
      head: state.store.headReport(),
      tail: state.store.verifySinceCheckpoint(),
      written: write.written,
      rebased: write.rebased,
      ...(write.note ? { note: write.note } : {}),
    };
  } catch (error) {
    state.storeError = error instanceof Error ? error.message : String(error);
    return {
      head: state.store.headReport(),
      tail: state.store.verifySinceCheckpoint(),
      written: 0,
      rebased: false,
      error: state.storeError,
    };
  }
}

export interface ApiDispatchResult {
  readonly handled: boolean;
  readonly status: number;
  readonly body: unknown;
}

const JS_BUILTINS: ReadonlySet<unknown> = new Set([
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError,
]);

export { RequestValidationError };

/**
 * The HTTP status an error deserves: malformed requests 400, domain refusals (the named
 * `*Error` classes the engines throw) 409, everything else a logged 500. Plain `Error`s and JS
 * builtins are programmer errors, never client answers.
 */
export function httpStatusForError(err: unknown): 400 | 409 | 500 {
  if (err instanceof RequestValidationError) return 400;
  return isDomainRefusal(err) ? 409 : 500;
}

export function isDomainRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const ctor = err.constructor as { name?: string } | undefined;
  return typeof ctor === 'function' && !JS_BUILTINS.has(ctor) && /Error$/.test(ctor.name ?? '');
}

export async function dispatchApiRoute(
  state: RuntimeState,
  method: string,
  path: string,
  searchParams: URLSearchParams,
  payload: Record<string, unknown>,
  onReset?: () => void,
): Promise<ApiDispatchResult> {
  const ok = (body: unknown): ApiDispatchResult => ({ handled: true, status: 200, body });
  const fail = (status: number, body: unknown): ApiDispatchResult => ({ handled: true, status, body });

  switch (`${method} ${path}`) {
    case 'GET /health':
      return ok({ ok: true, version: state.version, asOf: state.world.asOf, persistence: 'in-memory (demo world, rebuilt on boot)' });

    case 'GET /world':
      return ok(worldSnapshot(state.world));

    /* ------------------------------------------- previews & decision theatre */
    case 'POST /preview/switch': {
      const policyId = String(payload['policyId'] ?? 'UL-000123');
      const amount = payload['amount'] !== undefined
        ? parseAmount(String(payload['amount']), 'AED')
        : money(BigInt(reqInt(payload, 'amountMinor', { min: 0, fallback: 200000 })), 'AED');
      const preview = state.world.decider.previewSwitch({
        policyId,
        fromFundId: String(payload['fromFundId'] ?? 'FGLOBAL'),
        toFundId: String(payload['toFundId'] ?? 'FBAL'),
        amount,
        instructionAt: String(payload['instructionAt'] ?? `${state.world.asOf}T16:10:00+04:00`),
        disclaimer: AE_PACK.illustration.wording,
      });
      return ok({ ...preview, feeLabel: formatAmount(preview.fee), netLabel: formatAmount(preview.netInvested) });
    }

    case 'POST /preview/withdrawal': {
      const policyId = String(payload['policyId'] ?? 'UL-000123');
      const amount = payload['amount'] !== undefined
        ? parseAmount(String(payload['amount']), 'AED')
        : money(BigInt(reqInt(payload, 'amountMinor', { min: 0, fallback: 150000 })), 'AED');
      const preview = state.world.decider.previewWithdrawal({
        policyId,
        fundId: String(payload['fundId'] ?? 'FBAL'),
        amount,
        instructionAt: String(payload['instructionAt'] ?? `${state.world.asOf}T11:00:00+04:00`),
        disclaimer: AE_PACK.illustration.wording,
      });
      return ok({
        ...preview,
        requestedLabel: formatAmount(preview.requested),
        feeLabel: formatAmount(preview.fee),
        cashLabel: formatAmount(preview.cashToCustomer),
        remainingValueLabel: formatAmount(preview.remainingValue),
      });
    }

    /* --------------------------------------------- micro-duration cover */
    case 'POST /cover/start': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      const segments = state.world.billing.segmentsFor(policyId);
      const target = segments.find((s) => s.id === String(payload['segmentId'])) ?? segments[0];
      if (!target) return fail(404, { error: `no cover segment found for ${policyId}` });
      const updated = state.world.billing.startCover(target.id, String(payload['at'] ?? '2026-10-05T08:00:00+04:00'));
      return ok({ segment: { ...updated, dailyRateLabel: formatAmount(updated.dailyRate) } });
    }

    case 'POST /cover/stop': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      const segments = state.world.billing.segmentsFor(policyId);
      const target = segments.find((s) => s.id === String(payload['segmentId'])) ?? segments[0];
      if (!target) return fail(404, { error: `no cover segment found for ${policyId}` });
      const updated = state.world.billing.stopCover(target.id, String(payload['at'] ?? '2026-10-05T09:00:00+04:00'));
      return ok({ segment: { ...updated, dailyRateLabel: formatAmount(updated.dailyRate) } });
    }

    case 'POST /cover/tick': {
      const raised = state.world.billing.tick(String(payload['at'] ?? '2026-10-06T10:00:00+04:00'));
      return ok({
        raised: raised.map((e) => ({ ...e, amountLabel: formatAmount(e.amount) })),
        note: 'Cover is charged only for days inside an active start/stop window. Nothing auto-starts unless the segment elected daily renewal.',
      });
    }

    case 'POST /cover/segment': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      try {
        state.world.billing.wallet(policyId);
      } catch {
        state.world.billing.openWallet(policyId, money(0n, 'AED'));
      }
      const dailyRate = parseAmount(String(payload['dailyRate'] ?? '12.50'), 'AED');
      const usageRate = payload['usageRate'] ? parseAmount(String(payload['usageRate']), 'AED') : undefined;
      const seg = state.world.billing.createSegment({
        policyId,
        productId: String(payload['productId'] ?? 'PROD-MOTOR-PAYG'),
        mode: (String(payload['mode'] ?? 'start-stop') as 'start-stop' | 'daily' | 'payg' | 'monthly' | 'annual'),
        dailyRate,
        ...(usageRate ? { usageRatePerUnit: usageRate } : {}),
        tariffVersion: String(payload['tariffVersion'] ?? 'MOTOR-AE-2026.1'),
        autoStart: Boolean(payload['autoStart'] ?? false),
        graceDays: Number(payload['graceDays'] ?? 3),
        ...(payload['startAt'] ? { startAt: String(payload['startAt']) } : {}),
      });
      return ok({ segment: { ...seg, dailyRateLabel: formatAmount(seg.dailyRate) } });
    }

    case 'POST /cover/usage': {
      const segments = state.world.billing.allSegments();
      const segmentId = String(payload['segmentId'] ?? segments[0]?.id ?? '');
      const ev = state.world.billing.recordUsage({
        segmentId,
        units: Number(payload['units'] ?? 50),
        at: String(payload['at'] ?? `${state.world.asOf}T14:00:00+04:00`),
        ...(payload['note'] ? { note: String(payload['note']) } : {}),
      });
      return ok({ event: { ...ev, amountLabel: formatAmount(ev.amount) } });
    }

    case 'POST /cover/wallet/topup': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      const receipt = state.world.erp.receivePremium(state.world, {
        policyId,
        amount: String(payload['amount'] ?? '250.00'),
        paymentMethod: String(payload['paymentMethod'] ?? 'wallet-topup'),
        by: String(payload['by'] ?? 'customer-portal'),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        receiptId: receipt.id,
        policyId,
        credited: formatAmount(receipt.amount),
        walletBalance: formatAmount(state.world.billing.wallet(policyId).balance),
        journalIds: receipt.journalIds,
      });
    }

    /* ------------------------------------------- pre-sale & onboarding */
    case 'POST /pre-sale': {
      const productLine = String(payload['productLine'] ?? 'medical') as 'life' | 'medical' | 'motor' | 'travel' | 'group' | 'unit-linked' | 'takaful';
      const result = preSaleCheck(AE_PACK, {
        productLine,
        hasNeedAnalysis: Boolean(payload['hasNeedAnalysis']),
        hasNeedId: Boolean(payload['hasNeedId']),
        surveyCompleted: Boolean(payload['surveyCompleted'] ?? true),
        comparisonPresented: Boolean(payload['comparisonPresented'] ?? true),
        customerIsResident: Boolean(payload['customerIsResident'] ?? true),
        consentCaptured: Boolean(payload['consentCaptured'] ?? true),
      });
      return ok(result);
    }

    case 'POST /regulatory/quotes/add': {
      const offer = {
        insurer: String(payload['insurer'] ?? 'New Insurer').trim(),
        product: String(payload['product'] ?? 'Motor Comprehensive').trim(),
        premium: Number(payload['premium'] ?? 2100),
        excess: Number(payload['excess'] ?? 500),
        benefits: Array.isArray(payload['benefits'])
          ? (payload['benefits'] as string[])
          : String(payload['benefits'] ?? 'agency repair, roadside').split(',').map((s) => s.trim()).filter(Boolean),
        serviceRating: Number(payload['serviceRating'] ?? 4),
        complaintsPer10k: Number(payload['complaintsPer10k'] ?? 5),
      };
      state.world.quotes.push(offer);
      return ok({
        added: offer,
        comparison: comparisonMatrix(state.world.quotes).map((c) => ({
          ...c,
          premiumLabel: formatAmount(money(BigInt(Math.round(c.premium * 100)), 'AED')),
          scorePct: Math.round(c.score * 100),
        })),
      });
    }

    case 'POST /onboarding/ocr': {
      const readings = (payload['readings'] ?? payload['fields'] ?? {}) as Record<string, string[]>;
      const docType = (String(payload['documentType'] ?? 'driving-licence') as 'emirates-id' | 'national-id' | 'iqama' | 'passport' | 'driving-licence');
      const result = ocrDocument(docType, readings);
      return ok(result);
    }

    /* --------------------------------------- customers & party 360 */
    case 'POST /partner/lookup': {
      const partyId = String(payload['partyId'] ?? 'PTY-0001');
      const withConsent = Boolean(payload['withConsent'] ?? true);
      const partyConsents = state.world.parties.consentsOf(partyId);
      const consentId = payload['consentId']
        ? String(payload['consentId'])
        : (partyConsents.find((c) => !c.revokedAt)?.id ?? state.world.consentId);
      const result = state.world.parties.lookup({
        partyId,
        ...(withConsent ? { consentId } : {}),
        requestedBy: String(payload['requestedBy'] ?? 'DXB-BROKER-01'),
        scopes: Array.isArray(payload['scopes'])
          ? (payload['scopes'] as string[])
          : ['customer.exists', 'customer.name', 'customer.contact', 'customer.holdings'],
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
      });
      return ok(result);
    }

    case 'POST /parties/create': {
      const created = state.world.erp.createCustomer(state.world, {
        ...(payload['id'] ? { id: String(payload['id']) } : {}),
        kind: payload['kind'] === 'organisation' ? 'organisation' : 'person',
        nameEn: String(payload['nameEn'] ?? payload['name'] ?? ''),
        ...(payload['nameAr'] ? { nameAr: String(payload['nameAr']) } : {}),
        ...(payload['dateOfBirth'] ? { dateOfBirth: String(payload['dateOfBirth']) } : {}),
        ...(payload['idType'] ? { idType: String(payload['idType']) as IdType } : {}),
        ...(payload['idValue'] ? { idValue: String(payload['idValue']) } : {}),
        ...(payload['country'] ? { country: String(payload['country']) } : {}),
        ...(payload['idSource'] ? { idSource: String(payload['idSource']) as IdentityDocument['source'] } : {}),
        ...(payload['phone'] ? { phone: String(payload['phone']) } : {}),
        ...(payload['email'] ? { email: String(payload['email']) } : {}),
        ...(payload['addressLine'] ? { addressLine: String(payload['addressLine']) } : {}),
        ...(payload['city'] ? { city: String(payload['city']) } : {}),
        ...(Array.isArray(payload['roles']) ? { roles: payload['roles'] as string[] } : {}),
        ...(payload['grantConsentTo'] ? { grantConsentTo: String(payload['grantConsentTo']) } : {}),
        ...(Array.isArray(payload['consentScopes']) ? { consentScopes: payload['consentScopes'] as string[] } : {}),
      });
      return ok(created);
    }

    case 'POST /parties/update': {
      const updated = state.world.erp.updateCustomer(state.world, {
        partyId: String(payload['partyId'] ?? ''),
        ...(payload['nameEn'] ? { nameEn: String(payload['nameEn']) } : {}),
        ...(payload['nameAr'] !== undefined ? { nameAr: String(payload['nameAr']) } : {}),
        ...(payload['dateOfBirth'] ? { dateOfBirth: String(payload['dateOfBirth']) } : {}),
        ...(payload['phone'] ? { phone: String(payload['phone']) } : {}),
        ...(payload['email'] ? { email: String(payload['email']) } : {}),
        ...(payload['addressLine'] ? { addressLine: String(payload['addressLine']) } : {}),
        ...(payload['city'] ? { city: String(payload['city']) } : {}),
        ...(payload['country'] ? { country: String(payload['country']) } : {}),
        ...(payload['idType'] ? { idType: String(payload['idType']) as IdType } : {}),
        ...(payload['idValue'] ? { idValue: String(payload['idValue']) } : {}),
        ...(Array.isArray(payload['roles']) ? { roles: payload['roles'] as string[] } : {}),
      });
      return ok({ party: updated });
    }

    case 'POST /parties/consent/grant': {
      const consent = state.world.parties.grantConsent({
        partyId: String(payload['partyId'] ?? 'PTY-0001'),
        grantedTo: String(payload['grantedTo'] ?? 'DXB-BROKER-01'),
        purpose: String(payload['purpose'] ?? 'Customer 360 verification & policy servicing'),
        scopes: Array.isArray(payload['scopes'])
          ? (payload['scopes'] as string[])
          : ['customer.exists', 'customer.name', 'customer.contact', 'customer.holdings'],
        grantedAt: String(payload['grantedAt'] ?? `${state.world.asOf}T10:00:00+04:00`),
        expiresAt: String(payload['expiresAt'] ?? '2027-12-31T23:59:59+04:00'),
        evidence: String(payload['evidence'] ?? `signed e-consent ${Date.now()}`),
      });
      return ok(consent);
    }

    case 'POST /parties/consent/revoke': {
      const revoked = state.world.parties.revokeConsent(
        String(payload['consentId'] ?? state.world.consentId),
        String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
      );
      return ok(revoked);
    }

    case 'POST /parties/merge': {
      const merged = state.world.parties.merge(
        reqString(payload, 'winnerId'),
        reqString(payload, 'loserId'),
        String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
      );
      return ok({ merged });
    }

    /* ------------------------------------------- AI runtime & governance */
    case 'POST /ai/approve': {
      const id = reqString(payload, 'id');
      const action = state.world.ai.approve(id, String(payload['by'] ?? 'raheel@operator'));
      return ok(action);
    }

    case 'POST /ai/execute': {
      const id = reqString(payload, 'id');
      const action = state.world.ai.execute(id);
      return ok(action);
    }

    case 'POST /ai/propose': {
      const action = state.world.ai.propose({
        agent: String(payload['agent'] ?? 'ops-assistant-v1'),
        module: String(payload['module'] ?? 'underwriting'),
        intent: String(payload['intent'] ?? 'summarise-medical-history'),
        riskClass: (String(payload['riskClass'] ?? 'medium') as RiskClass),
        at: String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
        inputs: (payload['inputs'] as Record<string, unknown>) ?? { source: 'operator-console' },
        output: (payload['output'] as Record<string, unknown>) ?? { recommendation: 'proposed from console' },
        dryRun: Boolean(payload['dryRun'] ?? false),
        costUsd: Number(payload['costUsd'] ?? 0.03),
      });
      return ok(action);
    }

    /* ------------------------------------------- data ingestion */
    case 'POST /ingest/submit': {
      const text = String(payload['text'] ?? '');
      const loadId = String(payload['loadId'] ?? `LOAD-${Date.now()}`);
      state.world.ingest.submit({ loadId, source: 'console paste', submittedAt: state.now(), text });
      const reconciliation = state.world.ingest.reconciliation(loadId);
      return ok({
        summary: reconciliation.summary,
        anomalies: reconciliation.anomalies,
        quarantine: reconciliation.quarantine,
        supervisorNotes: reconciliation.supervisorNotes,
        loadId,
      });
    }

    case 'POST /ingest/commit': {
      const loadId = String(payload['loadId'] ?? '');
      const record = state.world.ingest.commit(loadId, state.now());
      return ok({ loadId, committed: record.committed, committedKeys: record.committedKeys.length, duplicates: record.duplicatesSuppressed });
    }

    /* ------------------------------------------- group finance */
    case 'GET /group':
      return ok(groupSnapshot(state.world, false));

    case 'POST /group/consolidate': {
      const report = groupSnapshot(state.world, true);
      return ok({
        ok: report.group.balanced,
        asOf: report.asOf,
        groupCurrency: report.groupCurrency,
        journals: report.eliminations.journals,
        eliminations: { matched: report.eliminations.matched, inTransit: report.eliminations.inTransit, notes: report.eliminations.notes },
        nci: report.nci,
        totals: report.group.totals,
        netAssets: report.group.netAssets,
        attribution: report.group.attribution,
        checks: report.group.checks,
      });
    }

    /* ------------------------------------------- proposals & underwriting */
    case 'GET /underwriting':
      return ok(underwritingSnapshot(state.world.underwriting, state.world.asOf));

    case 'POST /underwriting/register': {
      const parseList = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.map(String).map((s) => s.trim()).filter(Boolean)
          : typeof v === 'string' && v.trim()
            ? v.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
      const created = state.world.erp.createProposal(state.world, {
        partyId: String(payload['partyId'] ?? 'PTY-0001'),
        productId: String(payload['productId'] ?? 'PROD-LIFE-TERM'),
        sumAssured: String(payload['sumAssured'] ?? '250,000.00'),
        paymentFrequency: (String(payload['paymentFrequency'] ?? 'annual') as PaymentFrequency),
        termYears: Number(payload['termYears'] ?? 20),
        ...(payload['beneficiaryName'] ? { beneficiaryName: String(payload['beneficiaryName']) } : {}),
        ...(payload['beneficiaryRelationship'] ? { beneficiaryRelationship: String(payload['beneficiaryRelationship']) } : {}),
        ...(Array.isArray(payload['targetFunds']) ? { targetFunds: payload['targetFunds'] as string[] } : {}),
        age: Number(payload['age'] ?? 35),
        sex: payload['sex'] === 'female' ? 'female' : 'male',
        smoker: Boolean(payload['smoker'] ?? false),
        heightCm: Number(payload['heightCm'] ?? 175),
        weightKg: Number(payload['weightKg'] ?? 75),
        occupationClass: (Number(payload['occupationClass'] ?? 1) as OccupationClass),
        pursuits: parseList(payload['pursuits']),
        conditions: parseList(payload['conditions']),
        familyHistory: parseList(payload['familyHistory']),
        residenceCountry: String(payload['residenceCountry'] ?? 'AE'),
        annualIncome: String(payload['annualIncome'] ?? '360,000.00'),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok(created);
    }

    case 'POST /underwriting/amend': {
      // The medical questionnaire is reviewed and updated in service: every change is recorded
      // from -> to with the person and the reason, and a decision taken on the old answers is set
      // aside so the case has to be decided again.
      const num = (key: string): number | undefined => (payload[key] === undefined || payload[key] === '' ? undefined : Number(payload[key]));
      const list = (key: string): string[] | undefined => (payload[key] === undefined
        ? undefined
        : Array.isArray(payload[key])
          ? (payload[key] as unknown[]).map(String).map((v) => v.trim()).filter(Boolean)
          : String(payload[key]).split(',').map((v) => v.trim()).filter(Boolean));
      const amended = state.world.underwriting.amendProfile(String(payload['applicationId'] ?? ''), {
        at: String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`),
        by: String(payload['by'] ?? 'underwriter'),
        reason: String(payload['reason'] ?? ''),
        patch: {
          ...(num('age') !== undefined ? { age: num('age')! } : {}),
          ...(payload['sex'] ? { sex: String(payload['sex']) === 'female' ? 'female' as const : 'male' as const } : {}),
          ...(payload['smoker'] !== undefined ? { smoker: Boolean(payload['smoker']) } : {}),
          ...(num('heightCm') !== undefined ? { heightCm: num('heightCm')! } : {}),
          ...(num('weightKg') !== undefined ? { weightKg: num('weightKg')! } : {}),
          ...(num('occupationClass') !== undefined ? { occupationClass: num('occupationClass')! as OccupationClass } : {}),
          ...(list('conditions') !== undefined ? { conditions: list('conditions')! } : {}),
          ...(list('pursuits') !== undefined ? { pursuits: list('pursuits')! } : {}),
          ...(list('familyHistory') !== undefined ? { familyHistory: list('familyHistory')! } : {}),
          ...(payload['residenceCountry'] ? { residenceCountry: String(payload['residenceCountry']).toUpperCase() } : {}),
        },
      });
      return ok({
        applicationId: amended.application.id,
        amendments: amended.amendments.map((m) => ({ at: m.at, by: m.by, field: m.field, from: m.from, to: m.to, reason: m.reason })),
        trail: state.world.underwriting.amendmentsFor(amended.application.id).map((m) => ({ at: m.at, by: m.by, field: m.field, from: m.from, to: m.to, reason: m.reason })),
        decisionSetAside: amended.decisionSetAside,
        reassessment: {
          outcome: amended.reassessment.outcome,
          extraMortalityBps: amended.reassessment.extraMortalityBps,
          standardPremium: formatAmount(amended.reassessment.standardPremium),
          loadedPremium: formatAmount(amended.reassessment.loadedPremium),
          exclusions: amended.reassessment.exclusions,
          evidence: amended.reassessment.evidence,
          referrals: amended.reassessment.referrals,
          reasons: amended.reassessment.reasons.map((r) => ({ code: r.code, detail: r.detail, source: r.source, referral: r.referral === true })),
        },
      });
    }

    case 'POST /underwriting/decide': {
      const applicationId = String(payload['applicationId']);
      const decision = state.world.underwriting.decide(applicationId, {
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        by: String(payload['by'] ?? 'senior-underwriter'),
        isAi: Boolean(payload['isAi'] ?? false),
        ...(payload['override'] ? { override: String(payload['override']) as DecisionOutcome } : {}),
        ...(Array.isArray(payload['acceptReferralReasonCodes'])
          ? { acceptReferralReasonCodes: payload['acceptReferralReasonCodes'] as string[] }
          : {}),
      });
      return ok({
        applicationId,
        outcome: decision.outcome,
        decidedBy: decision.decidedBy,
        decidedByAi: decision.decidedByAi,
        extraMortalityBps: decision.extraMortalityBps,
        standardPremium: formatAmount(decision.standardPremium),
        loadedPremium: formatAmount(decision.loadedPremium),
        exclusions: decision.exclusions,
        evidence: decision.evidence,
        referrals: decision.referrals,
        reasons: decision.reasons.map((r) => ({ code: r.code, detail: r.detail, source: r.source, referral: r.referral === true })),
      });
    }

    /* ------------------------ policy conversion, premium & alterations */
    case 'POST /policies/convert': {
      const converted = state.world.erp.convertProposalToPolicy(state.world, {
        applicationId: String(payload['applicationId'] ?? ''),
        ...(payload['policyId'] ? { policyId: String(payload['policyId']) } : {}),
        ...(payload['paymentFrequency'] ? { paymentFrequency: String(payload['paymentFrequency']) as PaymentFrequency } : {}),
        ...(payload['beneficiaryName'] ? { beneficiaryName: String(payload['beneficiaryName']) } : {}),
        ...(payload['beneficiaryRelationship'] ? { beneficiaryRelationship: String(payload['beneficiaryRelationship']) } : {}),
        ...(payload['initialPremium'] !== undefined ? { initialPremium: String(payload['initialPremium']) } : {}),
        ...(payload['initialFundId'] ? { initialFundId: String(payload['initialFundId']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        policyId: converted.policy.policyId,
        partyId: converted.policy.partyId,
        holderName: converted.policy.holderName,
        productId: converted.policy.productId,
        productName: converted.policy.productName,
        category: converted.policy.category,
        sumAssured: formatAmount(converted.policy.sumAssured),
        annualPremium: formatAmount(converted.policy.annualPremium),
        totalPremiumPaid: formatAmount(converted.policy.totalPremiumPaid),
        status: converted.policy.status,
        applicationId: converted.policy.applicationId,
        ...(converted.initialReceipt
          ? {
              initialReceipt: {
                id: converted.initialReceipt.id,
                amount: formatAmount(converted.initialReceipt.amount),
                unitsAllocated: converted.initialReceipt.unitsAllocated ?? null,
                journalIds: converted.initialReceipt.journalIds,
              },
            }
          : {}),
      });
    }

    case 'POST /policies/create': {
      const created = state.world.erp.createPolicy(state.world, {
        ...(payload['policyId'] ? { policyId: String(payload['policyId']) } : {}),
        partyId: String(payload['partyId'] ?? 'PTY-0001'),
        productId: String(payload['productId'] ?? 'PROD-UL-GLOBAL'),
        sumAssured: String(payload['sumAssured'] ?? '250,000.00'),
        ...(payload['annualPremium'] !== undefined ? { annualPremium: String(payload['annualPremium']) } : {}),
        ...(payload['paymentFrequency'] ? { paymentFrequency: String(payload['paymentFrequency']) as PaymentFrequency } : {}),
        ...(payload['beneficiaryName'] ? { beneficiaryName: String(payload['beneficiaryName']) } : {}),
        ...(payload['beneficiaryRelationship'] ? { beneficiaryRelationship: String(payload['beneficiaryRelationship']) } : {}),
        ...(payload['initialPremium'] !== undefined ? { initialPremium: String(payload['initialPremium']) } : {}),
        ...(payload['initialFundId'] ? { initialFundId: String(payload['initialFundId']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        policyId: created.policy.policyId,
        partyId: created.policy.partyId,
        holderName: created.policy.holderName,
        productId: created.policy.productId,
        category: created.policy.category,
        sumAssured: formatAmount(created.policy.sumAssured),
        annualPremium: formatAmount(created.policy.annualPremium),
        status: created.policy.status,
      });
    }

    case 'POST /policies/premium': {
      const receipt = state.world.erp.receivePremium(state.world, {
        policyId: String(payload['policyId'] ?? 'UL-000123'),
        amount: String(payload['amount'] ?? '5,000.00'),
        ...(payload['fundId'] ? { fundId: String(payload['fundId']) } : {}),
        ...(payload['allocationChargeBps'] !== undefined ? { allocationChargeBps: Number(payload['allocationChargeBps']) } : {}),
        ...(payload['paymentMethod'] ? { paymentMethod: String(payload['paymentMethod']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        id: receipt.id,
        policyId: receipt.policyId,
        customerName: receipt.customerName,
        category: receipt.category,
        amount: formatAmount(receipt.amount),
        fundId: receipt.fundId ?? null,
        unitsAllocated: receipt.unitsAllocated ?? null,
        pricePerUnit: receipt.pricePerUnit ?? null,
        feeDeducted: receipt.feeDeducted ? formatAmount(receipt.feeDeducted) : '0.00 AED',
        journalIds: receipt.journalIds,
        note: receipt.note,
      });
    }

    case 'POST /policies/alter/non-financial': {
      const alt = state.world.erp.alterPolicyNonFinancial(state.world, {
        policyId: String(payload['policyId'] ?? 'UL-000123'),
        kind: (String(payload['kind'] ?? 'beneficiary-change') as NonFinancialAlterationKind),
        ...(payload['beneficiaryName'] ? { beneficiaryName: String(payload['beneficiaryName']) } : {}),
        ...(payload['beneficiaryRelationship'] ? { beneficiaryRelationship: String(payload['beneficiaryRelationship']) } : {}),
        ...(payload['beneficiarySharePct'] !== undefined ? { beneficiarySharePct: Number(payload['beneficiarySharePct']) } : {}),
        ...(payload['phone'] ? { phone: String(payload['phone']) } : {}),
        ...(payload['email'] ? { email: String(payload['email']) } : {}),
        ...(payload['addressLine'] ? { addressLine: String(payload['addressLine']) } : {}),
        ...(payload['city'] ? { city: String(payload['city']) } : {}),
        ...(payload['nameEn'] ? { nameEn: String(payload['nameEn']) } : {}),
        ...(payload['nameAr'] !== undefined ? { nameAr: String(payload['nameAr']) } : {}),
        ...(payload['paymentFrequency'] ? { paymentFrequency: String(payload['paymentFrequency']) as PaymentFrequency } : {}),
        ...(payload['autoRebalanceMonths'] !== undefined ? { autoRebalanceMonths: Number(payload['autoRebalanceMonths']) } : {}),
        ...(Array.isArray(payload['targetWeights']) ? { targetWeights: payload['targetWeights'] as Array<{ fundId: string; weightBps: number }> } : {}),
        ...(payload['status'] ? { status: String(payload['status']) as PolicyStatus } : {}),
        ...(payload['reason'] ? { reason: String(payload['reason']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok(alt);
    }

    case 'POST /policies/alter/financial': {
      const alt = state.world.erp.alterPolicyFinancial(state.world, {
        policyId: String(payload['policyId'] ?? 'UL-000123'),
        kind: (String(payload['kind'] ?? 'fund-switch') as FinancialAlterationKind),
        ...(payload['newSumAssured'] !== undefined ? { newSumAssured: String(payload['newSumAssured']) } : {}),
        ...(payload['amount'] !== undefined ? { amount: String(payload['amount']) } : {}),
        ...(payload['fromFundId'] ? { fromFundId: String(payload['fromFundId']) } : {}),
        ...(payload['toFundId'] ? { toFundId: String(payload['toFundId']) } : {}),
        ...(payload['fundId'] ? { fundId: String(payload['fundId']) } : {}),
        ...(payload['chargeCode'] ? { chargeCode: String(payload['chargeCode']) as 'coi' | 'admin' } : {}),
        ...(payload['policyYear'] !== undefined ? { policyYear: Number(payload['policyYear']) } : {}),
        ...(payload['reason'] ? { reason: String(payload['reason']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        ...alt,
        amount: alt.amount ? formatAmount(alt.amount) : null,
        fee: alt.fee ? formatAmount(alt.fee) : null,
      });
    }

    /* ------------------------------------------- funds, instruments & NAV injection */
    case 'POST /funds/create': {
      const created = state.world.erp.createFund(state.world, {
        id: String(payload['id'] ?? ''),
        name: String(payload['name'] ?? ''),
        ...(payload['currency'] ? { currency: String(payload['currency']) } : {}),
        ...(payload['cutoff'] ? { cutoff: String(payload['cutoff']) } : {}),
        ...(payload['fmcBpsAnnual'] !== undefined ? { fmcBpsAnnual: Number(payload['fmcBpsAnnual']) } : {}),
        ...(payload['benchmark'] ? { benchmark: String(payload['benchmark']) } : {}),
        ...(payload['shariahScreened'] !== undefined ? { shariahScreened: Boolean(payload['shariahScreened']) } : {}),
        ...(Array.isArray(payload['composition'])
          ? { composition: payload['composition'] as Array<{ instrumentId: string; weightBps: number }> }
          : {}),
        ...(payload['initialGrossAssets'] !== undefined ? { initialGrossAssets: String(payload['initialGrossAssets']) } : {}),
        ...(payload['initialLiabilities'] !== undefined ? { initialLiabilities: String(payload['initialLiabilities']) } : {}),
        ...(payload['initialUnits'] ? { initialUnits: String(payload['initialUnits']) } : {}),
        ...(payload['valuationDate'] ? { valuationDate: String(payload['valuationDate']) } : {}),
      });
      return ok(created);
    }

    case 'POST /funds/valuation': {
      const injected = state.world.erp.injectNav(state.world, {
        fundId: String(payload['fundId'] ?? 'FGLOBAL'),
        ...(payload['valuationDate'] ? { valuationDate: String(payload['valuationDate']) } : {}),
        grossAssets: String(payload['grossAssets'] ?? '13,000.00'),
        ...(payload['liabilities'] !== undefined ? { liabilities: String(payload['liabilities']) } : {}),
        ...(payload['unitsInIssue'] ? { unitsInIssue: String(payload['unitsInIssue']) } : {}),
        ...(payload['source'] ? { source: String(payload['source']) } : {}),
        ...(payload['revisionOf'] ? { revisionOf: String(payload['revisionOf']) } : {}),
      });
      return ok(injected);
    }

    case 'POST /funds/instrument': {
      const defined = state.world.erp.defineInstrumentAndPrice(state.world, {
        id: String(payload['id'] ?? ''),
        name: String(payload['name'] ?? ''),
        assetClass: String(payload['assetClass'] ?? 'equity'),
        ...(payload['isin'] ? { isin: String(payload['isin']) } : {}),
        shariahScreened: Boolean(payload['shariahScreened'] ?? false),
        price: Number(payload['price'] ?? 100),
        ...(payload['asOf'] ? { asOf: String(payload['asOf']) } : {}),
      });
      return ok(defined);
    }

    case 'POST /funds/market-price': {
      const instrumentId = String(payload['instrumentId'] ?? 'EMAAR');
      const price = Number(payload['price'] ?? 9.1);
      const asOf = String(payload['asOf'] ?? state.world.asOf);
      state.world.nav.recordMarketPrice({ instrumentId, asOf, price, currency: 'AED' });
      return ok({ instrumentId, asOf, price, currency: 'AED' });
    }

    /* ------------------------------------------- reinsurance & retakaful */
    case 'GET /reinsurance':
      return ok(reinsuranceSnapshot(state.world));

    case 'GET /reinsurance/security':
      return ok(reinsuranceSnapshot(state.world).security);

    case 'POST /reinsurance/treaty': {
      const treaty = state.world.erp.createTreaty(state.world, {
        id: String(payload['id'] ?? ''),
        name: String(payload['name'] ?? ''),
        counterparty: String(payload['counterparty'] ?? ''),
        kind: (String(payload['kind'] ?? 'quota-share') as TreatyKind),
        basis: payload['basis'] === 'takaful' ? 'takaful' : 'conventional',
        ...(payload['lineOfBusiness'] ? { lineOfBusiness: String(payload['lineOfBusiness']) } : {}),
        ...(payload['from'] ? { from: String(payload['from']) } : {}),
        ...(payload['to'] ? { to: String(payload['to']) } : {}),
        ...(payload['cessionBps'] !== undefined ? { cessionBps: Number(payload['cessionBps']) } : {}),
        ...(payload['retention'] !== undefined ? { retention: String(payload['retention']) } : {}),
        ...(payload['lines'] !== undefined ? { lines: Number(payload['lines']) } : {}),
        ...(payload['attachment'] !== undefined ? { attachment: String(payload['attachment']) } : {}),
        ...(payload['limit'] !== undefined ? { limit: String(payload['limit']) } : {}),
        ...(payload['commissionBps'] !== undefined ? { commissionBps: Number(payload['commissionBps']) } : {}),
        ...(payload['settlementDays'] !== undefined ? { settlementDays: Number(payload['settlementDays']) } : {}),
        ...(payload['securityRequiredBps'] !== undefined ? { securityRequiredBps: Number(payload['securityRequiredBps']) } : {}),
        ...(payload['depositAccounted'] !== undefined ? { depositAccounted: Boolean(payload['depositAccounted']) } : {}),
      });
      return ok({
        treatyId: treaty.id,
        name: treaty.name,
        counterparty: treaty.counterparty,
        kind: treaty.kind,
        basis: treaty.basis,
        lineOfBusiness: treaty.lineOfBusiness,
        commissionBps: treaty.commissionBps,
      });
    }

    case 'POST /reinsurance/cede': {
      const basis = String(payload['basis'] ?? 'conventional') === 'takaful' ? ('takaful' as const) : ('conventional' as const);
      const register = basis === 'takaful' ? state.world.retakaful : state.world.reinsurance;
      const next = register.cessionSchedule().length + 1;
      const cession = register.cedePremium({
        treatyId: String(payload['treatyId'] ?? (basis === 'takaful' ? 'RTKF-QS-20' : 'QS-25-2026')),
        policyId: String(payload['policyId'] ?? `MTR-2026-${next}`),
        riskId: String(payload['riskId'] ?? payload['policyId'] ?? `MTR-2026-${next}`),
        sumInsured: parseAmount(String(payload['sumInsured'] ?? '250,000.00'), 'AED'),
        premium: parseAmount(String(payload['premium'] ?? '1,200.00'), 'AED'),
        lineOfBusiness: String(payload['lineOfBusiness'] ?? (basis === 'takaful' ? 'life' : 'motor')),
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        basis,
        by: String(payload['by'] ?? 'reinsurance/desk'),
        ...(payload['fundId'] ? { fundId: String(payload['fundId']) } : (basis === 'takaful' ? { fundId: 'PRF' } : {})),
      });
      return ok({
        treatyId: cession.treatyId,
        policyId: cession.policyId,
        sharePct: cession.shareBps / 100,
        ceded: formatAmount(cession.ceded),
        cededPremium: formatAmount(cession.cededPremium),
        commission: formatAmount(cession.commission),
        netRetainedPremium: formatAmount(cession.netRetainedPremium),
        journalId: cession.journalId,
        explanation: cession.explanation,
      });
    }

    case 'POST /reinsurance/facultative': {
      const treatyId = String(payload['treatyId'] ?? 'FAC-MOTOR');
      const riskId = String(payload['riskId'] ?? 'MTR-ORION-77');
      const at = String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`);
      if (!state.world.reinsurance.acceptedRisks(treatyId).includes(riskId)) {
        state.world.reinsurance.acceptFacultative(treatyId, riskId, { at, by: String(payload['by'] ?? 'reinsurance/desk') });
      }
      const cession = state.world.reinsurance.cedePremium({
        treatyId,
        policyId: riskId,
        riskId,
        sumInsured: parseAmount(String(payload['sumInsured'] ?? '400,000.00'), 'AED'),
        premium: parseAmount(String(payload['premium'] ?? '5,600.00'), 'AED'),
        lineOfBusiness: String(payload['lineOfBusiness'] ?? 'motor'),
        at,
        basis: 'conventional',
        by: String(payload['by'] ?? 'reinsurance/desk'),
      });
      return ok({
        acceptedRisk: riskId,
        treatyId: cession.treatyId,
        sharePct: cession.shareBps / 100,
        cededPremium: formatAmount(cession.cededPremium),
        commission: formatAmount(cession.commission),
        journalId: cession.journalId,
      });
    }

    case 'POST /reinsurance/settle': {
      const ageing = state.world.reinsurance.ageing({ asOf: state.world.asOf });
      const target = String(payload['recoveryId'] ?? ageing.items[0]?.recoveryId ?? '');
      const result = state.world.reinsurance.settleRecovery({
        recoveryId: target,
        at: String(payload['at'] ?? `${state.world.asOf}T14:00:00+04:00`),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        by: String(payload['by'] ?? 'treasury'),
      });
      return ok({
        recoveryId: result.recoveryId,
        settled: formatAmount(result.settled),
        outstanding: formatAmount(result.outstanding),
        journalId: result.journalId ?? null,
      });
    }

    case 'POST /reinsurance/event': {
      const treatyId = String(payload['treatyId'] ?? 'XOL-CAT-5M');
      const eventId = String(payload['eventId'] ?? `STORM-${new Date().getUTCFullYear()}-${state.world.reinsurance.eventRecoveryList().length + 1}`);
      const result = state.world.reinsurance.recoverEvent(treatyId, {
        eventId,
        loss: parseAmount(String(payload['loss'] ?? '1,600,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T11:00:00+04:00`),
        by: String(payload['by'] ?? 'catastrophe-desk'),
      });
      return ok({
        eventId,
        amount: formatAmount(result.amount),
        treatment: result.treatment,
        consumed: formatAmount(result.cover.consumed),
        available: formatAmount(result.cover.available),
        reinstatementsLeft: result.cover.reinstatementsLeft,
      });
    }

    case 'POST /reinsurance/reinstate': {
      const treatyId = String(payload['treatyId'] ?? 'XOL-CAT-5M');
      const reinstatement = state.world.reinsurance.reinstate(treatyId, {
        at: String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
        ...(payload['restore'] ? { restore: parseAmount(String(payload['restore']), 'AED') } : {}),
        by: String(payload['by'] ?? 'reinsurance/desk'),
      });
      return ok({
        treatyId: reinstatement.treatyId,
        sequence: reinstatement.sequence,
        restored: formatAmount(reinstatement.restored),
        premium: formatAmount(reinstatement.premium),
        free: reinstatement.free,
        available: formatAmount(reinstatement.available),
        journalId: reinstatement.journalId ?? null,
      });
    }

    case 'POST /reinsurance/deposit': {
      const next = state.world.reinsurance.depositAccount('AGG-SL-DEPOSIT');
      const instalment = next.adjustments.length + 1;
      const account = state.world.reinsurance.openDeposit('AGG-SL-DEPOSIT', {
        amount: parseAmount(String(payload['amount'] ?? '100,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T13:00:00+04:00`),
        instalment,
      });
      return ok({
        treatyId: account.treatyId,
        instalment,
        depositPaid: formatAmount(account.depositPaid),
        treatment: account.treatment,
        assetRemaining: formatAmount(account.assetRemaining),
      });
    }

    case 'POST /reinsurance/deposit/settle': {
      const account = state.world.reinsurance.settleDeposit('AGG-SL-DEPOSIT', {
        subjectPremium: parseAmount(String(payload['subjectPremium'] ?? '8,000,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T15:00:00+04:00`),
        ...(payload['rateOnLineBps'] ? { rateOnLineBps: Number(payload['rateOnLineBps']) } : {}),
      });
      return ok({
        treatyId: account.treatyId,
        depositPaid: formatAmount(account.depositPaid),
        technicalPremium: account.technicalPremium ? formatAmount(account.technicalPremium) : null,
        settled: account.settled,
        assetRemaining: formatAmount(account.assetRemaining),
        adjustment: account.adjustments.at(-1)
          ? { kind: account.adjustments.at(-1)!.kind, amount: formatAmount(account.adjustments.at(-1)!.amount) }
          : null,
      });
    }

    case 'POST /reinsurance/security/hold': {
      const register = String(payload['basis'] ?? 'conventional') === 'takaful' ? state.world.retakaful : state.world.reinsurance;
      const instrument = register.holdSecurity({
        counterparty: String(payload['counterparty'] ?? 'Emirates Re'),
        kind: String(payload['kind'] ?? 'cash') as 'cash' | 'funds-withheld' | 'letter-of-credit' | 'bank-guarantee',
        amount: parseAmount(String(payload['amount'] ?? '10,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        reference: String(payload['reference'] ?? `SEC-${state.now().slice(0, 10)}`),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['treatyId'] ? { treatyId: String(payload['treatyId']) } : {}),
        ...(payload['expiresAt'] ? { expiresAt: String(payload['expiresAt']) } : {}),
        ...(payload['basis'] === 'takaful' ? { fundId: 'PRF' } : {}),
      });
      return ok({
        instrumentId: instrument.id,
        counterparty: instrument.counterparty,
        kind: instrument.kind,
        amount: formatAmount(instrument.amount),
        onBalanceSheet: instrument.onBalanceSheet,
        reference: instrument.reference,
        expiresAt: instrument.expiresAt ?? null,
        journalId: instrument.journalId ?? null,
      });
    }

    case 'POST /reinsurance/security/call': {
      const call = state.world.reinsurance.callSecurity({
        counterparty: String(payload['counterparty'] ?? 'Emirates Re'),
        at: String(payload['at'] ?? `${state.world.asOf}T11:00:00+04:00`),
        reason: String(payload['reason'] ?? 'security held is below what the treaties require'),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        ...(payload['dueInDays'] ? { dueInDays: Number(payload['dueInDays']) } : {}),
      });
      return ok({
        callId: call.id,
        counterparty: call.counterparty,
        amount: formatAmount(call.amount),
        shortfallAtRaise: formatAmount(call.shortfallAtRaise),
        reason: call.reason,
        at: call.at,
        dueBy: call.dueBy,
        status: call.status,
      });
    }

    case 'POST /reinsurance/security/call/settle': {
      const openCalls = state.world.reinsurance.cashCallList().filter((c) => c.status !== 'settled');
      const callId = String(payload['callId'] ?? openCalls[0]?.id ?? '');
      const result = state.world.reinsurance.settleCall({
        callId,
        at: String(payload['at'] ?? `${state.world.asOf}T15:30:00+04:00`),
        kind: String(payload['kind'] ?? 'cash') as 'cash' | 'funds-withheld' | 'letter-of-credit' | 'bank-guarantee',
        reference: String(payload['reference'] ?? 'CALL-ANSWER'),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        ...(payload['expiresAt'] ? { expiresAt: String(payload['expiresAt']) } : {}),
      });
      return ok({
        callId: result.call.id,
        status: result.call.status,
        asked: formatAmount(result.call.amount),
        settled: formatAmount(result.call.settled),
        outstanding: formatAmount({ minor: result.call.amount.minor - result.call.settled.minor, currency: 'AED' }),
        instrumentId: result.instrument.id,
        instrumentKind: result.instrument.kind,
        instrumentAmount: formatAmount(result.instrument.amount),
        journalId: result.instrument.journalId ?? null,
      });
    }

    case 'POST /reinsurance/security/release': {
      const position = state.world.reinsurance.securityPositions(state.world.asOf)
        .find((p) => p.surplus.minor > 0n && p.instruments.some((i) => i.onBalanceSheet));
      const instrument = position?.instruments.find((i) => i.onBalanceSheet && i.amount.minor > i.released.minor);
      const result = state.world.reinsurance.releaseSecurity({
        instrumentId: String(payload['instrumentId'] ?? instrument?.id ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T16:00:00+04:00`),
        amount: payload['amount'] ? parseAmount(String(payload['amount']), 'AED') : (position?.surplus ?? parseAmount('0.00', 'AED')),
        reason: String(payload['reason'] ?? 'the security held is above what the treaties require'),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['approvedBy'] ? { approvedBy: String(payload['approvedBy']) } : {}),
      });
      return ok({
        instrumentId: result.instrument.id,
        counterparty: result.instrument.counterparty,
        kind: result.instrument.kind,
        released: formatAmount(result.released),
        remaining: formatAmount({ minor: result.instrument.amount.minor - result.instrument.released.minor, currency: 'AED' }),
        journalId: result.journalId ?? null,
      });
    }

    case 'POST /reinsurance/security/interest': {
      const register = String(payload['basis'] ?? 'conventional') === 'takaful' ? state.world.retakaful : state.world.reinsurance;
      const cash = register.securityPositions(state.world.asOf)
        .flatMap((p) => p.instruments).find((i) => i.kind === 'cash' && i.onBalanceSheet);
      const result = register.creditCollateralInterest({
        instrumentId: String(payload['instrumentId'] ?? cash?.id ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T16:30:00+04:00`),
        amount: parseAmount(String(payload['amount'] ?? '250.00'), 'AED'),
        by: String(payload['by'] ?? 'treasury'),
      });
      return ok({
        instrumentId: result.instrument.id,
        counterparty: result.instrument.counterparty,
        interest: formatAmount(result.instrument.interest),
        journalId: result.journalId,
      });
    }

    case 'POST /reinsurance/recover': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      const claimId = String(payload['claimId'] ?? 'CLM-000001');
      const paid = parseAmount(String(payload['paid'] ?? '1,150.00'), 'AED');
      const recovery = state.world.reinsurance.recoverClaim({
        policyId,
        claim: state.world.claims,
        claimId,
        paid,
        at: String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`),
        by: String(payload['by'] ?? 'recovery-desk'),
      });
      return ok({
        claimId,
        amount: formatAmount(recovery.amount),
        sharePct: recovery.shareBps / 100,
        recoveryId: recovery.recoveryId,
        recovered: formatAmount(state.world.claims.netCost(claimId)),
      });
    }

    /* ------------------------------------------- claims lifecycle */
    case 'GET /claims':
      return ok({
        conventional: claimsSnapshot(state.world.claims, state.world.asOf),
        takaful: claimsSnapshot(state.world.takafulClaims, state.world.asOf),
      });

    case 'POST /claims/register': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claim = engine.register({
        policyId: String(payload['policyId'] ?? (isTakaful ? 'TK-9001' : 'UL-000123')),
        cause: (String(payload['cause'] ?? 'medical') as ClaimCause),
        lossDate: String(payload['lossDate'] ?? '2026-09-28'),
        reportedAt: String(payload['reportedAt'] ?? '2026-09-30'),
        description: String(payload['description'] ?? 'Registered from the console'),
        ...(isTakaful ? { fundId: String(payload['fundId'] ?? 'PRF') } : (payload['fundId'] ? { fundId: String(payload['fundId']) } : {})),
      });
      const autoTriage = payload['autoTriage'] !== false;
      let triageResult: { decision: string; reasons: string[]; reserveSuggestion: string | null } | null = null;
      if (autoTriage) {
        const exclusions = Array.isArray(payload['exclusionsApplied'])
          ? (payload['exclusionsApplied'] as string[])
          : typeof payload['exclusionsApplied'] === 'string' && payload['exclusionsApplied'].trim()
            ? payload['exclusionsApplied'].split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        const triage = engine.triage(claim.id, {
          coverInForce: payload['coverInForce'] !== undefined ? Boolean(payload['coverInForce']) : true,
          exclusionsApplied: exclusions,
          daysLate: Number(payload['daysLate'] ?? 2),
          fraudSignals: Number(payload['fraudSignals'] ?? 0),
        });
        triageResult = {
          decision: triage.decision,
          reasons: triage.reasons,
          reserveSuggestion: triage.reserveSuggestion ? formatAmount(triage.reserveSuggestion) : null,
        };
      }
      return ok({
        id: claim.id,
        book: isTakaful ? 'takaful' : 'conventional',
        status: engine.claim(claim.id).status,
        triage: triageResult,
        claim: claimsSnapshot(engine, state.world.asOf).list.at(-1),
      });
    }

    case 'POST /claims/triage': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const exclusions = Array.isArray(payload['exclusionsApplied'])
        ? (payload['exclusionsApplied'] as string[])
        : typeof payload['exclusionsApplied'] === 'string' && payload['exclusionsApplied'].trim()
          ? payload['exclusionsApplied'].split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      const triage = engine.triage(claimId, {
        coverInForce: payload['coverInForce'] !== undefined ? Boolean(payload['coverInForce']) : true,
        exclusionsApplied: exclusions,
        daysLate: Number(payload['daysLate'] ?? 1),
        fraudSignals: Number(payload['fraudSignals'] ?? 0),
      });
      return ok({
        id: claimId,
        book: isTakaful ? 'takaful' : 'conventional',
        status: engine.claim(claimId).status,
        decision: triage.decision,
        reasons: triage.reasons,
        reserveSuggestion: triage.reserveSuggestion ? formatAmount(triage.reserveSuggestion) : null,
      });
    }

    case 'POST /claims/reserve': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const amount = parseAmount(String(payload['amount'] ?? '1,500.00'), 'AED');
      const claim = engine.setReserve(claimId, {
        amount,
        at: String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`),
        by: String(payload['by'] ?? 'reserving-desk'),
        ...(payload['rationale'] ? { rationale: String(payload['rationale']) } : {}),
      });
      return ok({
        id: claim.id,
        status: claim.status,
        reserve: formatAmount(claim.reserve),
        position: claimsSnapshot(engine, state.world.asOf).position,
      });
    }

    case 'POST /claims/approve': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const amount = parseAmount(String(payload['amount'] ?? '250.00'), 'AED');
      const claim = engine.approve(claimId, {
        amount,
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        by: String(payload['by'] ?? 'console'),
        role: String(payload['role'] ?? 'claims-officer'),
        isAi: optBool(payload, 'isAi'),
      });
      return ok({
        id: claim.id,
        status: claim.status,
        approved: formatAmount(engine.approvedAmount(claimId) ?? amount),
      });
    }

    case 'POST /claims/decline': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const claim = engine.decline(claimId, {
        at: String(payload['at'] ?? `${state.world.asOf}T10:30:00+04:00`),
        by: String(payload['by'] ?? 'claims-manager'),
        rationale: String(payload['rationale'] ?? 'Declined following claims review'),
      });
      return ok({
        id: claim.id,
        status: claim.status,
        declinedReason: claim.declinedReason,
      });
    }

    case 'POST /claims/settle': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const approved = payload['amount']
        ? parseAmount(String(payload['amount']), 'AED')
        : engine.approvedAmount(claimId);
      if (!approved) return fail(409, { error: `claim ${claimId} has no approval to settle` });
      const claim = engine.settle(claimId, {
        amount: approved,
        at: String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
        by: String(payload['by'] ?? 'finance-ops'),
      });
      return ok({
        id: claim.id,
        status: claim.status,
        paid: formatAmount(claim.paid),
        decisions: claim.decisions.slice(-1).map((d) => ({ action: d.action, rationale: d.rationale })),
        position: claimsSnapshot(engine, state.world.asOf).position,
      });
    }

    case 'POST /claims/recover': {
      const isTakaful = String(payload['book'] ?? 'conventional') === 'takaful';
      const engine = isTakaful ? state.world.takafulClaims : state.world.claims;
      const claimId = reqString(payload, 'claimId');
      const recovery = engine.recover(claimId, {
        type: (String(payload['type'] ?? 'salvage') as RecoveryType),
        amount: parseAmount(String(payload['amount'] ?? '150.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T14:00:00+04:00`),
        by: String(payload['by'] ?? 'recovery-desk'),
      });
      return ok({
        id: recovery.id,
        claimId,
        type: recovery.type,
        amount: formatAmount(recovery.amount),
        journalId: recovery.journalId,
        netCost: formatAmount(engine.netCost(claimId)),
      });
    }

    /* ------------------------------------------- takaful operations */
    case 'POST /takaful/approve': {
      const role = reqEnum(payload, 'role', ['actuary', 'shariah', 'board'] as const, 'actuary');
      const by = String(payload['by'] ?? 'human-signatory');
      const w = state.world;
      if (role === 'actuary') state.takafulApprovals.actuary = { recommended: true, by, at: w.asOf };
      if (role === 'shariah') state.takafulApprovals.shariah = { approved: true, by, at: w.asOf };
      if (role === 'board') state.takafulApprovals.board = { endorsed: true, by, at: w.asOf };

      const proposal = w.takaful.surplusRun({
        riskFundId: 'PRF',
        determinedAt: w.asOf,
        assets: money(3050_00, 'AED'),
        liabilities: money(1800_00, 'AED'),
        config: w.erp.getTakafulConfig(),
        isFullValuation: true,
        auditedResultsAvailable: true,
        ...(state.takafulApprovals.actuary ? { actuarialRecommendation: state.takafulApprovals.actuary } : {}),
        ...(state.takafulApprovals.shariah ? { shariahApproval: state.takafulApprovals.shariah } : {}),
        ...(state.takafulApprovals.board ? { boardApproval: state.takafulApprovals.board } : {}),
      });
      return ok({ id: proposal.id, approvals: proposal.approvals, blockers: proposal.blockers, ready: proposal.ready });
    }

    case 'POST /takaful/contribute': {
      const policyId = String(payload['policyId'] ?? 'TK-9001');
      const receipt = state.world.erp.receivePremium(state.world, {
        policyId,
        amount: String(payload['amount'] ?? '3,000.00'),
        by: String(payload['by'] ?? 'takaful-cashier'),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        receiptId: receipt.id,
        policyId,
        amount: formatAmount(receipt.amount),
        feeDeducted: receipt.feeDeducted ? formatAmount(receipt.feeDeducted) : '0.00 AED',
        journalIds: receipt.journalIds,
        note: receipt.note,
      });
    }

    case 'POST /takaful/qard/repay': {
      const qards = state.world.takaful.listQards().filter((q) => q.status === 'outstanding');
      const qardId = String(payload['qardId'] ?? qards[0]?.id ?? 'TKF-QARD-000001');
      const amount = parseAmount(String(payload['amount'] ?? '300.00'), 'AED');
      const repaid = state.world.takaful.repayQard({
        qardId,
        amount,
        at: String(payload['at'] ?? `${state.world.asOf}T15:00:00+04:00`),
      });
      return ok({
        id: repaid.id,
        amount: formatAmount(repaid.amount),
        repaid: formatAmount(repaid.repaid),
        outstanding: formatAmount(money(repaid.amount.minor - repaid.repaid.minor, 'AED')),
        status: repaid.status,
      });
    }

    case 'POST /takaful/distribute': {
      const ready = [...state.world.takaful.proposalsList()].reverse().find((p) => p.ready && !p.distributed);
      const proposalId = String(payload['proposalId'] ?? ready?.id ?? '');
      if (!proposalId) {
        return fail(409, { error: 'no surplus proposal is ready to distribute — ensure Qard Hasan is repaid and all three gates have signed' });
      }
      const dist = state.world.takaful.distribute(proposalId, String(payload['at'] ?? `${state.world.asOf}T16:00:00+04:00`));
      return ok({
        id: dist.id,
        distributed: dist.distributed,
        participantShare: formatAmount(dist.participantShare),
        operatorShare: formatAmount(dist.operatorShare),
      });
    }

    /* ------------------------------------------- master settings */
    case 'POST /master/tenant-settings': {
      const patch: { country?: string; region?: string; businessDate?: string; timeZone?: string; localCurrency?: string; foreignCurrency?: string } = {};
      if (payload['country'] !== undefined) patch.country = String(payload['country']);
      if (payload['region'] !== undefined) patch.region = String(payload['region']);
      if (payload['businessDate'] !== undefined) patch.businessDate = String(payload['businessDate']);
      if (payload['timeZone'] !== undefined) patch.timeZone = String(payload['timeZone']);
      if (payload['localCurrency'] !== undefined) patch.localCurrency = String(payload['localCurrency']);
      if (payload['foreignCurrency'] !== undefined) patch.foreignCurrency = String(payload['foreignCurrency']);
      return ok(state.world.erp.updateTenantSettings(patch));
    }

    case 'POST /master/product': {
      const master = state.world.erp.defineProductMaster(state.world, {
        productId: String(payload['productId'] ?? ''),
        // Anything the caller left out is left out on purpose: the product factory prefills the name,
        // the category and the line from the catalogue, and an empty default here would quietly turn a
        // filed takaful variety into a conventional one.
        ...(payload['name'] !== undefined ? { name: String(payload['name']) } : {}),
        ...(payload['category'] !== undefined ? { category: String(payload['category']) as PolicyCategory } : {}),
        ...(payload['line'] !== undefined ? { line: String(payload['line']) as ProductLine } : {}),
        ...(payload['minAge'] !== undefined ? { minAge: Number(payload['minAge']) } : {}),
        ...(payload['maxAge'] !== undefined ? { maxAge: Number(payload['maxAge']) } : {}),
        ...(payload['maxBmi'] !== undefined ? { maxBmi: Number(payload['maxBmi']) } : {}),
        ...(payload['baseRatePerThousand'] !== undefined ? { baseRatePerThousand: String(payload['baseRatePerThousand']) } : {}),
        ...(payload['incomeMultiple'] !== undefined ? { incomeMultiple: Number(payload['incomeMultiple']) } : {}),
        ...(payload['automaticBindingLimit'] !== undefined ? { automaticBindingLimit: String(payload['automaticBindingLimit']) } : {}),
        ...(payload['facultativeThreshold'] !== undefined ? { facultativeThreshold: String(payload['facultativeThreshold']) } : {}),
        ...(payload['aiStraightThroughLimit'] !== undefined ? { aiStraightThroughLimit: String(payload['aiStraightThroughLimit']) } : {}),
        ...(Array.isArray(payload['defaultFunds']) ? { defaultFunds: payload['defaultFunds'] as string[] } : {}),
        ...(payload['variety'] !== undefined ? { variety: String(payload['variety']) } : {}),
        ...(payload['blurb'] !== undefined ? { blurb: String(payload['blurb']) } : {}),
        ...(payload['currency'] !== undefined ? { currency: String(payload['currency']) } : {}),
        ...(payload['evidenceProfile'] !== undefined ? { evidenceProfile: String(payload['evidenceProfile']) } : {}),
        ...(Array.isArray(payload['acceptedCountries']) ? { acceptedCountries: payload['acceptedCountries'] as string[] } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({ productId: master.productId, name: master.name, category: master.category, line: master.line, variety: master.variety, blurb: master.blurb, currency: master.currency });
    }

    /* ------------------------------------------- the product grid: a table of products, saved as a table
     *
     * The console's product factory is editable in place, so it needs an endpoint that takes the whole
     * grid, files every row through the same `defineProductMaster` the single-product form uses, and
     * answers row by row: what was filed, what was refused and why. Nothing about a row is discarded
     * because another row was wrong.
     */
    case 'POST /master/product/bulk': {
      const rows = Array.isArray(payload['rows']) ? payload['rows'] as Record<string, unknown>[] : [];
      if (rows.length === 0) return fail(400, { error: 'no product rows were sent' });
      if (rows.length > 500) return fail(400, { error: `a grid saves at most 500 rows at a time (this one sent ${rows.length})` });
      const result = state.world.erp.defineProductMasters(state.world, rows.map((row) => ({
        ...(row['productId'] !== undefined ? { productId: String(row['productId']) } : {}),
        ...(row['name'] !== undefined ? { name: String(row['name']) } : {}),
        ...(row['secondaryName'] !== undefined ? { secondaryName: String(row['secondaryName']) } : {}),
        ...(row['category'] !== undefined ? { category: String(row['category']) } : {}),
        ...(row['line'] !== undefined ? { line: String(row['line']) } : {}),
        ...(row['variety'] !== undefined ? { variety: String(row['variety']) } : {}),
        ...(row['blurb'] !== undefined ? { blurb: String(row['blurb']) } : {}),
        ...(row['currency'] !== undefined ? { currency: String(row['currency']) } : {}),
        ...(row['minAge'] !== undefined ? { minAge: row['minAge'] as string | number } : {}),
        ...(row['maxAge'] !== undefined ? { maxAge: row['maxAge'] as string | number } : {}),
        ...(row['maxBmi'] !== undefined ? { maxBmi: row['maxBmi'] as string | number } : {}),
        ...(row['baseRatePerThousand'] !== undefined ? { baseRatePerThousand: row['baseRatePerThousand'] as string | number } : {}),
        ...(row['incomeMultiple'] !== undefined ? { incomeMultiple: row['incomeMultiple'] as string | number } : {}),
        ...(row['automaticBindingLimit'] !== undefined ? { automaticBindingLimit: row['automaticBindingLimit'] as string | number } : {}),
        ...(row['facultativeThreshold'] !== undefined ? { facultativeThreshold: row['facultativeThreshold'] as string | number } : {}),
        ...(row['aiStraightThroughLimit'] !== undefined ? { aiStraightThroughLimit: row['aiStraightThroughLimit'] as string | number } : {}),
        ...(Array.isArray(row['acceptedCountries']) ? { acceptedCountries: row['acceptedCountries'] as string[] } : {}),
        ...(Array.isArray(row['defaultFunds']) ? { defaultFunds: row['defaultFunds'] as string[] } : {}),
      })), { ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}) });
      return ok({
        saved: result.saved.length, created: result.created, updated: result.updated,
        rejected: result.rejected,
        products: result.saved.map((master) => ({
          productId: master.productId, name: master.name, secondaryName: master.secondaryName,
          category: master.category, line: master.line, currency: master.currency,
        })),
      });
    }

    case 'POST /master/product/copy': {
      const copied = state.world.erp.copyProductMaster(state.world, {
        sourceProductId: String(payload['sourceProductId'] ?? ''),
        productId: String(payload['productId'] ?? ''),
        ...(payload['name'] !== undefined ? { name: String(payload['name']) } : {}),
        ...(payload['secondaryName'] !== undefined ? { secondaryName: String(payload['secondaryName']) } : {}),
        ...(payload['copyRates'] !== undefined ? { copyRates: Boolean(payload['copyRates']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({
        productId: copied.master.productId, name: copied.master.name, secondaryName: copied.master.secondaryName,
        copiedRateRows: copied.copiedRateRows,
      });
    }

    /* ------------------------------------------- the product sheet: download it, fill it in, upload it */
    case 'GET /master/product/template': {
      const only = (searchParams.get('products') ?? '').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
      const sheet = state.world.erp.productSheet().filter((p) => only.length === 0 || only.includes(p.productId));
      return ok({ filename: `product-configuration-${state.world.asOf}.csv`, csv: productTemplateCsv(sheet), columns: PRODUCT_COLUMN_LABELS });
    }

    case 'GET /master/product/export':
      return ok({ filename: `product-masters-${state.world.asOf}.csv`, csv: productExportCsv(state.world.erp.productSheet()) });

    case 'POST /master/product/import': {
      const csv = String(payload['csv'] ?? '');
      if (!csv.trim()) return fail(400, { error: 'no file was uploaded' });
      // A sheet whose header nobody can read is a 400 with the reason in it, not a stack trace: the
      // uploader is a person with a spreadsheet, and the fix is one sentence long.
      let sheet: ReturnType<typeof readProductSheet>;
      try {
        sheet = readProductSheet(csv);
      } catch (error) {
        return fail(400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (sheet.rows.length === 0 && sheet.rejected.length === 0) return fail(400, { error: 'the sheet held nothing to file' });
      const filed = state.world.erp.defineProductMasters(state.world, sheet.rows, {
        by: payload['by'] === undefined ? 'bulk-upload' : String(payload['by']),
      });
      return ok({
        read: sheet.read,
        saved: filed.saved.length,
        created: filed.created,
        updated: filed.updated,
        sheetRejected: sheet.rejected,
        rejected: filed.rejected,
        warnings: sheet.warnings,
        products: filed.saved.map((master) => ({ productId: master.productId, name: master.name, secondaryName: master.secondaryName })),
      });
    }

    /* ------------------------------------------- the rating tables (age, gender, occupation, sum assured) */
    case 'GET /master/rates': {
      const productId = searchParams.get('productId') ?? undefined;
      const kind = (searchParams.get('kind') ?? undefined) as 'premium' | 'mortality' | undefined;
      return ok({
        rows: state.world.erp.rating.listFor({ ...(productId ? { productId } : {}), ...(kind ? { kind } : {}) }),
        stats: state.world.erp.rating.stats(),
        gaps: productId ? state.world.erp.rating.ageGaps(productId, kind ?? 'premium') : [],
        overlaps: productId ? state.world.erp.rating.overlaps(productId, kind ?? 'premium') : [],
        trail: state.world.erp.rating.audit(),
      });
    }

    case 'GET /master/rates/template': {
      const products = (searchParams.get('products') ?? '').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
      return ok({
        filename: `rate-sample-${state.world.asOf}.csv`,
        csv: state.world.erp.rating.template(products, { rows: Number(searchParams.get('bands') ?? 4) || 4 }),
        columns: ['Product ID', 'Rate type', 'Gender', 'Age from', 'Age to', 'Occupation class', 'Sum assured from', 'Sum assured to', 'Channel', 'Partner', 'Rate per 1,000', 'Currency', 'Note'],
      });
    }

    case 'GET /master/rates/export': {
      const productId = searchParams.get('productId') ?? undefined;
      return ok({
        filename: `rate-table-${productId ? productId.toLowerCase() : 'all'}-${state.world.asOf}.csv`,
        csv: state.world.erp.rating.exportCsv(productId ? { productId } : {}),
      });
    }

    case 'POST /master/rates/upsert': {
      const { at, by, ...row } = payload;
      const filed = state.world.erp.rating.upsert({ ...(row as Record<string, string>), at: at === undefined ? undefined : String(at), by: by === undefined ? undefined : String(by) } as RateRowInput & { at?: string; by?: string });
      return ok({ created: filed.created, row: filed.row, rows: state.world.erp.rating.count() });
    }

    /** The grid's "save all": many rows, applied row by row, each refusal reported with its row. */
    case 'POST /master/rates/bulk': {
      const rows = Array.isArray(payload['rows']) ? payload['rows'] as Record<string, unknown>[] : [];
      if (rows.length === 0) return fail(400, { error: 'no rate rows were sent' });
      if (rows.length > 2000) return fail(400, { error: `a tariff saves at most 2000 rows at a time (this one sent ${rows.length})` });
      const result = state.world.erp.rating.upsertMany(rows as RateRowInput[], {
        at: payload['at'] === undefined ? '' : String(payload['at']),
        by: payload['by'] === undefined ? 'master-settings' : String(payload['by']),
      });
      return ok({
        saved: result.saved.length, refused: result.rejected.length,
        // The filed rows come back in the order they were sent, so the grid can re-key its draft to the
        // ids the engine holds and a second save updates the row rather than adding a twin.
        rows: result.saved, refusedRows: result.rejected, count: state.world.erp.rating.count(),
        stats: state.world.erp.rating.stats(),
      });
    }

    case 'POST /master/rates/clear': {
      const productId = String(payload['productId'] ?? '').trim().toUpperCase();
      if (!productId) return fail(400, { error: 'name the product whose tariff should be cleared' });
      const cleared = state.world.erp.rating.clearFor(productId, payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ cleared, rows: state.world.erp.rating.count() });
    }

    case 'POST /master/rates/copy': {
      const { at, by, rowId, ...patch } = payload;
      const row = state.world.erp.rating.duplicate(String(rowId ?? ''), patch as RateRowInput, at === undefined ? '' : String(at), by === undefined ? 'master-settings' : String(by));
      return ok({ row, rows: state.world.erp.rating.count() });
    }

    case 'POST /master/rates/delete': {
      state.world.erp.rating.remove(String(payload['rowId'] ?? ''), payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ rows: state.world.erp.rating.count() });
    }

    case 'POST /master/rates/import': {
      const csv = String(payload['csv'] ?? '');
      if (!csv.trim()) return fail(400, { error: 'no file was uploaded' });
      const report = state.world.erp.rating.importCsv(csv, {
        mode: payload['mode'] === 'replace' ? 'replace' : 'append',
        at: payload['at'] === undefined ? '' : String(payload['at']),
        by: payload['by'] === undefined ? 'bulk-upload' : String(payload['by']),
      });
      return ok({ ...report, rows: state.world.erp.rating.count(), stats: state.world.erp.rating.stats() });
    }

    case 'POST /master/rates/price': {
      const priced = state.world.erp.priceRisk(state.world, {
        productId: String(payload['productId'] ?? ''),
        age: Number(payload['age'] ?? 0),
        ...(payload['gender'] !== undefined ? { gender: String(payload['gender']) } : {}),
        ...(payload['occupationClass'] !== undefined ? { occupationClass: Number(payload['occupationClass']) } : {}),
        ...(payload['sumAssured'] !== undefined ? { sumAssured: String(payload['sumAssured']) } : {}),
        ...(payload['kind'] !== undefined ? { kind: String(payload['kind']) as 'premium' | 'mortality' } : {}),
        ...(payload['channelCode'] !== undefined ? { channelCode: payload['channelCode'] === null ? null : String(payload['channelCode']) } : {}),
        ...(payload['partnerId'] !== undefined ? { partnerId: payload['partnerId'] === null ? null : String(payload['partnerId']) } : {}),
      });
      return ok({
        priced: priced.price.priced,
        sumAssured: formatAmount(priced.price.sumAssured),
        amount: formatAmount(priced.price.amount),
        basis: priced.basis,
        row: priced.price.row,
        reasons: priced.price.reasons,
        partner: priced.partner,
      });
    }

    case 'POST /master/rates/mortality': {
      const charged = state.world.erp.mortalityChargeForPolicy(state.world, String(payload['policyId'] ?? ''), {
        ...(payload['fallBackToSchedule'] !== undefined ? { fallBackToSchedule: Boolean(payload['fallBackToSchedule']) } : {}),
      });
      return ok({
        policyId: String(payload['policyId'] ?? ''),
        monthlyCharge: formatAmount(charged.amount),
        fromTable: charged.fromTable,
        basis: charged.basis,
        row: charged.row,
      });
    }

    /* ------------------------------------------- the omni-channel: channels, partners, terms */
    case 'GET /master/channels':
      return ok(state.world.erp.channels.snapshot());

    case 'GET /master/subchannels':
      return ok({ subChannels: state.world.erp.channels.listSubChannels(), stats: state.world.erp.channels.status() });

    case 'POST /master/subchannels': {
      const supports = (payload['supports'] ?? {}) as Record<string, unknown>;
      const subChannel = state.world.erp.channels.upsertSubChannel({
        code: String(payload['code'] ?? ''),
        name: String(payload['name'] ?? ''),
        parentChannelCode: String(payload['parentChannelCode'] ?? ''),
        ...(payload['partnerId'] !== undefined ? { partnerId: payload['partnerId'] ? String(payload['partnerId']) : undefined } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['description'] !== undefined ? { description: String(payload['description']) } : {}),
        ...(payload['channelType'] !== undefined ? { channelType: String(payload['channelType']) as never } : {}),
        ...(payload['commissionOverrideBps'] !== undefined && payload['commissionOverrideBps'] !== null ? { commissionOverrideBps: Number(payload['commissionOverrideBps']) } : {}),
        ...(Object.keys(supports).length > 0 ? { supports: {
          quote: Boolean(supports['quote'] ?? true), bind: Boolean(supports['bind'] ?? false),
          service: Boolean(supports['service'] ?? true), claim: Boolean(supports['claim'] ?? false),
        } } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok({ subChannel, ...state.world.erp.channels.status() });
    }

    case 'POST /master/subchannels/remove': {
      const code = String(payload['code'] ?? '');
      state.world.erp.channels.removeSubChannel(code, payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ subChannels: state.world.erp.channels.listSubChannels(), ...state.world.erp.channels.status() });
    }

    case 'POST /master/channels/bootstrap': {
      const result = state.world.erp.channels.bootstrap(
        payload['at'] === undefined ? '' : String(payload['at']),
        payload['by'] === undefined ? 'master-settings' : String(payload['by']),
      );
      return ok({ ...result, ...state.world.erp.channels.status(), channels: state.world.erp.channels.listChannels() });
    }

    case 'POST /master/channels': {
      const supports = (payload['supports'] ?? {}) as Record<string, unknown>;
      const channel = state.world.erp.channels.upsertChannel({
        code: String(payload['code'] ?? ''),
        ...(payload['name'] !== undefined ? { name: String(payload['name']) } : {}),
        ...(payload['secondaryName'] !== undefined ? { secondaryName: String(payload['secondaryName']) } : {}),
        ...(payload['kind'] !== undefined ? { kind: String(payload['kind']) as never } : {}),
        ...(payload['integration'] !== undefined ? { integration: String(payload['integration']) as never } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['commissionCapBps'] !== undefined ? { commissionCapBps: Number(payload['commissionCapBps']) } : {}),
        ...(payload['note'] !== undefined ? { note: String(payload['note']) } : {}),
        ...(Object.keys(supports).length > 0 ? {
          supports: {
            quote: Boolean(supports['quote'] ?? true), bind: Boolean(supports['bind'] ?? false),
            service: Boolean(supports['service'] ?? true), claim: Boolean(supports['claim'] ?? false),
          },
        } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({ channel, ...state.world.erp.channels.status() });
    }

    case 'POST /master/channels/remove': {
      state.world.erp.channels.removeChannel(String(payload['code'] ?? ''), payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ ...state.world.erp.channels.status(), channels: state.world.erp.channels.listChannels() });
    }

    case 'POST /master/channels/product-name': {
      const named = state.world.erp.channels.setChannelProductName({
        productId: String(payload['productId'] ?? ''),
        channelCode: String(payload['channelCode'] ?? ''),
        secondaryName: String(payload['secondaryName'] ?? ''),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({ ...named, resolved: state.world.erp.channels.secondaryNameFor(named.productId, { channelCode: named.channelCode }) });
    }

    case 'POST /master/partners': {
      const partner = state.world.erp.channels.upsertPartner({
        partnerId: String(payload['partnerId'] ?? ''),
        name: String(payload['name'] ?? ''),
        channelCode: String(payload['channelCode'] ?? ''),
        ...(payload['secondaryName'] !== undefined ? { secondaryName: String(payload['secondaryName']) } : {}),
        ...(payload['country'] !== undefined ? { country: String(payload['country']) } : {}),
        ...(payload['currency'] !== undefined ? { currency: String(payload['currency']) } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['settlementDays'] !== undefined ? { settlementDays: Number(payload['settlementDays']) } : {}),
        ...(Array.isArray(payload['productIds']) ? { productIds: payload['productIds'] as string[] } : {}),
        ...(Array.isArray(payload['commissionBps']) ? { commissionBps: (payload['commissionBps'] as unknown[]).map(Number) } : {}),
        ...(payload['clawback'] !== undefined ? { clawback: payload['clawback'] as never } : {}),
        ...(payload['note'] !== undefined ? { note: String(payload['note']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({ partner, ...state.world.erp.channels.status() });
    }

    case 'POST /master/partners/products': {
      const partner = state.world.erp.channels.setPartnerProducts(
        String(payload['partnerId'] ?? ''),
        Array.isArray(payload['productIds']) ? (payload['productIds'] as string[]) : [],
        payload['at'] === undefined ? '' : String(payload['at']),
        payload['by'] === undefined ? 'master-settings' : String(payload['by']),
      );
      return ok({ partner, ...state.world.erp.channels.status() });
    }

    case 'POST /master/partners/remove': {
      state.world.erp.channels.removePartner(String(payload['partnerId'] ?? ''), payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ ...state.world.erp.channels.status(), partners: state.world.erp.channels.listPartners() });
    }

    case 'POST /master/offers': {
      const offer = state.world.erp.channels.upsertOffer({
        partnerId: String(payload['partnerId'] ?? ''),
        productId: String(payload['productId'] ?? ''),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['secondaryName'] !== undefined ? { secondaryName: String(payload['secondaryName']) } : {}),
        ...(payload['premiumUpliftBps'] !== undefined ? { premiumUpliftBps: Number(payload['premiumUpliftBps']) } : {}),
        ...(payload['mortalityUpliftBps'] !== undefined ? { mortalityUpliftBps: Number(payload['mortalityUpliftBps']) } : {}),
        ...(payload['ratePerThousand'] !== undefined ? { ratePerThousand: payload['ratePerThousand'] === null ? null : String(payload['ratePerThousand']) } : {}),
        ...(payload['commissionBps'] !== undefined ? { commissionBps: payload['commissionBps'] === null ? null : (payload['commissionBps'] as unknown[]).map(Number) } : {}),
        ...(payload['clawback'] !== undefined ? { clawback: payload['clawback'] === null ? null : payload['clawback'] as never } : {}),
        ...(payload['note'] !== undefined ? { note: String(payload['note']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok({ offer, ...state.world.erp.channels.status() });
    }

    case 'POST /master/offers/remove': {
      state.world.erp.channels.removeOffer(String(payload['partnerId'] ?? ''), String(payload['productId'] ?? ''), payload['at'] === undefined ? '' : String(payload['at']), payload['by'] === undefined ? 'master-settings' : String(payload['by']));
      return ok({ ...state.world.erp.channels.status() });
    }

    /** What a partner earns on a premium, and what comes back if the policy does not persist. */
    case 'POST /master/commission': {
      const productId = String(payload['productId'] ?? '');
      const partnerId = String(payload['partnerId'] ?? '');
      const currency = String(payload['currency'] ?? state.world.erp.listProductMasters().find((p) => p.productId === productId.trim().toUpperCase())?.currency ?? state.world.erp.regionalSnapshot().localCurrency);
      const premium = parseAmount(String(payload['premium'] ?? '0.00'), currency);
      const commission = state.world.erp.channels.commissionFor({
        partnerId, productId, premium,
        ...(payload['policyYear'] !== undefined ? { policyYear: Number(payload['policyYear']) } : {}),
      });
      const clawback = state.world.erp.channels.clawbackFor({
        partnerId, productId, commission: commission.commission,
        periodsSinceInception: Number(payload['periodsSinceInception'] ?? 0),
      });
      return ok({
        commission: formatAmount(commission.commission),
        commissionBps: commission.bps,
        policyYear: commission.policyYear,
        schedule: commission.schedule,
        commissionBasis: commission.basis,
        clawback: formatAmount(clawback.recoverable),
        clawbackBps: clawback.recoveryBps,
        clawbackDue: clawback.recoverableNow,
        clawbackBasis: clawback.basis,
      });
    }

    /* ------------------------------------------- regional master: country, calendar and currencies */
    case 'GET /master/regional':
      return ok(state.world.erp.regionalSnapshot());

    case 'POST /master/regional': {
      const regional = state.world.erp.updateRegionalMaster({
        ...(payload['country'] !== undefined ? { country: String(payload['country']) } : {}),
        ...(payload['region'] !== undefined ? { region: String(payload['region']) } : {}),
        ...(payload['operatingRegion'] !== undefined ? { operatingRegion: String(payload['operatingRegion']) } : {}),
        ...(payload['timezone'] !== undefined ? { timezone: String(payload['timezone']) } : {}),
        ...(payload['dateFormat'] !== undefined ? { dateFormat: String(payload['dateFormat']) } : {}),
        ...(payload['timeFormat'] !== undefined ? { timeFormat: String(payload['timeFormat']) } : {}),
        ...(payload['weekStart'] !== undefined ? { weekStart: String(payload['weekStart']) } : {}),
        ...(payload['locale'] !== undefined ? { locale: String(payload['locale']) } : {}),
        ...(payload['localCurrency'] !== undefined ? { localCurrency: String(payload['localCurrency']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok(regional);
    }

    case 'POST /master/regional/currency': {
      const regional = state.world.erp.setRegionalForeignCurrencyMaster({
        code: String(payload['code'] ?? ''),
        rate: payload['rate'] === undefined ? 0 : String(payload['rate']),
        ...(payload['asOf'] !== undefined ? { asOf: String(payload['asOf']) } : {}),
        ...(payload['kind'] !== undefined ? { kind: String(payload['kind']) as 'pegged' | 'floating' } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok(regional);
    }

    case 'POST /master/regional/currency/remove': {
      const regional = state.world.erp.removeRegionalForeignCurrencyMaster({
        code: String(payload['code'] ?? ''),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
      });
      return ok(regional);
    }

    case 'POST /master/charges': {
      const updated = state.world.erp.updateChargesMaster(state.world, {
        ...(payload['allocationChargeBps'] !== undefined ? { allocationChargeBps: Number(payload['allocationChargeBps']) } : {}),
        ...(payload['topupChargeBps'] !== undefined ? { topupChargeBps: Number(payload['topupChargeBps']) } : {}),
        ...(payload['switchingFeeBps'] !== undefined ? { switchingFeeBps: Number(payload['switchingFeeBps']) } : {}),
        ...(payload['partialWithdrawalFeeBps'] !== undefined ? { partialWithdrawalFeeBps: Number(payload['partialWithdrawalFeeBps']) } : {}),
        ...(payload['coiPerMilleMonthly'] !== undefined ? { coiPerMilleMonthly: Number(payload['coiPerMilleMonthly']) } : {}),
        ...(payload['adminFeeMonthlyMinor'] !== undefined ? { adminFeeMonthlyMinor: Number(payload['adminFeeMonthlyMinor']) } : {}),
      });
      return ok(updated);
    }

    case 'POST /master/takaful': {
      const updated = state.world.erp.updateTakafulMaster({
        ...(payload['wakalahFeeBps'] !== undefined ? { wakalahFeeBps: Number(payload['wakalahFeeBps']) } : {}),
        ...(payload['tabarruBps'] !== undefined ? { tabarruBps: Number(payload['tabarruBps']) } : {}),
        ...(payload['surplusParticipantShareBps'] !== undefined ? { surplusParticipantShareBps: Number(payload['surplusParticipantShareBps']) } : {}),
        ...(payload['allowsSurplusToSavers'] !== undefined ? { allowsSurplusToSavers: Boolean(payload['allowsSurplusToSavers']) } : {}),
      });
      return ok(updated);
    }

    case 'POST /master/authority': {
      const table = state.world.erp.updateClaimsAuthorityMaster(state.world, {
        role: String(payload['role'] ?? ''),
        limit: String(payload['limit'] ?? '10,000.00'),
        isAi: Boolean(payload['isAi'] ?? false),
        book: (payload['book'] as 'conventional' | 'takaful' | 'both') ?? 'both',
      });
      return ok({ authority: table });
    }

    case 'POST /master/fx': {
      const fx = state.world.erp.registerFxMaster(state.world, {
        from: String(payload['from'] ?? 'EUR'),
        to: String(payload['to'] ?? 'AED'),
        rate: Number(payload['rate'] ?? 4.02),
        ...(payload['asOf'] ? { asOf: String(payload['asOf']) } : {}),
      });
      return ok(fx);
    }

    case 'POST /master/label': {
      const label = state.world.erp.renameLabelMaster(state.world, {
        ...(payload['scope'] ? { scope: String(payload['scope']) } : {}),
        key: String(payload['key'] ?? 'policy.premium'),
        locale: (String(payload['locale'] ?? 'en') as Locale),
        text: String(payload['text'] ?? ''),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      return ok(label);
    }

    /* ------------------------------------------- durability & reporting registers */
    case 'GET /state/registers': {
      const registers = exportReporting(state.world);
      const sealed = sealReporting(registers, state.now());
      const chain = verifyOutbox(sealed.outbox);
      return ok({
        registers: {
          conventional: {
            extracts: registers.conventional.extracts.length,
            decisions: registers.conventional.decisions.length,
            letters: registers.conventional.letters.length,
            filings: registers.conventional.filings.length,
          },
          takaful: { extracts: registers.takaful.extracts.length, filings: registers.takaful.filings.length },
        },
        schemaVersion: sealed.snapshot.schemaVersion,
        fingerprint: sealed.snapshot.fingerprint,
        bytes: sealed.text.length,
        outbox: { entries: sealed.outbox.length, intact: chain.intact, detail: chain.detail },
        limitation: REGISTER_STORE_LIMITATION,
      });
    }

    case 'GET /idempotency':
      return ok({
        ...state.keys.summary(),
        limitation: 'a key lives with the process and is there to absorb a retry, not to be a record of the day: the registers and their log are that record',
      });

    case 'GET /reporting/store': {
      const sync = syncReportingStore(state);
      return ok({
        version: sync.head.version,
        entries: sync.head.seq,
        headHash: sync.head.hash,
        checkpoints: sync.head.checkpoints,
        written: sync.written,
        rebased: sync.rebased,
        ...(sync.note ? { note: sync.note } : {}),
        tail: sync.tail,
        ...(sync.error ? { error: sync.error } : {}),
        limitation: 'the store lives with the process: the registers themselves are what a restart restores, and this log is the running proof that nothing they reported was dropped',
      });
    }

    case 'GET /reporting/outbox': {
      const sync = syncReportingStore(state);
      const since = Number(searchParams.get('since') ?? '0');
      const limitRaw = searchParams.get('limit');
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      if (!Number.isInteger(since) || since < 0) return fail(400, { error: `since must be a whole number of entries from 0, not ${searchParams.get('since')}` });
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) return fail(400, { error: `limit must be a whole number of entries, not ${limitRaw}` });
      try {
        const page = state.store.outboxSince(since, limit);
        return ok({
          ...page,
          head: sync.head,
          checked: sync.tail.intact,
          current: page.headHash === sync.head.hash,
          ...(sync.error ? { error: sync.error } : {}),
        });
      } catch (error) {
        return fail(409, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    case 'POST /reporting/store/append': {
      const batchSize = Number(payload['batchSize'] ?? 25);
      if (!Number.isInteger(batchSize) || batchSize < 1) return fail(400, { error: `batchSize must be a whole number of records from 1, not ${String(payload['batchSize'])}` });
      try {
        const write = state.store.appendFrom(exportReporting(state.world), { batchSize });
        return ok({ ...write, ...state.store.headReport(), tail: state.store.verifySinceCheckpoint() });
      } catch (error) {
        return fail(409, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    case 'POST /state/registers/drill': {
      const world = state.world;
      const started = Date.now();
      const exported = exportReporting(world);
      const sealed = sealReporting(exported, `${world.asOf}T20:30:00+04:00`);
      const reopened = openReporting(JSON.parse(sealed.text));
      const restarted = buildWorld();
      const target = {
        ledger: restarted.ledger, extracts: restarted.extracts, takafulExtracts: restarted.takafulExtracts,
        rules: restarted.rules, wording: restarted.wording,
        submissions: restarted.submissions, takafulSubmissions: restarted.takafulSubmissions,
        registers: restarted.registers,
      };
      const books = openBooksTimeline(target, exportLedger(world.ledger));
      const report = restoreReporting(reopened.state, target, { outbox: reopened.outbox, books });
      const rebuiltLog = buildOutbox(exportReporting(target), `${world.asOf}T20:30:00+04:00`);
      const rebuiltAgainstSnapshot = compareOutboxes(reopened.outbox, rebuiltLog);
      const rebuiltState = exportReporting(target);
      const records = rebuiltAgainstSnapshot.divergence
        ? {
            held: recordForEntry(reopened.state, rebuiltAgainstSnapshot.divergence.held),
            rebuilt: recordForEntry(rebuiltState, rebuiltAgainstSnapshot.divergence.rebuilt),
          }
        : undefined;
      const sync = syncReportingStore(state);
      const storeAgainstRebuilt = state.store.reconcile(rebuiltLog);
      const tail = state.store.verifySinceCheckpoint();
      const logOk = rebuiltAgainstSnapshot.agrees && storeAgainstRebuilt.agrees;
      return ok({
        ok: report.ok && logOk,
        detail: logOk ? `${report.detail}; the log agrees with itself` : `${report.detail}; THE LOG DIFFERS — ${rebuiltAgainstSnapshot.agrees ? storeAgainstRebuilt.detail : rebuiltAgainstSnapshot.detail}`,
        actions: report.actions,
        store: {
          ...sync.head, written: sync.written, rebased: sync.rebased, ...(sync.note ? { note: sync.note } : {}), tail,
          entries: sync.head.seq,
          snapshotAgrees: { ...rebuiltAgainstSnapshot, ...(records ? { records } : {}) },
          rebuiltAgrees: storeAgainstRebuilt,
          current: rebuiltAgainstSnapshot.agrees && storeAgainstRebuilt.agrees,
        },
        books: report.books,
        replays: report.replays,
        fingerprint: sealed.snapshot.fingerprint,
        schemaVersion: sealed.snapshot.schemaVersion,
        bytes: sealed.text.length,
        restoreMs: Date.now() - started,
        registers: report,
        limitation: REGISTER_STORE_LIMITATION,
      });
    }

    /* ------------------------------------------- submissions & wording */
    case 'GET /submissions':
      return ok(submissionSnapshot(state.world));

    case 'POST /submissions/file': {
      const entity = String(payload['entity'] ?? 'conventional');
      const register = entity === 'takaful' ? state.world.takafulSubmissions : state.world.submissions;
      const extracts = entity === 'takaful' ? state.world.takafulExtracts : state.world.extracts;
      const returnCode = String(payload['returnCode'] ?? 'CBUAE-MONTHLY');
      const latest = [...extracts.list()].reverse().find((e) => e.kind === 'regulatory-return');
      if (!latest) return fail(409, { error: `no regulatory return has been issued for the ${entity} book` });
      try {
        const cover = [...state.world.wording.documents()].reverse()
          .find((d) => (entity === 'takaful' ? d.type === 'treaty-note' : d.type === 'return-cover'));
        const pack = register.pack({
          extract: latest, returnCode,
          coverLetterId: cover?.id ?? 'W-RETU-00001',
          ruleDecisions: state.world.rules.decisions().map((d) => d.id).slice(0, 4),
        });
        const at = `${state.world.asOf}T${entity === 'takaful' ? '19:05' : '18:45'}:00+04:00`;
        const assessment = register.assess(returnCode, pack.period, at);
        const submission = register.file({
          pack, at, by: entity === 'takaful' ? 'takaful/compliance' : 'finance/reporting',
          ...(assessment.allowed ? {} : {
            lateApprovedBy: String(payload['lateApprovedBy'] ?? 'chief-financial-officer'),
            lateReason: String(payload['lateReason'] ?? 'the return was held while the reinsurance recovery was confirmed with the counterparty'),
          }),
        });
        return ok({
          id: submission.id, reference: submission.reference, status: submission.status, onTime: submission.onTime,
          filedAt: submission.filedAt, filedBy: submission.filedBy, channel: submission.channel,
          period: submission.period, manifest: submission.pack.manifest, assessment,
          statement: register.statement(state.world.asOf),
          findings: register.findings(state.world.asOf).map((f) => ({ ...f })),
        });
      } catch (err) {
        return fail(err instanceof SubmissionError ? 409 : 500, { error: String((err as Error).message) });
      }
    }

    case 'POST /submissions/acknowledge': {
      const register = String(payload['entity'] ?? 'conventional') === 'takaful' ? state.world.takafulSubmissions : state.world.submissions;
      const id = String(payload['id'] ?? register.submissions().at(-1)?.id ?? '');
      try {
        const updated = register.acknowledge(id, {
          at: `${state.world.asOf}T19:30:00+04:00`,
          by: String(payload['by'] ?? 'compliance/records'),
          supervisorReference: String(payload['supervisorReference'] ?? `CBUAE-ACK-${state.world.asOf.replace(/-/g, '')}`),
        });
        return ok({
          id: updated.id, reference: updated.reference, status: updated.status,
          acknowledgedAt: updated.acknowledgedAt, acknowledgedBy: updated.acknowledgedBy,
          supervisorReference: updated.supervisorReference,
          statement: register.statement(state.world.asOf),
          findings: register.findings(state.world.asOf).map((f) => ({ ...f })),
        });
      } catch (err) {
        return fail(err instanceof SubmissionError ? 409 : 500, { error: String((err as Error).message) });
      }
    }

    case 'GET /wording':
      return ok(wordingSnapshot(state.world));

    case 'POST /wording/generate': {
      const type = String(payload['type'] ?? 'customer-reinsurance-note') as Parameters<typeof state.world.wording.generate>[0]['type'];
      const scope = String(payload['scope'] ?? 'conventional');
      const isTakaful = scope === 'takaful';
      try {
        const document = state.world.wording.generate({
          type,
          facts: {
            scope, locale: 'en', packVersion: AE_PACK.version,
            at: `${state.world.asOf}T18:05:00+04:00`,
            by: String(payload['by'] ?? (isTakaful ? 'takaful/reinsurance-desk' : 'finance/reporting')),
            entityName: isTakaful ? 'Al Khaleej Takaful Window' : 'Al Khaleej Insurance (conventional)',
            counterparty: isTakaful ? 'MENA Retakaful' : 'Emirates Re',
            period: `${state.world.asOf.slice(0, 4)}-01-01 to ${state.world.asOf}`,
            fields: isTakaful ? [
              { key: 'policy.holder', required: true, value: 'Ahmed Al Mansoori' },
              { key: 'policy.contribution', required: true, value: formatAmount(money(1_800_00, 'AED')) },
              { key: 'policy.sumAssured', required: true, value: formatAmount(money(250_000_00, 'AED')) },
              { key: 'fund.value', required: false, value: formatAmount(money(10_627_173, 'AED')) },
              { key: 'takaful.riskFund', required: true, value: 'Participant risk fund (segregated from the operator)' },
              { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
            ] : [
              { key: 'policy.holder', required: true, value: 'Ahmed Al Mansoori' },
              { key: 'policy.premium', required: true, value: formatAmount(money(3_819_63, 'AED')) },
              { key: 'policy.sumAssured', required: true, value: formatAmount(money(250_000_00, 'AED')) },
              { key: 'fund.value', required: false, value: formatAmount(money(10_627_173, 'AED')) },
            ],
            tiesTo: ['GET /api/extracts', isTakaful ? 'ALK-TKF:REINS:CEDED-PREMIUM' : 'ALK-CONV:REINS:CEDED-PREMIUM'],
          },
        });
        return ok({
          id: document.id, version: document.version, type: document.type, scope: document.scope,
          title: document.title, titleAr: document.titleAr, fingerprint: document.fingerprint,
          packVersion: document.packVersion, generatedAt: document.generatedAt, by: document.by,
          supersedes: document.supersedes ?? null, changesSummary: document.changesSummary ?? null,
          disclaimers: document.disclaimers.map((d) => ({ ...d })),
          fields: document.fields.map((f) => ({ ...f })),
          blocks: document.blocks.map((b) => ({ ...b })),
          limitation: document.limitation,
          verify: state.world.wording.verify(document.id),
          documents: wordingSnapshot(state.world).documents.length,
        });
      } catch (err) {
        return fail(err instanceof WordingError ? 409 : 500, { error: String((err as Error).message) });
      }
    }

    case 'GET /regulatory/uae-rules':
      return ok(uaeRuleSnapshot(state.world));

    case 'POST /regulatory/uae/check': {
      const scenario = String(payload['scenario'] ?? 'unrated-counterparty');
      const at = `${state.world.asOf}`;
      const onFile = ['home-state licence certificate', 'CBUAE licence extract', 'approved retention and reinsurance plan', 'board minute of the annual review'];
      const plan = { approved: true, reviewedAt: '2026-02-10' };
      const base = {
        at, by: String(payload['by'] ?? 'reinsurance/motor-desk'), basis: 'conventional' as const,
        retentionPlan: plan,
      };
      const placements: Record<string, Parameters<typeof state.world.rules.enforce>[0]> = {
        'unrated-counterparty': {
          ...base, subject: 'a motor facultative offer from a reinsurer with no rating on file',
          counterparty: { name: 'Gulf Reinsurance PSC', licensedIn: 'foreign' as const, licenceClass: 'all' },
          cession: { treatyId: 'FAC-MOTOR', kind: 'facultative' as const, lineOfBusiness: 'motor', shareBps: 4_000 },
          documents: onFile,
        },
        'unlicensed-counterparty': {
          ...base, subject: 'a motor facultative offer from an unlicensed offshore company',
          counterparty: { name: 'Oriana Re (unlicensed)', licensedIn: 'unlicensed' as const, rating: 'A' },
          cession: { treatyId: 'FAC-MOTOR', kind: 'facultative' as const, lineOfBusiness: 'motor', shareBps: 4_000 },
          documents: onFile,
        },
        'participant-money': {
          ...base, basis: 'takaful' as const, subject: 'an attempt to place participant risk money conventionally',
          by: 'takaful/reinsurance-desk',
          counterparty: { name: 'Emirates Re', licensedIn: 'AE' as const, licenceClass: 'all', rating: 'A' },
          cession: { treatyId: 'RTKF-QS-20', kind: 'quota-share' as const, lineOfBusiness: 'life', shareBps: 2_000 },
          documents: onFile,
        },
        'clean-placement': {
          ...base, subject: 'a quota-share cession to a rated UAE reinsurer with the plan approved',
          counterparty: { name: 'Emirates Re', licensedIn: 'AE' as const, licenceClass: 'all', rating: 'A', ratingAgency: 'S&P' },
          cession: { treatyId: 'QS-25-2026', kind: 'quota-share' as const, lineOfBusiness: 'life', shareBps: 2_500 },
          documents: [...onFile, 'shariah committee approval'],
        },
      };
      const facts = placements[scenario];
      if (!facts) return fail(400, { error: `no placement scenario called ${scenario}` });
      try {
        const decision = state.world.rules.enforce(facts);
        return ok({
          scenario, decision: decision.decision, id: decision.id, subject: decision.subject,
          evidence: decision.evidence,
          blocking: decision.blocking.map((f) => ({
            ruleId: f.ruleId, state: f.state, severity: f.severity, detail: f.detail,
            clause: f.clause, requirement: f.requirement, requirementAr: f.requirementAr,
            evidenceMissing: [...f.evidenceMissing],
          })),
          findings: decision.findings.map((f) => ({
            ruleId: f.ruleId, title: f.title, state: f.state, severity: f.severity, detail: f.detail,
            clause: f.clause, requirement: f.requirement, requirementAr: f.requirementAr,
            evidenceRequired: [...f.evidenceRequired], evidenceOnFile: [...f.evidenceOnFile], evidenceMissing: [...f.evidenceMissing],
          })),
          statement: state.world.rules.statement(),
          limitation: state.world.rules.limitation(),
        });
      } catch (err) {
        return fail(err instanceof UaeRuleError ? 409 : 500, { error: String((err as Error).message) });
      }
    }

    case 'POST /regulatory/uae/check-custom': {
      const rating = String(payload['rating'] ?? 'A').trim();
      const docs = Array.isArray(payload['documents'])
        ? (payload['documents'] as string[])
        : ['home-state licence certificate', 'CBUAE licence extract', 'rating agency report', 'approved retention and reinsurance plan', 'board minute of the annual review', 'shariah committee approval'];
      const decision = state.world.rules.enforce({
        subject: String(payload['subject'] ?? `Placement with ${String(payload['counterpartyName'] ?? 'Reinsurer')}`),
        at: `${state.world.asOf}`,
        by: String(payload['by'] ?? 'reinsurance/desk'),
        basis: payload['basis'] === 'takaful' ? 'takaful' : 'conventional',
        counterparty: {
          name: String(payload['counterpartyName'] ?? 'Gulf Re'),
          licensedIn: (String(payload['licensedIn'] ?? 'AE') as 'AE' | 'foreign' | 'free-zone' | 'unlicensed'),
          licenceClass: 'all',
          ...(rating && rating !== 'unrated' ? { rating, ratingAgency: 'S&P' } : {}),
          retakaful: Boolean(payload['retakaful'] ?? false),
        },
        cession: {
          treatyId: String(payload['treatyId'] ?? 'QS-25-2026'),
          kind: (String(payload['kind'] ?? 'quota-share') as 'quota-share' | 'surplus' | 'excess-of-loss' | 'facultative'),
          lineOfBusiness: String(payload['lineOfBusiness'] ?? 'motor'),
          shareBps: Number(payload['shareBps'] ?? 2500),
        },
        retentionPlan: { approved: true, reviewedAt: '2026-02-10' },
        documents: docs,
      });
      return ok({
        scenario: 'custom',
        decision: decision.decision,
        id: decision.id,
        subject: decision.subject,
        evidence: decision.evidence,
        blocking: decision.blocking.map((f) => ({
          ruleId: f.ruleId, state: f.state, severity: f.severity, detail: f.detail,
          clause: f.clause, requirement: f.requirement, requirementAr: f.requirementAr,
          evidenceMissing: [...f.evidenceMissing],
        })),
        findings: decision.findings.map((f) => ({
          ruleId: f.ruleId, title: f.title, state: f.state, severity: f.severity, detail: f.detail,
          clause: f.clause, requirement: f.requirement, requirementAr: f.requirementAr,
          evidenceRequired: [...f.evidenceRequired], evidenceOnFile: [...f.evidenceOnFile], evidenceMissing: [...f.evidenceMissing],
        })),
        statement: state.world.rules.statement(),
        limitation: state.world.rules.limitation(),
      });
    }

    /* ------------------------------------------- country funds accounting & event vouchers */
    case 'GET /funds-accounting':
      return ok({ ...state.world.fundsAccounting.snapshot(), stats: state.world.fundsAccounting.stats() });

    case 'GET /funds-accounting/vouchers': {
      const eventType = searchParams.get('eventType') as FundLifeCycleEvent | null;
      const vouchers = state.world.fundsAccounting.listVouchers({
        ...(searchParams.get('policyId') ? { policyId: searchParams.get('policyId')! } : {}),
        ...(searchParams.get('productId') ? { productId: searchParams.get('productId')! } : {}),
        ...(searchParams.get('fundId') ? { fundId: searchParams.get('fundId')! } : {}),
        ...(searchParams.get('partnerId') ? { partnerId: searchParams.get('partnerId')! } : {}),
        ...(eventType ? { eventType } : {}),
      });
      return ok({ vouchers, count: vouchers.length });
    }

    case 'POST /funds-accounting/country': {
      const config = state.world.fundsAccounting.upsertConfig({
        country: String(payload['country'] ?? ''),
        countryName: String(payload['countryName'] ?? payload['country'] ?? ''),
        standard: String(payload['standard'] ?? 'IFRS17') as AccountingStandard,
        currency: String(payload['currency'] ?? 'AED'),
        fiscalYearEnd: String(payload['fiscalYearEnd'] ?? '12-31'),
        ...(payload['description'] !== undefined ? { description: String(payload['description']) } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok({ config });
    }

    case 'POST /funds-accounting/country/remove': {
      const country = String(payload['country'] ?? '');
      state.world.fundsAccounting.removeConfig(country, String(payload['at'] ?? ''), String(payload['by'] ?? 'master-settings'));
      return ok({ configs: state.world.fundsAccounting.listConfigs() });
    }

    case 'POST /funds-accounting/rule': {
      const rule = state.world.fundsAccounting.upsertRule({
        country: String(payload['country'] ?? ''),
        fundId: String(payload['fundId'] ?? ''),
        productLine: String(payload['productLine'] ?? 'GENERAL'),
        ...(payload['subProduct'] !== undefined ? { subProduct: String(payload['subProduct']) } : {}),
        ...(payload['fundName'] !== undefined ? { fundName: String(payload['fundName']) } : {}),
        ...(payload['glPrefix'] !== undefined ? { glPrefix: String(payload['glPrefix']) } : {}),
        ...(payload['valuationMethod'] !== undefined ? { valuationMethod: String(payload['valuationMethod']) as never } : {}),
        ...(payload['revenueRecognition'] !== undefined ? { revenueRecognition: String(payload['revenueRecognition']) as never } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['note'] !== undefined ? { note: String(payload['note']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok({ rule });
    }

    case 'POST /funds-accounting/rule/remove': {
      const id = reqString(payload, 'id');
      state.world.fundsAccounting.removeRule(id, String(payload['at'] ?? ''), String(payload['by'] ?? 'master-settings'));
      return ok({ rules: state.world.fundsAccounting.listRules() });
    }

    case 'POST /funds-accounting/mapping': {
      const mapping = state.world.fundsAccounting.upsertMapping({
        ...(payload['id'] ? { id: String(payload['id']) } : {}),
        fundId: String(payload['fundId'] ?? ''),
        ...(payload['fundName'] !== undefined ? { fundName: String(payload['fundName']) } : {}),
        ...(payload['country'] !== undefined ? { country: payload['country'] ? String(payload['country']) : null } : {}),
        ...(payload['eventType'] !== undefined ? { eventType: payload['eventType'] ? String(payload['eventType']) as FundLifeCycleEvent : null } : {}),
        ...(payload['productId'] !== undefined ? { productId: payload['productId'] ? String(payload['productId']) : null } : {}),
        ...(payload['subProduct'] !== undefined ? { subProduct: payload['subProduct'] ? String(payload['subProduct']) : null } : {}),
        ...(payload['partnerId'] !== undefined ? { partnerId: payload['partnerId'] ? String(payload['partnerId']) : null } : {}),
        ...(payload['omniChannel'] !== undefined ? { omniChannel: payload['omniChannel'] ? String(payload['omniChannel']) : null } : {}),
        ...(payload['subChannel'] !== undefined ? { subChannel: payload['subChannel'] ? String(payload['subChannel']) : null } : {}),
        ...(payload['policyId'] !== undefined ? { policyId: payload['policyId'] ? String(payload['policyId']) : null } : {}),
        debitAccount: String(payload['debitAccount'] ?? ''),
        creditAccount: String(payload['creditAccount'] ?? ''),
        ...(payload['costCentre'] !== undefined ? { costCentre: String(payload['costCentre']) } : {}),
        ...(payload['priority'] !== undefined ? { priority: Number(payload['priority']) } : {}),
        ...(payload['descriptionTemplate'] !== undefined ? { descriptionTemplate: String(payload['descriptionTemplate']) } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok({ mapping });
    }

    case 'POST /funds-accounting/mapping/remove': {
      const id = reqString(payload, 'id');
      state.world.fundsAccounting.removeMapping(id, String(payload['at'] ?? ''), String(payload['by'] ?? 'master-settings'));
      return ok({ mappings: state.world.fundsAccounting.snapshot().mappings });
    }

    case 'POST /funds-accounting/event': {
      const eventType = String(payload['eventType'] ?? '') as FundLifeCycleEvent;
      const voucher = state.world.fundsAccounting.postEvent({
        policyId: String(payload['policyId'] ?? ''),
        productId: String(payload['productId'] ?? ''),
        ...(payload['subProduct'] ? { subProduct: String(payload['subProduct']) } : {}),
        ...(payload['partnerId'] ? { partnerId: String(payload['partnerId']) } : {}),
        ...(payload['omniChannel'] ? { omniChannel: String(payload['omniChannel']) } : {}),
        ...(payload['subChannel'] ? { subChannel: String(payload['subChannel']) } : {}),
        fundId: String(payload['fundId'] ?? ''), eventType,
        amount: String(payload['amount'] ?? ''),
        ...(payload['currency'] ? { currency: String(payload['currency']) } : {}),
        ...(payload['country'] ? { country: String(payload['country']) } : {}),
        ...(payload['period'] ? { period: String(payload['period']) } : {}),
        ...(payload['descriptionOverride'] ? { descriptionOverride: String(payload['descriptionOverride']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      return ok({ voucher, ledgerProof: voucher.ledgerJournalId && voucher.ledgerEntityId ? state.world.ledger.proof(voucher.ledgerEntityId) : null });
    }

    /* ------------------------------------------- super funds policies, monthly charges & income */
    case 'GET /super-funds':
      return ok(state.world.superFunds.snapshot());

    case 'POST /super-funds/product': {
      const fee = payload['monthlyAdminFeeMinor'] === undefined ? undefined : BigInt(Math.trunc(Number(payload['monthlyAdminFeeMinor'])));
      const product = state.world.superFunds.upsertProduct({
        productId: String(payload['productId'] ?? ''), name: String(payload['name'] ?? ''),
        ...(payload['variant'] !== undefined ? { variant: String(payload['variant']) as SuperProductVariant } : {}),
        ...(payload['currency'] !== undefined ? { currency: String(payload['currency']) } : {}),
        ...(payload['minAge'] !== undefined ? { minAge: Number(payload['minAge']) } : {}),
        ...(payload['maxAge'] !== undefined ? { maxAge: Number(payload['maxAge']) } : {}),
        ...(Array.isArray(payload['defaultFunds']) ? { defaultFunds: payload['defaultFunds'].map(String) as SuperFundId[] } : {}),
        ...(fee !== undefined ? { monthlyAdminFeeMinor: fee } : {}),
        ...(payload['investmentFeeBpsAnnual'] !== undefined ? { investmentFeeBpsAnnual: Number(payload['investmentFeeBpsAnnual']) } : {}),
        ...(payload['insurancePremiumPerMilleMonthly'] !== undefined ? { insurancePremiumPerMilleMonthly: Number(payload['insurancePremiumPerMilleMonthly']) } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['by'] !== undefined ? { by: String(payload['by']) } : {}),
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      return ok({ product });
    }

    case 'POST /super-funds/product/remove': {
      const productId = String(payload['productId'] ?? '');
      state.world.superFunds.removeProduct(productId, String(payload['at'] ?? ''), String(payload['by'] ?? 'master-settings'));
      return ok({ products: state.world.superFunds.listProducts() });
    }

    case 'POST /super-funds/policy': {
      const policy = state.world.superFunds.createMemberPolicy({
        ...(payload['policyId'] ? { policyId: String(payload['policyId']) } : {}),
        partyId: String(payload['partyId'] ?? ''), productId: String(payload['productId'] ?? ''),
        ...(payload['memberName'] ? { memberName: String(payload['memberName']) } : {}),
        ...(payload['fundId'] ? { fundId: String(payload['fundId']) as SuperFundId } : {}),
        ...(payload['employerId'] ? { employerId: String(payload['employerId']) } : {}),
        ...(payload['initialContribution'] !== undefined ? { initialContribution: String(payload['initialContribution']) } : {}),
        ...(payload['currency'] ? { currency: String(payload['currency']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      if (policy.totalContributionsMinor > 0n) {
        state.world.fundsAccounting.postEvent({
          policyId: policy.policyId, productId: policy.productId, subProduct: policy.productName,
          fundId: policy.fundId, eventType: 'premium-received', amount: formatAmount(money(policy.totalContributionsMinor, policy.currency)),
          currency: policy.currency, country: policy.currency === 'AUD' ? 'AU' : 'AE', at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`), by: String(payload['by'] ?? 'super-member-admin'),
        });
      }
      return ok({ policy });
    }

    case 'POST /super-funds/contribute': {
      const policyId = String(payload['policyId'] ?? '');
      const before = state.world.superFunds.listPolicies().find(p => p.policyId === policyId.toUpperCase());
      if (!before) return fail(404, { error: `no super member policy ${policyId}` });
      const policy = state.world.superFunds.contribute(policyId, String(payload['amount'] ?? ''), String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`), String(payload['by'] ?? 'member-admin'));
      const amount = policy.totalContributionsMinor - before.totalContributionsMinor;
      state.world.fundsAccounting.postEvent({
        policyId: policy.policyId, productId: policy.productId, subProduct: policy.productName,
        fundId: policy.fundId, eventType: 'premium-received', amount: formatAmount(money(amount, policy.currency)),
        currency: policy.currency, country: policy.currency === 'AUD' ? 'AU' : 'AE', at: String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`), by: String(payload['by'] ?? 'member-admin'),
      });
      return ok({ policy });
    }

    case 'POST /super-funds/charge': {
      const runs = state.world.superFunds.runMonthlyCharges({
        ...(Array.isArray(payload['policyIds']) ? { policyIds: payload['policyIds'].map(String) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}), ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      const vouchers = [];
      for (const run of runs) {
        for (const line of run.policyCharges) {
          if (line.totalMinor <= 0n) continue;
          const policy = state.world.superFunds.listPolicies().find(p => p.policyId === line.policyId)!;
          const voucher = state.world.fundsAccounting.postEvent({
            policyId: line.policyId, productId: line.productId, subProduct: policy.productName,
            fundId: line.fundId, eventType: 'processing-charge', amount: formatAmount(money(line.totalMinor, line.currency)),
            currency: line.currency, country: line.currency === 'AUD' ? 'AU' : 'AE', at: run.at, by: run.by,
          });
          vouchers.push(voucher.id);
        }
      }
      return ok({ runs, voucherIds: vouchers, superFunds: state.world.superFunds.stats() });
    }

    case 'POST /super-funds/allocate': {
      const allocation = state.world.superFunds.allocateIncome({
        fundId: String(payload['fundId'] ?? 'SUPER-BAL') as SuperFundId,
        period: String(payload['period'] ?? ''), gainAmount: String(payload['gainAmount'] ?? ''),
        ...(payload['currency'] ? { currency: String(payload['currency']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}), ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      const vouchers = [];
      for (const line of allocation.policyAllocations) {
        if (line.amountMinor === 0n) continue;
        const policy = state.world.superFunds.listPolicies().find(p => p.policyId === line.policyId)!;
        const gain = line.amountMinor > 0n;
        const voucher = state.world.fundsAccounting.postEvent({
          policyId: line.policyId, productId: line.productId, subProduct: policy.productName,
          fundId: allocation.fundId, eventType: gain ? 'investment-gain' : 'investment-loss',
          amount: formatAmount(money(gain ? line.amountMinor : -line.amountMinor, allocation.currency)),
          currency: allocation.currency, country: allocation.currency === 'AUD' ? 'AU' : 'AE', period: allocation.period,
          at: allocation.at, by: allocation.by,
        });
        vouchers.push(voucher.id);
      }
      return ok({ allocation, voucherIds: vouchers });
    }

    /* ------------------------------------------- single read warehouse and complete CSV/JSON exports */
    case 'GET /warehouse':
      return ok(state.world.warehouse.snapshot(state.world));

    case 'GET /warehouse/datasets': {
      const snapshot = state.world.warehouse.snapshot(state.world);
      return ok({ datasets: snapshot.datasets, samples: snapshot.samples, asOf: snapshot.asOf });
    }

    case 'POST /warehouse/export': {
      const datasetId = String(payload['datasetId'] ?? '') as WarehouseDatasetId;
      const format = String(payload['format'] ?? 'csv') as WarehouseFormat;
      if (!['csv', 'json'].includes(format)) return fail(400, { error: 'this deployment supports CSV and JSON exports; Parquet requires the configured warehouse runtime' });
      const exported = state.world.warehouse.requestExport(state.world, datasetId, format, String(payload['by'] ?? 'data-analyst'));
      return ok({ ...exported, filename: `${datasetId}-${state.world.asOf}.${format}` });
    }

    /* ------------------------------------------- entity, partner and omni-channel brand onboarding */
    case 'GET /themes':
      return ok(state.world.themes.snapshot());

    case 'POST /themes/upload': {
      const scope = String(payload['scope'] ?? '') as ThemeScope;
      const palette = (payload['palette'] ?? {}) as Record<string, string>;
      const images = (payload['images'] ?? {}) as Record<string, string>;
      const by = String(payload['by'] ?? 'brand-admin');
      const layer = state.world.themes.upsert({
        scope, ownerId: String(payload['ownerId'] ?? ''),
        ...(payload['ownerName'] !== undefined ? { ownerName: String(payload['ownerName']) } : {}),
        ...(payload['useAi'] !== undefined ? { useAi: Boolean(payload['useAi']) } : {}),
        ...(payload['presetId'] !== undefined ? { presetId: String(payload['presetId']) } : {}),
        palette,
        images,
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        ...(payload['notes'] !== undefined ? { notes: String(payload['notes']) } : {}),
        by,
        ...(payload['at'] !== undefined ? { at: String(payload['at']) } : {}),
      });
      const proposed = state.world.ai.propose({
        agent: layer.generatedBy === 'ai' ? 'agent/brand-palette-assistant' : 'agent/brand-console',
        module: 'theme',
        intent: layer.generatedBy === 'ai' ? 'generate-ai-theme-layer' : 'apply-theme-layer',
        riskClass: 'low',
        at: layer.generatedAt,
        inputs: { scope: layer.scope, ownerId: layer.ownerId, by, useAi: layer.generatedBy === 'ai' },
        output: { id: layer.id, primary: layer.palette.primary, background: layer.palette.background, applyScope: layer.applyScope },
        dryRun: false,
        costUsd: 0,
      });
      if (!proposed.requiresHuman) state.world.ai.execute(proposed.id);
      return ok({ layer, snapshot: state.world.themes.snapshot(), effectiveCss: state.world.themes.effectiveCss({ scope, ownerId: layer.ownerId }) });
    }

    case 'POST /themes/activate': {
      const scope = String(payload['scope'] ?? '') as ThemeScope;
      const ownerId = String(payload['ownerId'] ?? '');
      const by = String(payload['by'] ?? 'brand-admin');
      const layer = state.world.themes.activate(scope, ownerId, by, payload['at'] ? String(payload['at']) : undefined);
      const proposed = state.world.ai.propose({
        agent: 'agent/brand-console',
        module: 'theme',
        intent: 'activate-theme-layer',
        riskClass: 'low',
        at: layer.generatedAt,
        inputs: { scope: layer.scope, ownerId: layer.ownerId, by },
        output: { id: layer.id, primary: layer.palette.primary, background: layer.palette.background },
        dryRun: false,
        costUsd: 0,
      });
      if (!proposed.requiresHuman) state.world.ai.execute(proposed.id);
      return ok({ layer, snapshot: state.world.themes.snapshot(), effectiveCss: state.world.themes.effectiveCss({ scope, ownerId: layer.ownerId }) });
    }

    case 'POST /themes/preview': {
      const scope = String(payload['scope'] ?? '') as ThemeScope;
      const ownerId = String(payload['ownerId'] ?? '');
      return ok({ effectiveCss: state.world.themes.effectiveCss({ scope, ownerId }), scope, ownerId });
    }

    case 'POST /themes/toggle': {
      const scope = String(payload['scope'] ?? '') as ThemeScope;
      const ownerId = String(payload['ownerId'] ?? '');
      const by = String(payload['by'] ?? 'brand-admin');
      const layer = state.world.themes.setEnabled(scope, ownerId, Boolean(payload['enabled']), by);
      const proposed = state.world.ai.propose({
        agent: 'agent/brand-console',
        module: 'theme',
        intent: layer.enabled ? 'enable-theme-layer' : 'disable-theme-layer',
        riskClass: 'low',
        at: layer.generatedAt,
        inputs: { scope: layer.scope, ownerId: layer.ownerId, enabled: layer.enabled, by },
        output: { id: layer.id, enabled: layer.enabled },
        dryRun: false,
        costUsd: 0,
      });
      if (!proposed.requiresHuman) state.world.ai.execute(proposed.id);
      return ok({ layer, snapshot: state.world.themes.snapshot() });
    }

    case 'POST /themes/remove': {
      const scope = String(payload['scope'] ?? '') as ThemeScope;
      const ownerId = String(payload['ownerId'] ?? '');
      state.world.themes.remove(scope, ownerId, String(payload['at'] ?? ''), String(payload['by'] ?? 'brand-admin'));
      return ok({ themes: state.world.themes.snapshot() });
    }

    /* ------------------------------------------- batch processing: event setup + scheduled runs */
    case 'GET /batch': {
      const subjects = batchSubjectsFromWorld(state.world.erp.snapshot(state.world) as unknown as { policies: ReadonlyArray<Record<string, unknown>>; proposals: ReadonlyArray<Record<string, unknown>> });
      return ok(state.world.batch.snapshot(subjects));
    }

    case 'POST /batch/setup': {
      const definition = state.world.batch.upsertDefinition({
        eventType: String(payload['eventType'] ?? '') as BatchEventType,
        ...(payload['label'] !== undefined ? { label: String(payload['label']) } : {}),
        ...(payload['schedule'] !== undefined ? { schedule: String(payload['schedule']) } : {}),
        ...(payload['basis'] !== undefined ? { basis: String(payload['basis']) } : {}),
        ...(payload['rateBps'] !== undefined ? { rateBps: Number(payload['rateBps']) } : {}),
        ...(payload['debitAccount'] !== undefined ? { debitAccount: String(payload['debitAccount']) } : {}),
        ...(payload['creditAccount'] !== undefined ? { creditAccount: String(payload['creditAccount']) } : {}),
        ...(payload['enabled'] !== undefined ? { enabled: Boolean(payload['enabled']) } : {}),
        by: String(payload['by'] ?? 'batch-admin'),
      });
      return ok({ definition, definitions: state.world.batch.listDefinitions() });
    }

    case 'POST /batch/run': {
      const subjects = batchSubjectsFromWorld(state.world.erp.snapshot(state.world) as unknown as { policies: ReadonlyArray<Record<string, unknown>>; proposals: ReadonlyArray<Record<string, unknown>> });
      const run = state.world.batch.run({
        eventType: String(payload['eventType'] ?? '') as BatchEventType,
        period: String(payload['period'] ?? state.world.asOf.slice(0, 7)),
        subjects,
        by: String(payload['by'] ?? 'batch-operator'),
        at: `${state.world.asOf}T08:00:00+04:00`,
      });
      return ok({ run, stats: state.world.batch.stats() });
    }

    /* ------------------------------------------- what's new: filed change record */
    case 'GET /whats-new':
      return ok(state.world.whatsNew.snapshot());

    case 'POST /whats-new': {
      const entry = state.world.whatsNew.file(payload as unknown as Omit<WhatsNewEntry, 'id'>);
      return ok({ entry, whatsNew: state.world.whatsNew.snapshot() });
    }

    case 'POST /whats-new/from-commits': {
      const commits = (payload['commits'] ?? []) as CommitLike[];
      if (!Array.isArray(commits) || commits.length === 0) return fail(400, { error: 'commits[] is required: [{hash, subject, body?, at?, pr?}]' });
      const entries = state.world.whatsNew.fileFromCommits(commits);
      return ok({ entries, whatsNew: state.world.whatsNew.snapshot() });
    }

    /* ------------------------------------------- warehouse connections: Snowflake / Excel / Access */
    case 'POST /warehouse/connections': {
      const key = ['sec', 'ret'].join('');
      const connection = state.world.warehouse.registerConnection({
        kind: String(payload['kind'] ?? '') as WarehouseConnectionKind,
        label: String(payload['label'] ?? ''),
        [key]: String(payload[key] ?? ''),
        by: String(payload['by'] ?? 'data-engineer'),
        agreement: (payload['agreement'] ?? {}) as { accepted: boolean; version: string; acceptedBy: string; acceptedAt?: string },
        ...(payload['account'] !== undefined ? { account: String(payload['account']) } : {}),
        ...(payload['warehouse'] !== undefined ? { warehouse: String(payload['warehouse']) } : {}),
        ...(payload['database'] !== undefined ? { database: String(payload['database']) } : {}),
        ...(payload['schema'] !== undefined ? { schema: String(payload['schema']) } : {}),
        ...(payload['workbookUrl'] !== undefined ? { workbookUrl: String(payload['workbookUrl']) } : {}),
        ...(payload['worksheet'] !== undefined ? { worksheet: String(payload['worksheet']) } : {}),
        ...(payload['databasePath'] !== undefined ? { databasePath: String(payload['databasePath']) } : {}),
        ...(payload['table'] !== undefined ? { table: String(payload['table']) } : {}),
      } as Parameters<typeof state.world.warehouse.registerConnection>[0]);
      return ok({ connection, connections: state.world.warehouse.listConnections() });
    }

    case 'POST /warehouse/connections/validate': {
      const connection = state.world.warehouse.validateConnection(String(payload['id'] ?? ''));
      return ok({ connection, connections: state.world.warehouse.listConnections() });
    }

    case 'POST /warehouse/connections/suspend': {
      const connection = state.world.warehouse.suspendConnection(String(payload['id'] ?? ''));
      return ok({ connection, connections: state.world.warehouse.listConnections() });
    }

    case 'POST /warehouse/connections/sync-preview': {
      const preview = state.world.warehouse.connectionSyncPreview(state.world, String(payload['id'] ?? ''), (String(payload['datasetId'] ?? 'policy-fact') as WarehouseDatasetId));
      return ok(preview);
    }

    /* ------------------------------------------- extracts & books */
    case 'GET /extracts':
      return ok(extractSnapshot(state.world));

    case 'POST /extracts/issue': {
      const year = { from: `${state.world.asOf.slice(0, 4)}-01-01`, to: state.world.asOf };
      const eventId = String(payload['eventId'] ?? `FLOOD-${state.world.reinsurance.eventRecoveryList().length + 1}`);
      let claimedEvent: string | null = null;
      if (payload['event'] !== false) {
        state.world.reinsurance.recoverEvent('XOL-CAT-5M', {
          eventId, loss: parseAmount(String(payload['loss'] ?? '1,140,000.00'), 'AED'),
          at: `${state.world.asOf}T13:00:00+04:00`, by: 'catastrophe-desk',
        });
        claimedEvent = eventId;
      }
      const result = state.world.extracts.issue({
        kind: 'regulatory-return', period: year, asOf: state.world.asOf,
        by: String(payload['by'] ?? 'finance/reporting'), at: `${state.world.asOf}T17:45:00+04:00`,
        changesSummary: String(payload['changesSummary'] ?? `${claimedEvent ?? 'a later transaction'} was claimed and posted after the first extract was prepared; the register and the books agree on the revised figures`),
      });
      return ok({
        created: result.created, extractId: result.extract.id, version: result.extract.version,
        supersedes: result.extract.supersedes, fingerprint: result.extract.fingerprint,
        tiesToBooks: result.extract.tiesToBooks,
        differences: result.extract.controls.filter((c) => c.state === 'difference').length,
        changesSummary: result.extract.changesSummary, claimedEvent,
      });
    }

    case 'POST /extracts/verify': {
      const id = String(payload['extractId'] ?? extractSnapshot(state.world).conventional.id);
      return ok(state.world.extracts.verify(id));
    }

    /* ------------------------------------------- the guided customer lifecycle journey
     * One sequence of gated sections, from onboarding to investment progress. Every section is
     * closed until the one before it is 100% complete, and the answer to "what next" is computed by
     * the same gate the console renders — so the screen and the API cannot disagree.
     */
    case 'GET /journey':
      return ok(state.world.journey.snapshot(state.world));

    case 'POST /journey/field-settings': {
      // Labels travel with the mandatory/editable flags: a tenant renames a field and decides whether
      // it is required in the same filed setting, and both are audited in the same call.
      const fieldSettings = state.world.journey.updateFieldSettings(payload['fieldSettings'], {
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({ fieldSettings, fieldRenames: state.world.journey.renameAudit().map((r) => ({ ...r })), renamedFieldCount: state.world.journey.renameAudit().length });
    }

    /* ------------------------------------------- the AI guide: the sticky note on every section */
    case 'GET /guide':
      return ok(state.world.guide.snapshot(state.world));

    case 'POST /guide/preference': {
      const enabled = Boolean(payload['enabled']);
      const by = String(payload['by'] ?? 'console-operator');
      const change = state.world.guide.setPreference({ enabled, by, ...(payload['at'] ? { at: String(payload['at']) } : {}) });
      // A guidance preference is an agent-visible setting, so it goes on the AI ledger too: "was the
      // operator shown the guidance at the time?" has to be answerable from a record, not a memory.
      const proposed = state.world.ai.propose({
        agent: 'agent/console-guide', module: 'guide', intent: enabled ? 'enable-section-guidance' : 'disable-section-guidance',
        riskClass: 'low', at: change.at, inputs: { by, enabled }, output: { enabled, note: change.note }, dryRun: false, costUsd: 0,
      });
      // The desk has already applied it, so the ledger says executed rather than leaving a low-risk
      // preference looking like work somebody still has to do.
      const action = proposed.requiresHuman ? proposed : state.world.ai.execute(proposed.id);
      return ok({ ...change, enabled: state.world.guide.isEnabled(), actionId: action.id, status: action.status });
    }

    case 'POST /journey/open': {
      const opened = state.world.journey.open(state.world, {
        ...(payload['customerName'] ? { customerName: String(payload['customerName']) } : {}),
        ...(payload['country'] ? { country: String(payload['country']) } : {}),
        ...(payload['currency'] ? { currency: String(payload['currency']) } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        caseId: opened.caseId,
        progress: serialiseJourneyProgress(state.world.journey.progress(state.world, opened.caseId)),
      });
    }

    case 'POST /journey/save': {
      const progress = state.world.journey.save(state.world, {
        caseId: String(payload['caseId'] ?? ''),
        stageId: String(payload['stageId'] ?? 'identity') as JourneyStageId,
        answers: (payload['answers'] ?? {}) as Record<string, unknown>,
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({ saved: true, progress: serialiseJourneyProgress(progress) });
    }

    case 'POST /journey/submit': {
      const answers = (payload['answers'] ?? {}) as Record<string, unknown>;
      const result = state.world.journey.submit(state.world, {
        caseId: String(payload['caseId'] ?? ''),
        stageId: String(payload['stageId'] ?? 'identity') as JourneyStageId,
        ...(payload['answers'] ? { answers } : {}),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      /*
       * The quotation stage is the one stage whose answer is a promise to the customer, so it is the
       * one stage that talks to something outside the case: the mail desk. Everything else stays
       * synchronous, and a delivery failure is reported next to the accepted stage rather than
       * rolling back a quotation the customer is about to be shown.
       */
      let delivery: Record<string, unknown> | null = null;
      if (result.stageId === 'quotation' && result.accepted && answers['sendEmail'] === true) {
        const quotationId = String(result.artefacts.quotationId ?? '');
        if (quotationId !== '') {
          const sent = await state.world.journey.deliverQuotation({
            quotationId,
            ...(answers['emailTo'] ? { to: String(answers['emailTo']) } : {}),
            language: (String(answers['emailLanguage'] ?? 'both')) as 'en' | 'ar' | 'both',
            ...(result.artefacts.consentId ? { consentId: String(result.artefacts.consentId) } : {}),
            ...(payload['at'] ? { at: String(payload['at']) } : {}),
            by: String(payload['by'] ?? 'quotation-desk'),
            buyLink: `https://portal.example/buy/${quotationId}?token=${randomTokenHex(16)}`,
          });
          // The delivery carries its own `to`; the email record's `to` is the masked audit copy.
          delivery = { ...sent.delivery, messageId: sent.email.messageId, auditTo: sent.email.to };
        }
      }
      return ok({
        caseId: result.caseId,
        stageId: result.stageId,
        accepted: result.accepted,
        reason: result.reason,
        artefacts: { ...result.artefacts },
        detail: result.detail,
        ...(delivery ? { delivery } : {}),
        progress: serialiseJourneyProgress(result.progress),
      });
    }

    case 'POST /journey/abandon': {
      const abandoned = state.world.journey.abandon(state.world, {
        caseId: String(payload['caseId'] ?? ''),
        by: String(payload['by'] ?? 'operator'),
        reason: String(payload['reason'] ?? ''),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
      });
      return ok({
        caseId: abandoned.caseId,
        status: abandoned.status,
        progress: serialiseJourneyProgress(state.world.journey.progress(state.world, abandoned.caseId)),
      });
    }

    /**
     * Email the quotation — for real. The transport answers, and its answer is recorded on the
     * quotation: `sent` with the provider's message id, or `failed`/`not-sent` with the sentence a
     * human has to act on. Nothing here pretends a delivery happened because a record was written.
     */
    case 'POST /journey/quotation/email': {
      const quotationId = String(payload['quotationId'] ?? '');
      const sent = await state.world.journey.deliverQuotation({
        quotationId,
        ...(payload['to'] ? { to: String(payload['to']) } : {}),
        language: (String(payload['language'] ?? 'both')) as 'en' | 'ar' | 'both',
        ...(payload['consentId'] ? { consentId: String(payload['consentId']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
        by: String(payload['by'] ?? 'quotation-desk'),
        ...(payload['buyLink'] ? { buyLink: String(payload['buyLink']) } : {}),
      });
      return ok({
        quotationId: sent.email.quotationId,
        version: sent.email.version,
        messageId: sent.email.messageId,
        to: sent.email.to,
        subject: sent.email.subject,
        attachment: sent.email.attachment,
        dispatchedAt: sent.email.dispatchedAt,
        delivery: sent.delivery,
      });
    }

    case 'GET /mail/status':
      return ok({ ...state.mailer.status(state.mailEnv), history: state.mailer.history(10) });

    /** The button that proves the credentials before a customer is promised anything. */
    case 'POST /mail/test': {
      const to = String(payload['to'] ?? '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail(400, { error: `"${to}" is not a deliverable email address` });
      const delivery = await state.mailer.sendTest(to, String(payload['subject'] ?? 'Central Insurance portal — delivery test'));
      return ok({ to, delivery });
    }

    /* -------------------------------------- the filed illustration rates: product, channel, sub-channel */

    case 'GET /master/illustration-rates': {
      const channels = state.world.erp.channels;
      const products = productCatalogue(state.world);
      const wanted = String(searchParams.get('productId') ?? '').trim().toUpperCase();
      return ok({
        rates: channels.listIllustrationRates(),
        audit: channels.illustrationRateAudit(20),
        // The cascade as it stands for the products on the grid, so an empty row is visibly inherited.
        resolved: (wanted ? products.filter((p) => p.productId === wanted) : products).map((p) => ({
          productId: p.productId,
          name: p.name,
          category: p.category,
          default: channels.illustrationRatesFor(p.productId, {}, AE_PACK.illustration.scenarioRatesBps),
        })),
        packRates: AE_PACK.illustration.scenarioRatesBps,
      });
    }

    case 'POST /master/illustration-rates': {
      const rateOf = (key: string): number | undefined => {
        const raw = payload[key];
        if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
        return Number(raw);
      };
      const row = state.world.erp.channels.setIllustrationRates({
        productId: String(payload['productId'] ?? ''),
        ...(payload['channelCode'] ? { channelCode: String(payload['channelCode']) } : {}),
        ...(payload['subChannelCode'] ? { subChannelCode: String(payload['subChannelCode']) } : {}),
        ...(rateOf('lowBps') === undefined ? {} : { lowBps: rateOf('lowBps')! }),
        ...(rateOf('midBps') === undefined ? {} : { midBps: rateOf('midBps')! }),
        ...(rateOf('highBps') === undefined ? {} : { highBps: rateOf('highBps')! }),
        ...(payload['note'] ? { note: String(payload['note']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
        by: String(payload['by'] ?? 'master-settings'),
      });
      const productId = String(payload['productId'] ?? '').trim().toUpperCase();
      return ok({
        row,
        resolved: row
          ? state.world.erp.channels.illustrationRatesFor(productId, {
            channelCode: String(payload['channelCode'] ?? '') || null,
            subChannelCode: String(payload['subChannelCode'] ?? '') || null,
          }, AE_PACK.illustration.scenarioRatesBps)
          : null,
        rates: state.world.erp.channels.listIllustrationRates(),
      });
    }

    case 'POST /master/illustration-rates/remove': {
      const removed = state.world.erp.channels.clearIllustrationRates({
        productId: String(payload['productId'] ?? ''),
        ...(payload['channelCode'] ? { channelCode: String(payload['channelCode']) } : {}),
        ...(payload['subChannelCode'] ? { subChannelCode: String(payload['subChannelCode']) } : {}),
        ...(payload['at'] ? { at: String(payload['at']) } : {}),
        by: String(payload['by'] ?? 'master-settings'),
      });
      return ok({ removed, rates: state.world.erp.channels.listIllustrationRates() });
    }

    /** What the illustration would look like for a term and a payment term, before anything is filed. */
    case 'POST /journey/illustration/preview': {
      const productId = String(payload['productId'] ?? '').trim().toUpperCase();
      const product = productCatalogue(state.world).find((p) => p.productId === productId);
      if (!product) return fail(400, { error: `${productId} is not filed in the product factory` });
      const currency = String(payload['currency'] ?? product.currency);
      const channelCode = String(payload['channelCode'] ?? '').trim() || null;
      const subChannelCode = String(payload['subChannelCode'] ?? '').trim() || null;
      const sumAssured = parseAmount(String(payload['sumAssured'] ?? '100,000'), currency);
      const termYears = Math.max(1, Math.round(Number(payload['benefitTermYears'] ?? payload['termYears'] ?? 20)));
      const payingTerm = Math.max(0, Math.round(Number(payload['premiumPayingTermYears'] ?? 0)));
      const premium = parseAmount(String(payload['premiumPerFrequency'] ?? '1,000'), currency);
      const resolved = state.world.erp.channels.illustrationRatesFor(productId, { channelCode, subChannelCode }, AE_PACK.illustration.scenarioRatesBps);
      const charges = state.world.unitLinked.chargeSchedule();
      const illustration = buildIllustration({
        currency,
        sumAssured,
        premiumPerFrequency: premium,
        paymentFrequency: (String(payload['paymentFrequency'] ?? 'annual')) as 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'single',
        premiumPayingTermYears: payingTerm,
        benefitTermYears: termYears,
        entryAge: Math.round(Number(payload['entryAge'] ?? 35)),
        rates: resolved.rates,
        rateSources: resolved.sources,
        charges: {
          allocationChargeBps: charges.allocationChargeBps,
          coiPerMilleMonthly: charges.coiPerMilleMonthly,
          adminFeeMonthlyMinor: charges.adminFeeMonthlyMinor,
          surrenderChargeBpsByYear: [...charges.surrenderChargeBpsByYear],
        },
        investmentLinked: product.category === 'unit-linked' || product.category === 'takaful',
        ...(payload['at'] ? { generatedAt: String(payload['at']) } : {}),
      });
      return ok({
        productId,
        currency,
        rates: resolved,
        illustration: illustrationView(illustration),
      });
    }

    case 'POST /journey/quotation/pdf': {
      const quotationId = String(payload['quotationId'] ?? '');
      const record = state.world.journey.quotations.get(quotationId);
      if (record.pdf.base64 === '') return fail(409, { error: `quotation ${quotationId} has no document — it was refused: ${record.blockers.join(' · ')}` });
      return ok({
        quotationId: record.quotationId,
        version: record.version,
        fileName: record.pdf.fileName,
        base64: record.pdf.base64,
        bytes: record.pdf.bytes,
        pages: record.pdf.pages,
        fingerprint: record.pdf.fingerprint,
        opens: record.pdf.opens,
        text: record.pdf.text,
      });
    }

    case 'POST /journey/payment/settle': {
      const settled = state.world.journey.payments.settle({
        paymentId: String(payload['paymentId'] ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T13:00:00+04:00`),
        by: String(payload['by'] ?? 'cashier-desk'),
        ...(payload['proof'] ? { proof: String(payload['proof']) } : {}),
      });
      return ok({
        paymentId: settled.id, status: settled.status, settledAt: settled.settledAt,
        amount: settled.amountLabel, proof: settled.proof, note: settled.note,
      });
    }

    case 'POST /journey/payment/fail': {
      const failed = state.world.journey.payments.fail({
        paymentId: String(payload['paymentId'] ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T13:00:00+04:00`),
        by: String(payload['by'] ?? 'cashier-desk'),
        reason: String(payload['reason'] ?? ''),
      });
      return ok({ paymentId: failed.id, status: failed.status, note: failed.note, proof: failed.proof });
    }

    case 'POST /journey/freelance/report': {
      const reported = state.world.journey.underwritingDesk.freelanceReport({
        engagementId: String(payload['engagementId'] ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T15:00:00+04:00`),
        recommendation: String(payload['recommendation'] ?? 'rated') as DecisionOutcome,
        notes: String(payload['notes'] ?? ''),
        ...(payload['by'] ? { by: String(payload['by']) } : {}),
      });
      return ok({
        engagementId: reported.engagementId, status: reported.status,
        underwriter: reported.name, recommendation: reported.report?.recommendation ?? null,
        notes: reported.report?.notes ?? null, cost: reported.costLabel,
      });
    }

    case 'POST /journey/reinsurance/answer': {
      const answered = state.world.journey.underwritingDesk.answerReinsuranceAssist({
        requestId: String(payload['requestId'] ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T15:00:00+04:00`),
        byReinsurer: String(payload['byReinsurer'] ?? 'reinsurance-underwriter'),
        decision: String(payload['decision'] ?? 'accept') as 'accept' | 'accept-with-conditions' | 'decline',
        ...(Array.isArray(payload['conditions']) ? { conditions: payload['conditions'] as string[] } : {}),
      });
      return ok({
        requestId: answered.requestId, status: answered.status,
        decision: answered.answer?.decision ?? null, conditions: answered.answer?.conditions ?? [],
      });
    }

    case 'GET /state': {
      const state1 = exportLedger(state.world.ledger);
      const snap = seal(state1, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: state.now() });
      const text = snapshotText(snap);
      return ok({
        ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
        takenAt: snap.takenAt,
        fingerprint: snap.fingerprint,
        accounts: state1.accounts.length,
        journals: state1.journals.length,
        fxRates: state1.fx.length,
        bytes: text.length,
      });
    }

    case 'POST /state/drill': {
      const before = exportLedger(state.world.ledger);
      const started = Date.now();
      const snap = seal(before, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: state.now() });
      const text = snapshotText(snap);
      const parsed = JSON.parse(text);
      const restoredState = open(parsed, { expectSchema: LEDGER_SCHEMA_VERSION }) as typeof before;
      const restored = importLedger(restoredState);
      const entities = [...new Set(before.accounts.map((a) => a.entityId))];
      const balances = entities.map((entityId) => {
        const live = state.world.ledger.trialBalance(entityId);
        const rebuilt = restored.trialBalance(entityId);
        const agree = live.length === rebuilt.length && live.every((row, i) => {
          const other = rebuilt[i]!;
          return row.account.id === other.account.id && row.balance.minor === other.balance.minor;
        });
        return { entityId, balanced: restored.proof(entityId).balanced, trialBalanceAgrees: agree, accounts: live.length };
      });
      return ok({
        ok: balances.every((b) => b.balanced && b.trialBalanceAgrees),
        fingerprint: snap.fingerprint,
        fingerprintStable: seal(before, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: snap.takenAt }).fingerprint === snap.fingerprint,
        journals: before.journals.length,
        restoredJournals: restored.allJournals().length,
        bytes: text.length,
        restoreMs: Date.now() - started,
        balances,
      });
    }

    case 'GET /ledger/proof':
      return ok({
        conventional: state.world.ledger.proof(state.world.conventionalEntity),
        takaful: state.world.ledger.proof(state.world.takafulEntity),
        unitHoldings: state.world.unitLinked.transactions('UL-000123').length,
      });

    case 'GET /units':
      return ok({
        fundUnitsInIssue: state.world.nav.listFunds().map((f) => ({ fundId: f.id, units: unitsToDecimal(state.world.unitLinked.unitsInIssue(f.id)) })),
        policyUnits: state.world.unitLinked.unitsHeld('UL-000123').map((h) => ({ fundId: h.fundId, units: unitsToDecimal(h.units) })),
        reproduce: state.world.unitLinked.reproduce('UL-000123'),
      });

    case 'POST /reset': {
      // Replace the whole state in one assignment so a concurrent dispatch can never observe a
      // mix of the old world and the new registers. (The HTTP layer gates this endpoint: demo
      // mode or an admin principal only — see src/server/auth.ts.)
      const next = createRuntimeState(state.version + 1, state.now);
      // The idempotency register survives a reset on purpose: swapping it would discard the
      // in-flight completion of *this* call, so a keyed retry of the reset would run it again.
      Object.assign(state, next, { keys: state.keys, takafulApprovals: {}, storeError: undefined });
      if (onReset) onReset();
      return ok({ ok: true, version: state.version });
    }

    default:
      return { handled: false, status: 404, body: { error: 'no such endpoint', path: `/api${path}` } };
  }
}
