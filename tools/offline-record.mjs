/**
 * Record the API conversation the console has with the engine, so the console can be shipped as a
 * single file that runs with no server and no tunnel.
 *
 * It drives the real app against the running server and stores every /api response it sees,
 * keyed by method + path, plus the initial world snapshot. `tools/offline-build.mjs` then embeds
 * that recording into `demo/offline.html`, where a fetch shim replays it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:8787';
const grab = new Map();          // "METHOD /path" -> response body
const bodies = new Map();        // "METHOD /path" -> request body (for the manifest)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(page, label) {
  const ok = await page.evaluate((wanted) => {
    const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent ?? '').trim().toLowerCase().endsWith(wanted.toLowerCase()));
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no tab ${label}`);
  await page.waitForTimeout(900);
}

async function press(page, text, nth = 0) {
  const ok = await page.evaluate(({ wanted, index }) => {
    const buttons = [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes(wanted));
    if (!buttons[index]) return false;
    buttons[index].click();
    return true;
  }, { wanted: text, index: nth });
  await page.waitForTimeout(1800);
  return ok;
}

/* Read before anything is pressed: the security statement is most informative as it stands, with a
   shortfall open, a call unanswered and a surplus everybody has forgotten about. */

/* The replay keys a response by method, path and — when a body was sent — the body itself. Without
   the body in the key, three different drafts through the same endpoint would replay as one. */
function bodyHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const keyOf = (method, path, body) => `${method} ${path}${body === undefined ? '' : ` ${bodyHash(typeof body === 'string' ? body : JSON.stringify(body))}`}`;

