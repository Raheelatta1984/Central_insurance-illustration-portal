/**
 * Build the customer demo pack: for every module, a screenshot and a short screen recording of the
 * live app doing the thing that module is for.
 *
 * It drives the running console through the same steps as `src/core/tour.ts`, so the pack cannot
 * describe a workflow the product does not have. Run the server first (npm start), then:
 *
 *   npm run demo:pack
 *
 * Output: demo/screens/<module>.png, demo/video/<module>.webm (+ .mp4 when ffmpeg allows),
 * demo/index.html (the gallery), demo/demo-pack.json (the manifest).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:8787';
const SCREENS = resolve(ROOT, 'demo/screens');
const VIDEO = resolve(ROOT, 'demo/video');
const VIEWPORT = { width: 1600, height: 1000 };

mkdirSync(SCREENS, { recursive: true });
mkdirSync(VIDEO, { recursive: true });

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, text, { optional = false, nth = 0 } = {}) {
  const button = page.getByRole('button', { name: text, exact: false }).nth(nth);
  try {
    await button.scrollIntoViewIfNeeded({ timeout: 3000 });
    await button.click({ timeout: 5000 });
    await sleep(700);
    return true;
  } catch (err) {
    if (!optional) console.log(`      ! could not click "${text}" (${String(err).slice(0, 60)})`);
    return false;
  }
}

async function openTab(page, label) {
  // The sidebar is taller than the viewport, so use the DOM directly: this is a capture tool,
  // not a test of the click target.
  const clicked = await page.evaluate((wanted) => {
    const buttons = [...document.querySelectorAll('nav button')];
    const match = buttons.find((b) => (b.textContent ?? '').trim().toLowerCase().endsWith(wanted.toLowerCase()));
    if (!match) return false;
    match.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`no nav button ending with "${label}"`);
  await page.waitForTimeout(1400);   // let the tab render from the live snapshot
}

/* ------------------------------------------------------------------- script */

