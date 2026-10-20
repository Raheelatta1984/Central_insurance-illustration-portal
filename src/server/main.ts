/**
 * The API server.
 *
 * One process serves the SPA and the JSON API on one port, so a preview URL is the whole
 * application. Every endpoint is a thin, typed shell over the domain core (`src/core/routes.ts`) —
 * no business logic lives here, which is why the tests and the console can never drift apart.
 *
 * What this layer *does* own (and `src/server/main.test.ts` now proves over real HTTP):
 *  - request bodies: a byte-accurate size limit (413), malformed JSON and non-object bodies
 *    refused as 400 — never silently replaced with `{}` and executed against demo defaults;
 *  - error mapping: validation 400, domain refusals 409 with their sentence, everything else a
 *    generic 500 carrying a request id (the detail is logged server-side, not leaked);
 *  - authentication/authorisation when configured via the environment (`src/server/auth.ts`),
 *    with the audit actor stamped from the principal; open **demo mode** otherwise, labelled
 *    in `/health`, and refused in production unless explicitly allowed;
 *  - idempotent retries (`Idempotency-Key`, implemented with the domain `IdempotencyKeys`);
 *  - static files confined to `dist/`, immutable caching for hashed assets, gzip for JSON/text.
 *
 * State is the in-memory demo world (`createRuntimeState`): rebuilt on boot, lost on restart.
 * The seal/open machinery for durable books and registers exists in the core and is exercised
 * by the durability drills; wiring it to a store is the documented next step (docs/14).
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { IdempotencyError, IdempotencyKeys } from '../core/idempotency.js';
import { createRuntimeState, dispatchApiRoute, httpStatusForError, RuntimeState } from '../core/routes.js';
import { assertPayloadObject, RequestValidationError } from '../core/validate.js';
import { randomTokenHex } from '../core/hash.js';
import { usingDemoVaultSecret } from '../core/pii-masking.js';
import { AuthConfig, authenticate, authorize, corsOriginFor, loadAuthConfig } from './auth.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY_BYTES = 5_000_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface PortalServerOptions {
  readonly state?: RuntimeState;
  readonly dist?: string;
  readonly auth?: AuthConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}

export function createPortalServer(options: PortalServerOptions = {}): Server {
  const env = options.env ?? process.env;
  const state: RuntimeState = options.state ?? createRuntimeState(1);
  const dist = resolve(options.dist ?? join(process.cwd(), 'dist'));
  const auth = options.auth ?? loadAuthConfig(env);
  const log = options.log ?? ((line: string) => console.error(line));

  /**
   * The key a mutating call arrived under, for the length of that call. Every route answers
   * through `json()`, which is the one place an answer is final — so recording it there means
   * a retry gets back exactly what the first call was given, status and body.
   */
  const idempotency = new AsyncLocalStorage<{ key: string; request: string; requestId: string }>();

  function sendBuffer(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: Buffer, extra: Record<string, string> = {}): void {
    const headers: Record<string, string> = {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...extra,
    };
    let out = body;
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (acceptsGzip && body.length > 1024 && /text|json|javascript|svg/.test(type)) {
      out = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = String(out.length);
    res.writeHead(status, headers);
    res.end(out);
  }

  function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, requestId: string): void {
    const context = idempotency.getStore();
    if (context) {
      try {
        state.keys.complete(context.key, context.request, status, body, state.now());
      } catch (error) {
        // Never silent: if the answer could not be recorded, a retry will re-run the request,
        // so the operator must be able to see that the at-most-once guarantee was degraded.
        log(`[idempotency] request ${context.requestId}: could not record completion for key ${context.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const cors = corsOriginFor(auth, req.headers['origin'], env);
    sendBuffer(req, res, status, MIME['.json']!, Buffer.from(text), {
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...(cors ? { 'access-control-allow-origin': cors, 'vary': 'Origin' } : {}),
    });
  }

  function errorBody(req: IncomingMessage, res: ServerResponse, err: unknown, requestId: string, method: string, path: string): void {
    if (err instanceof HttpError) {
      json(req, res, err.status, { error: err.message, requestId }, requestId);
      return;
    }
    const status = httpStatusForError(err);
    if (status === 500) {
      log(`[500] request ${requestId} ${method} ${path}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      json(req, res, 500, { error: 'internal error', requestId }, requestId);
      return;
    }
    json(req, res, status, { error: err instanceof Error ? err.message : String(err), requestId }, requestId);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let refused = false;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          // Refuse, but keep draining (discarding) so the 413 response can actually be sent —
          // destroying the socket here turns a clean refusal into a connection reset.
          if (!refused) { refused = true; chunks.length = 0; reject(new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)); }
          return;
        }
        if (!refused) chunks.push(chunk);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string, requestId: string): void {
    const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(dist, safe === '/' || safe === '' ? 'index.html' : safe);
    // Confinement is asserted, not assumed from normalize()+join() behaviour.
    if (filePath !== dist && !filePath.startsWith(dist + sep)) filePath = join(dist, 'index.html');
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(dist, 'index.html');
    if (!existsSync(filePath)) {
      sendBuffer(req, res, 503, 'text/plain; charset=utf-8', Buffer.from('UI not built yet — run: npm run build:ui'), { 'x-request-id': requestId });
      return;
    }
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    const hashedAsset = filePath.startsWith(join(dist, 'assets') + sep);
    sendBuffer(req, res, 200, type, readFileSync(filePath), {
      'cache-control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-request-id': requestId,
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<boolean> {
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method ?? 'GET';

    let payload: Record<string, unknown> = {};
    if (method === 'POST') {
      const body = await readBody(req); // throws HttpError(413) — never swallowed into {}
      if (body.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new RequestValidationError('request body is not valid JSON');
        }
        assertPayloadObject(parsed);
        payload = parsed;
      }
    }

    // Authentication & authorisation (health stays public for load balancers).
    const publicHealth = method === 'GET' && path === '/health';
    if (!publicHealth) {
      const principal = authenticate(auth, req);
      if (!principal) {
        json(req, res, 401, { error: 'authentication required (Authorization: Bearer …)', requestId }, requestId);
        return true;
      }
      if (auth.enabled) {
        const refusal = authorize(principal, method, path, payload);
        if (refusal) {
          json(req, res, 403, { error: refusal, requestId }, requestId);
          return true;
        }
        // The audit actor is who authenticated, never a string the caller chose.
        if (method !== 'GET') payload = { ...payload, by: principal.name, __principal: principal.name };
      }
    }

    const keyHeader = req.headers['idempotency-key'];
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    const mutating = method !== 'GET' && method !== 'OPTIONS';
    if (mutating && key) {
      const request = IdempotencyKeys.requestOf(method, path, payload);
      let answer;
      try {
        answer = state.keys.begin(key, request, state.now());
      } catch (error) {
        json(req, res, 400, { error: error instanceof IdempotencyError ? error.message : String(error), requestId }, requestId);
        return true;
      }
      if (answer.state === 'replay') {
        res.setHeader('idempotent-replay', 'true');
        json(req, res, answer.status, answer.body, requestId);
        return true;
      }
      if (answer.state === 'refused') {
        json(req, res, 409, { error: answer.detail, reason: answer.reason, requestId }, requestId);
        return true;
      }
      try {
        const handled = await idempotency.run({ key, request, requestId }, () =>
          handleApiKeyed(req, res, url, path, payload, requestId, method),
        );
        if (!handled) {
          state.keys.abort(key);
          return false;
        }
        return true;
      } catch (error) {
        const status = httpStatusForError(error);
        const errBody = status === 500
          ? { error: 'internal error', requestId }
          : { error: error instanceof Error ? error.message : String(error), requestId };
        if (status === 500) log(`[500] request ${requestId} ${method} ${path}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        try {
          state.keys.complete(key, request, status, errBody, state.now());
        } catch {
          state.keys.abort(key);
        }
        json(req, res, status, errBody, requestId);
        return true;
      }
    }
    return handleApiKeyed(req, res, url, path, payload, requestId, method);
  }

  async function handleApiKeyed(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    payload: Record<string, unknown>,
    requestId: string,
    method: string,
  ): Promise<boolean> {
    const result = await dispatchApiRoute(state, method, path, url.searchParams, payload);
    if (!result.handled) return false;
    json(req, res, result.status, result.body, requestId);
    return true;
  }

  const server = createServer((req, res) => {
    const requestId = randomTokenHex(8);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'OPTIONS') {
      const cors = corsOriginFor(auth, req.headers['origin'], env);
      res.writeHead(204, {
        ...(cors ? { 'access-control-allow-origin': cors, 'vary': 'Origin' } : {}),
        'access-control-allow-headers': 'content-type, authorization, idempotency-key',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'x-request-id': requestId,
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api')) {
      handleApi(req, res, url, requestId).then((handled) => {
        if (!handled) json(req, res, 404, { error: 'no such endpoint', path: url.pathname, requestId }, requestId);
      }).catch((err: unknown) => {
        if (!res.headersSent) errorBody(req, res, err, requestId, req.method ?? 'GET', url.pathname);
      });
      return;
    }
    serveStatic(req, res, url.pathname, requestId);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

/** Production guardrails: no silent demo posture. Returns refusal sentences (empty = safe). */
export function productionRefusals(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env['NODE_ENV'] !== 'production' || env['PORTAL_ALLOW_DEMO'] === '1') return [];
  const refusals: string[] = [];
  if (!loadAuthConfig(env).enabled) {
    refusals.push('authentication is not configured (set PORTAL_AUTH_TOKENS, or PORTAL_ALLOW_DEMO=1 to run the open demo on purpose)');
  }
  if (!env['PII_VAULT_SECRET']?.trim() && usingDemoVaultSecret()) {
    refusals.push('PII masking would run on the public demo vault secret (set PII_VAULT_SECRET from your KMS/secret store)');
  }
  return refusals;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const refusals = productionRefusals();
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`Refusing to start: ${refusal}`);
    process.exit(1);
  }
  const auth = loadAuthConfig();
  const server = createPortalServer({ auth });
  server.listen(PORT, HOST, () => {
    console.log(`Insurance ERP API listening on http://${HOST}:${PORT}`);
    console.log(auth.enabled
      ? `Authentication: enabled (${auth.principals.size} principal(s)); actor identity is taken from the token.`
      : 'Authentication: DEMO MODE — the API is open. Set PORTAL_AUTH_TOKENS before exposing this beyond a demo.');
    if (usingDemoVaultSecret()) console.log('PII masking: demo vault secret (set PII_VAULT_SECRET in a real deployment).');
    console.log('State: in-memory demo world (rebuilt on every boot).');
  });
  const shutdown = (signal: string) => {
    console.log(`${signal} received — closing…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
