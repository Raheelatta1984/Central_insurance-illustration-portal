/**
 * Refresh the offline replay recording with the guided customer journey.
 *
 * The console ships as one file (demo/offline.html) that replays recorded API answers, so a new
 * endpoint that is not in the recording shows up as "not captured". This walks the live server the
 * same way the console does — the world snapshot, the journey catalogue, and a full lifecycle from
 * onboarding to investment progress on a fresh case — and merges the answers into the recording.
 *
 *   npm start          (in another shell)
 *   node tools/offline-record-journey.mjs
 *   npm run demo:offline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:8787';
const FILE = resolve(ROOT, 'demo/offline-responses.json');

const record = JSON.parse(readFileSync(FILE, 'utf8'));

function bodyHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
const keyOf = (method, path, body) => `${method} ${path}${body === undefined ? '' : ` ${bodyHash(typeof body === 'string' ? body : JSON.stringify(body))}`}`;

let added = 0;
async function capture(method, path, body, { bare = false } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const entry = { status: res.status, body: parsed };
  record.responses[keyOf(method, `/api${path}`, body)] = entry;
  if (bare || body === undefined) record.responses[`${method} /api${path}`] = entry;
  if (body !== undefined) {
    record.requestBodies = record.requestBodies ?? {};
    record.requestBodies[keyOf(method, `/api${path}`, body)] = body;
  }
  added += 1;
  return parsed;
}

/* ------------------------------------------------------------------ the reads the console makes */
const reads = [
  '/health', '/world', '/journey', '/underwriting', '/claims', '/reinsurance', '/reinsurance/security',
  '/group', '/state', '/state/registers', '/reporting/store', '/reporting/outbox',
  '/reporting/outbox?since=0&limit=5', '/submissions', '/wording', '/extracts',
  '/regulatory/uae-rules', '/idempotency', '/units', '/ledger/proof',
];
for (const path of reads) await capture('GET', path);

/* ------------------------------------------------- a whole lifecycle, on a case of its own */
const opened = await capture('POST', '/journey/open', { customerName: 'Noura Saeed Al Zaabi', country: 'AE', by: 'offline-recording' }, { bare: true });
const caseId = opened.caseId;

const steps = [
  ['identity', { kind: 'person', nameEn: 'Noura Saeed Al Zaabi', nameAr: 'نورة الزعابي', dateOfBirth: '1993-03-08', idType: 'emirates-id', idNumber: '784-1993-2233445-6', idSource: 'chip', phone: '+971 50 778 9900', email: 'noura.zaabi@example.ae', addressLine: 'Corniche Tower, Apt 1204', city: 'Abu Dhabi', country: 'AE', consentTo: 'DXB-BROKER-01' }],
  ['profile', { contactConfirmed: true, duplicateChecked: true, consentScopes: ['customer.exists', 'customer.name', 'customer.contact', 'customer.holdings'], dataResidency: 'in-country', taxResidence: 'AE', taxId: 'AE-TIN-1993-2233445', preferedChannel: 'portal' }],
  ['needs', { country: 'AE', attestationAgreed: true, answers: [
    { questionId: 'residence-country', value: 'AE' }, { questionId: 'dependants', value: 2 },
    { questionId: 'annual-income', value: 480000 }, { questionId: 'existing-cover', value: 3900000 },
    { questionId: 'outstanding-debt', value: 600000 }, { questionId: 'premium-budget', value: 60000 },
    { questionId: 'objective', value: 'family-protection' }, { questionId: 'risk-appetite', value: 'growth' },
    { questionId: 'shariah-preferred', value: false }, { questionId: 'age', value: 41 },
    { questionId: 'smoker', value: false }, { questionId: 'medical-conditions', value: false },
    { questionId: 'occupation-class', value: '2' },
  ] }],
  ['recommendation', { productId: 'PROD-UL-GLOBAL', alternativesPresented: true, customerAccepted: true, recommendationNote: 'Growth appetite with income to replace and a mortgage to cover: the unit-linked plan answers both inside the stated budget.' }],
  ['coverage', { sumAssured: '1020000', termYears: 20, paymentFrequency: 'annual', annualIncome: '480000', age: 41, sex: 'female', smoker: false, heightCm: 168, weightKg: 62, residenceCountry: 'AE' }],
  ['loadings', { occupationClass: '3', occupationTitle: 'Marine logistics supervisor, work at height on the quayside', conditions: ['hypertension-controlled'], pursuits: ['scuba-diving'], familyHistory: [], loadingReviewedBy: 'underwriter-1', loadingAcknowledged: true }],
  ['riders', { ridersConsidered: true, riders: ['critical-illness', 'waiver-of-premium'], withoutLoading: ['waiver-of-premium'], waiverBy: 'chief-underwriter', waiverReason: 'Waived under the corporate scheme agreement dated 2026-09-30', ridersAcknowledged: true }],
  ['medical', { requirementsOrdered: true, reviewedBy: 'underwriter-1', reviewNote: 'Every requirement received from the treating physician and read against the manual.', results: [
    { label: 'blood profile', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'urine analysis', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'recent blood pressure readings', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Occupation and duties declaration', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Critical illness questionnaire', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Signed acknowledgement of the exclusion "Death while scuba diving below 30 metres"', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
  ] }],
  ['funds', { weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }], appetiteAcknowledged: true, dealingAcknowledged: true }],
  ['beneficiaries', { beneficiaries: [
    { name: 'Saeed Al Zaabi', relationship: 'father', sharePct: 60, kind: 'primary' },
    { name: 'Hessa Al Zaabi', relationship: 'daughter', sharePct: 40, kind: 'primary', dateOfBirth: '2015-04-02', guardian: 'Saeed Al Zaabi' },
  ], customerConfirmed: true }],
  ['uw-review', { questionnaireReviewed: true, questionnaireUpdatedBy: 'underwriter-1', questionnaireNotes: 'Questionnaire reviewed against the evidence on file; hypertension confirmed controlled on medication.', decisionOutcome: 'rated', decidedBy: 'senior-underwriter', decidedByAi: false, acceptedReferrals: ['occupation-referral'] }],
  ['quotation', { issue: true, emailTo: 'noura.zaabi@example.ae', emailLanguage: 'both', sendEmail: true, buyLinkSent: true }],
  ['finalisation', { coolingOffAcknowledged: true, reviewedWithCustomer: true, signedBy: 'Noura Saeed Al Zaabi', signedAt: '2026-10-05' }],
];

