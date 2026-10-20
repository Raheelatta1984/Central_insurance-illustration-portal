#!/usr/bin/env node
/**
 * e2e-smoke.mjs — boots a real browser against a running console and walks the opening
 * screens. Kept out of the default verify loop (browsers are heavy); run it manually or in a
 * nightly job:
 *   npx playwright install chromium
 *   npm run build && npm start &    # or any deployed BASE_URL
 *   BASE_URL=http://127.0.0.1:8787 npm run test:e2e
 */
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const title = await page.title();
  if (!/Central Insurance/.test(title)) throw new Error(`unexpected page title: ${title}`);
  // The journey tab is the product's centrepiece: it must render its gated sections.
  const journeyTab = page.getByRole('button', { name: /customer journey/i }).first();
  await journeyTab.click();
  await page.waitForTimeout(500);
  const body = await page.textContent('body');
  if (!/onboarding/i.test(body ?? '')) throw new Error('journey sections did not render');
  console.log(`e2e smoke passed against ${base}`);
} finally {
  await browser.close();
}
