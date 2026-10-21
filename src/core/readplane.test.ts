/**
 * The read plane has one job: make reads faster without ever making them wrong. These tests pin
 * the refusals (locks, sequences, session state, unknown SQL, write transactions, read-your-writes
 * pinning), the fallback when no replica is fresh, the breaker, and the cache's refusal to store
 * money or a clock-dependent answer.
 */
import { describe, expect, it } from 'vitest';
import { CacheCluster, CacheError, ReadPlaneError, ReadRouter } from './readplane.js';
import { classifySql, stripSql } from './sqlclass.js';

describe('sql classification', () => {
  const read = [
    'SELECT 1',
    'select * from products where line = $1',
    "SELECT * FROM t WHERE note = 'delete every row'",     // a literal is not a statement
    '/* DELETE FROM t */ SELECT count(*) FROM t',
    '-- UPDATE t SET x = 1\nSELECT 1',
    'WITH cheap AS (SELECT * FROM fund) SELECT * FROM cheap',
    'WITH RECURSIVE tree AS (SELECT 1) SELECT * FROM tree',
    'VALUES (1), (2)',
    'TABLE products',
    'EXPLAIN SELECT * FROM t',
  ];
  it.each(read)('routes %j to a replica', (sql) => {
    expect(classifySql(sql).kind).toBe('read');
  });

  const write = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x = 1',
    'DELETE FROM t',
    'TRUNCATE t',
    'CREATE TABLE t (id bigint)',
    'ALTER TABLE t ADD COLUMN x int',
    'DROP TABLE t',
    'GRANT SELECT ON t TO reader',
    'COPY t FROM STDIN',
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t FOR NO KEY UPDATE',
    'SELECT * INTO scratch FROM t',
    "SELECT nextval('policy_seq')",
    "SELECT setval('policy_seq', 10)",
    'WITH gone AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM gone)',
    'EXPLAIN ANALYZE DELETE FROM t',
  ];
  it.each(write)('refuses to send %j to a replica', (sql) => {
    expect(classifySql(sql).kind).toBe('write');
  });

  const session = [
    'BEGIN',
    'START TRANSACTION',
    'COMMIT',
    'SET search_path TO portal',
    'RESET ALL',
    'LISTEN changes',
    'PREPARE p AS SELECT 1',
    'SELECT pg_advisory_lock(42)',
    'SELECT set_config($1, $2, false)',
  ];
  it.each(session)('keeps %j on the primary (session state)', (sql) => {
    expect(classifySql(sql).kind).toBe('session');
  });

  it('treats what it does not understand as primary-only, never as a read', () => {
    for (const sql of ['', '   ', '-- just a comment', 'FOO BAR', 'SELECT 1; DELETE FROM t']) {
      expect(classifySql(sql).kind, sql).toBe('unknown');
    }
    expect(classifySql('').reason).toMatch(/empty/);
    expect(classifySql('SELECT 1; DELETE FROM t').reason).toMatch(/multiple statements/);
  });

  it('does not cache a read whose answer depends on the clock or randomness', () => {
    expect(classifySql('SELECT * FROM products').cacheable).toBe(true);
    expect(classifySql('SELECT now()').cacheable).toBe(false);
    expect(classifySql('SELECT current_timestamp').cacheable).toBe(false);
    expect(classifySql('SELECT random()').cacheable).toBe(false);
    expect(classifySql('SELECT * FROM t WHERE created_by = current_user').cacheable).toBe(false);
    expect(classifySql('INSERT INTO t VALUES (1)').cacheable).toBe(false);
  });

  it('strips dollar-quoted bodies, so a function body cannot smuggle a keyword', () => {
    const body = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; DROP TABLE t; $$ LANGUAGE sql';
    expect(stripSql(body)).not.toMatch(/DROP/);
    expect(classifySql(body).kind).toBe('write');
  });
});

const T0 = 1_000_000;

function router(overrides: Partial<ConstructorParameters<typeof ReadRouter>[0]> = {}) {
  let now = T0;
  const instance = new ReadRouter({
    primary: 'primary',
    replicas: [{ id: 'r1', zone: 'a' }, { id: 'r2', zone: 'b' }],
    maxLagMs: 1_000,
    now: () => now,
    pinMs: 5_000,
    ...overrides,
  });
  return {
    router: instance,
    advance(ms: number) { now += ms; },
  };
}