let due = '49,219.49';
let quotationId = null;
for (const [stageId, answers] of steps) {
  const result = await capture('POST', '/journey/submit', { caseId, stageId, answers, by: 'offline-recording' }, { bare: true });
  if (!result.accepted) console.log(`  ! ${stageId} refused: ${result.reason}`);
  if (stageId === 'quotation') {
    due = String(result.detail.totalPayable).replace(' AED', '');
    quotationId = result.detail.quotationId;
  }
  console.log(`  ${result.accepted ? '✓' : '✗'} ${stageId} → ${result.progress.nextRecommendedTitle ?? 'complete'}`);
}

await capture('POST', '/journey/quotation/pdf', { quotationId }, { bare: true });
await capture('POST', '/journey/save', { caseId, stageId: 'payment', answers: { method: 'credit-card', amount: due }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'payment', answers: { method: 'credit-card', amount: due, pan: '4111 1111 1111 1111', expiry: '09/2029', authentication: 'sca-3ds' }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'routing', answers: { routeConfirmed: true, confirmedBy: 'senior-underwriter', engageFreelance: true, freelanceAcceptedBy: 'chief-underwriter', seniorSignOff: 'chief-underwriter' }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'conversion', answers: { convert: true, convertedBy: 'policy-issue-desk', commencement: '2026-10-05', initialFundId: 'FGLOBAL' }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'allocation', answers: { allocationReviewed: true, reviewedBy: 'fund-administrator', reviewedAt: '2026-10-05', rebalanceRequested: true, rebalanceNote: 'Rebalance the first contribution back to the signed 60/40 target weights at the next dealing valuation.' }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'investment', answers: { progressReviewed: true, statementSent: true, reviewedBy: 'fund-administrator' }, by: 'offline-recording' }, { bare: true });
await capture('POST', '/journey/submit', { caseId, stageId: 'servicing', answers: { handoverAcknowledged: true, serviceChannel: 'portal', handoverBy: 'policy-servicing' }, by: 'offline-recording' }, { bare: true });

/* ------------------------------------------------------------------ write it back
 * The offline console runs the engine in the browser (src/ui/api.ts dispatches locally whenever
 * window.__OFFLINE__ is set), so the recording is a manifest of what was captured rather than the
 * data the page reads. One answer per endpoint is enough: keeping a 50 KB response per submit body
 * would double the size of demo/offline.html for nothing.
 */
for (const key of Object.keys(record.responses)) {
  if (/^POST \/api\/journey\/.* [0-9a-f]{8}$/.test(key)) {
    delete record.responses[key];
    if (record.requestBodies) delete record.requestBodies[key];
  }
}
record.capturedAt = new Date().toISOString();
record.note = `${record.note ?? ''} Refreshed with the guided customer journey (GET /api/journey and the whole POST /api/journey/submit sequence) on ${record.capturedAt}.`;
writeFileSync(FILE, JSON.stringify(record, null, 2));   // same shape tools/offline-record.mjs writes
console.log(`offline-record-journey: ${added} responses captured, ${Object.keys(record.responses).length} in the recording`);
