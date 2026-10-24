/**
 * The request guard: rate limiting, a Bloom filter and negative caching at the API boundary —
 * the three cheapest ways to stop junk traffic from ever reaching the dispatcher or a database.
 *
 * Why this layer exists. The expensive thing in this system is not the 404 — it is everything a
 * request drags behind it on the way to discovering it is a 404: token hashing, a 5 MB body
 * parse, authorisation, and a dispatcher round-trip that, in a durable deployment, becomes SQL
 * against the primary (see `readplane.ts`: unknown statements already default to the primary,
 * the most expensive target). Scanners, typo'd integrations and retry storms generate exactly
 * that traffic. The guard answers it at the door, in microseconds, from memory:
 *
 *  1. **Rate limiting first** (token bucket per client). A bucket costs one map lookup; an
 *     unauthenticated flood is refused with 429 before any hashing or parsing, and an
 *     authenticated abuser is capped per principal so one tenant cannot starve the others.
 *     Two buckets — reads and writes — because a read burst from a console opening is normal
 *     and a write burst at the same rate never is.
 *  2. **A Bloom filter over the route catalogue** (`route-catalogue.ts`). If the filter says
 *     a `METHOD /path` is *definitely* not an endpoint, the request is a 404 without touching
 *     the dispatcher. A Bloom filter never gives a false negative, so a real endpoint is never
 *     refused this way; its rare false positives simply fall through to the dispatcher, which
 *     is the authority. 231 routes at a 0.1% false-positive target cost ~420 bytes.
 *  3. **Negative caching of the 404s that remain.** A false-positive path, or any unknown path
 *     seen once, is remembered for a few jittered seconds in a bounded LRU. Repeat probes —
 *     the actual shape of scanner and broken-client traffic — are then one map hit, and the
 *     dispatcher/database sees each distinct bad path at most once per TTL window.
 *
 * What is deliberately **not** cached or short-circuited here, and why:
 *  - Positive GET bodies. `readplane.ts` rule two — never cache money — applies at this layer
 *    too: most GETs in this portal are balances, holdings or PII-shaped snapshots. Saving the
 *    dispatcher a lookup is not worth serving a stale balance. Reference-data caching belongs
 *    to the memcached read plane, with its generation-counter invalidation.
 *  - POST business refusals (409s). They depend on the payload and on state, not just the path:
 *    "claim CLM-1 is already settled" cached under `/claims/settle` would lie about CLM-2.
 *    Only payload-independent 404s enter the negative cache, and only with status 404 — the
 *    cache itself refuses any other status, so a future caller cannot misuse it.
 *  - Stale negatives after a write. Any successful mutation clears the whole negative cache:
 *    a resource that 404'd a second ago may exist now, and a tiny cache is cheaper to refill
 *    than to invalidate precisely. Correctness beats hit rate.
 *
 * Everything here is bounded (filter bits, cache entries, tracked clients) and clock-injectable,
 * because an unbounded "protection" map is itself a memory denial-of-service.
 */
import { sha256Hex } from './hash.js';

export class RequestGuardError extends Error {}

/* --------------------------------------------------------------------- Bloom filter */

export interface BloomFilterOptions {
  /** Items expected to be added. Ignored when `bits` is given. */
  readonly expectedItems?: number;
  /** Target false-positive probability at `expectedItems`. Ignored when `bits` is given. */
  readonly falsePositiveRate?: number;
  /** Explicit bitset size (deterministic sizing for tests/ops). */
  readonly bits?: number;
  /** Explicit hash count. Derived from bits/expectedItems when omitted. */
  readonly hashFunctions?: number;
}

export interface BloomFilterStats {
  readonly bits: number;
  readonly hashFunctions: number;
  readonly inserted: number;
  readonly setBits: number;
  readonly fillRatio: number;
  /** (setBits / bits) ^ hashFunctions — the classic estimate at the current fill. */
  readonly estimatedFalsePositiveRate: number;
}

const LN2 = Math.LN2;

/**
 * A classic Bloom filter: `k` positions from one SHA-256 digest (double hashing,
 * Kirsch–Mitzenmacher), so the same item hashes identically in Node and the browser.
 * `mightContain` returning false is a proof of absence; true is only a probability.
 */