describe('read routing', () => {
  it('sends writes to the primary and notes that the session must read its own write', () => {
    const { router: r } = router();
    const write = r.route({ sql: 'UPDATE policy SET status = $1', sessionId: 's1' });
    expect(write.target).toBe('primary');
    expect(write.kind).toBe('write');
    const read = r.route({ sql: 'SELECT * FROM policy', sessionId: 's1' });
    expect(read.target).toBe('primary');
    expect(read.reason).toMatch(/read-your-writes/);
    // Another session is not pinned.
    expect(r.route({ sql: 'SELECT * FROM policy', sessionId: 's2' }).target).toMatch(/^r[12]$/);
  });

  it('load-balances reads across healthy replicas and uses the primary when there are none', () => {
    const { router: r } = router();
    const targets = new Set(Array.from({ length: 6 }, () => r.route({ sql: 'SELECT * FROM products' }).target));
    expect(targets).toEqual(new Set(['r1', 'r2']));
    expect(r.stats().replicaRoutes).toBe(6);

    const direct = new ReadRouter({ primary: 'primary', replicas: [] });
    expect(direct.route({ sql: 'SELECT 1' }).target).toBe('primary');
    expect(direct.route({ sql: 'SELECT 1' }).reason).toMatch(/no replicas/);
    expect(direct.stats().replicaFallbacks).toBe(2);
  });

  it('stops using a replica whose lag is outside the budget, and says how far behind it is', () => {
    const { router: r } = router();
    r.updateLag('r1', 500);
    r.updateLag('r2', 900);
    expect(r.route({ sql: 'SELECT 1' }).target).toBe('r1');
    r.updateLag('r1', 1_500);
    const fallback = r.route({ sql: 'SELECT 1' });
    expect(fallback.target).toBe('r2');
    r.updateLag('r2', 1_500);
    const primary = r.route({ sql: 'SELECT 1' });
    expect(primary.target).toBe('primary');
    expect(primary.reason).toMatch(/lagging|no replica/i);
    expect(() => r.updateLag('nope', 0)).toThrow(ReadPlaneError);
    expect(() => r.updateLag('r1', -1)).toThrow(/non-negative/);
  });

  it('honours a per-replica lag budget as an override', () => {
    const { router: r } = router({ replicas: [{ id: 'fast', maxLagMs: 10 }, { id: 'slow', maxLagMs: 10_000 }] });
    r.updateLag('fast', 50);
    r.updateLag('slow', 50);
    expect(Array.from({ length: 4 }, () => r.route({ sql: 'SELECT 1' }).target)).toEqual(['slow', 'slow', 'slow', 'slow']);
  });

  it('never sends a read inside a write transaction to a replica', () => {
    const { router: r } = router();
    const decision = r.route({ sql: 'SELECT balance FROM ledger', inTransaction: true });
    expect(decision.target).toBe('primary');
    expect(decision.reason).toMatch(/has not committed/);
  });

  it('opens a breaker after repeated failures, closes it after the cooldown, and probes again', () => {
    const { router: r, advance } = router({ breakerFailureThreshold: 2, breakerCooldownMs: 10_000 });
    r.markDown('r1');
    expect(r.route({ sql: 'SELECT 1' }).target).toBe('r2');
    r.recordFailure('r2');
    r.recordFailure('r2');
    expect(r.route({ sql: 'SELECT 1' }).target).toBe('primary');
    advance(10_001);
    // The cooled-down breaker admits one probe; success closes it.
    expect(r.route({ sql: 'SELECT 1' }).target).toBe('r2');
    r.recordSuccess('r2');
    expect(r.states().find((s) => s.id === 'r2')!.healthy).toBe(true);
    r.markUp('r1');
    expect(r.route({ sql: 'SELECT 1' }).target).toBe('r1');
  });

  it('unpins a session after the pin window, and never pins without a session id', () => {
    const { router: r, advance } = router({ pinMs: 100 });
    r.route({ sql: 'INSERT INTO t VALUES (1)', sessionId: 's1' });
    expect(r.isPinned('s1')).toBe(true);
    advance(101);
    expect(r.isPinned('s1')).toBe(false);
    r.route({ sql: 'INSERT INTO t VALUES (1)' });
    expect(r.isPinned(undefined)).toBe(false);
    expect(r.stats().reads).toBe(0);
  });

  it('counts what it did, so the console can show it', () => {
    const { router: r } = router();
    r.route({ sql: 'SELECT 1' });
    r.route({ sql: 'BEGIN' });
    r.route({ sql: 'DELETE FROM t' });
    r.route({ sql: 'SOMETHING ELSE' });
    expect(r.stats()).toMatchObject({ reads: 1, sessionStatements: 2, writes: 1, replicaRoutes: 1 });
  });

  it('refuses a router that cannot be right', () => {
    expect(() => new ReadRouter({ primary: '', replicas: [] })).toThrow(ReadPlaneError);
    expect(() => new ReadRouter({ primary: 'p', replicas: [{ id: 'p' }] })).toThrow(/also the primary/);
    expect(() => new ReadRouter({ primary: 'p', replicas: [{ id: 'a' }, { id: 'a' }] })).toThrow(/twice/);
    expect(() => new ReadRouter({ primary: 'p', replicas: [], maxLagMs: -1 })).toThrow(/maxLagMs/);
  });
});