/** One entry per module: the tour step it belongs to plus the interaction to film. */
const MODULES = [
  { id: 'overview', label: 'Overview', tour: '00:00',
    blurb: 'One tenant, three entities, two currencies: the whole book on one screen, with both entity ledgers proving balanced.' },
  { id: 'policyholder', label: 'Policyholder', tour: '00:04',
    blurb: 'Look-through from a unit-linked policy into the actual instruments it holds — real prices, with the date each price was taken.',
    async script(page) {
      await page.mouse.wheel(0, 700); await sleep(1200);
      await page.mouse.wheel(0, 900); await sleep(1600);
      await page.mouse.wheel(0, -1600); await sleep(600);
    } },
  { id: 'decisions', label: 'Decision theatre', tour: '00:10',
    blurb: 'Price a switch and a withdrawal before anything moves: units, price, valuation date, dealing rule and fees, plus the labelled projection envelopes.',
    async script(page) {
      await clickText(page, 'Preview switch', { optional: true });
      await sleep(1200);
      await page.mouse.wheel(0, 800); await sleep(1400);
      await clickText(page, 'Preview withdrawal', { optional: true });
      await sleep(1400);
    } },
  { id: 'cover', label: 'Cover control', tour: '00:16',
    blurb: 'Micro-duration cover: stop it, advance the clock and watch nothing accrue, start it again and watch only the active days charge.',
    async script(page) {
      await clickText(page, 'Stop cover', { optional: true });
      await sleep(1000);
      await clickText(page, 'Advance the clock', { optional: true });
      await sleep(1600);
      await clickText(page, 'Start cover', { optional: true });
      await sleep(1000);
      await clickText(page, 'Advance the clock', { optional: true });
      await sleep(1600);
      await page.mouse.wheel(0, 500); await sleep(1200);
    } },
  { id: 'funds', label: 'Funds & NAV', tour: '00:21',
    blurb: 'The NAV engine behind every price: cut-off, business days, floor price with a named residual, and a reconciliation that has to tie exactly.' },
  { id: 'takaful', label: 'Takaful', tour: '00:26',
    blurb: 'Three segregated pools, a claim paid from the risk fund with qard hasan, and a surplus blocked until the actuary, the Shariah Committee and the board have signed.',
    async script(page) {
      await page.mouse.wheel(0, 700); await sleep(1200);
      await clickText(page, 'Approve as actuary', { optional: true });
      await sleep(900);
      await clickText(page, 'Approve as Shariah', { optional: true });
      await sleep(900);
      await clickText(page, 'Approve as board', { optional: true });
      await sleep(1500);
    } },
  { id: 'group', label: 'Group finance', tour: '00:32',
    blurb: 'Three entities and two currencies consolidated: closing rate for the balance sheet, average rate for the result, historical rate for equity, intercompany eliminated and a 30% minority stated.',
    async script(page) {
      await page.mouse.wheel(0, 900); await sleep(1200);
      const run = page.getByRole('button', { name: /Run the consolidation/i }).first();
      try { await run.scrollIntoViewIfNeeded(); await run.click({ timeout: 6000 }); await sleep(2200); } catch { /* optional */ }
      await page.mouse.wheel(0, -900); await sleep(1200);
    } },
  { id: 'underwriting', label: 'Underwriting', tour: '00:38',
    blurb: 'A manual held as data: every loading, exclusion and evidence requirement with its reason — and an AI agent that may rate inside its limit but never decline.',
    async script(page) {
      await page.mouse.wheel(0, 1400); await sleep(1200);
      await clickText(page, 'Ask the AI agent to decide', { optional: true });
      await sleep(2000);
      await clickText(page, 'Senior underwriter takes the case', { optional: true });
      await sleep(1800);
    } },
  { id: 'claims', label: 'Claims', tour: '00:43',
    blurb: 'Triage, reserves as booked liabilities, authority-gated approval, settlement releasing the reserve and recoveries as their own income — with a pooled takaful claim paid from the risk fund.',
    async script(page) {
      await page.mouse.wheel(0, 1000); await sleep(1200);
      await clickText(page, 'Ask the AI to approve 25,000.00', { optional: true });
      await sleep(2200);
      await page.mouse.wheel(0, 900); await sleep(1000);
      await clickText(page, 'Register a new claim', { optional: true });
      await sleep(2000);
    } },
  { id: 'reinsurance', label: 'Reinsurance', tour: '00:48',
    blurb: 'Treaty register and utilisation: a quota share, a surplus treaty above a retention, catastrophe cover and a retakaful treaty for the takaful window — ceded premium, commission and recoveries posted to the books, with participant-money segregation enforced in code.',
    async script(page) {
      await page.mouse.wheel(0, 900); await sleep(1200);
      await clickText(page, 'Place a risk facultatively', { optional: true });
      await sleep(2200);
      await clickText(page, 'Claim the reinsurance recovery', { optional: true });
      await sleep(2200);
    } },
  { id: 'durability', label: 'Durability', tour: '00:53',
    blurb: 'Seal the books into a canonical fingerprinted snapshot, rebuild a fresh ledger from that text and compare trial balances — a restore drill, not a promise.',
    async script(page) {
      await clickText(page, 'Run durability drill', { optional: true });
      await sleep(2600);
      await page.mouse.wheel(0, 300); await sleep(1400);
    } },
  { id: 'onboarding', label: 'Onboarding', tour: '00:56',
    blurb: 'Chip read, government lookup and OCR consensus with a per-field review queue, gated until consent and a need analysis are in place.' },
  { id: 'ingest', label: 'Ingestion', tour: '00:56',
    blurb: 'Any shape of file: columns typed from the data, bad rows quarantined with a reason, duplicates suppressed, and a reconciliation a supervisor can sign.',
    async script(page) {
      await clickText(page, 'Submit', { optional: true });
      await sleep(1500);
      await clickText(page, 'Commit', { optional: true });
      await sleep(1800);
      await page.mouse.wheel(0, 700); await sleep(1400);
    } },
  { id: 'parties', label: 'Parties & consent', tour: '00:56',
    blurb: 'A consented cross-party lookup that returns only what was consented to, a refusal when it is not — and an access log with every attempt on it.',
    async script(page) {
      await clickText(page, 'Look up', { optional: true });
      await sleep(1600);
      await page.mouse.wheel(0, 700); await sleep(1400);
    } },
  { id: 'regulatory', label: 'Regulatory', tour: '00:56',
    blurb: 'Per-country pre-sale gates and the motor comparison matrix: why a health sale is blocked without an ID, and how the best-insurer ranking is scored.' },
  { id: 'ai', label: 'AI ledger', tour: '00:56',
    blurb: 'Six prohibited intents, risk-gated approvals and a refusal that stays on the record — governance a regulator can read.',
    async script(page) {
      await page.mouse.wheel(0, 700); await sleep(1200);
      await clickText(page, 'Execute', { optional: true, nth: 0 });
      await sleep(1800);
    } },
  { id: 'ledger', label: 'Books', tour: '00:56',
    blurb: 'The trial balance and journal list for an entity, straight out of the double-entry ledger that every other module posts into.' },
  { id: 'labels', label: 'Labels & rename', tour: '00:56',
    blurb: 'The same platform, renamed per scope: the takaful window says Contribution where the conventional book says Premium, and neither leaks into the other.' },
  { id: 'tour', label: 'Tour', tour: '00:00',
    blurb: 'The guided sixty minutes, held as data: eleven steps with a live clock, each saying where to go, what to press, what to expect and why it matters.',
    async script(page) {
      await clickText(page, 'Start the tour', { optional: true });
      await sleep(2000);
      await page.mouse.wheel(0, 600); await sleep(1600);
    } },
];

