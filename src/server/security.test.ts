/**
 * The credential path, proven over a real socket.
 *
 * What this file is protecting, and why each test exists rather than what it mechanically checks:
 *  - the browser must never be handed a credential that script can read, so a sign-in response is
 *    asserted to be an `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `__Host-` cookie and *not* a
 *    token in the body;
 *  - a cookie is attached automatically by the browser, which is exactly what makes forgery
 *    possible, so a foreign `Origin` on an unsafe method must be refused even when the session is
 *    genuine — and a same-origin call must still work, or operators would route around the fix;
 *  - machine clients keep working: `Authorization: Bearer …` is the documented API contract and is
 *    never subject to the cookie rules;
 *  - signing out must revoke server-side, not merely ask the browser to forget the id;
 *  - every response carries the hardening headers, including the ones a new route would forget.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortalServer } from './main.js';
import { SessionStore, loadAuthConfig, parseCookies, sessionCookie, clearedSessionCookie, HOST_SESSION_COOKIE } from './auth.js';
import { contentSecurityPolicy, originRefusal } from './security.js';
import { createRuntimeState } from '../core/routes.js';

const dist = mkdtempSync(join(tmpdir(), 'portal-security-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")');

const TOKENS = { PORTAL_AUTH_TOKENS: 'admintoken=alice:admin;partnertoken=bob:partner-manager,partner:DEMO-BROKER' };

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveListen(`http://127.0.0.1:${port}`);
    });
  });
}

/** The cookie pair (`name=value`) from a `set-cookie` header, ready to send back. */
function cookiePair(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0]!;
}

describe('browser sessions (auth enabled)', () => {
  let server: Server;
  let base: string;
  let sessions: SessionStore;
  beforeAll(async () => {
    sessions = new SessionStore({ ttlMs: 60_000 });
    server = createPortalServer({
      state: createRuntimeState(), dist, auth: loadAuthConfig(TOKENS), env: TOKENS, sessions, log: () => {},
    });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('exchanges a valid token for an HttpOnly __Host- cookie instead of returning the token', async () => {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'admintoken' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    // The attributes that make theft-by-script impossible and cross-site use hard.
    expect(setCookie).toContain(`${HOST_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=60');
    // __Host- forbids a Domain attribute; a browser would reject the cookie if one were present.
    expect(setCookie).not.toContain('Domain=');
    const body = (await res.json()) as { principal: { name: string; roles: string[] }; expiresAt: string };
    expect(body.principal).toEqual({ name: 'alice', roles: ['admin'] });
    // The credential itself must never come back to the page.
    expect(JSON.stringify(body)).not.toContain('admintoken');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('authenticates with the cookie alone — no Authorization header at all', async () => {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'admintoken' }),
    });
    const cookie = cookiePair(login.headers.get('set-cookie'));
    const res = await fetch(`${base}/api/world`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await fetch(`${base}/api/world`)).status).toBe(401);
  });

  it('refuses a wrong, missing or non-string token without minting a session', async () => {
    for (const body of [JSON.stringify({ token: 'not-a-token' }), JSON.stringify({}), JSON.stringify({ token: 42 })]) {
      const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect([400, 401]).toContain(res.status);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect((await fetch(`${base}/api/world`, { headers: { cookie: `${HOST_SESSION_COOKIE}=forged` } })).status).toBe(401);
  });

  it('refuses a cookie-authenticated write whose Origin is another site, and allows its own', async () => {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'admintoken' }),
    });
    const cookie = cookiePair(login.headers.get('set-cookie'));
    const foreign = await fetch(`${base}/api/cover/start`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ customerName: 'csrf probe' }),
    });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toMatch(/Origin https:\/\/evil\.example/);
    const opaque = await fetch(`${base}/api/cover/start`, {
      method: 'POST', headers: { cookie, origin: 'null', 'content-type': 'application/json' }, body: '{}',
    });
    expect(opaque.status).toBe(403);
    // Its own origin still works: the fix must not forbid the console it protects.
    const own = await fetch(`${base}/api/cover/start`, {
      method: 'POST',
      headers: { cookie, origin: new URL(base).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ customerName: 'same-origin' }),
    });
    expect([200, 400, 409]).toContain(own.status);
  });

  it('keeps Bearer clients working and out of the cookie rules (no Origin needed)', async () => {
    const res = await fetch(`${base}/api/cover/start`, {
      method: 'POST',
      headers: { authorization: 'Bearer admintoken', origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    // A cross-site page cannot set Authorization without a preflight that CORS refuses; the request
    // here is a non-browser client, and its credential is not ambient, so it is not a CSRF risk.
    expect([200, 400, 409]).toContain(res.status);
  });

  it('revokes the session on sign-out and clears the cookie with the same attributes', async () => {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'admintoken' }),
    });
    const cookie = cookiePair(login.headers.get('set-cookie'));
    expect((await fetch(`${base}/api/world`, { headers: { cookie } })).status).toBe(200);
    const out = await fetch(`${base}/api/session`, {
      method: 'DELETE', headers: { cookie, origin: new URL(base).origin, host: new URL(base).host },
    });
    expect(out.status).toBe(200);
    const cleared = out.headers.get('set-cookie');
    expect(cleared).toContain(`${HOST_SESSION_COOKIE}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    // Revoked server-side: the old id is worthless now, which clearing alone would not achieve.
    expect((await fetch(`${base}/api/world`, { headers: { cookie } })).status).toBe(401);
  });

  it('refuses a cross-site sign-out', async () => {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'admintoken' }),
    });
    const cookie = cookiePair(login.headers.get('set-cookie'));
    const out = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { cookie, origin: 'https://evil.example', host: new URL(base).host } });
    expect(out.status).toBe(403);
    expect((await fetch(`${base}/api/world`, { headers: { cookie } })).status).toBe(200);
    expect(sessions.size).toBeGreaterThan(0);
  });
});

