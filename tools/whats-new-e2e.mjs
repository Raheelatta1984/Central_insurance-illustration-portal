#!/usr/bin/env node
/** Smoke-test the published static console, not only the source registry. */
import { chromium } from 'playwright';

const base = process.env.WHATS_NEW_BASE_URL ?? 'http://127.0.0.1:4173/console.html';
const executablePath = process.env.WHATS_NEW_CHROMIUM_PATH;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // Suitable for the optional headless-shell binary in containerized test environments.
  ...(process.env.WHATS_NEW_HEADLESS_SHELL === 'true' ? { args: ['--no-sandbox', '--single-process', '--no-zygote'] } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-select-profile="administration"]').first().click();
  await page.getByRole('button', { name: /what's new log/i }).first().click();
  await page.getByRole('heading', { name: 'Access & DOA and Role access matrix tabs restricted to Administration only' }).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: 'Unlocked non-financial partner reconciliation foundation' }).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: "What's New publication corrected" }).waitFor({ state: 'visible' });
  const heading = page.getByRole('heading', { name: 'Partner reconciliation foundation — not yet available' });
  await heading.waitFor({ state: 'visible' });
  const card = heading.locator('xpath=ancestor::section[1]');
  const cardText = await card.innerText();
  if (!cardText.includes('PR #38') || !cardText.includes('No new reconciliation workflow is available')) {
    throw new Error('PR #38 or its disabled-workflow notice is missing');
  }
  if (!(await page.locator('body').innerText()).includes('merging a PR does not automatically add one')) {
    throw new Error('Manual release publication notice is missing');
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('What\'s New browser smoke passed: PR #38, disabled status and manual-publication notice are visible.');
} finally {
  await browser.close();
}