/* -------------------------------------------------------------------- main */

const ffmpeg = (() => {
  // Prefer a full build (the one Playwright ships can only encode VP8, which is why webm is the
  // guaranteed output and mp4 is the bonus).
  const candidates = [
    resolve(process.env.HOME ?? '/home/user', '.local/bin/ffmpeg'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
})();

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const manifest = [];

for (const module of MODULES) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir: resolve(VIDEO, 'raw'), size: VIEWPORT },
  });
  const page = await context.newPage();
  console.log(`→ ${module.id}`);
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('nav button', { timeout: 15_000 });
    await sleep(900);
    await openTab(page, module.label);
    await page.waitForTimeout(600);
    if (module.script) await module.script(page);
    await page.screenshot({ path: resolve(SCREENS, `${module.id}.png`), fullPage: false });
    const wide = await page.screenshot({ path: resolve(SCREENS, `${module.id}-full.png`), fullPage: true });
    const poster = await page.screenshot({
      path: resolve(SCREENS, `${module.id}-poster.jpg`), type: 'jpeg', quality: 45,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(820, VIEWPORT.height) },
    });
    console.log(`   shot ${(wide.length / 1024).toFixed(0)} KB full page, poster ${(poster.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.log(`   FAILED: ${String(err).split('\n')[0]}`);
  } finally {
    const video = page.video();
    await context.close();          // closing the context is what writes the video
    if (video) {
      try {
        const path = await video.path();
        const target = resolve(VIDEO, `${module.id}.webm`);
        writeFileSync(target, readFileSync(path));
        rmSync(path, { force: true });
        let mp4 = null;
        if (ffmpeg) {
          try {
            execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', target, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(VIDEO, `${module.id}.mp4`)]);
            mp4 = true;
          } catch (err) { console.log(`   mp4 conversion skipped: ${String(err).slice(0, 80)}`); }
        }
        manifest.push({ ...module, script: undefined, screenshot: `screens/${module.id}.png`, screenshotFull: `screens/${module.id}-full.png`, video: mp4 ? `video/${module.id}.mp4` : `video/${module.id}.webm`, videoFallback: mp4 ? `video/${module.id}.webm` : null, bytes: statSync(target).size });
        console.log(`   video ${(statSync(target).size / 1024).toFixed(0)} KB${mp4 ? ' (+mp4)' : ''}`);
      } catch (err) { console.log(`   video unavailable: ${String(err).slice(0, 80)}`); }
    }
  }
}

await browser.close();
writeFileSync(resolve(ROOT, 'demo/demo-pack.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, viewport: VIEWPORT, modules: manifest }, null, 2));
console.log(`\ndemo pack: ${manifest.length} module(s) with screenshots${ffmpeg ? ' and video' : ''}`);