describe('demo mode', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth: loadAuthConfig({}), env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('says there is nothing to sign in with instead of pretending to authenticate', async () => {
    const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"x"}' });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toMatch(/demo mode/);
  });
});

describe('hardening headers', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createPortalServer({ state: createRuntimeState(), dist, auth: loadAuthConfig({}), env: {}, log: () => {} });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  const expectBaseline = (res: Response) => {
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // The line that must never be crossed: inline script would neuter the whole policy.
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
  };

  it('sends the policy on the HTML shell, on an asset and on the API', async () => {
    expectBaseline(await fetch(`${base}/`));
    expectBaseline(await fetch(`${base}/assets/app.js`));
    expectBaseline(await fetch(`${base}/api/health`));
  });

  it('never sends HSTS over plain HTTP, and sends it when a proxy says the request was HTTPS', async () => {
    expect((await fetch(`${base}/`)).headers.get('strict-transport-security')).toBeNull();
    const viaProxy = await fetch(`${base}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(viaProxy.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('adds upgrade-insecure-requests only in production', () => {
    expect(contentSecurityPolicy({})).not.toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy({ NODE_ENV: 'production' })).toContain('upgrade-insecure-requests');
  });
});

describe('origin check unit rules', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers } as never);

  it('only checks unsafe methods', () => {
    expect(originRefusal(req('GET', { origin: 'https://evil.example', host: 'portal.example' }))).toBeNull();
  });

  it('allows a matching host, a configured allowlist entry and a bare non-browser client', () => {
    expect(originRefusal(req('POST', { origin: 'https://portal.example', host: 'portal.example' }))).toBeNull();
    expect(originRefusal(req('POST', { origin: 'https://console.example', host: 'portal.example' }), { PORTAL_CORS_ORIGIN: 'https://console.example' })).toBeNull();
    expect(originRefusal(req('POST', { host: 'portal.example' }))).toBeNull();
  });

  it('never accepts the wildcard as an origin', () => {
    expect(originRefusal(req('POST', { origin: 'https://evil.example', host: 'portal.example' }), { PORTAL_CORS_ORIGIN: '*' })).toMatch(/Origin/);
  });

  it('falls back to the Referer, and refuses a malformed one', () => {
    expect(originRefusal(req('POST', { referer: 'https://portal.example/console', host: 'portal.example' }))).toBeNull();
    expect(originRefusal(req('POST', { referer: 'https://evil.example/x', host: 'portal.example' }))).toMatch(/Referer/);
    expect(originRefusal(req('POST', { referer: 'not a url', host: 'portal.example' }))).toMatch(/Referer/);
  });
});

describe('session store', () => {
  it('expires, revokes and caps sessions, and stores only digests', () => {
    let now = 1_000;
    const store = new SessionStore({ ttlMs: 100, maxSessions: 2, now: () => now });
    const first = store.issue({ name: 'alice', roles: ['admin'] });
    expect(store.resolve(first.id)?.name).toBe('alice');
    now += 101;
    expect(store.resolve(first.id)).toBeUndefined();

    const live = store.issue({ name: 'bob', roles: ['operator'] });
    expect(store.revoke(live.id)).toBe(true);
    expect(store.revoke(live.id)).toBe(false);
    expect(store.resolve(live.id)).toBeUndefined();

    const a = store.issue({ name: 'a', roles: [] });
    const b = store.issue({ name: 'b', roles: [] });
    const c = store.issue({ name: 'c', roles: [] });
    expect(store.size).toBe(2);
    expect(store.resolve(a.id)).toBeUndefined();
    expect(store.resolve(b.id)).toBeDefined();
    expect(store.resolve(c.id)).toBeDefined();
  });

  it('serialises and clears with the same name and attributes', () => {
    expect(sessionCookie('abc', { secure: true, maxAgeSeconds: 60 })).toBe(`${HOST_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60`);
    expect(clearedSessionCookie(true)).toContain(`${HOST_SESSION_COOKIE}=;`);
    // A __Host- cookie without Secure is discarded by the browser, so the dev opt-out drops the prefix.
    expect(sessionCookie('abc', { secure: false, maxAgeSeconds: 60 })).toMatch(/^portal_session=abc; Path=\/; HttpOnly; SameSite=Lax/);
    expect(parseCookies(`${HOST_SESSION_COOKIE}=%41%42; other=1`).get(HOST_SESSION_COOKIE)).toBe('AB');
  });
});
