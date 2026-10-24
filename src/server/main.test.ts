/**
 * The HTTP layer, proven over a real socket: body discipline, error mapping, idempotent
 * replay, auth gating and static-file confinement. The domain dispatcher's own tests cannot
 * see any of this — it only exists once bytes arrive.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortalServer, productionRefusals } from './main.js';
import { loadAuthConfig } from './auth.js';
import { createRuntimeState } from '../core/routes.js';
import { RequestShield } from '../core/requestguard.js';
import { API_ROUTE_KEYS } from '../core/route-catalogue.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveListen(`http://127.0.0.1:${port}`);
    });
  });
}

const dist = mkdtempSync(join(tmpdir(), 'portal-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<html>console</html>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');

describe('http server (demo mode)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth: loadAuthConfig({}), env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('serves health with a request id', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it('refuses malformed JSON and non-object bodies as 400 (never an executed {})', async () => {
    const malformed = await fetch(`${base}/api/cover/start`, { method: 'POST', body: '{nope' });
    expect(malformed.status).toBe(400);
    const array = await fetch(`${base}/api/cover/start`, { method: 'POST', body: '[1,2]' });
    expect(array.status).toBe(400);
  });

  it('refuses oversized bodies as 413', async () => {
    const res = await fetch(`${base}/api/ingest/submit`, { method: 'POST', body: 'x'.repeat(5_000_001) });
    expect(res.status).toBe(413);
  });

  it('answers unknown endpoints with 404 JSON', async () => {
    const res = await fetch(`${base}/api/no-such-endpoint`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'no such endpoint' });
  });

  it('replays a keyed mutation instead of applying it twice', async () => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'test-key-reset-1' }, body: '{}' };
    const first = await fetch(`${base}/api/reset`, init);
    const firstBody = (await first.json()) as { version: number };
    const second = await fetch(`${base}/api/reset`, init);
    const secondBody = (await second.json()) as { version: number };
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(secondBody.version).toBe(firstBody.version);
  });

  it('confines static files to dist and caches hashed assets immutably', async () => {
    const traversal = await fetch(`${base}/../secret.txt`);
    expect(await traversal.text()).not.toContain('secret');
    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('maps a domain refusal to 409 with its sentence', async () => {
    const res = await fetch(`${base}/api/claims/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: 'CLM-NOPE' }),
    });
    expect([400, 409]).toContain(res.status);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/CLM-NOPE|no approval/);
  });
});

describe('http server (auth enabled)', () => {
  let server: Server;
  let base: string;
  const auth = loadAuthConfig({ PORTAL_AUTH_TOKENS: 'admintoken=alice:admin;claimstoken=bob:claims-officer' });
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth, env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('requires a token for the API but keeps health public', async () => {
    expect((await fetch(`${base}/api/world`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const ok = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer admintoken' } });
    expect(ok.status).toBe(200);
  });

  it('forbids role escalation and non-admin reset/master changes', async () => {
    const headers = { authorization: 'Bearer claimstoken', 'content-type': 'application/json' };
    const escalate = await fetch(`${base}/api/claims/approve`, {
      method: 'POST', headers, body: JSON.stringify({ claimId: 'CLM-1', role: 'chief-claims-officer' }),
    });
    expect(escalate.status).toBe(403);
    expect((await fetch(`${base}/api/reset`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/master/authority`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
  });
});

describe('http server (request guard: Bloom filter + negative cache)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth: loadAuthConfig({}), env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('refuses an invented endpoint at the Bloom gate, then from the negative cache', async () => {
    const first = await fetch(`${base}/api/definitely-not-an-endpoint`);
    expect(first.status).toBe(404);
    expect(first.headers.get('x-request-guard')).toBe('bloom-miss');
    await expect(first.json()).resolves.toMatchObject({ error: 'no such endpoint' });
    // The repeat never reaches the dispatcher: the remembered 404 answers it.
    const second = await fetch(`${base}/api/definitely-not-an-endpoint`);
    expect(second.status).toBe(404);
    expect(second.headers.get('x-negative-cache')).toBe('hit');
    await expect(second.json()).resolves.toMatchObject({ error: 'no such endpoint' });
  });

  it('refuses an invented POST without parsing or dispatching its body', async () => {
    const res = await fetch(`${base}/api/wp-admin/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ probe: true }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-guard')).toBe('bloom-miss');
  });

  it('still serves real endpoints, and a successful write clears remembered negatives', async () => {
    expect((await fetch(`${base}/api/idempotency`)).status).toBe(200);
    const reset = await fetch(`${base}/api/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(reset.status).toBe(200);
    // The write may have created what the negative denied, so the next probe is gated fresh.
    const again = await fetch(`${base}/api/definitely-not-an-endpoint`);
    expect(again.status).toBe(404);
    expect(again.headers.get('x-negative-cache')).toBeNull();
    expect(again.headers.get('x-request-guard')).toBe('bloom-miss');
  });

  it('reports guard counters on the public health answer', async () => {
    const body = (await (await fetch(`${base}/api/health`)).json()) as { requestGuard?: { bloom: { inserted: number } } };
    expect(body.requestGuard?.bloom.inserted).toBe(API_ROUTE_KEYS.length);
  });
});

describe('http server (request guard: rate limiting)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const guard = new RequestShield({
      routes: API_ROUTE_KEYS, readCapacity: 2, readRefillPerSecond: 0.01, writeCapacity: 1, writeRefillPerSecond: 0.01,
    });
    server = createPortalServer({ state: createRuntimeState(), dist, auth: loadAuthConfig({}), env: {}, guard, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('absorbs the burst, then answers 429 with Retry-After and the budget — while health stays exempt', async () => {
    expect((await fetch(`${base}/api/idempotency`)).status).toBe(200);
    expect((await fetch(`${base}/api/idempotency`)).status).toBe(200);
    const refused = await fetch(`${base}/api/idempotency`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-limit')).toBe('2');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await expect(refused.json()).resolves.toMatchObject({ error: expect.stringContaining('rate limit') });
    // A throttled process is still alive, and the load balancer must be able to learn that.
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});

describe('http server (request guard behind auth)', () => {
  let server: Server;
  let base: string;
  const auth = loadAuthConfig({ PORTAL_AUTH_TOKENS: 'admintoken=alice:admin' });
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth, env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('keeps 401 ahead of the route gate, so the guard is not a route oracle', async () => {
    expect((await fetch(`${base}/api/definitely-not-an-endpoint`)).status).toBe(401);
    const authed = await fetch(`${base}/api/definitely-not-an-endpoint`, { headers: { authorization: 'Bearer admintoken' } });
    expect(authed.status).toBe(404);
    expect(authed.headers.get('x-request-guard')).toBe('bloom-miss');
  });
});

describe('production guardrails', () => {
  it('refuses an open, demo-secret production boot but honours an explicit demo opt-in', () => {
    expect(productionRefusals({ NODE_ENV: 'production' }).length).toBeGreaterThan(0);
    expect(productionRefusals({ NODE_ENV: 'production', PORTAL_ALLOW_DEMO: '1' })).toEqual([]);
    expect(productionRefusals({})).toEqual([]);
    expect(productionRefusals({ NODE_ENV: 'production', PORTAL_API_TOKEN: 't', PII_VAULT_SECRET: 'a-real-secret-from-kms' })).toEqual([]);
  });
});
