#!/usr/bin/env node
/**
 * mail-smoke.mjs — prove a quotation email really leaves the building, without touching a real
 * mailbox.
 *
 * The portal talks to Google with two calls: an OAuth2 refresh at the token endpoint and a
 * `messages/send` at the Gmail API. This tool stands up a stand-in for both on localhost, points
 * the mailer at it, walks a whole customer journey to the quotation stage with "send the email"
 * ticked, and inspects the message Google would have received: the MIME envelope, the address,
 * the bilingual body and the PDF attachment. It then makes Google refuse once, to prove a failed
 * delivery is recorded honestly rather than swallowed.
 *
 *   npm run build:server && npm run mail:smoke
 *
 * Nothing here is mocked inside the product: the engine, the PDF writer and the mailer are the
 * real ones. Only the two HTTPS calls are answered by the stand-in. Exit code 0 means every
 * assertion held.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = process.cwd();
const routesServerPath = resolve(ROOT, 'dist-server/core/routes.js');
if (!existsSync(routesServerPath)) throw new Error('build the server first: npm run build:server');

/* --------------------------------------------------- the stand-in for Google ---------------- */

const inbox = [];
let refuseNext = false;

const google = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== 'smoke-client-id' || !form.get('refresh_token')) {
        return send(400, { error: 'invalid_grant', error_description: 'the smoke test sent bad credentials' });
      }
      return send(200, { access_token: 'smoke-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    const sendMatch = /^\/gmail\/v1\/users\/([^/]+)\/messages\/send$/.exec(url.pathname);
    if (sendMatch) {
      if ((req.headers.authorization ?? '') !== 'Bearer smoke-access-token') return send(401, { error: { message: 'Invalid Credentials' } });
      if (refuseNext) {
        refuseNext = false;
        return send(403, { error: { message: 'Mail service not enabled', status: 'PERMISSION_DENIED' } });
      }
      const raw = JSON.parse(body).raw ?? '';
      const mime = Buffer.from(raw, 'base64url').toString('utf8');
      inbox.push({ to: sendMatch[1], mime, at: new Date().toISOString() });
      return send(200, { id: `smoke-message-${inbox.length}`, threadId: 'smoke-thread-1', labelIds: ['SENT'] });
    }
    return send(404, { error: { message: `no stand-in route for ${url.pathname}` } });
  });
});

await new Promise((done) => google.listen(0, '127.0.0.1', done));
const port = google.address().port;
const base = `http://127.0.0.1:${port}`;

/* --------------------------------------------------- the engine, with the mailer pointed at it */

const require = createRequire(import.meta.url);
const { createRuntimeState, dispatchApiRoute } = require(routesServerPath);

const env = {
  MAIL_FROM: 'Quotations <quotations@central-insurance.example>',
  GOOGLE_CLIENT_ID: 'smoke-client-id',
  GOOGLE_CLIENT_SECRET: 'smoke-client-secret',
  GOOGLE_REFRESH_TOKEN: 'smoke-refresh-token',
  GOOGLE_TOKEN_URL: `${base}/token`,
  GMAIL_API_BASE_URL: base,
  MAIL_FROM_NAME: 'Central Insurance quotations',
};
const state = createRuntimeState(1, undefined, env);
const call = async (method, path, payload = {}, search = {}) => dispatchApiRoute(
  state, method, path, new URLSearchParams(search), payload,
);

let failures = 0;
const check = (label, held, detail = '') => {
  console.log(`  ${held ? '✓' : '✗'} ${label}${held || !detail ? '' : ` — ${detail}`}`);
  if (!held) failures += 1;
};

console.log('mail smoke: standing in for Google on ' + base);

/* --------------------------------------------------- 1. the mailer says it is live ------------ */

const status = (await call('GET', '/mail/status')).body;
check('the transport is the Gmail API', status.kind === 'gmail-api', status.kind);
check('the mailer reports itself configured', status.configured === true, status.reason);
check('the session starts empty', status.sent === 0 && status.failed === 0);
check('no secret is exposed on the status screen', Object.values(status.env).every((v) => v === 'set' || v === 'missing'));

/* --------------------------------------------------- 2. a test email reaches the stand-in ---- */

const test = await call('POST', '/mail/test', { to: 'desk@central-insurance.example', by: 'mail-smoke' });
check('the test email is sent', test.body.delivery?.status === 'sent', JSON.stringify(test.body.delivery));
check('the test email carries the provider message id', typeof test.body.delivery?.providerMessageId === 'string');
const bad = await call('POST', '/mail/test', { to: 'not-an-address', by: 'mail-smoke' });
check('a malformed address is refused', bad.status === 400, `status ${bad.status}`);

/* --------------------------------------------------- 3. a real quotation is emailed ---------- */