export class BloomFilter {
  private readonly bitset: Uint8Array;
  private readonly bits: number;
  private readonly hashes: number;
  private insertedCount = 0;
  private setBitCount = 0;

  constructor(options: BloomFilterOptions = {}) {
    const expected = options.expectedItems ?? 512;
    const target = options.falsePositiveRate ?? 0.001;
    if (!Number.isFinite(expected) || expected < 1) throw new RequestGuardError('a Bloom filter needs expectedItems >= 1');
    if (!Number.isFinite(target) || target <= 0 || target >= 1) throw new RequestGuardError('a Bloom filter false-positive rate must be between 0 and 1');
    this.bits = options.bits ?? Math.max(64, Math.ceil((-expected * Math.log(target)) / (LN2 * LN2)));
    if (!Number.isFinite(this.bits) || this.bits < 8) throw new RequestGuardError('a Bloom filter needs at least 8 bits');
    this.hashes = options.hashFunctions ?? Math.min(32, Math.max(1, Math.round((this.bits / expected) * LN2)));
    if (!Number.isFinite(this.hashes) || this.hashes < 1 || this.hashes > 64) throw new RequestGuardError('a Bloom filter needs 1–64 hash functions');
    this.bitset = new Uint8Array(Math.ceil(this.bits / 8));
  }

  private positions(item: string): number[] {
    const digest = sha256Hex(item);
    const h1 = Number.parseInt(digest.slice(0, 8), 16);
    // An odd step, never 0: the probe sequence must be able to reach the whole bitset.
    const h2 = (Number.parseInt(digest.slice(8, 16), 16) | 1) >>> 0;
    const out: number[] = [];
    for (let i = 0; i < this.hashes; i += 1) out.push((h1 + i * h2) % this.bits);
    return out;
  }

  add(item: string): void {
    if (!item) throw new RequestGuardError('a Bloom filter cannot add an empty item');
    for (const position of this.positions(item)) {
      const byte = Math.floor(position / 8);
      const mask = 1 << (position % 8);
      if ((this.bitset[byte]! & mask) === 0) this.setBitCount += 1;
      this.bitset[byte] = this.bitset[byte]! | mask;
    }
    this.insertedCount += 1;
  }

  /** False = definitely absent (the answer the guard acts on). True = probably present. */
  mightContain(item: string): boolean {
    if (!item) return false;
    for (const position of this.positions(item)) {
      if ((this.bitset[Math.floor(position / 8)]! & (1 << (position % 8))) === 0) return false;
    }
    return true;
  }

  stats(): BloomFilterStats {
    const fillRatio = this.setBitCount / this.bits;
    return {
      bits: this.bits,
      hashFunctions: this.hashes,
      inserted: this.insertedCount,
      setBits: this.setBitCount,
      fillRatio,
      estimatedFalsePositiveRate: Math.pow(fillRatio, this.hashes),
    };
  }
}

/* ------------------------------------------------------------------- negative cache */

export interface NegativeCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Injected for deterministic TTL jitter in tests; defaults to Math.random. */
  readonly random?: () => number;
}

export interface NegativeCacheStats {
  readonly size: number;
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly hits: number;
  readonly misses: number;
  readonly stores: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly invalidations: number;
}

interface NegativeEntry {
  readonly status: number;
  readonly body: unknown;
  readonly expiresAt: number;
}

function cloneBody(body: unknown): unknown {
  try {
    return structuredClone(body);
  } catch {
    return body;
  }
}

/**
 * Bounded, jittered-TTL cache of "that does not exist" answers. Only HTTP 404 may be stored —
 * the class enforces it — and entries expire ±10% around the TTL (the read plane's rule) so a
 * warm set of negatives does not all expire into one thundering herd of re-checks. LRU order is
 * the map's insertion order, refreshed on every hit.
 */
