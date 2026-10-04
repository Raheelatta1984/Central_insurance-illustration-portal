/**
 * Build `demo/offline.html`: the real console, in one file, with no server and no tunnel.
 *
 * It inlines the built UI bundle and installs a fetch shim that replays the API conversation
 * recorded by tools/offline-record.mjs. The result is the actual product — every tab, every panel,
 * every number a real engine produced — that opens from a file, an email attachment or a static
 * host, with no token, no port and no sandbox.
 *
 * Two honest labels are built in: a banner saying the page is a replay, and a note on any endpoint
 * that was not captured. Buttons still work; they show the recorded response.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const dist = resolve(ROOT, 'dist/index.html');
if (!existsSync(dist)) throw new Error('build the app first: npm run build');
const record = JSON.parse(readFileSync(resolve(ROOT, 'demo/offline-responses.json'), 'utf8'));

const html = readFileSync(dist, 'utf8');
const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
if (!m) throw new Error('no bundle found in dist/index.html');
const bundlePath = resolve(ROOT, 'dist', m[1].replace(/^\//, ''));
const bundle = readFileSync(bundlePath, 'utf8');
const bundleSafe = bundle.replace(/<\/script/gi, '<\\/script');

const captured = new Set(Object.keys(record.responses));
const shim = `
/* ------------------------------------------------------------------ offline replay */
/* The console talks to /api/*. Here that conversation is answered from the recording made by
   tools/offline-record.mjs against the live engine, so the product can be demonstrated with no
   server, no port and no tunnel token. */
(function () {
  var RESPONSES = ${JSON.stringify(record.responses)};
  var CAPTURED_AT = ${JSON.stringify(record.capturedAt)};
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  function reply(body, status) {
    return Promise.resolve({
      ok: (status || 200) < 400,
      status: status || 200,
      statusText: 'OK',
      headers: { get: function () { return 'application/json'; } },
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); },
    });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var path = url;
    try { path = new URL(url, window.location.href).pathname; } catch (e) { /* keep as-is */ }

    if (path.indexOf('/api') !== 0) return realFetch ? realFetch(input, init) : reply({}, 404);

    var key = method + ' ' + path;
    if (Object.prototype.hasOwnProperty.call(RESPONSES, key)) {
      var recorded = RESPONSES[key];
      // Recorded refusals replay as refusals, so the console shows the same error card it showed live.
      return reply(recorded.body !== undefined ? recorded.body : recorded, recorded.status || 200);
    }

    return reply({
      offline: true,
      note: 'This action was not captured in the replay. Everything on this page is real engine ' +
            'output recorded at ' + CAPTURED_AT + '; run the live app (npm start) for stateful actions.',
      endpoint: key,
    }, 200);
  };

  window.__OFFLINE__ = { capturedAt: CAPTURED_AT, endpoints: Object.keys(RESPONSES).sort(), base: ${JSON.stringify(record.base)} };

  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.setAttribute('data-offline-banner', 'true');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:linear-gradient(90deg,#0f2a1d,#123b28)', 'color:#d9ffe9',
      'border-bottom:1px solid #1f5a3c', 'padding:7px 12px',
      'font:12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      'display:flex', 'gap:12px', 'align-items:center', 'flex-wrap:wrap',
    ].join(';');
    var stamp = new Date(CAPTURED_AT).toUTCString();
    bar.innerHTML =
      '<strong style="color:#6ff0b0">Offline replay</strong>' +
      '<span>Every screen, number and refusal below came out of the live engine — recorded ' + stamp +
      '. ' + Object.keys(RESPONSES).length + ' API endpoints are replayed so this file needs no server, no port and no access token.</span>' +
      '<span style="opacity:.85">Actions show their recorded response; run <code>npm install &amp;&amp; npm run build &amp;&amp; npm start</code> for stateful live use.</span>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.style.paddingTop = '46px';
  });
})();
`;

const out = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Central Insurance ERP — offline replay</title>
    <script>${shim}</script>
    <script type="module">${bundleSafe}</script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

mkdirSync(resolve(ROOT, 'demo'), { recursive: true });
writeFileSync(resolve(ROOT, 'demo/offline.html'), out);
const kb = (out.length / 1024).toFixed(0);
console.log(`demo/offline.html written: ${kb} KB, ${captured.size} endpoint(s) replayed, bundle ${(bundle.length / 1024).toFixed(0)} KB`);
