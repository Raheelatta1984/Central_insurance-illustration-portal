/**
 * The request guard, proven at the unit boundary: a Bloom filter that can never refuse a real
 * endpoint, a negative cache that can only ever hold 404s and never outlives a write, and a
 * token bucket that absorbs a console's opening burst while pacing a flood — because each of
 * those properties is the difference between "less load" and "a new way to be wrong".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BloomFilter, NegativeCache, RequestGuardError, RequestShield, TokenBucketRateLimiter,
  loadRequestGuardConfig, negativeKey, rateLimitClientKey, requestShieldFromConfig, routeKey,
} from './requestguard.js';
import { API_ROUTE_KEYS } from './route-catalogue.js';

describe('route catalogue (the Bloom filter seed)', () => {
  it('matches the dispatcher case table exactly, so the seed can never drift', () => {
    // Reason: a catalogue that misses a real route would make the guard refuse a live endpoint.
    const source = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
    const fromDispatcher = [...source.matchAll(/case\s+'(GET|POST)\s+([^']+)'/g)]
      .map((m) => `${m[1]} ${m[2]}`);
    expect(new Set(API_ROUTE_KEYS)).toEqual(new Set(fromDispatcher));
    expect(API_ROUTE_KEYS.length).toBe(new Set(API_ROUTE_KEYS).size);
  });
});

describe('BloomFilter', () => {
  it('never reports a seeded route as absent (a false negative would refuse a real endpoint)', () => {
    const filter = new BloomFilter({ expectedItems: API_ROUTE_KEYS.length, falsePositiveRate: 0.001 });
    for (const route of API_ROUTE_KEYS) filter.add(route);
    for (const route of API_ROUTE_KEYS) expect(filter.mightContain(route), route).toBe(true);
    expect(filter.stats().inserted).toBe(API_ROUTE_KEYS.length);
  });

  it('rejects plainly-unknown paths while keeping false positives rare and honest', () => {
    const filter = new BloomFilter({ expectedItems: API_ROUTE_KEYS.length, falsePositiveRate: 0.001 });
    for (const route of API_ROUTE_KEYS) filter.add(route);
    // Scanner-shaped probes: none of these exist, so almost all must be proven absent.
    const probes = Array.from({ length: 500 }, (_, i) => `GET /scan/wp-admin-${i}`);
    const falsePositives = probes.filter((p) => filter.mightContain(p));
    expect(falsePositives.length).toBeLessThanOrEqual(10);
    expect(filter.mightContain('GET /wp-login.php')).toBe(false);
    expect(filter.stats().estimatedFalsePositiveRate).toBeLessThan(0.05);
    expect(filter.stats().bits).toBeLessThan(10_000); // hundreds of routes must cost bytes, not megabytes
  });

  it('treats an empty item as absent and refuses to add one', () => {
    const filter = new BloomFilter();
    expect(filter.mightContain('')).toBe(false);
    expect(() => filter.add('')).toThrow(RequestGuardError);
    expect(() => new BloomFilter({ falsePositiveRate: 1 })).toThrow(RequestGuardError);
    expect(() => new BloomFilter({ expectedItems: 0 })).toThrow(RequestGuardError);
  });

  it('honours explicit sizing for deterministic deployments', () => {
    const filter = new BloomFilter({ bits: 1024, hashFunctions: 7 });
    filter.add('GET /health');
    expect(filter.mightContain('GET /health')).toBe(true);
    expect(filter.stats()).toMatchObject({ bits: 1024, hashFunctions: 7, inserted: 1 });
    expect(filter.stats().setBits).toBeGreaterThan(0);
    expect(filter.stats().setBits).toBeLessThanOrEqual(7);
  });
});

describe('NegativeCache', () => {
  it('serves a remembered 404 until its TTL passes, then makes the caller re-check', () => {
    let at = 1_000;
    const cache = new NegativeCache({ ttlMs: 1_000, now: () => at, random: () => 0.5 });
    expect(cache.lookup('GET /nope')).toEqual({ hit: false, reason: 'miss' });
    expect(cache.remember('GET /nope', 404, { error: 'no such endpoint' })).toBe(true);
    expect(cache.lookup('GET /nope')).toEqual({ hit: true, status: 404, body: { error: 'no such endpoint' } });
    at += 1_001;
    expect(cache.lookup('GET /nope')).toEqual({ hit: false, reason: 'expired' });
    expect(cache.stats()).toMatchObject({ size: 0, hits: 1, expirations: 1 });
  });

  it('refuses to store anything but a 404 (a cached 409 or 500 would lie about other requests)', () => {
    const cache = new NegativeCache();
    expect(cache.remember('POST /claims/settle', 409, { error: 'already settled' })).toBe(false);
    expect(cache.remember('GET /world', 500, { error: 'internal error' })).toBe(false);
    expect(cache.remember('', 404, {})).toBe(false);
    expect(cache.stats().size).toBe(0);
  });

  it('is bounded LRU: the coldest negative makes room, a hot one survives', () => {
    const cache = new NegativeCache({ maxEntries: 2, random: () => 0.5 });
    cache.remember('GET /a', 404, {});
    cache.remember('GET /b', 404, {});
    cache.lookup('GET /a'); // hot
    cache.remember('GET /c', 404, {});
    expect(cache.lookup('GET /b').hit).toBe(false);
    expect(cache.lookup('GET /a').hit).toBe(true);
    expect(cache.stats()).toMatchObject({ size: 2, evictions: 1 });
  });

  it('returns a copy, so a caller mutating a cached body cannot poison the next answer', () => {
    const cache = new NegativeCache({ random: () => 0.5 });
    cache.remember('GET /nope', 404, { error: 'no such endpoint' });
    const first = cache.lookup('GET /nope');
    if (first.hit) (first.body as { error: string }).error = 'tampered';
    expect(cache.lookup('GET /nope')).toEqual({ hit: true, status: 404, body: { error: 'no such endpoint' } });
  });

  it('validates its bounds instead of becoming an unbounded memory sink', () => {
    expect(() => new NegativeCache({ maxEntries: 0 })).toThrow(RequestGuardError);
    expect(() => new NegativeCache({ ttlMs: 0 })).toThrow(RequestGuardError);
  });
});

describe('TokenBucketRateLimiter', () => {
  it('absorbs a burst up to capacity, then paces to the refill rate with a retry delay', () => {
    let at = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => at });
    expect(limiter.check('client').allowed).toBe(true);
    expect(limiter.check('client').allowed).toBe(true);
    expect(limiter.check('client').allowed).toBe(true);
    const refused = limiter.check('client');
    expect(refused).toMatchObject({ allowed: false, limit: 3, remaining: 0 });
    expect(refused.retryAfterMs).toBe(1_000);
    at += 1_000; // one token refills
    expect(limiter.check('client').allowed).toBe(true);
    expect(limiter.stats()).toMatchObject({ allowed: 4, rejected: 1, clients: 1 });
  });

  it('keeps clients independent and bounds how many it tracks', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, maxClients: 2, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true); // a's flood does not spend b's budget
    limiter.check('c'); // third distinct key evicts the least-recently-used bucket
    expect(limiter.stats().clients).toBe(2);
  });

  it('supports a cost above one for expensive requests and rejects bad input', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillPerSecond: 1, now: () => 0 });
    expect(limiter.check('client', 4).remaining).toBe(1);
    expect(limiter.check('client', 2).allowed).toBe(false);
    expect(() => limiter.check('')).toThrow(RequestGuardError);
    expect(() => limiter.check('client', 0)).toThrow(RequestGuardError);
    expect(() => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(RequestGuardError);
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(RequestGuardError);
  });
});

describe('RequestShield', () => {
  function shield(overrides: Partial<ConstructorParameters<typeof RequestShield>[0]> = {}): RequestShield {
    const at = 0;
    return new RequestShield({
      routes: API_ROUTE_KEYS, now: () => at, random: () => 0.5, ...overrides,
    });
  }

  it('recognises every real route and dismisses invented ones before any dispatch', () => {
    const guard = shield();
    for (const route of API_ROUTE_KEYS) {
      const [method = 'GET', path = '/'] = route.split(/\s+/);
      expect(guard.mightBeRoute(method, path!), route).toBe(true);
    }
    expect(guard.mightBeRoute('GET', '/wp-login.php')).toBe(false);
    expect(guard.mightBeRoute('POST', '/claims/settle/extra')).toBe(false);
    expect(guard.mightBeRoute('DELETE', '/world')).toBe(false);
  });

  it('normalises method, trailing slash and query so spelling cannot fork the gate', () => {
    const guard = shield();
    expect(routeKey('get', '/claims/')).toBe('GET /claims');
    expect(routeKey('GET', '/claims?x=1')).toBe('GET /claims');
    expect(guard.mightBeRoute('get', '/claims/')).toBe(true);
    expect(negativeKey('GET', '/x', 'b=2&a=1')).toBe(negativeKey('GET', '/x', 'a=1&b=2'));
  });

  it('negative-caches a miss, then drops every negative the moment a write succeeds', () => {
    const guard = shield();
    guard.rememberNegative('GET', '/ghost', '', 404, { error: 'no such endpoint' });
    expect(guard.lookupNegative('GET', '/ghost').hit).toBe(true);
    guard.noteSuccess('POST', '/claims/register'); // the ghost may have just been created
    expect(guard.lookupNegative('GET', '/ghost').hit).toBe(false);
    expect(guard.stats().negative.invalidations).toBe(1);
  });

  it('rates reads and writes from separate buckets (a read burst must not spend write budget)', () => {
    const guard = shield({ readCapacity: 2, readRefillPerSecond: 0.1, writeCapacity: 1, writeRefillPerSecond: 0.1 });
    expect(guard.checkRate('principal:alice', 'GET').allowed).toBe(true);
    expect(guard.checkRate('principal:alice', 'GET').allowed).toBe(true);
    expect(guard.checkRate('principal:alice', 'GET')).toMatchObject({ allowed: false, class: 'read' });
    expect(guard.checkRate('principal:alice', 'POST')).toMatchObject({ allowed: true, class: 'write' });
    expect(RequestShield.classOf('HEAD')).toBe('read');
    expect(RequestShield.classOf('DELETE')).toBe('write');
  });

  it('reports one coherent stats snapshot for health/ops', () => {
    const guard = shield();
    guard.checkRate('ip:203.0.113.9', 'GET');
    guard.rememberNegative('GET', '/ghost', '', 404, { error: 'no such endpoint' });
    const stats = guard.stats();
    expect(stats.bloom.inserted).toBe(API_ROUTE_KEYS.length);
    expect(stats.negative.size).toBe(1);
    expect(stats.rate.read.allowed).toBe(1);
  });
});

describe('client keys and environment config', () => {
  it('keys by principal first, and only trusts a forwarded address behind a declared proxy', () => {
    expect(rateLimitClientKey({ principal: 'alice', remoteAddress: '10.0.0.1' })).toBe('principal:alice');
    expect(rateLimitClientKey({ remoteAddress: '10.0.0.1', forwardedFor: '203.0.113.9, 10.0.0.2' })).toBe('ip:10.0.0.1');
    expect(rateLimitClientKey({ remoteAddress: '10.0.0.1', forwardedFor: '203.0.113.9, 10.0.0.2', trustProxy: true })).toBe('ip:203.0.113.9');
    expect(rateLimitClientKey({})).toBe('ip:unknown');
  });

  it('defaults to a guard sized for a console opening, and honours explicit off', () => {
    const config = loadRequestGuardConfig({});
    expect(config).toMatchObject({ enabled: true, readCapacity: 120, writeCapacity: 60, negativeTtlMs: 10_000 });
    expect(requestShieldFromConfig(config, API_ROUTE_KEYS)).toBeInstanceOf(RequestShield);
    const off = loadRequestGuardConfig({ PORTAL_REQUEST_GUARD: 'off' });
    expect(off.enabled).toBe(false);
    expect(requestShieldFromConfig(off, API_ROUTE_KEYS)).toBeUndefined();
  });

  it('parses operator tuning and fails fast on nonsense instead of silently unlimiting', () => {
    const config = loadRequestGuardConfig({
      PORTAL_RATE_READ_BURST: '30', PORTAL_RATE_WRITE_PER_SECOND: '2',
      PORTAL_NEGATIVE_CACHE_TTL_MS: '2500', PORTAL_TRUST_PROXY: '1',
    });
    expect(config).toMatchObject({ readCapacity: 30, writeRefillPerSecond: 2, negativeTtlMs: 2500, trustProxy: true });
    expect(() => loadRequestGuardConfig({ PORTAL_RATE_READ_BURST: 'lots' })).toThrow(RequestGuardError);
    expect(() => loadRequestGuardConfig({ PORTAL_NEGATIVE_CACHE_MAX: '-1' })).toThrow(RequestGuardError);
  });
});