async function direct(method, path, body) {
  const key = keyOf(method, `/api${path}`, body);
  if (grab.has(key)) return;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = { note: 'non-JSON response' }; }
  grab.set(key, { status: res.status, body: parsed });
  if (body !== undefined) bodies.set(key, body);
  console.log(`   direct ${key} → ${res.status}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('response', async (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith('/api')) return;
  const sent = response.request().postData();
  const key = keyOf(response.request().method(), url.pathname, sent ?? undefined);   // e.g. "GET /api/world"
  const bare = `${response.request().method()} ${url.pathname}`;
  if (grab.has(key) && response.request().method() === 'GET') return;      // keep the first GET
  try {
    const body = await response.json();
    grab.set(key, { status: response.status(), body });
    if (sent) { bodies.set(key, JSON.parse(sent)); if (!grab.has(`${bare} (first)`)) grab.set(`${bare} (first)`, { status: response.status(), body }); }
  } catch { /* not JSON: skip */ }
});

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('nav button');
await sleep(1200);

await direct('GET', '/reinsurance/security');
await direct('GET', '/regulatory/uae-rules');
await direct('GET', '/wording');
await direct('GET', '/submissions');
await direct('GET', '/extracts');
const issued = grab.get('GET /api/extracts')?.body;
await direct('POST', '/extracts/verify', issued ? { extractId: issued.conventional.id } : {});
await direct('POST', '/reinsurance/security/call', {
  counterparty: 'Emirates Re', reason: 'the catastrophe recovery is unsecured beyond the letters of credit in force',
});

/* Walk every module and press the things a customer would press. Real button labels, taken from
   the console itself. Each tab starts on a freshly loaded page: the world lives on the server, so
   a reload gives a clean view and stops one failed click from cascading into the rest. */
const script = [
  ['Overview', []],
  ['Policyholder', []],
  ['Decision theatre', ['Price the switch', 'Price the withdrawal']],
  ['Cover control', ['Stop cover', 'Advance the clock one day', 'Start cover now', 'Advance the clock one day']],
  ['Funds & NAV', []],
  ['Takaful', ['Actuary recommends', 'Shariah Committee approves', 'Board endorses', 'Approve']],
  ['Group finance', ['Run the consolidation']],
  ['Underwriting', ['Ask the AI agent to decide']],
  ['Claims', ['Ask the AI to approve 25,000.00', 'Register a new claim']],
  ['Reinsurance', ['Place a risk facultatively', 'Cede a further risk', 'Claim the reinsurance recovery', 'Claim a catastrophe event', 'Reinstate the catastrophe cover', 'Pay a deposit instalment', 'Settle the deposit premium', 'Settle the outstanding recovery', 'Answer the outstanding cash call', 'Release the security we no longer need', 'Credit the interest on their cash', 'Reissue the return after a later event']],
  ['Onboarding', []],
  ['Ingestion', ['Validate & reconcile', 'Commit the accepted rows']],
  ['Parties & consent', ['Ask with consent', 'Ask without consent']],
  ['Regulatory', ['Run the check', 'Check a clean placement', 'Check a placement with an unrated reinsurer', 'Draft the note to the policyholder', "Draft the window's treaty note", 'Draft the cover letter to the supervisor', 'File the return with the supervisor', "Record the supervisor's acknowledgement"]],
  ['AI ledger', ['Approve', 'Execute']],   // Execute only renders once a human has approved the action
  ['Books', []],
  ['Labels & rename', []],
  ['Durability', ['Run durability drill', 'Rebuild every register from the snapshot']],
  ['Tour', ['Start the tour']],
];

for (const [tab, actions] of script) {
  console.log(`→ ${tab}`);
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('nav button', { timeout: 15_000 });
    await sleep(800);
    await openTab(page, tab);
    for (const label of actions) {
      const pressed = await press(page, label);
      console.log(`   ${pressed ? 'pressed' : 'not found:'} ${label}`);
      if (!pressed && label === 'Approve') console.log('   (the surplus "Approve" button only exists once the gates are signed)');
    }
  } catch (err) {
    console.log(`   FAILED on ${tab}: ${String(err).split('\n')[0]}`);
  }
}

/* The console settles the deposit on the Reinsurance tab, and that settlement is what brings the
   recognised premium into the return — so ask for the return once more, after the presses, so the
   recorded draft is the one an operator would see standing at the desk this afternoon. */
await direct('GET', '/extracts');

await direct('POST', '/regulatory/uae/check', { scenario: 'unlicensed-counterparty' });

/* Some responses are only reachable by asking the API directly — a refusal, for instance, which
   the console renders as an error card. Mirror exactly what the console sends. */
const claims = grab.get('GET /api/claims')?.body;
const openClaim = claims?.conventional?.list?.find((c) => c.status === 'approved') ?? claims?.conventional?.list?.[0];
if (openClaim) {
  await direct('POST', '/claims/approve', { claimId: openClaim.id, amount: '25000.00', by: 'agent/claims-triage', role: 'ai-straight-through', isAi: true });
}
await direct('GET', '/health');
await direct('GET', '/ledger/proof');
await direct('GET', '/units');
await direct('POST', '/onboarding/ocr', { documentType: 'emirates-id', fields: { fullName: ['Ahmed Al Mansoori', 'Ahmed Al Mansoori'], idNumber: ['784-1985-1234567-1', '784-1985-1234567-1'] } });
await direct('POST', '/partner/lookup', { withConsent: false });
await direct('POST', '/pre-sale', { productLine: 'medical', hasNeedAnalysis: false, hasNeedId: false });
/* Security: money posted by a counterparty, and a call on a shortfall. Both are the answers the
   engine gives to the desk, recorded exactly as they came back. */
await direct('POST', '/reinsurance/security/hold', {
  counterparty: 'Emirates Re', treatyId: 'XOL-CAT-5M', kind: 'letter-of-credit',
  amount: '25,000.00', reference: 'LC-RECORDED', expiresAt: '2027-03-31', by: 'treasury',
});
await direct('POST', '/reinsurance/security/call', {
  counterparty: 'Emirates Re', reason: 'the catastrophe recovery is unsecured beyond the letters of credit in force',
});

const world = grab.get('GET /api/world')?.body;
await browser.close();

/* The "(first)" markers exist only so a GET recorded before the presses is kept when the same GET is
   made again afterwards; they are not shipped, because the replay answers on method, path and body. */
for (const key of [...grab.keys()]) if (key.endsWith(' (first)')) grab.delete(key);

mkdirSync(resolve(ROOT, 'demo'), { recursive: true });
const record = {
  capturedAt: new Date().toISOString(),
  base: BASE,
  note: 'Recorded from the live engine by tools/offline-record.mjs. The offline console replays these responses so the product can be demonstrated without a server.',
  responses: Object.fromEntries([...grab.entries()].sort()),
  requestBodies: Object.fromEntries([...bodies.entries()].sort()),
};
writeFileSync(resolve(ROOT, 'demo/offline-responses.json'), JSON.stringify(record, null, 2));
console.log(`recorded ${grab.size} endpoint response(s); world snapshot ${world ? 'yes' : 'MISSING'}`);
