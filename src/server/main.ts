/**
 * The API server.
 *
 * One process serves the SPA and the JSON API on one port, so a preview URL is the whole
 * application. Every endpoint is a thin, typed shell over the domain core (`src/core/routes.ts`) —
 * no business logic lives here, which is why the tests and the console can never drift apart.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { IdempotencyError, IdempotencyKeys } from '../core/idempotency.js';
import { createRuntimeState, dispatchApiRoute, isDomainRefusal, RuntimeState } from '../core/routes.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = resolve(process.cwd(), 'dist');

const state: RuntimeState = createRuntimeState(1);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

/**
 * The key a mutating call arrived under, for the length of that call. Every route answers through
 * `json()`, which is the one place an answer is final — so recording it there means a retry gets back
 * exactly what the first call was given, status and body, without any route having to know about keys.
 */
const idempotency = new AsyncLocalStorage<{ key: string; request: string }>();

function json(res: ServerResponse, status: number, body: unknown): void {
  const context = idempotency.getStore();
  if (context) {
    try {
      state.keys.complete(context.key, context.request, status, body, new Date().toISOString());
    } catch {
      // an answer that could not be recorded — the key had already been completed or released — is
      // still an answer: the caller gets it, and the next retry simply runs the request again
    }
  }
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': MIME['.json']!, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 5_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, safe === '/' || safe === '' ? 'index.html' : safe);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(DIST, 'index.html');
  if (!existsSync(filePath)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('UI not built yet — run: npm run build:ui');
    return;
  }
  const type = MIME[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(readFileSync(filePath));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace(/^\/api/, '');
  const body = req.method === 'POST' ? await readBody(req).catch(() => '') : '';
  const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};

  const keyHeader = req.headers['idempotency-key'];
  const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  const mutating = req.method !== 'GET' && req.method !== 'OPTIONS';
  if (mutating && key) {
    const request = IdempotencyKeys.requestOf(req.method ?? 'POST', path, payload);
    let answer;
    try {
      answer = state.keys.begin(key, request, new Date().toISOString());
    } catch (error) {
      json(res, 400, { error: error instanceof IdempotencyError ? error.message : String(error) });
      return true;
    }
    if (answer.state === 'replay') {
      res.setHeader('idempotent-replay', 'true');
      json(res, answer.status, answer.body);
      return true;
    }
    if (answer.state === 'refused') {
      json(res, 409, { error: answer.detail, reason: answer.reason });
      return true;
    }
    try {
      const handled = await idempotency.run({ key, request }, () =>
        handleApiKeyed(req, res, url, path, payload),
      );
      if (!handled) {
        state.keys.abort(key);
        return false;
      }
      return true;
    } catch (error) {
      const status = isDomainRefusal(error) ? 409 : 500;
      const errBody = { error: error instanceof Error ? error.message : String(error) };
      try {
        state.keys.complete(key, request, status, errBody, new Date().toISOString());
      } catch {
        state.keys.abort(key);
      }
      json(res, status, errBody);
      return true;
    }
  }
  return handleApiKeyed(req, res, url, path, payload);
}

async function handleApiKeyed(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const result = await dispatchApiRoute(state, req.method ?? 'GET', path, url.searchParams, payload);
  if (!result.handled) return false;
  json(res, result.status, result.body);
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api')) {
    handleApi(req, res, url).then((handled) => {
      if (!handled) json(res, 404, { error: 'no such endpoint', path: url.pathname });
    }).catch((err: unknown) => {
      json(res, isDomainRefusal(err) ? 409 : 500, { error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Insurance ERP API listening on http://${HOST}:${PORT} (serving ${DIST})`);
});
