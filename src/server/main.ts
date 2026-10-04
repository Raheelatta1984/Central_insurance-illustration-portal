/**
 * The API server.
 *
 * One process serves the SPA and the JSON API on one port, so a preview URL is the whole
 * application. Every endpoint is a thin, typed shell over the domain core — no business logic
 * lives here, which is why the tests and the console can never drift apart.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { buildWorld, worldSnapshot, World, groupSnapshot, underwritingSnapshot, claimsSnapshot, reinsuranceSnapshot } from '../core/demo.js';
import { money, formatAmount } from '../core/money.js';
import { AE_PACK, preSaleCheck } from '../core/regulatory.js';
import { ocrDocument } from '../core/onboarding.js';
import { unitsToDecimal } from '../core/units.js';
import { ClaimsEngine, ClaimCause } from '../core/claims.js';
import { parseAmount } from '../core/money.js';
import { exportLedger, importLedger, open, seal, snapshotText, LEDGER_SCHEMA_VERSION } from '../core/persistence.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = resolve(process.cwd(), 'dist');

interface State { world: World; version: number }
let state: State = { world: buildWorld(), version: 1 };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': MIME['.json']!, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 5_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, safe === '/' || safe === '' ? 'index.html' : safe);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(DIST, 'index.html');
  if (!existsSync(filePath)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('UI not built yet — run: npm run build:ui');
    return;
  }
  const type = MIME[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(readFileSync(filePath));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace(/^\/api/, '');
  const body = req.method === 'POST' ? await readBody(req).catch(() => '') : '';
  const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};

  switch (`${req.method} ${path}`) {
    case 'GET /health':
      json(res, 200, { ok: true, version: state.version, asOf: state.world.asOf });
      return true;

    case 'GET /world':
      json(res, 200, worldSnapshot(state.world));
      return true;

    case 'POST /preview/switch': {
      const amount = money(BigInt(Math.round(Number(payload['amountMinor'] ?? 200000))), 'AED');
      const preview = state.world.decider.previewSwitch({
        policyId: 'UL-000123', fromFundId: String(payload['fromFundId'] ?? 'FGLOBAL'),
        toFundId: String(payload['toFundId'] ?? 'FBAL'), amount,
        instructionAt: String(payload['instructionAt'] ?? `${state.world.asOf}T16:10:00+04:00`),
        disclaimer: AE_PACK.illustration.wording,
      });
      json(res, 200, { ...preview, feeLabel: formatAmount(preview.fee), netLabel: formatAmount(preview.netInvested) });
      return true;
    }

    case 'POST /preview/withdrawal': {
      const amount = money(BigInt(Math.round(Number(payload['amountMinor'] ?? 150000))), 'AED');
      const preview = state.world.decider.previewWithdrawal({
        policyId: 'UL-000123', fundId: String(payload['fundId'] ?? 'FBAL'), amount,
        instructionAt: String(payload['instructionAt'] ?? `${state.world.asOf}T11:00:00+04:00`),
        disclaimer: AE_PACK.illustration.wording,
      });
      json(res, 200, {
        ...preview, requestedLabel: formatAmount(preview.requested), feeLabel: formatAmount(preview.fee),
        cashLabel: formatAmount(preview.cashToCustomer), remainingValueLabel: formatAmount(preview.remainingValue),
      });
      return true;
    }

    case 'POST /cover/start': {
      const segments = state.world.billing.segmentsFor('MTR-0441');
      const target = segments.find((s) => s.id === String(payload['segmentId'])) ?? segments[0];
      const updated = state.world.billing.startCover(target!.id, String(payload['at'] ?? '2026-10-05T08:00:00+04:00'));
      json(res, 200, { segment: { ...updated, dailyRateLabel: formatAmount(updated.dailyRate) } });
      return true;
    }

    case 'POST /cover/stop': {
      const segments = state.world.billing.segmentsFor('MTR-0441');
      const target = segments.find((s) => s.id === String(payload['segmentId'])) ?? segments[0];
      const updated = state.world.billing.stopCover(target!.id, String(payload['at'] ?? '2026-10-05T09:00:00+04:00'));
      json(res, 200, { segment: { ...updated, dailyRateLabel: formatAmount(updated.dailyRate) } });
      return true;
    }

    case 'POST /cover/tick': {
      const raised = state.world.billing.tick(String(payload['at'] ?? '2026-10-06T10:00:00+04:00'));
      json(res, 200, {
        raised: raised.map((e) => ({ ...e, amountLabel: formatAmount(e.amount) })),
        note: 'Cover is charged only for days inside an active start/stop window. Nothing auto-starts unless the segment elected daily renewal.',
      });
      return true;
    }

    case 'POST /pre-sale': {
      const productLine = String(payload['productLine'] ?? 'medical') as 'life' | 'medical' | 'motor' | 'travel' | 'group' | 'unit-linked' | 'takaful';
      const result = preSaleCheck(AE_PACK, {
        productLine,
        hasNeedAnalysis: Boolean(payload['hasNeedAnalysis']),
        hasNeedId: Boolean(payload['hasNeedId']),
        surveyCompleted: Boolean(payload['surveyCompleted'] ?? true),
        comparisonPresented: Boolean(payload['comparisonPresented'] ?? true),
        customerIsResident: true,
        consentCaptured: Boolean(payload['consentCaptured'] ?? true),
      });
      json(res, 200, result);
      return true;
    }

    case 'POST /onboarding/ocr': {
      const readings = (payload['readings'] ?? {}) as Record<string, string[]>;
      const result = ocrDocument('driving-licence', readings);
      json(res, 200, result);
      return true;
    }

    case 'POST /partner/lookup': {
      const withConsent = Boolean(payload['withConsent'] ?? true);
      const result = state.world.parties.lookup({
        partyId: 'PTY-0001',
        ...(withConsent ? { consentId: state.world.consentId } : {}),
        requestedBy: 'DXB-BROKER-01',
        scopes: ['customer.exists', 'customer.name', 'customer.holdings'],
        at: `${state.world.asOf}T09:00:00+04:00`,
      });
      json(res, 200, result);
      return true;
    }

    case 'POST /ai/approve': {
      const id = String(payload['id'] ?? '');
      const action = state.world.ai.approve(id, 'raheel@operator');
      json(res, 200, action);
      return true;
    }

    case 'POST /ai/execute': {
      const id = String(payload['id'] ?? '');
      const action = state.world.ai.execute(id);
      json(res, 200, action);
      return true;
    }

    case 'POST /ingest/submit': {
      const text = String(payload['text'] ?? '');
      const loadId = String(payload['loadId'] ?? `LOAD-${Date.now()}`);
      const record = state.world.ingest.submit({ loadId, source: 'console paste', submittedAt: new Date().toISOString(), text });
      const reconciliation = state.world.ingest.reconciliation(loadId);
      json(res, 200, {
        summary: reconciliation.summary, anomalies: reconciliation.anomalies,
        quarantine: reconciliation.quarantine, supervisorNotes: reconciliation.supervisorNotes, loadId,
      });
      return true;
    }

    case 'POST /ingest/commit': {
      const loadId = String(payload['loadId'] ?? '');
      const record = state.world.ingest.commit(loadId, new Date().toISOString());
      json(res, 200, { loadId, committed: record.committed, committedKeys: record.committedKeys.length, duplicates: record.duplicatesSuppressed });
      return true;
    }

    case 'GET /group': {
      const report = groupSnapshot(state.world, false);
      json(res, 200, report);
      return true;
    }

    case 'POST /group/consolidate': {
      const report = groupSnapshot(state.world, true);
      json(res, 200, {
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
      return true;
    }

    case 'GET /underwriting': {
      // Exactly the shape the console renders, so the two can never drift apart.
      json(res, 200, underwritingSnapshot(state.world.underwriting, state.world.asOf));
      return true;
    }

    case 'GET /reinsurance': {
      // Exactly the shape the console renders, so the two can never drift apart.
      json(res, 200, reinsuranceSnapshot(state.world));
      return true;
    }

    case 'POST /reinsurance/cede': {
      const basis = String(payload['basis'] ?? 'conventional') === 'takaful' ? 'takaful' as const : 'conventional' as const;
      const register = basis === 'takaful' ? state.world.retakaful : state.world.reinsurance;
      // Each press cedes the next motor risk to come off the broker's desk, so a demo shows the
      // utilisation statement move. Naming an existing risk twice is still refused by the engine.
      const next = register.cessionSchedule().length + 1;
      const cession = register.cedePremium({
        treatyId: String(payload['treatyId'] ?? 'QS-25-2026'),
        policyId: String(payload['policyId'] ?? `MTR-2026-${next}`),
        riskId: String(payload['riskId'] ?? payload['policyId'] ?? `MTR-2026-${next}`),
        sumInsured: parseAmount(String(payload['sumInsured'] ?? '250,000.00'), 'AED'),
        premium: parseAmount(String(payload['premium'] ?? '1,200.00'), 'AED'),
        lineOfBusiness: String(payload['lineOfBusiness'] ?? 'motor'),
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        basis,
        by: String(payload['by'] ?? 'reinsurance/desk'),
        ...(payload['fundId'] ? { fundId: String(payload['fundId']) } : {}),
      });
      json(res, 200, {
        treatyId: cession.treatyId, policyId: cession.policyId, sharePct: cession.shareBps / 100,
        ceded: formatAmount(cession.ceded), cededPremium: formatAmount(cession.cededPremium),
        commission: formatAmount(cession.commission), netRetainedPremium: formatAmount(cession.netRetainedPremium),
        journalId: cession.journalId, explanation: cession.explanation,
      });
      return true;
    }

    case 'POST /reinsurance/facultative': {
      const riskId = String(payload['riskId'] ?? 'MTR-ORION-77');
      const at = String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`);
      // Two steps, in the order the market works: the reinsurer accepts the named risk, then the
      // premium moves. Press it twice and the second press is refused by the engine, not by the UI.
      if (!state.world.reinsurance.acceptedRisks('FAC-MOTOR').includes(riskId)) {
        state.world.reinsurance.acceptFacultative('FAC-MOTOR', riskId, { at, by: 'reinsurance/desk' });
      }
      const cession = state.world.reinsurance.cedePremium({
        treatyId: 'FAC-MOTOR', policyId: riskId, riskId,
        sumInsured: parseAmount(String(payload['sumInsured'] ?? '400,000.00'), 'AED'),
        premium: parseAmount(String(payload['premium'] ?? '5,600.00'), 'AED'),
        lineOfBusiness: 'motor', at, basis: 'conventional', by: 'reinsurance/desk',
      });
      json(res, 200, {
        acceptedRisk: riskId, treatyId: cession.treatyId, sharePct: cession.shareBps / 100,
        cededPremium: formatAmount(cession.cededPremium), commission: formatAmount(cession.commission),
        journalId: cession.journalId,
      });
      return true;
    }

    case 'POST /reinsurance/recover': {
      const policyId = String(payload['policyId'] ?? 'MTR-0441');
      const claimId = String(payload['claimId'] ?? 'CLM-000001');
      const paid = parseAmount(String(payload['paid'] ?? '1,150.00'), 'AED');
      const recovery = state.world.reinsurance.recoverClaim({
        policyId, claim: state.world.claims, claimId, paid,
        at: String(payload['at'] ?? `${state.world.asOf}T10:00:00+04:00`),
        by: String(payload['by'] ?? 'recovery-desk'),
      });
      json(res, 200, {
        claimId, amount: formatAmount(recovery.amount), sharePct: recovery.shareBps / 100,
        recoveryId: recovery.recoveryId,
        recovered: formatAmount(state.world.claims.netCost(claimId)),
      });
      return true;
    }

    case 'POST /underwriting/decide': {
      const applicationId = String(payload['applicationId']);
      const decision = state.world.underwriting.decide(applicationId, {
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        by: String(payload['by'] ?? 'senior-underwriter'),
        isAi: Boolean(payload['isAi'] ?? false),
        ...(Array.isArray(payload['acceptReferralReasonCodes']) ? { acceptReferralReasonCodes: payload['acceptReferralReasonCodes'] as string[] } : {}),
      });
      json(res, 200, {
        applicationId, outcome: decision.outcome, decidedBy: decision.decidedBy, decidedByAi: decision.decidedByAi,
        extraMortalityBps: decision.extraMortalityBps,
        standardPremium: formatAmount(decision.standardPremium), loadedPremium: formatAmount(decision.loadedPremium),
        exclusions: decision.exclusions, evidence: decision.evidence, referrals: decision.referrals,
        reasons: decision.reasons.map((r) => ({ code: r.code, detail: r.detail, source: r.source, referral: r.referral === true })),
      });
      return true;
    }

    case 'GET /claims': {
      json(res, 200, {
        conventional: claimsSnapshot(state.world.claims, state.world.asOf),
        takaful: claimsSnapshot(state.world.takafulClaims, state.world.asOf),
      });
      return true;
    }

    case 'POST /claims/register': {
      const claim = state.world.claims.register({
        policyId: String(payload['policyId'] ?? 'UL-000123'),
        cause: (String(payload['cause'] ?? 'medical') as ClaimCause),
        lossDate: String(payload['lossDate'] ?? '2026-09-28'),
        reportedAt: String(payload['reportedAt'] ?? '2026-09-30'),
        description: String(payload['description'] ?? 'Registered from the console'),
      });
      const triage = state.world.claims.triage(claim.id, {
        coverInForce: true, exclusionsApplied: [], daysLate: 2, fraudSignals: 0,
      });
      json(res, 200, {
        id: claim.id,
        status: state.world.claims.claim(claim.id).status,
        triage: {
          decision: triage.decision, reasons: triage.reasons,
          reserveSuggestion: triage.reserveSuggestion ? formatAmount(triage.reserveSuggestion) : null,
        },
        claim: claimsSnapshot(state.world.claims, state.world.asOf).list.at(-1),
      });
      return true;
    }

    case 'POST /claims/approve': {
      const claimId = String(payload['claimId']);
      const amount = parseAmount(String(payload['amount'] ?? '250.00'), 'AED');
      const claim = state.world.claims.approve(claimId, {
        amount, at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        by: String(payload['by'] ?? 'console'), role: String(payload['role'] ?? 'claims-officer'),
        isAi: payload['isAi'] === undefined ? undefined : Boolean(payload['isAi']),
      });
      json(res, 200, { id: claim.id, status: claim.status, approved: formatAmount(state.world.claims.approvedAmount(claimId) ?? amount) });
      return true;
    }

    case 'POST /claims/settle': {
      const claimId = String(payload['claimId']);
      const approved = state.world.claims.approvedAmount(claimId);
      if (!approved) { json(res, 409, { error: `claim ${claimId} has no approval to settle` }); return true; }
      const claim = state.world.claims.settle(claimId, {
        amount: approved, at: String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`), by: String(payload['by'] ?? 'finance-ops'),
      });
      json(res, 200, {
        id: claim.id, status: claim.status, paid: formatAmount(claim.paid),
        decisions: claim.decisions.slice(-1).map((d) => ({ action: d.action, rationale: d.rationale })),
        position: claimsSnapshot(state.world.claims, state.world.asOf).position,
      });
      return true;
    }

    case 'POST /reset':
      state = { world: buildWorld(), version: state.version + 1 };
      json(res, 200, { ok: true, version: state.version });
      return true;

    case 'POST /takaful/approve': {
      const role = String(payload['role'] ?? 'actuary') as 'actuary' | 'shariah' | 'board';
      const by = String(payload['by'] ?? 'human-signatory');
      const w = state.world;
      const proposal = w.takaful.surplusRun({
        riskFundId: 'PRF', determinedAt: w.asOf,
        assets: money(3050_00, 'AED'), liabilities: money(1800_00, 'AED'),
        config: { productId: 'PROD-TKF-FAMILY', model: 'wakalah', wakalahFeeBps: 2000, mudarabahProfitShareBps: 0, tabarruBps: 3000, surplusParticipantShareBps: 7000, allowsSurplusToSavers: false, jurisdiction: 'AE' },
        isFullValuation: true, auditedResultsAvailable: true,
        ...(role === 'actuary' ? { actuarialRecommendation: { recommended: true, by, at: w.asOf } } : {}),
        ...(role === 'shariah' ? { shariahApproval: { approved: true, by, at: w.asOf } } : {}),
        ...(role === 'board' ? { boardApproval: { endorsed: true, by, at: w.asOf } } : {}),
      });
      json(res, 200, { id: proposal.id, approvals: proposal.approvals, blockers: proposal.blockers, ready: proposal.ready });
      return true;
    }

    case 'GET /state': {
      const state1 = exportLedger(state.world.ledger);
      const snap = seal(state1, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: new Date().toISOString() });
      const text = snapshotText(snap);
      json(res, 200, {
        ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
        takenAt: snap.takenAt,
        fingerprint: snap.fingerprint,
        accounts: state1.accounts.length,
        journals: state1.journals.length,
        fxRates: state1.fx.length,
        bytes: text.length,
      });
      return true;
    }

    case 'POST /state/drill': {
      // Durability drill: seal the books, write them to text, read them back, rebuild a fresh
      // ledger from that text, and prove the rebuilt books agree with the live ones.
      const before = exportLedger(state.world.ledger);
      const started = Date.now();
      const snap = seal(before, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: new Date().toISOString() });
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
      json(res, 200, {
        ok: balances.every((b) => b.balanced && b.trialBalanceAgrees),
        fingerprint: snap.fingerprint,
        fingerprintStable: seal(before, { schemaVersion: LEDGER_SCHEMA_VERSION, takenAt: snap.takenAt }).fingerprint === snap.fingerprint,
        journals: before.journals.length,
        restoredJournals: restored.allJournals().length,
        bytes: text.length,
        restoreMs: Date.now() - started,
        balances,
      });
      return true;
    }

    case 'GET /ledger/proof':
      json(res, 200, {
        conventional: state.world.ledger.proof(state.world.conventionalEntity),
        takaful: state.world.ledger.proof(state.world.takafulEntity),
        unitHoldings: state.world.unitLinked.transactions('UL-000123').length,
      });
      return true;

    case 'GET /units':
      json(res, 200, {
        fundUnitsInIssue: state.world.nav.listFunds().map((f) => ({ fundId: f.id, units: unitsToDecimal(state.world.unitLinked.unitsInIssue(f.id)) })),
        policyUnits: state.world.unitLinked.unitsHeld('UL-000123').map((h) => ({ fundId: h.fundId, units: unitsToDecimal(h.units) })),
        reproduce: state.world.unitLinked.reproduce('UL-000123'),
      });
      return true;

    default:
      return false;
  }
}

/**
 * Is this the engine saying no, or the code being broken? Every refusal the core raises is a named
 * *Error class of its own (`ClaimsError`, `FundError`, `GroupError`, ...) — those are answers, and an
 * answer deserves 409 with the sentence attached, not a 500. JS built-ins (a real TypeError in our
 * own code) keep the 500, because that is a bug and should look like one.
 */
const JS_BUILTINS: ReadonlySet<unknown> = new Set([Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError]);
function refusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const ctor = err.constructor as { name?: string } | undefined;
  return typeof ctor === 'function' && !JS_BUILTINS.has(ctor) && /Error$/.test(ctor.name ?? '');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api')) {
    handleApi(req, res, url).then((handled) => {
      if (!handled) json(res, 404, { error: 'no such endpoint', path: url.pathname });
    }).catch((err: unknown) => {
      json(res, refusal(err) ? 409 : 500, { error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Insurance ERP API listening on http://${HOST}:${PORT} (serving ${DIST})`);
});
