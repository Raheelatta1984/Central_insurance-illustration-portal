#!/usr/bin/env node
/**
 * Dependency audit gate: fail on a High or Critical advisory, with a written record for anything we
 * consciously accept.
 *
 * `npm audit --audit-level=high` already fails the job, but it fails with a paragraph and no way to
 * accept one advisory without lowering the bar for all of them. This wrapper does three things
 * `npm audit` alone does not:
 *  - it prints one line per advisory (package, severity, the advisory's own title, whether it is
 *    reachable in production or only at build time);
 *  - it reads `.security-audit-allowlist` and lets an accepted risk through **by name**, so the
 *    exception is reviewable in the diff instead of invisible in a muted pipeline;
 *  - it fails a stale exception, because an allowlist nobody prunes is a blindfold.
 *
 * Allowlist format — one entry per line, `#` starts a comment:
 *   GHSA-xxxx-yyyy-zzzz   # why it is accepted, which service is affected, when it is re-checked
 *
 *   node tools/security-audit.mjs
 *   node tools/security-audit.mjs --json     # machine-readable summary
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ALLOWLIST_FILE = join(ROOT, '.security-audit-allowlist');
const BLOCKING = new Set(['high', 'critical']);

function allowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return [];
  return readFileSync(ALLOWLIST_FILE, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line !== '');
}

function audit() {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (error) {
    // npm exits non-zero whenever it reports anything; the JSON on stdout is still the answer.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

const report = audit();
const allow = allowlist();
const used = new Set();
const blocking = [];

for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
  if (!BLOCKING.has(entry.severity)) continue;
  const advisories = (entry.via ?? []).filter((via) => typeof via === 'object');
  const identifiers = advisories.flatMap((advisory) => [advisory.source, ...(advisory.cves ?? []), ...(advisory.url ? [advisory.url.split('/').pop()] : [])])
    .filter(Boolean).map(String);
  const accepted = allow.find((entryId) => identifiers.includes(entryId) || identifiers.some((id) => id.includes(entryId)));
  if (accepted) { used.add(accepted); continue; }
  blocking.push({
    package: name,
    severity: entry.severity,
    production: Boolean(entry.isDirect && !entry.effects?.length) || entry.range !== undefined,
    titles: advisories.map((advisory) => advisory.title).filter(Boolean),
    identifiers,
  });
}

const stale = allow.filter((entry) => !used.has(entry));
const summary = {
  totals: report.metadata?.vulnerabilities ?? {},
  blocking: blocking.length,
  accepted: used.size,
  stale: stale.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...summary, findings: blocking, stale }, null, 2));
} else {
  const totals = summary.totals;
  console.log(`security-audit: ${totals.info ?? 0} info · ${totals.low ?? 0} low · ${totals.moderate ?? 0} moderate · ${totals.high ?? 0} high · ${totals.critical ?? 0} critical`);
  for (const finding of blocking) {
    console.log(`  BLOCKING ${finding.severity.toUpperCase()} ${finding.package} — ${finding.titles.join('; ') || 'no title'} (${finding.identifiers.join(', ') || 'no id'})`);
  }
  for (const entry of allow) {
    console.log(`  ${used.has(entry) ? 'ACCEPTED' : 'STALE   '} ${entry}`);
  }
}

if (stale.length > 0) {
  console.error(`security-audit: FAIL — ${stale.length} allowlist entr(ies) no longer match an advisory; remove them.`);
  process.exit(1);
}
if (blocking.length > 0) {
  console.error(`security-audit: FAIL — ${blocking.length} high/critical advisor${blocking.length === 1 ? 'y' : 'ies'} not accepted.`);
  console.error(`  Fix it (npm audit fix / bump the dependency), or record it in ${'.security-audit-allowlist'} with a reason.`);
  process.exit(1);
}
console.log('security-audit: ok — no unaccepted high or critical advisories.');
