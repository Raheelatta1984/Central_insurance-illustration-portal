#!/usr/bin/env node
/**
 * Regression guard: no credential may live in browser storage.
 *
 * This is the check that would have failed the day the console started keeping the operator's access
 * token in `sessionStorage`. A comment in a review document does not survive the next contributor;
 * a red CI job does.
 *
 * What it flags: a `localStorage`/`sessionStorage` read or write whose key looks like a credential
 * (`token`, `jwt`, `auth`, `secret`, `apiKey`, `credential`, `refresh`, `id_token`, `access…`).
 * `removeItem` is deliberately *not* flagged — deleting a credential is the fix, not the bug.
 *
 * Exceptions go in `.security-storage-allowlist`, one substring per line (`#` starts a comment).
 * Every line must match at least one real finding, so a stale exception fails the build too.
 *
 *   node tools/security-guard.mjs            # scan and report
 *   node tools/security-guard.mjs --verbose  # also list the files that were clean
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ALLOWLIST_FILE = join(ROOT, '.security-storage-allowlist');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', 'build', 'coverage', 'site', '.git']);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html'];

// A read or write of a credential-shaped key through a web-storage API.
const STORAGE_CREDENTIAL =
  /(?:localStorage|sessionStorage)\s*(?:\?\.)?\s*(?:\.\s*(setItem|getItem)|\[\s*['"`]([^'"`]+)['"`]\s*\])/gi;
const CREDENTIAL_WORD = /token|jwt|auth|secret|api[_-]?key|credential|refresh|id_token|access/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) out.push(full);
  }
  return out;
}

function allowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return [];
  return readFileSync(ALLOWLIST_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function scan() {
  const findings = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Only the key argument can tell us whether this is a credential: match the call, then look
      // at the handful of characters that follow the opening parenthesis.
      for (const match of line.matchAll(STORAGE_CREDENTIAL)) {
        const rest = line.slice((match.index ?? 0) + match[0].length);
        const keyText = `${match[2] ?? ''}${rest.slice(0, 60)}`;
        if (!CREDENTIAL_WORD.test(keyText)) continue;
        findings.push({
          file: relative(ROOT, file).split(/[\\/]/).join('/'),
          line: index + 1,
          text: line.trim().slice(0, 160),
        });
      }
    });
  }
  return findings;
}

const findings = scan();
const allow = allowlist();
const used = new Set();
const unallowed = findings.filter((finding) => {
  const hit = allow.find((entry) => `${finding.file}:${finding.line}`.includes(entry) || finding.text.includes(entry));
  if (hit) used.add(hit);
  return !hit;
});

if (findings.length > 0) {
  console.log(`security-guard: ${findings.length} storage credential reference(s)`);
  for (const finding of findings) {
    const allowed = unallowed.includes(finding) ? ' ' : 'ALLOWED ';
    console.log(`  ${allowed}${finding.file}:${finding.line}  ${finding.text}`);
  }
}
const stale = allow.filter((entry) => !used.has(entry));
if (stale.length > 0) {
  console.error(`security-guard: ${stale.length} allowlist entr(ies) match nothing and must be removed:`);
  for (const entry of stale) console.error(`  ${entry}`);
}
if (unallowed.length > 0) {
  console.error(`security-guard: FAIL — ${unallowed.length} credential(s) readable by JavaScript.`);
  console.error('  A browser credential belongs in an HttpOnly cookie (see src/server/auth.ts), not in web storage.');
  console.error(`  If this is genuinely not a credential, record it in ${relative(ROOT, ALLOWLIST_FILE)} with a reason.`);
  process.exit(1);
}
if (stale.length > 0) process.exit(1);
console.log(`security-guard: ok — no credentials in web storage (${allow.length} allowlisted exception(s)).`);