describe('memcached cluster', () => {
  function cluster(options: Partial<ConstructorParameters<typeof CacheCluster>[0]> = {}) {
    let now = T0;
    const instance = new CacheCluster({
      servers: [{ id: 'mc1' }, { id: 'mc2' }],
      namespace: 'acme',
      now: () => now,
      random: () => 0.5,   // no jitter unless a test asks for it
      defaultTtlMs: 1_000,
      ...options,
    });
    return { cache: instance, advance(ms: number) { now += ms; } };
  }

  it('routes a key to one server, deterministically, and spreads keys over the cluster', () => {
    const { cache } = cluster();
    expect(cache.serverFor('products')).toBe(cache.serverFor('products'));
    const servers = new Set(Array.from({ length: 60 }, (_, i) => cache.serverFor(`key-${i}`)));
    expect(servers).toEqual(new Set(['mc1', 'mc2']));
    expect(cache.keyFor('products', 'catalogue')).toBe('acme:catalogue:0:products');
    expect(() => cache.keyFor('')).toThrow(CacheError);
  });

  it('stores, serves and expires a value, and counts the hit and the expiry', () => {
    const { cache, advance } = cluster();
    expect(cache.get('products')).toMatchObject({ hit: false, reason: 'miss' });
    expect(cache.set('products', [{ id: 'LIFE' }], { ttlMs: 1_000 })).toMatchObject({ ok: true });
    const hit = cache.get<Array<{ id: string }>>('products');
    expect(hit.hit).toBe(true);
    expect(hit.value![0]!.id).toBe('LIFE');
    advance(1_001);
    expect(cache.get('products')).toMatchObject({ hit: false, reason: 'expired' });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, expired: 1, sets: 1 });
    // The stored copy is not the caller's object: mutating the original cannot corrupt the cache.
    const original = { id: 'MOTOR' };
    cache.set('one', original);
    original.id = 'CHANGED';
    expect(cache.get<{ id: string }>('one').value!.id).toBe('MOTOR');
  });

  it('jitters the TTL so a warm cache does not expire in one herd', () => {
    const exact = cluster({ random: () => 0.5 });
    exact.cache.set('k', 1, { ttlMs: 1_000 });
    exact.advance(999);
    expect(exact.cache.get('k').hit).toBe(true);
    exact.advance(2);
    expect(exact.cache.get('k').hit).toBe(false);

    const long = cluster({ random: () => 1 });
    long.cache.set('k', 1, { ttlMs: 1_000 });
    long.advance(1_099);
    expect(long.cache.get('k').hit).toBe(true);   // +10%
    long.advance(2);
    expect(long.cache.get('k').hit).toBe(false);

    const short = cluster({ random: () => 0 });
    short.cache.set('k', 1, { ttlMs: 1_000 });
    short.advance(901);
    expect(short.cache.get('k').hit).toBe(false); // -10%
  });

  it('invalidates a whole family by moving its generation, with no window and no scan', () => {
    const { cache } = cluster();
    cache.set('LIFE', 'old', { tag: 'catalogue', ttlMs: 60_000 });
    expect(cache.get('LIFE', 'catalogue').hit).toBe(true);
    expect(cache.invalidateTag('catalogue')).toBe(1);
    expect(cache.get('LIFE', 'catalogue')).toMatchObject({ hit: false, reason: 'miss' });
    expect(cache.keyFor('LIFE', 'catalogue')).toBe('acme:catalogue:1:LIFE');
    cache.set('LIFE', 'new', { tag: 'catalogue', ttlMs: 60_000 });
    expect(cache.get<string>('LIFE', 'catalogue').value).toBe('new');
    expect(cache.stats().invalidations).toBe(1);
  });

  it('refuses to cache money, PII, auth material, writes and clock-dependent reads', () => {
    const { cache } = cluster();
    expect(cache.canCache('SELECT * FROM products')).toMatchObject({ ok: true });
    expect(cache.canCache('SELECT * FROM ledger', 'money')).toMatchObject({ ok: false });
    expect(cache.canCache('SELECT * FROM ledger', 'money').reason).toMatch(/money/);
    expect(cache.canCache('SELECT * FROM party', 'pii').ok).toBe(false);
    expect(cache.canCache('SELECT * FROM session', 'auth').ok).toBe(false);
    expect(cache.canCache('DELETE FROM products').ok).toBe(false);
    expect(cache.canCache('SELECT now()').ok).toBe(false);
    expect(cache.canCache('SELECT * FROM products', 'reference').ok).toBe(true);

    const result = cache.getOrLoad('ledger', { sql: 'SELECT sum(amount) FROM ledger', dataClass: 'money', loader: () => 42 });
    return expect(result).resolves.toMatchObject({ cached: false, value: 42 });
  });

  it('collapses a stampede into one load (single-flight)', async () => {
    const { cache } = cluster();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { rows: 3 };
    };
    const answers = await Promise.all(Array.from({ length: 5 }, () =>
      cache.getOrLoad('catalogue', { sql: 'SELECT * FROM products', ttlMs: 5_000, loader })));
    expect(loads).toBe(1);
    expect(answers.every((a) => a.value.rows === 3)).toBe(true);
    expect(cache.stats().singleFlightJoins).toBe(4);
    // A second call after the flight is a cache hit, not another load.
    const again = await cache.getOrLoad('catalogue', { sql: 'SELECT * FROM products', ttlMs: 5_000, loader });
    expect(again).toMatchObject({ cached: true, reason: 'hit' });
    expect(loads).toBe(1);
  });

  it('refuses a value or key memcached could not hold, rather than dropping it silently', () => {
    const { cache } = cluster({ maxValueBytes: 16, maxKeyLength: 24 });
    expect(cache.set('big', 'x'.repeat(100))).toMatchObject({ ok: false });
    expect(cache.set('big', 'x'.repeat(100)).reason).toMatch(/memcached allows/);
    expect(cache.set('a-very-long-cache-key-name', 1)).toMatchObject({ ok: false });
    expect(cache.set('k', 1, { ttlMs: 0 })).toMatchObject({ ok: false });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(cache.set('k', circular).ok).toBe(false);
    expect(cache.stats().refusals).toBeGreaterThan(0);
  });

  it('purges expired entries on demand and reports what each server holds', () => {
    const { cache, advance } = cluster();
    cache.set('a', 'x', { ttlMs: 10 });
    cache.set('b', 'y', { ttlMs: 60_000 });
    expect(cache.occupancy().reduce((sum, s) => sum + s.keys, 0)).toBe(2);
    advance(11);
    expect(cache.purgeExpired()).toBe(1);
    const occupancy = cache.occupancy();
    expect(occupancy.reduce((sum, s) => sum + s.keys, 0)).toBe(1);
    expect(occupancy.reduce((sum, s) => sum + s.bytes, 0)).toBeGreaterThan(0);
    expect(cache.delete('b')).toBe(true);
    expect(cache.delete('b')).toBe(false);
  });

  it('refuses a cluster that would share keys or lose writes', () => {
    expect(() => new CacheCluster({ servers: [], namespace: 'x' })).toThrow(CacheError);
    expect(() => new CacheCluster({ servers: [{ id: 'a' }, { id: 'a' }], namespace: 'x' })).toThrow(/twice/);
    expect(() => new CacheCluster({ servers: [{ id: 'a' }], namespace: ' ' })).toThrow(/namespace/);
  });
});
