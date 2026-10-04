/**
 * Assemble the demo site: one static directory that any host can serve — Vercel, GitHub Pages, an
 * S3 bucket, a USB stick. Nothing here needs a server: the console is the real application with the
 * engine's recorded answers, and the gallery is the recordings.
 *
 *   npm run build && npm run demo:pack && npm run demo:offline && npm run demo:gallery
 *   npm run demo:site
 *
 * Output: site/index.html (landing), site/console.html (the console), site/gallery.html (the
 * gallery), site/tour.md (the written tour). All three source files are committed, so a host that
 * only runs a build step (Vercel, CI) can assemble this without installing a single dependency.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'site');

const files = [
  ['demo/site/index.html', 'index.html', 'the landing page'],
  ['demo/offline.html', 'console.html', 'the console with the engine\u2019s recorded answers'],
  ['demo/index.html', 'gallery.html', 'the module gallery'],
  ['docs/07-TOUR.md', 'tour.md', 'the written sixty-minute tour'],
];

mkdirSync(OUT, { recursive: true });
const missing = [];
for (const [from, to, what] of files) {
  const source = resolve(ROOT, from);
  if (!existsSync(source)) { missing.push(`${from} (${what})`); continue; }
  copyFileSync(source, resolve(OUT, to));
  const kb = Math.round(statSync(resolve(ROOT, from)).size / 1024);
  console.log(`  ${to.padEnd(14)} ${String(kb).padStart(6)} KB  ${what}`);
}
if (missing.length > 0) {
  console.error(`demo:site — missing source files:\n  ${missing.join('\n  ')}`);
  console.error('Run: npm run build && npm run demo:pack && npm run demo:offline && npm run demo:gallery');
  process.exit(1);
}

// A tiny robots file: the demo is meant to be seen, not indexed as if it were a business site.
writeFileSync(resolve(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n');

const total = files.reduce((t, [from]) => t + statSync(resolve(ROOT, from)).size, 0);
console.log(`demo:site — ${OUT} assembled, ${(total / 1024 / 1024).toFixed(1)} MB across ${files.length} files`);