const steps = [
  ['identity', { kind: 'person', nameEn: 'Noura Saeed Al Zaabi', nameAr: 'نورة الزعابي', dateOfBirth: '1993-03-08', idType: 'emirates-id', idNumber: '784-1993-2233445-6', idSource: 'chip', phone: '+971 50 778 9900', email: 'noura.zaabi@example.ae', addressLine: 'Corniche Tower, Apt 1204', city: 'Abu Dhabi', country: 'AE', consentTo: 'DXB-BROKER-01' }],
  ['profile', { contactConfirmed: true, duplicateChecked: true, consentScopes: ['customer.exists', 'customer.name', 'customer.contact'], dataResidency: 'in-country', taxResidence: 'AE', taxId: 'AE-TIN-1993-2233445', preferedChannel: 'portal' }],
  ['needs', { country: 'AE', attestationAgreed: true, answers: [
    { questionId: 'residence-country', value: 'AE' }, { questionId: 'dependants', value: 2 },
    { questionId: 'annual-income', value: 480000 }, { questionId: 'existing-cover', value: 3900000 },
    { questionId: 'outstanding-debt', value: 600000 }, { questionId: 'premium-budget', value: 60000 },
    { questionId: 'objective', value: 'family-protection' }, { questionId: 'risk-appetite', value: 'growth' },
    { questionId: 'shariah-preferred', value: false }, { questionId: 'age', value: 41 },
    { questionId: 'smoker', value: false }, { questionId: 'medical-conditions', value: false },
    { questionId: 'occupation-class', value: '2' },
  ] }],
  ['recommendation', { productId: 'PROD-UL-GLOBAL', alternativesPresented: true, customerAccepted: true, recommendationNote: 'Growth appetite with income to replace and a mortgage to cover.' }],
  ['coverage', { sumAssured: '1020000', termYears: 20, premiumPayingTermYears: 10, paymentFrequency: 'annual', annualIncome: '480000', age: 41, sex: 'female', smoker: false, heightCm: 168, weightKg: 62, residenceCountry: 'AE' }],
  ['loadings', { occupationClass: '3', occupationTitle: 'Marine logistics supervisor', conditions: ['hypertension-controlled'], pursuits: ['scuba-diving'], familyHistory: [], loadingReviewedBy: 'underwriter-1', loadingAcknowledged: true }],
  ['riders', { ridersConsidered: true, riders: ['critical-illness', 'waiver-of-premium'], withoutLoading: ['waiver-of-premium'], waiverBy: 'chief-underwriter', waiverReason: 'Waived under the corporate scheme agreement', ridersAcknowledged: true }],
  ['medical', { requirementsOrdered: true, reviewedBy: 'underwriter-1', reviewNote: 'Every requirement received and read against the manual.', results: [
    { label: 'blood profile', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'urine analysis', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'recent blood pressure readings', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Occupation and duties declaration', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Critical illness questionnaire', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
    { label: 'Signed acknowledgement of the exclusion "Death while scuba diving below 30 metres"', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' },
  ] }],
  ['funds', { weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }], appetiteAcknowledged: true, dealingAcknowledged: true }],
  ['beneficiaries', { beneficiaries: [{ name: 'Saeed Al Zaabi', relationship: 'father', sharePct: 60, kind: 'primary' }, { name: 'Hessa Al Zaabi', relationship: 'daughter', sharePct: 40, kind: 'primary', dateOfBirth: '2015-04-02', guardian: 'Saeed Al Zaabi' }], customerConfirmed: true }],
  ['uw-review', { questionnaireReviewed: true, questionnaireUpdatedBy: 'underwriter-1', questionnaireNotes: 'Reviewed against the evidence on file.', decisionOutcome: 'rated', decidedBy: 'senior-underwriter', decidedByAi: false, acceptedReferrals: ['occupation-referral'] }],
  ['quotation', { issue: true, emailTo: 'noura.zaabi@example.ae', emailLanguage: 'both', sendEmail: true, buyLinkSent: true }],
];

const opened = (await call('POST', '/journey/open', { customerName: 'Noura Saeed Al Zaabi', country: 'AE', by: 'mail-smoke' })).body;
const caseId = opened.caseId;
let quotation = null;
for (const [stageId, answers] of steps) {
  const res = await call('POST', '/journey/submit', { caseId, stageId, answers, by: 'mail-smoke' });
  if (stageId === 'quotation') quotation = res.body;
  else if (!res.body.accepted) console.log(`  ! ${stageId} refused: ${res.body.reason}`);
}

check('the quotation stage was accepted', Boolean(quotation?.accepted), quotation?.reason);
const delivery = quotation?.delivery;
check('the quotation was delivered', delivery?.status === 'sent', JSON.stringify(delivery));
check('the delivery names the provider message', typeof delivery?.providerMessageId === 'string');

const illustration = quotation?.detail?.illustration;
check('the quotation carries an illustration', typeof illustration === 'object' && illustration !== null);
check('the illustration runs the full benefit term', Number(illustration?.yearly?.at(-1)?.[0]) === 20,
  `last row ${JSON.stringify(illustration?.yearly?.at(-1))}`);
