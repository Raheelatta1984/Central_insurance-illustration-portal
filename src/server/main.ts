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
import { buildWorld, worldSnapshot, World } from '../core/demo.js';
import { money, formatAmount } from '../core/money.js';
import { AE_PACK, preSaleCheck } from '../core/regulatory.js';
import { ocrDocument } from '../core/onboarding.js';
import { unitsToDecimal } from '../core/units.js';

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
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Insurance ERP API listening on http://${HOST}:${PORT} (serving ${DIST})`);
});