export class NegativeCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly entries = new Map<string, NegativeEntry>();
  private counters = { hits: 0, misses: 0, stores: 0, evictions: 0, expirations: 0, invalidations: 0 };

  constructor(options: NegativeCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.ttlMs = options.ttlMs ?? 10_000;
    if (!Number.isFinite(this.maxEntries) || this.maxEntries < 1) throw new RequestGuardError('a negative cache needs maxEntries >= 1');
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new RequestGuardError('a negative cache needs a positive ttlMs');
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  lookup(key: string): { hit: true; status: number; body: unknown } | { hit: false; reason: 'miss' | 'expired' } {
    const entry = this.entries.get(key);
    if (!entry) {
      this.counters.misses += 1;
      return { hit: false, reason: 'miss' };
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return { hit: false, reason: 'expired' };
    }
    // Refresh LRU position: a hot negative stays, a cold one makes room.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return { hit: true, status: entry.status, body: cloneBody(entry.body) };
  }

  /** Store a 404 answer. Any other status is refused (returns false) — see the module header. */
  remember(key: string, status: number, body: unknown): boolean {
    if (status !== 404 || !key) return false;
    if (this.entries.has(key)) this.entries.delete(key);
    const jittered = this.ttlMs * (1 + (this.random() * 2 - 1) * 0.1);
    this.entries.set(key, { status, body: cloneBody(body), expiresAt: this.now() + jittered });
    this.counters.stores += 1;
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.counters.evictions += 1;
      }
    }
    return true;
  }

  forget(key: string): boolean {
    return this.entries.delete(key);
  }

  /** A write may have created what a negative denies. Drop them all; refilling is cheap. */
  clear(): number {
    const removed = this.entries.size;
    if (removed > 0) {
      this.entries.clear();
      this.counters.invalidations += 1;
    }
    return removed;
  }

  stats(): NegativeCacheStats {
    return { size: this.entries.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs, ...this.counters };
  }
}

/* --------------------------------------------------------------------- rate limiter */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Burst capacity of the bucket — the `X-RateLimit-Limit` a client should pace against. */
  readonly limit: number;
  /** Whole tokens left after this call (never negative). */
  readonly remaining: number;
  /** Ms until one more token is available (0 when allowed); drives `Retry-After`. */
  readonly retryAfterMs: number;
  /** Ms until the bucket is completely full again. */
  readonly resetAfterMs: number;
}

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly maxClients?: number;
  readonly now?: () => number;
}

export interface TokenBucketStats {
  readonly clients: number;
  readonly maxClients: number;
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly allowed: number;
  readonly rejected: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per client key: `capacity` tokens of burst, refilled at a steady rate. A burst
 * (a console firing twenty opening reads) is absorbed instantly; a flood drains the bucket and
 * is then paced to the refill rate with an honest `Retry-After`. Tracked clients are bounded
 * LRU — an attacker minting source keys cannot grow this map without limit.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxClients: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private allowedCount = 0;
  private rejectedCount = 0;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxClients = options.maxClients ?? 10_000;
    if (!Number.isFinite(this.capacity) || this.capacity < 1) throw new RequestGuardError('a rate limiter needs capacity >= 1');
    if (!Number.isFinite(this.refillPerSecond) || this.refillPerSecond <= 0) throw new RequestGuardError('a rate limiter needs a positive refillPerSecond');
    if (!Number.isFinite(this.maxClients) || this.maxClients < 1) throw new RequestGuardError('a rate limiter needs maxClients >= 1');
    this.now = options.now ?? Date.now;
  }

  check(key: string, cost = 1): RateLimitDecision {
    if (!key) throw new RequestGuardError('a rate limiter needs a non-empty client key');
    if (!Number.isFinite(cost) || cost <= 0) throw new RequestGuardError('a rate-limit cost must be positive');
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxClients) {
        const oldest = this.buckets.keys().next().value as string | undefined;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, updatedAt: at };
      this.buckets.set(key, bucket);
    } else {
      // Refresh LRU position so active clients are not evicted by a flood of new keys.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, (at - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = at;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.allowedCount += 1;
      return {
        allowed: true,
        limit: this.capacity,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        resetAfterMs: Math.ceil(((this.capacity - bucket.tokens) / this.refillPerSecond) * 1000),
      };
    }
    this.rejectedCount += 1;
    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      limit: this.capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: Math.ceil((deficit / this.refillPerSecond) * 1000),
      resetAfterMs: Math.ceil(((this.capacity - bucket.tokens) / this.refillPerSecond) * 1000),
    };
  }

  stats(): TokenBucketStats {
    return {
      clients: this.buckets.size,
      maxClients: this.maxClients,
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
      allowed: this.allowedCount,
      rejected: this.rejectedCount,
    };
  }
}