check('there is one row per benefit year', illustration?.yearly?.length === 20, String(illustration?.yearly?.length));
check('the illustration shows the paying term the customer chose', /for 10 year\(s\).*cover running for 20 year\(s\)/.test(String(illustration?.paymentTermsLabel ?? '')), String(illustration?.paymentTermsLabel));
check('the illustration shows three scenarios', illustration?.scenarios?.length === 3, String(illustration?.scenarios?.length));

/* --------------------------------------------------- 4. what Google actually received -------- */

const last = inbox[inbox.length - 1];
check('a message reached the Gmail send endpoint', Boolean(last), `${inbox.length} message(s) received`);
if (last) {
  const mime = last.mime;
  check('the envelope is addressed to the customer', /^To: .*noura\.zaabi@example\.ae/m.test(mime));
  check('the envelope names the sender', /^From: .*quotations@central-insurance\.example/m.test(mime));
  check('the message is multipart', /Content-Type: multipart\/mixed; boundary=/.test(mime));
  check('the body carries a plain-text part', /Content-Type: text\/plain/i.test(mime));
  check('the body carries an html part', /Content-Type: text\/html/i.test(mime));
  check('the two body parts are alternatives, not attachments', /Content-Type: multipart\/alternative; boundary=/.test(mime));
  check('the plain part is offered before the html part',
    mime.indexOf('Content-Type: text/plain') < mime.indexOf('Content-Type: text/html'));
  check('the PDF is attached', /Content-Type: application\/pdf; name="[^"]+\.pdf"/.test(mime));
  check('the attachment is a disposition, not a body part', /Content-Disposition: attachment; filename="[^"]+\.pdf"/.test(mime));
  check('the attachment is base64', /Content-Transfer-Encoding: base64/.test(mime));

  writeFileSync(resolve(ROOT, 'tmp/mail-smoke-message.eml'), mime);

  const attach = /------=_Part_[0-9a-f]+\r?\nContent-Type: application\/pdf; name="([^"]+)"[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(mime);
  check('the attachment decodes', Boolean(attach));
  if (attach) {
    const pdf = Buffer.from(attach[2].replace(/\r?\n/g, ''), 'base64');
    check('the attachment is a real PDF', pdf.subarray(0, 5).toString('latin1') === '%PDF-', pdf.subarray(0, 8).toString('latin1'));
    check('the PDF names the customer', pdf.toString('latin1').includes('Noura'), `${pdf.length} bytes`);
    mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
    writeFileSync(resolve(ROOT, 'tmp/mail-smoke-quotation.pdf'), pdf);
    console.log(`    attachment written to tmp/mail-smoke-quotation.pdf (${pdf.length} bytes, ${attach[1]})`);
  }
}

/* --------------------------------------------------- 5. a refusal is recorded, not swallowed - */

const quotationId = quotation?.artefacts?.quotationId ?? '';
check('the quotation stage produced a quotation id', quotationId !== '', quotationId);
refuseNext = true;
const refused = quotationId === ''
  ? { body: { delivery: null } }
  : await call('POST', '/journey/quotation/email', { quotationId, by: 'mail-smoke' });
check('a refusal is reported as failed', refused.body.delivery?.status === 'failed', JSON.stringify(refused.body.delivery));
check('a refusal carries the provider reason', typeof refused.body.delivery?.error === 'string' && refused.body.delivery.error.length > 0);

const after = (await call('GET', '/mail/status')).body;
check('the session counts both outcomes', after.sent >= 2 && after.failed === 1, `sent ${after.sent}, failed ${after.failed}`);
check('the history records the last attempt', after.last?.status === 'failed', String(after.last?.status));
check('the history is listed newest first', after.history[0]?.status === 'failed', String(after.history[0]?.status));

/* --------------------------------------------------- 6. the illustration preview endpoint ---- */

const preview = await call('POST', '/journey/illustration/preview', {
  productId: 'PROD-UL-GLOBAL', sumAssured: '500000', termYears: 30, premiumPayingTermYears: 15, entryAge: 35,
  premiumPerFrequency: '49,219.49', by: 'mail-smoke',
});
check('a preview can be built before the quotation', preview.status === 200 && preview.body.illustration?.yearly?.length === 30,
  `status ${preview.status}, rows ${preview.body.illustration?.yearly?.length}`);
check('the preview projects a positive fund', /[1-9]/.test(String(preview.body.illustration?.headline ?? '')),
  String(preview.body.illustration?.headline));
check('the preview names where its rates came from', typeof preview.body.rates?.sources === 'object',
  JSON.stringify(preview.body.rates?.sources));
const unfiled = await call('POST', '/journey/illustration/preview', {
  productId: 'PROD-NOT-FILED', sumAssured: '500000', termYears: 20, entryAge: 35, by: 'mail-smoke',
});
check('a product that is not filed is refused', unfiled.status === 400, `status ${unfiled.status}`);

google.close();
console.log(failures === 0 ? '\nmail smoke: every check held.' : `\nmail smoke: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
