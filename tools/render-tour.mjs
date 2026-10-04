/**
 * Render the tour as markdown from the same data the console uses, so the document cannot drift
 * from the app. Run `npm run tour:doc` after changing src/core/tour.ts.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONSOLE_TABS, TOUR, tourMinutes } from '../dist-server/core/tour.js';

const label = (id) => CONSOLE_TABS.find((t) => t.id === id)?.label ?? id;

const lines = [
  '# 07 — The sixty-minute tour',
  '',
  `*Generated from \`src/core/tour.ts\` — the same data the console's Tour tab runs. ${TOUR.length} steps, ${tourMinutes()} minutes.*`,
  '',
  '> **Live app:** run `npm install && npm run build && npm start`, then open the console and start on the **Tour** tab. Every number you see is computed by an engine in `src/core`; nothing on the screen is seeded display text.',
  '',
  '## Before you start',
  '',
  '| # | Time | Tab | What you are doing |',
  '| --- | --- | --- | --- |',
];
TOUR.forEach((step, i) => {
  lines.push(`| ${i + 1} | ${step.at} | ${label(step.tab)} | ${step.title} |`);
});

for (const [i, step] of TOUR.entries()) {
  lines.push('', `## ${i + 1}. ${step.at} — ${step.title}`, '', `**Tab:** ${label(step.tab)} · **${step.minutes} minutes**`, '', step.why, '', '**Do this**', '');
  for (const line of step.doThis) lines.push(`- ${line}`);
  lines.push('', '**You should see**', '');
  for (const line of step.expect) lines.push(`- ${line}`);
  if (step.api?.length) lines.push('', `*Endpoints: ${step.api.join(' · ')}*`);
}

lines.push(
  '',
  '## If something refuses you',
  '',
  'That is the product working, not a bug. The refusals worth trying on purpose:',
  '',
  '- Ask an AI agent to approve above its straight-through limit — it names the limit and stays on the record.',
  '- Try to distribute a takaful surplus before every gate has signed — it names the gate that is missing.',
  '- Try to reduce a claim reserve without settling — refused, because reserves move deliberately or not at all.',
  '- Stop micro-duration cover and advance the clock — no day charges until someone starts it again.',
  '',
  '## What is not finished',
  '',
  'This is an honest inventory, mirrored in `docs/06-QA-REPORT.md`: reinsurance, policy administration, the data warehouse and the customer-service modules are designed and backlogged, not yet built. `ledger/runs.jsonl` records every backlog chunk the fleet has claimed with its evidence; `node tools/fleet.mjs` prints how many are still open.',
  '',
  '## Where the numbers live',
  '',
  '| Surface | Where it is computed |',
  '| --- | --- |',
  '| Fund value, units, dealing rules | `src/core/unitlinked.ts`, `src/core/fund.ts` |',
  '| Money and rounding | `src/core/money.ts` |',
  '| Books, balances, proofs | `src/core/ledger.ts`, `src/core/chart.ts` |',
  '| Takaful pools and gates | `src/core/takaful.ts` |',
  '| Claims, authority, recoveries | `src/core/claims.ts` |',
  '| Underwriting | `src/core/underwriting.ts` |',
  '| Group consolidation | `src/core/groupfinance.ts` |',
  '| Micro-duration cover | `src/core/billing.ts` |',
  '| Snapshot and restore | `src/core/persistence.ts` |',
  '',
);

writeFileSync(resolve(process.cwd(), 'docs/07-TOUR.md'), lines.join('\n'));
console.log(`docs/07-TOUR.md written: ${TOUR.length} steps, ${tourMinutes()} minutes`);
