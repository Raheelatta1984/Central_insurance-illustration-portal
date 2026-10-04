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
import { buildWorld, worldSnapshot, World, groupSnapshot, underwritingSnapshot, claimsSnapshot, reinsuranceSnapshot, extractSnapshot, uaeRuleSnapshot, wordingSnapshot, submissionSnapshot } from '../core/demo.js';
import { money, formatAmount } from '../core/money.js';
import { AE_PACK, preSaleCheck } from '../core/regulatory.js';
import { UaeRuleError } from '../core/uae.js';
import { WordingError } from '../core/wording.js';
import { SubmissionError } from '../core/submission.js';
import { openBooksTimeline, REGISTER_STORE_LIMITATION, exportReporting, openReporting, restoreReporting, sealReporting, verifyOutbox } from '../core/registerstore.js';
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

    case 'GET /state/registers': {
      // What the reporting registers hold, and the outbox that will prove on restore that nothing
      // was dropped between snapshots.
      const registers = exportReporting(state.world);
      const sealed = sealReporting(registers, new Date().toISOString());
      const chain = verifyOutbox(sealed.outbox);
      json(res, 200, {
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
      return true;
    }

    case 'POST /state/registers/drill': {
      // The restart drill: seal the registers, throw the live objects away, rebuild them in a fresh
      // world from the text alone, and report what came back — including the outbox chain.
      const world = state.world;
      const started = Date.now();
      const payload = exportReporting(world);
      const sealed = sealReporting(payload, `${world.asOf}T20:30:00+04:00`);
      const reopened = openReporting(JSON.parse(sealed.text));
      const restarted = buildWorld();
      const target = {
        ledger: restarted.ledger, extracts: restarted.extracts, takafulExtracts: restarted.takafulExtracts,
        rules: restarted.rules, wording: restarted.wording,
        submissions: restarted.submissions, takafulSubmissions: restarted.takafulSubmissions,
      };
      // the books come with the registers: opened as a timeline so each return is replayed against
      // the books as they stood when it was issued, then settled so the end state is compared
      const books = openBooksTimeline(target, exportLedger(world.ledger));
      const report = restoreReporting(reopened.state, target, { outbox: reopened.outbox, books });
      json(res, 200, {
        ok: report.ok,
        detail: report.detail,
        books: report.books,
        replays: report.replays,
        fingerprint: sealed.snapshot.fingerprint,
        schemaVersion: sealed.snapshot.schemaVersion,
        bytes: sealed.text.length,
        restoreMs: Date.now() - started,
        registers: report,
        limitation: REGISTER_STORE_LIMITATION,
      });
      return true;
    }

    case 'GET /submissions': {
      // The filing log: what went to the supervisor, what came back, and what is still outstanding.
      json(res, 200, submissionSnapshot(state.world));
      return true;
    }

    case 'POST /submissions/file': {
      // File the current return. The pack is built from the issued extract, the cover letter the
      // wording book generated for it, and the rule decisions behind the figures; the register
      // recomputes the return from the books first, so a return that has moved cannot be filed old.
      const entity = String(payload['entity'] ?? 'conventional');
      const register = entity === 'takaful' ? state.world.takafulSubmissions : state.world.submissions;
      const extracts = entity === 'takaful' ? state.world.takafulExtracts : state.world.extracts;
      const returnCode = String(payload['returnCode'] ?? 'CBUAE-MONTHLY');
      const latest = [...extracts.list()].reverse().find((e) => e.kind === 'regulatory-return');
      if (!latest) { json(res, 409, { error: `no regulatory return has been issued for the ${entity} book` }); return true; }
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
        json(res, 200, {
          id: submission.id, reference: submission.reference, status: submission.status, onTime: submission.onTime,
          filedAt: submission.filedAt, filedBy: submission.filedBy, channel: submission.channel,
          period: submission.period, manifest: submission.pack.manifest, assessment,
          statement: register.statement(state.world.asOf),
          findings: register.findings(state.world.asOf).map((f) => ({ ...f })),
        });
      } catch (err) {
        json(res, err instanceof SubmissionError ? 409 : 500, { error: String((err as Error).message) });
      }
      return true;
    }

    case 'POST /submissions/acknowledge': {
      // The supervisor answers. It names who recorded it and under what reference; an acknowledgement
      // without a reference is not an acknowledgement.
      const register = String(payload['entity'] ?? 'conventional') === 'takaful' ? state.world.takafulSubmissions : state.world.submissions;
      const id = String(payload['id'] ?? register.submissions().at(-1)?.id ?? '');
      try {
        const updated = register.acknowledge(id, {
          at: `${state.world.asOf}T19:30:00+04:00`,
          by: String(payload['by'] ?? 'compliance/records'),
          supervisorReference: String(payload['supervisorReference'] ?? `CBUAE-ACK-${state.world.asOf.replace(/-/g, '')}`),
        });
        json(res, 200, {
          id: updated.id, reference: updated.reference, status: updated.status,
          acknowledgedAt: updated.acknowledgedAt, acknowledgedBy: updated.acknowledgedBy,
          supervisorReference: updated.supervisorReference,
          statement: register.statement(state.world.asOf),
          findings: register.findings(state.world.asOf).map((f) => ({ ...f })),
        });
      } catch (err) {
        json(res, err instanceof SubmissionError ? 409 : 500, { error: String((err as Error).message) });
      }
      return true;
    }

    case 'GET /wording': {
      // The templates and the mandated paragraphs as data, and every letter generated from them.
      json(res, 200, wordingSnapshot(state.world));
      return true;
    }

    case 'POST /wording/generate': {
      // Compose a letter the way the desk would: the same templates, the same mandated paragraphs, and
      // the scope's own words for a field. Generating identical content returns the letter already on
      // file; a moved figure supersedes it with a changes summary and keeps the earlier version.
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
            // Each scope supplies its own vocabulary: a conventional letter states a premium, the
            // window's states a contribution. Supplying both would add a field to a letter that never
            // had one — and an addition is a change, which would need a reason.
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
        json(res, 200, {
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
        json(res, err instanceof WordingError ? 409 : 500, { error: String((err as Error).message) });
      }
      return true;
    }

    case 'GET /regulatory/uae-rules': {
      // The rule book as data: every rule with its instrument, its clause and both languages, and the
      // decisions taken under it. Nothing here is a summary of the rules — this is the rules.
      json(res, 200, uaeRuleSnapshot(state.world));
      return true;
    }

    case 'POST /regulatory/uae/check': {
      // A placement put past the rule book. The console runs it with an unrated counterparty so the
      // answer is the honest one an operator meets on a Monday: held for a named human, with the
      // missing evidence named and the clause quoted.
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
          documents: onFile,   // the licence and the plan are on file; the rating nobody has seen is the point
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
      if (!facts) { json(res, 400, { error: `no placement scenario called ${scenario}` }); return true; }
      try {
        const decision = state.world.rules.enforce(facts);
        json(res, 200, {
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
        json(res, err instanceof UaeRuleError ? 409 : 500, { error: String((err as Error).message) });
      }
      return true;
    }

    case 'GET /extracts': {
      // The issued returns, the actuary's exhibits and the bordereaux, exactly as they were issued.
      json(res, 200, extractSnapshot(state.world));
      return true;
    }

    case 'POST /extracts/issue': {
      // A later transaction moves the figures, and the return is issued again: the previous version is
      // kept, the new one says what changed, and nothing is quietly rewritten.
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
      json(res, 200, {
        created: result.created, extractId: result.extract.id, version: result.extract.version,
        supersedes: result.extract.supersedes, fingerprint: result.extract.fingerprint,
        tiesToBooks: result.extract.tiesToBooks,
        differences: result.extract.controls.filter((c) => c.state === 'difference').length,
        changesSummary: result.extract.changesSummary, claimedEvent,
      });
      return true;
    }

    case 'POST /extracts/verify': {
      const id = String(payload['extractId'] ?? extractSnapshot(state.world).conventional.id);
      json(res, 200, state.world.extracts.verify(id));
      return true;
    }

    case 'GET /reinsurance/security': {
      // The security statement on its own: who owes what, who has secured it, and what is missing.
      json(res, 200, reinsuranceSnapshot(state.world).security);
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

    case 'POST /reinsurance/settle': {
      // The counterparty pays: the receivable becomes cash, and a part settlement is fine.
      const ageing = state.world.reinsurance.ageing({ asOf: state.world.asOf });
      const target = String(payload['recoveryId'] ?? ageing.items[0]?.recoveryId ?? '');
      const result = state.world.reinsurance.settleRecovery({
        recoveryId: target,
        at: String(payload['at'] ?? `${state.world.asOf}T14:00:00+04:00`),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        by: String(payload['by'] ?? 'treasury'),
      });
      json(res, 200, {
        recoveryId: result.recoveryId, settled: formatAmount(result.settled),
        outstanding: formatAmount(result.outstanding), journalId: result.journalId ?? null,
      });
      return true;
    }

    case 'POST /reinsurance/event': {
      // One more catastrophe on the motor book: the layer responds, and it eats the cover until the
      // treaty is reinstated. Pressing it twice without reinstating is refused, which is the point.
      const eventId = String(payload['eventId'] ?? `STORM-${new Date().getUTCFullYear()}-${state.world.reinsurance.eventRecoveryList().length + 1}`);
      const result = state.world.reinsurance.recoverEvent('XOL-CAT-5M', {
        eventId,
        loss: parseAmount(String(payload['loss'] ?? '1,600,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T11:00:00+04:00`),
        by: String(payload['by'] ?? 'catastrophe-desk'),
      });
      json(res, 200, {
        eventId, amount: formatAmount(result.amount), treatment: result.treatment,
        consumed: formatAmount(result.cover.consumed), available: formatAmount(result.cover.available),
        reinstatementsLeft: result.cover.reinstatementsLeft,
      });
      return true;
    }

    case 'POST /reinsurance/reinstate': {
      const reinstatement = state.world.reinsurance.reinstate('XOL-CAT-5M', {
        at: String(payload['at'] ?? `${state.world.asOf}T12:00:00+04:00`),
        ...(payload['restore'] ? { restore: parseAmount(String(payload['restore']), 'AED') } : {}),
        by: String(payload['by'] ?? 'reinsurance/desk'),
      });
      json(res, 200, {
        treatyId: reinstatement.treatyId, sequence: reinstatement.sequence, restored: formatAmount(reinstatement.restored),
        premium: formatAmount(reinstatement.premium), free: reinstatement.free,
        available: formatAmount(reinstatement.available), journalId: reinstatement.journalId ?? null,
      });
      return true;
    }

    case 'POST /reinsurance/deposit': {
      // A further deposit instalment. Once the period is settled the engine refuses, because a new
      // deposit belongs to the next period — not to this one.
      const next = state.world.reinsurance.depositAccount('AGG-SL-DEPOSIT');
      const instalment = next.adjustments.length + 1;
      const account = state.world.reinsurance.openDeposit('AGG-SL-DEPOSIT', {
        amount: parseAmount(String(payload['amount'] ?? '100,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T13:00:00+04:00`),
        instalment,
      });
      json(res, 200, {
        treatyId: account.treatyId, instalment, depositPaid: formatAmount(account.depositPaid),
        treatment: account.treatment, assetRemaining: formatAmount(account.assetRemaining),
      });
      return true;
    }

    case 'POST /reinsurance/deposit/settle': {
      const account = state.world.reinsurance.settleDeposit('AGG-SL-DEPOSIT', {
        subjectPremium: parseAmount(String(payload['subjectPremium'] ?? '8,000,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T15:00:00+04:00`),
        ...(payload['rateOnLineBps'] ? { rateOnLineBps: Number(payload['rateOnLineBps']) } : {}),
      });
      json(res, 200, {
        treatyId: account.treatyId, depositPaid: formatAmount(account.depositPaid),
        technicalPremium: account.technicalPremium ? formatAmount(account.technicalPremium) : null,
        settled: account.settled, assetRemaining: formatAmount(account.assetRemaining),
        adjustment: account.adjustments.at(-1) ? {
          kind: account.adjustments.at(-1)!.kind, amount: formatAmount(account.adjustments.at(-1)!.amount),
        } : null,
      });
      return true;
    }

    case 'POST /reinsurance/security/hold': {
      // Security arrives: cash, premium withheld, a letter of credit or a guarantee. Cash and withheld
      // premium move the books; a letter of credit is recorded and disclosed, never posted as money.
      const instrument = state.world.reinsurance.holdSecurity({
        counterparty: String(payload['counterparty'] ?? 'Emirates Re'),
        kind: String(payload['kind'] ?? 'cash') as 'cash' | 'funds-withheld' | 'letter-of-credit' | 'bank-guarantee',
        amount: parseAmount(String(payload['amount'] ?? '10,000.00'), 'AED'),
        at: String(payload['at'] ?? `${state.world.asOf}T09:00:00+04:00`),
        reference: String(payload['reference'] ?? `SEC-${new Date().toISOString().slice(0, 10)}`),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['treatyId'] ? { treatyId: String(payload['treatyId']) } : {}),
        ...(payload['expiresAt'] ? { expiresAt: String(payload['expiresAt']) } : {}),
      });
      json(res, 200, {
        instrumentId: instrument.id, counterparty: instrument.counterparty, kind: instrument.kind,
        amount: formatAmount(instrument.amount), onBalanceSheet: instrument.onBalanceSheet,
        reference: instrument.reference, expiresAt: instrument.expiresAt ?? null,
        journalId: instrument.journalId ?? null,
      });
      return true;
    }

    case 'POST /reinsurance/security/call': {
      // Call the shortfall, and only the shortfall: the engine refuses more, or a second call for the
      // same gap while the first is still unanswered.
      const call = state.world.reinsurance.callSecurity({
        counterparty: String(payload['counterparty'] ?? 'Emirates Re'),
        at: String(payload['at'] ?? `${state.world.asOf}T11:00:00+04:00`),
        reason: String(payload['reason'] ?? 'security held is below what the treaties require'),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        ...(payload['dueInDays'] ? { dueInDays: Number(payload['dueInDays']) } : {}),
      });
      json(res, 200, {
        callId: call.id, counterparty: call.counterparty, amount: formatAmount(call.amount),
        shortfallAtRaise: formatAmount(call.shortfallAtRaise), reason: call.reason,
        at: call.at, dueBy: call.dueBy, status: call.status,
      });
      return true;
    }

    case 'POST /reinsurance/security/call/settle': {
      // The counterparty answers, in cash or with an instrument. A part answer leaves the call open.
      const open = state.world.reinsurance.cashCallList().filter((c) => c.status !== 'settled');
      const callId = String(payload['callId'] ?? open[0]?.id ?? '');
      const result = state.world.reinsurance.settleCall({
        callId,
        at: String(payload['at'] ?? `${state.world.asOf}T15:30:00+04:00`),
        kind: String(payload['kind'] ?? 'cash') as 'cash' | 'funds-withheld' | 'letter-of-credit' | 'bank-guarantee',
        reference: String(payload['reference'] ?? 'CALL-ANSWER'),
        by: String(payload['by'] ?? 'treasury'),
        ...(payload['amount'] ? { amount: parseAmount(String(payload['amount']), 'AED') } : {}),
        ...(payload['expiresAt'] ? { expiresAt: String(payload['expiresAt']) } : {}),
      });
      json(res, 200, {
        callId: result.call.id, status: result.call.status, asked: formatAmount(result.call.amount),
        settled: formatAmount(result.call.settled),
        outstanding: formatAmount({ minor: result.call.amount.minor - result.call.settled.minor, currency: 'AED' }),
        instrumentId: result.instrument.id, instrumentKind: result.instrument.kind,
        instrumentAmount: formatAmount(result.instrument.amount), journalId: result.instrument.journalId ?? null,
      });
      return true;
    }

    case 'POST /reinsurance/security/release': {
      // Give security back. A release that would leave the exposure unsecured needs a name against it,
      // and both the release and the waiver are reported afterwards.
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
      json(res, 200, {
        instrumentId: result.instrument.id, counterparty: result.instrument.counterparty,
        kind: result.instrument.kind, released: formatAmount(result.released),
        remaining: formatAmount({ minor: result.instrument.amount.minor - result.instrument.released.minor, currency: 'AED' }),
        journalId: result.journalId ?? null,
      });
      return true;
    }

    case 'POST /reinsurance/security/interest': {
      // Interest on cash held as security belongs to the counterparty — unless the treaty is retakaful,
      // where a return on cash posted for a participant's risk would be riba and is refused outright.
      const register = String(payload['basis'] ?? 'conventional') === 'takaful' ? state.world.retakaful : state.world.reinsurance;
      const cash = register.securityPositions(state.world.asOf)
        .flatMap((p) => p.instruments).find((i) => i.kind === 'cash' && i.onBalanceSheet);
      const result = register.creditCollateralInterest({
        instrumentId: String(payload['instrumentId'] ?? cash?.id ?? ''),
        at: String(payload['at'] ?? `${state.world.asOf}T16:30:00+04:00`),
        amount: parseAmount(String(payload['amount'] ?? '250.00'), 'AED'),
        by: String(payload['by'] ?? 'treasury'),
      });
      json(res, 200, {
        instrumentId: result.instrument.id, counterparty: result.instrument.counterparty,
        interest: formatAmount(result.instrument.interest), journalId: result.journalId,
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