/* ------------------------------------------------------------------------- the shield */

export type RequestClass = 'read' | 'write';

export interface RequestShieldOptions {
  /** `METHOD /path` keys the Bloom filter is seeded with — the route catalogue. */
  readonly routes: Iterable<string>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly bloom?: BloomFilterOptions;
  readonly negativeTtlMs?: number;
  readonly negativeMaxEntries?: number;
  readonly readCapacity?: number;
  readonly readRefillPerSecond?: number;
  readonly writeCapacity?: number;
  readonly writeRefillPerSecond?: number;
  readonly maxClients?: number;
}

export interface RequestShieldStats {
  readonly bloom: BloomFilterStats;
  readonly negative: NegativeCacheStats;
  readonly rate: { readonly read: TokenBucketStats; readonly write: TokenBucketStats };
}

/** Canonical guard key for a route: `GET /claims` — query and trailing slash never fork it. */
export function routeKey(method: string, path: string): string {
  const verb = (method || 'GET').toUpperCase();
  const clean = (path.split('?')[0] || '/').trim();
  const withSlash = clean.startsWith('/') ? clean : `/${clean}`;
  return `${verb} ${withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash}`;
}

/** Canonical negative-cache key: the route key plus the query, sorted so order cannot fork it. */
export function negativeKey(method: string, path: string, query = ''): string {
  const sorted = [...new URLSearchParams(query).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = routeKey(method, path);
  return sorted ? `${base}?${sorted}` : base;
}

/**
 * Whose bucket a request draws from. An authenticated principal is the fairest unit (one abuser
 * cannot hide behind a shared NAT, and NAT'd innocents do not share one budget); before auth, or
 * in demo mode where every caller is the demo operator, the source address is the unit.
 * A forwarded address is only trusted when the deployment says a proxy sets it
 * (`PORTAL_TRUST_PROXY=1`) — otherwise any client could mint a fresh bucket per request by
 * lying in a header.
 */
export function rateLimitClientKey(input: {
  readonly principal?: string;
  readonly remoteAddress?: string;
  readonly forwardedFor?: string;
  readonly trustProxy?: boolean;
}): string {
  if (input.principal?.trim()) return `principal:${input.principal.trim()}`;
  if (input.trustProxy && input.forwardedFor?.trim()) {
    const first = input.forwardedFor.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${input.remoteAddress?.trim() || 'unknown'}`;
}

export class RequestShield {
  readonly bloom: BloomFilter;
  readonly negative: NegativeCache;
  private readonly reads: TokenBucketRateLimiter;
  private readonly writes: TokenBucketRateLimiter;

  constructor(options: RequestShieldOptions) {
    const routes = [...options.routes];
    this.bloom = new BloomFilter(options.bloom ?? { expectedItems: Math.max(64, routes.length), falsePositiveRate: 0.001 });
    for (const route of routes) this.bloom.add(routeKey(...splitRoute(route)));
    this.negative = new NegativeCache({
      maxEntries: options.negativeMaxEntries ?? 512,
      ttlMs: options.negativeTtlMs ?? 10_000,
      ...(options.now ? { now: options.now } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
    const shared = {
      maxClients: options.maxClients ?? 10_000,
      ...(options.now ? { now: options.now } : {}),
    };
    this.reads = new TokenBucketRateLimiter({ capacity: options.readCapacity ?? 120, refillPerSecond: options.readRefillPerSecond ?? 5, ...shared });
    this.writes = new TokenBucketRateLimiter({ capacity: options.writeCapacity ?? 60, refillPerSecond: options.writeRefillPerSecond ?? 1, ...shared });
  }

  static classOf(method: string): RequestClass {
    const verb = (method || 'GET').toUpperCase();
    return verb === 'GET' || verb === 'HEAD' ? 'read' : 'write';
  }

  checkRate(clientKey: string, method: string): RateLimitDecision & { class: RequestClass } {
    const requestClass = RequestShield.classOf(method);
    const decision = (requestClass === 'read' ? this.reads : this.writes).check(clientKey);
    return { ...decision, class: requestClass };
  }

  /** False = this `METHOD /path` is provably not an endpoint; refuse it at the door. */
  mightBeRoute(method: string, path: string): boolean {
    return this.bloom.mightContain(routeKey(method, path));
  }

  lookupNegative(method: string, path: string, query = ''): ReturnType<NegativeCache['lookup']> {
    return this.negative.lookup(negativeKey(method, path, query));
  }

  rememberNegative(method: string, path: string, query: string, status: number, body: unknown): boolean {
    return this.negative.remember(negativeKey(method, path, query), status, body);
  }

  /**
   * The world changed under the cache. A successful write clears every negative (the denied
   * thing may exist now); a successful read just retires its own key, if one was ever stored.
   */
  noteSuccess(method: string, path: string, query = ''): void {
    if (RequestShield.classOf(method) === 'write') {
      this.negative.clear();
    } else {
      this.negative.forget(negativeKey(method, path, query));
    }
  }

  stats(): RequestShieldStats {
    return {
      bloom: this.bloom.stats(),
      negative: this.negative.stats(),
      rate: { read: this.reads.stats(), write: this.writes.stats() },
    };
  }
}

function splitRoute(route: string): [method: string, path: string] {
  const [method = 'GET', ...rest] = route.trim().split(/\s+/);
  return [method, rest.join(' ') || '/'];
}

/* ---------------------------------------------------------------------- environment */

export interface RequestGuardConfig {
  readonly enabled: boolean;
  readonly readCapacity: number;
  readonly readRefillPerSecond: number;
  readonly writeCapacity: number;
  readonly writeRefillPerSecond: number;
  readonly maxClients: number;
  readonly negativeTtlMs: number;
  readonly negativeMaxEntries: number;
  /** Honour `x-forwarded-for` for rate-limit keys (only behind a proxy that sets it). */
  readonly trustProxy: boolean;
}

function positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RequestGuardError(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

/**
 * Guard configuration from the environment, following the `PORTAL_*` convention of
 * `src/server/auth.ts`. Defaults are sized for this portal: a console opening fires a few dozen
 * reads (burst 120, then 5/s sustained) and human-paced writes (burst 60, then 1/s). A durable
 * multi-tenant deployment raises them per principal, it does not disable the guard.
 */
export function loadRequestGuardConfig(env: Record<string, string | undefined> = process.env): RequestGuardConfig {
  return {
    enabled: env['PORTAL_REQUEST_GUARD']?.trim().toLowerCase() !== 'off',
    readCapacity: positiveNumber(env, 'PORTAL_RATE_READ_BURST', 120),
    readRefillPerSecond: positiveNumber(env, 'PORTAL_RATE_READ_PER_SECOND', 5),
    writeCapacity: positiveNumber(env, 'PORTAL_RATE_WRITE_BURST', 60),
    writeRefillPerSecond: positiveNumber(env, 'PORTAL_RATE_WRITE_PER_SECOND', 1),
    maxClients: Math.floor(positiveNumber(env, 'PORTAL_RATE_MAX_CLIENTS', 10_000)),
    negativeTtlMs: positiveNumber(env, 'PORTAL_NEGATIVE_CACHE_TTL_MS', 10_000),
    negativeMaxEntries: Math.floor(positiveNumber(env, 'PORTAL_NEGATIVE_CACHE_MAX', 512)),
    trustProxy: env['PORTAL_TRUST_PROXY']?.trim() === '1',
  };
}

/** Build the shield for a route catalogue from parsed config (undefined = guard off). */
export function requestShieldFromConfig(
  config: RequestGuardConfig,
  routes: Iterable<string>,
): RequestShield | undefined {
  if (!config.enabled) return undefined;
  return new RequestShield({
    routes,
    readCapacity: config.readCapacity,
    readRefillPerSecond: config.readRefillPerSecond,
    writeCapacity: config.writeCapacity,
    writeRefillPerSecond: config.writeRefillPerSecond,
    maxClients: config.maxClients,
    negativeTtlMs: config.negativeTtlMs,
    negativeMaxEntries: config.negativeMaxEntries,
  });
}
