/**
 * Build the customer demo gallery: one self-contained HTML file with every module's screenshot and
 * screen recording embedded, so it works from a file, an email attachment or a static host — no
 * server, no network, no dependencies.
 *
 * Reads demo/demo-pack.json (written by tools/demo-pack.mjs) and embeds:
 *  - the poster JPEG of each module,
 *  - the compact MP4 of each module,
 * and links to the full-page screenshot and the full-quality recording next to it.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, from this file's own location — so the command works from any directory. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(resolve(ROOT, 'demo/demo-pack.json'), 'utf8'));

const b64 = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`;
const sizemb = (path) => (statSync(path).size / 1024 / 1024).toFixed(1);

const cards = pack.modules.map((m, i) => {
  const posterJpg = resolve(ROOT, 'demo', m.screenshot.replace('.png', '-poster.jpg'));
  const posterPng = resolve(ROOT, 'demo', m.screenshot);
  const poster = existsSync(posterJpg) ? b64(posterJpg, 'image/jpeg') : b64(posterPng, 'image/png');
  // Recordings are the heaviest thing a repo can carry and the least worth carrying: they are
  // regenerated from the live app in one command. DEMO_NO_VIDEO=1 builds the gallery with its
  // screenshots embedded and no video at all, which is what the committed pack uses.
  const noVideo = process.env.DEMO_NO_VIDEO === '1';
  const smallMp4 = resolve(ROOT, 'demo/video/small', `${m.id}.mp4`);
  const video = !noVideo && existsSync(smallMp4) ? b64(smallMp4, 'video/mp4') : null;
  return `
  <section class="card" id="${m.id}">
    <div class="head">
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <h2>${m.label}</h2>
      <span class="pill">tour ${m.tour}</span>
      ${video ? `<span class="pill ok">video ${sizemb(smallMp4)} MB</span>` : ''}
    </div>
    <p class="blurb">${m.blurb}</p>
    ${video
      ? `<video controls preload="metadata" playsinline poster="${poster}" src="${video}"></video>`
      : `<img alt="Screenshot of the ${m.label} module" src="${poster}">`}
    <div class="links">
      <a href="${m.screenshotFull}" target="_blank" rel="noopener">full-page screenshot</a>
      ${noVideo ? '<span class="muted">recording produced by <code>npm run demo:pack</code></span>' : `<a href="${m.video}" target="_blank" rel="noopener">full-quality recording</a>`}
      ${!noVideo && m.videoFallback ? `<a href="${m.videoFallback}" target="_blank" rel="noopener">webm version</a>` : ''}
    </div>
  </section>`;
}).join('\n');

const index = pack.modules.map((m) => `<a href="#${m.id}">${m.label}</a>`).join(' · ');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Central Insurance ERP — customer demo pack</title>
<style>
  :root { color-scheme: dark; --bg:#0b1117; --panel:#111a23; --line:#1f2c39; --text:#e7eef6; --muted:#8ea3b8; --accent:#3ddc97; --warn:#ffd166; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding:34px 28px 18px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:27px; letter-spacing:-.02em; }
  header p { margin:4px 0; color:var(--muted); max-width:80ch; }
  .nav { padding:14px 28px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13.5px; }
  .nav a { color:var(--accent); text-decoration:none; }
  .nav a:hover { text-decoration:underline; }
  main { padding:22px 28px 60px; display:grid; gap:22px; grid-template-columns:repeat(auto-fit,minmax(480px,1fr)); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px 18px; }
  .head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .num { color:var(--muted); font-variant-numeric:tabular-nums; font-size:13px; }
  h2 { margin:0; font-size:19px; letter-spacing:-.01em; }
  .pill { font-size:11.5px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:2px 9px; }
  .pill.ok { color:#0b1117; background:var(--accent); border-color:var(--accent); font-weight:600; }
  .blurb { color:#c3d3e2; margin:10px 0 12px; }
  video, img { width:100%; border-radius:10px; border:1px solid var(--line); background:#000; display:block; }
  .links { margin-top:10px; font-size:12.5px; }
  .links a { color:var(--muted); margin-right:14px; }
  .links a:hover { color:var(--accent); }
  footer { padding:0 28px 50px; color:var(--muted); font-size:13px; max-width:90ch; }
  code { background:#0d151d; border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:12.5px; }
</style>
</head>
<body>
<header>
  <h1>Central Insurance ERP — customer demo pack</h1>
  <p>Eighteen modules captured from the running application on ${new Date(pack.generatedAt).toUTCString()} at ${pack.viewport.width}×${pack.viewport.height}. Each recording is a real session against the live engine: nothing is staged, no number is typed in by hand.</p>
  <p>Every screen shows <strong>AI-native insurance operations</strong>: unit-linked fund management with look-through, a structurally separate takaful window, group consolidation across two currencies, micro-duration cover billed only between start and stop, governed AI with human authority gates, and a double-entry ledger that proves itself.</p>
  <p>Run it yourself: <code>npm install &amp;&amp; npm run build &amp;&amp; npm start</code>, then open the console and start on the <strong>Tour</strong> tab. The same content is written up in <code>docs/07-TOUR.md</code>.</p>
</header>
<div class="nav">${index}</div>
<main>
${cards}
</main>
<footer>
  <p>Recordings are embedded, so this file works offline. Full-quality recordings and full-page screenshots sit next to it in <code>demo/video</code> and <code>demo/screens</code>. Regenerate the whole pack with <code>npm run demo:pack</code> (it drives the app with a headless browser) and rebuild this gallery with <code>npm run demo:gallery</code>.</p>
</footer>
</body>
</html>`;

writeFileSync(resolve(ROOT, 'demo/index.html'), html);
console.log(`demo/index.html written: ${pack.modules.length} modules, ${(html.length / 1024 / 1024).toFixed(1)} MB self-contained`);
