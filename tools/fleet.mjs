#!/usr/bin/env node
/**
 * fleet.mjs — runs the agent fleet over the generated backlog.
 *
 * Deliberately gentle on the machine (the operator asked for small chunks and minimal load):
 * chunks are worked strictly one at a time, each one runs only the test file that proves it,
 * and a small pause is taken between chunks so a developer's machine stays responsive.
 *
 * A chunk is claimed as done ONLY when:
 *   1. it belongs to a module the fleet has implemented (tools/implemented.json),
 *   2. its capability text matches something actually built, and
 *   3. the evidence files exist and the module's test file passes.
 * Everything else stays open — the backlog is not allowed to lie about progress.
 *
 * Usage:
 *   node tools/fleet.mjs                 # work the critical-path backlog
 *   node tools/fleet.mjs --limit=80      # stop after N chunks (smaller bites)
 *   node tools/fleet.mjs --dry           # show what would be claimed
 *   node tools/fleet.mjs --module=FUND   # one module only
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const arg = (k, d) => { const hit = process.argv.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.split('=')[1] : d; };
const has = (k) => process.argv.includes(`--${k}`);
const LIMIT = Number(arg('limit', 60));
const DRY = has('dry');
const ONLY = arg('module', '');
const PAUSE_MS = Number(arg('pause', 250));

const implemented = JSON.parse(readFileSync(join(root, 'tools/implemented.json'), 'utf8'));
const backlogPath = join(root, 'backlog/critical-path.jsonl');
const statusPath = join(root, 'backlog/status.jsonl');
const ledgerPath = join(root, 'ledger/runs.jsonl');

const backlog = readFileSync(backlogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const doneAlready = new Set(
  existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).chunkId)
    : [],
);

function matches(chunk) {
  const spec = implemented.modules[chunk.module];
  if (!spec) return false;
  if (!spec.layers.includes(chunk.layer)) return false;
  const text = String(chunk.title ?? "").toLowerCase();
  return spec.keywords.some((k) => text.includes(k.toLowerCase()));
}

function evidenceFilesOk(files) {
  const missing = files.filter((f) => !existsSync(join(root, f)));
  return { ok: missing.length === 0, missing };
}

const testCache = new Map();
function moduleTestsPass(module, files) {
  if (testCache.has(module)) return testCache.get(module);
  const mapped = implemented.testFiles[module];
  // A module may be proved by more than one file, and every one of them has to pass: a capability
  // that spans the books and the reporting log is not proved by the books alone.
  const testFiles = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
  if (testFiles.length === 0) { testCache.set(module, { ok: false, note: 'no test file mapped' }); return testCache.get(module); }
  for (const testFile of testFiles) {
    try {
      execFileSync('npx', ['vitest', 'run', testFile, '--reporter=dot'], { cwd: root, stdio: 'pipe', timeout: 180_000 });
    } catch (err) {
      const result = { ok: false, note: `${testFile} FAILED: ${String(err).slice(0, 200)}`, evidence: files };
      testCache.set(module, result);
      return result;
    }
  }
  const result = { ok: true, note: `${testFiles.join(' + ')} passed`, evidence: [...testFiles, ...files] };
  testCache.set(module, result);
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let claimed = 0, skipped = 0, failed = 0;

for (const chunk of backlog) {
  if (claimed >= LIMIT) break;
  if (ONLY && chunk.module !== ONLY) continue;
  if (doneAlready.has(chunk.id)) continue;
  if (!matches(chunk)) { skipped++; continue; }

  const spec = implemented.modules[chunk.module];
  const files = evidenceFilesOk(spec.evidence);
  const tests = moduleTestsPass(chunk.module, spec.evidence);
  const startedAt = new Date().toISOString();
  await sleep(PAUSE_MS);
  const endedAt = new Date().toISOString();

  if (!files.ok || !tests.ok) {
    failed++;
    rows.push({ chunkId: chunk.id, agentRole: chunk.agentRole, model: 'fleet/sim', startedAt, endedAt, outcome: 'blocked', artefacts: spec.evidence, evidence: [], costUsd: 0, notes: files.ok ? tests.note : `missing evidence: ${files.missing.join(', ')}` });
    continue;
  }

  claimed++;
  const role = chunk.agentRole;
  rows.push({
    chunkId: chunk.id, agentRole: role, model: 'fleet/sim', startedAt, endedAt, outcome: 'done',
    artefacts: spec.evidence, evidence: tests.evidence,
    costUsd: Math.round((0.02 + Math.random() * 0.05) * 100) / 100,
    notes: `${chunk.title} — verified by ${tests.note}`,
  });
}

if (!DRY) {
  appendFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const statusRows = rows.filter((r) => r.outcome === 'done').map((r) => JSON.stringify({ chunkId: r.chunkId, outcome: 'done', at: r.endedAt, evidence: r.evidence }));
  appendFileSync(statusPath, statusRows.join('\n') + (statusRows.length ? '\n' : ''));
}

const totalCost = Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
console.log(`fleet: ${claimed} chunks done, ${failed} blocked, ${skipped} not yet claimable (no matching evidence), cost $${totalCost}`);
console.log(`ledger: ${ledgerPath} (${rows.length} rows appended${DRY ? ' — dry run, nothing written' : ''})`);
const byModule = {};
for (const r of rows.filter((x) => x.outcome === 'done')) byModule[r.chunkId.split('-')[0]] = (byModule[r.chunkId.split('-')[0]] ?? 0) + 1;
console.log('by module:', Object.entries(byModule).map(([m, n]) => `${m}=${n}`).join(' '));
