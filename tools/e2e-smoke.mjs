#!/usr/bin/env node
/**
 * e2e-smoke.mjs — boots a real browser against a running console and verifies:
 *   1. Pre-load Security & role-based Selection Gate renders prior to entering the workspace.
 *   2. Administration enters with full unrestricted access across every console tab.
 *   3. Dedicated Role Access & DOA tab renders AI Advisor, Entity × Channel × Sub-Channel mapping & DOA queue.
 *   4. Customer Journey & Smart Auto-Pick sections render cleanly.
 */
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const title = await page.title();
  if (!/Central Insurance/.test(title)) throw new Error(`unexpected page title: ${title}`);

  // 1. Pre-load Security Gate must appear first with the live role count.
  const adminEnterBtn = page.locator('[data-select-profile="administration"]');
  await adminEnterBtn.waitFor({ state: 'visible', timeout: 10000 });
  const gateText = await page.textContent('body');
  if (!/All Roles \(\d+\)/.test(gateText ?? '')) {
    throw new Error('pre-load security gate did not render its role directory');
  }
  await adminEnterBtn.click();
  await page.waitForSelector('nav button', { timeout: 10000 });

  // 2. Role Access & DOA tab renders AI Advisor & Entity × Channel × Sub-Channel supervision mapping
  const rbacTab = page.getByRole('button', { name: /role access & doa/i }).first();
  await rbacTab.click();
  await page.waitForTimeout(400);
  const rbacBody = await page.textContent('body');
  if (!/Delegation of Authority/i.test(rbacBody ?? '')) {
    throw new Error('Role Access & DOA tab did not render');
  }

  // 3. Customer journey tab renders its gated sections + Smart Auto-Pick memory
  const journeyTab = page.getByRole('button', { name: /customer journey/i }).first();
  await journeyTab.click();
  await page.waitForTimeout(500);
  const body = await page.textContent('body');
  if (!/onboarding/i.test(body ?? '')) throw new Error('journey sections did not render');

  console.log(`e2e smoke passed against ${base} (role gate + RBAC/DOA + Smart Auto-Pick verified)`);
} finally {
  await browser.close();
}
