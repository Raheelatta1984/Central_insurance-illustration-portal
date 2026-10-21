/**
 * The read plane: replicas for the reads, memcached for the reads that repeat, and the two rules
 * that keep "faster" from meaning "wrong".
 *
 * **Rule one — a read that must be current goes to the primary.** A replica is a copy that is
 * behind by some milliseconds by design. Sending *every* `SELECT` to a replica is how a customer
 * approves a claim and then cannot see it, and how a settlement screen shows yesterday's cash. So
 * the router classifies the statement, and refuses the replica for anything that locks, anything
 * that writes through a function (`nextval`, an advisory lock), anything that runs inside a write
 * transaction, and every read from a session that has just written (read-your-writes pinning).
 * The classification defaults to the **primary** when it does not understand a statement: the safe
 * answer is the slower one.
 *
 * **Rule two — never cache money.** A memcached entry outlives the request that created it, and
 * there is no invalidation protocol that is reliable enough for a trial balance. The cache is for
 * reference data that a human edited (products, rating tables, labels, themes, fund lists) and for
 * expensive, non-volatile rollups — not for balances, not for PII. Invalidation is by **generation
 * counter**, not by deletion: bumping `products` changes every key in that namespace at once, so
 * there is no window in which half the cluster serves the old catalogue.
 *
 * Key stampedes are handled with single-flight: one loader runs per cache key and the concurrent
 * callers wait for its answer. TTLs jitter by ±10% so a warm cache does not expire in one thundering
 * herd.
 */
import { classifySql, type ClassifiedStatement } from './sqlclass.js';
import { sha256Hex } from './hash.js';

/* ------------------------------------------------------------------ replicas */

export class ReadPlaneError extends Error {}

export interface ReplicaSpec {
  readonly id: string;
  readonly zone?: string;
  /** Per-replica override of the router's lag budget. */
  readonly maxLagMs?: number;
}

export interface ReplicaState {
  readonly id: string;
  readonly zone: string;
  lagMs: number;
  healthy: boolean;
  consecutiveFailures: number;
  /** Epoch ms until which the breaker keeps this replica out of rotation. */
  openUntil: number;
}

export interface RouteDecision {
  /** `'primary'` or a replica id. */
  readonly target: string;
  readonly kind: ClassifiedStatement['kind'];
  readonly reason: string;
  /** True when the statement *may* be served from memcached (subject to the data-class policy). */
  readonly cacheable: boolean;
}

export interface ReadRouterOptions {
  readonly primary: string;
  readonly replicas: readonly ReplicaSpec[];
  /** Reads older than this are not served from a replica. */
  readonly maxLagMs?: number;
  readonly now?: () => number;
  /** Consecutive failures before a replica is taken out of rotation. */
  readonly breakerFailureThreshold?: number;
  /** How long a broken replica stays out, in ms. */
  readonly breakerCooldownMs?: number;
  /** How long a session's reads stay pinned to the primary after a write, in ms. */
  readonly pinMs?: number;
}

export interface ReadRouterStats {
  readonly reads: number;
  readonly writes: number;
  readonly sessionStatements: number;
  readonly primaryRoutes: number;
  readonly replicaRoutes: number;
  readonly replicaFallbacks: number;
  readonly cacheableReads: number;
}

const DEFAULT_MAX_LAG_MS = 2_000;
const DEFAULT_PIN_MS = 5_000;

export class ReadRouter {
  readonly primary: string;
  private readonly replicas: ReplicaState[];
  private readonly maxLagMs: number;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly pinMs: number;
  private readonly pinnedUntil = new Map<string, number>();
  private readonly lagOverrides = new Map<string, number>();
  private cursor = 0;
  private counters = { reads: 0, writes: 0, sessionStatements: 0, primaryRoutes: 0, replicaRoutes: 0, replicaFallbacks: 0, cacheableReads: 0 };

  constructor(options: ReadRouterOptions) {
    if (!options.primary.trim()) throw new ReadPlaneError('a primary is required: replicas cannot accept writes');
    if (options.replicas.some((r) => r.id === options.primary)) {
      throw new ReadPlaneError(`replica ${options.primary} is also the primary`);
    }
    if (new Set(options.replicas.map((r) => r.id)).size !== options.replicas.length) {
      throw new ReadPlaneError('a replica is listed twice');
    }
    this.primary = options.primary;
    this.maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
    if (!Number.isFinite(this.maxLagMs) || this.maxLagMs < 0) throw new ReadPlaneError('maxLagMs must be >= 0');
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.breakerFailureThreshold ?? 3;
    this.cooldownMs = options.breakerCooldownMs ?? 10_000;
    this.pinMs = options.pinMs ?? DEFAULT_PIN_MS;
    this.replicas = options.replicas.map((spec) => ({
      id: spec.id,
      zone: spec.zone ?? 'default',
      lagMs: 0,
      healthy: true,
      consecutiveFailures: 0,
      openUntil: 0,
    }));
    for (const spec of options.replicas) {
      if (spec.maxLagMs !== undefined) this.lagOverrides.set(spec.id, spec.maxLagMs);
    }
  }

  /** Streaming replication lag, in milliseconds. Called by the monitor, not by a request. */
  updateLag(id: string, lagMs: number): void {
    const replica = this.find(id);
    if (!Number.isFinite(lagMs) || lagMs < 0) throw new ReadPlaneError(`lag for ${id} must be a non-negative number of ms`);
    replica.lagMs = lagMs;
  }

  markDown(id: string): void {
    const replica = this.find(id);
    replica.healthy = false;
    replica.consecutiveFailures = this.failureThreshold;
    replica.openUntil = this.now() + this.cooldownMs;
  }

  markUp(id: string): void {
    const replica = this.find(id);
    replica.healthy = true;
    replica.consecutiveFailures = 0;
    replica.openUntil = 0;
  }

  recordFailure(id: string): void {
    const replica = this.find(id);
    replica.consecutiveFailures += 1;
    if (replica.consecutiveFailures >= this.failureThreshold) {
      replica.healthy = false;
      replica.openUntil = this.now() + this.cooldownMs;
    }
  }

  recordSuccess(id: string): void {
    const replica = this.find(id);
    replica.consecutiveFailures = 0;
    replica.healthy = true;
    replica.openUntil = 0;
  }

  /** A write happened in this session: its reads must see that write. */
  noteWrite(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.pinnedUntil.set(sessionId, this.now() + this.pinMs);
    // Keep the map from growing with dead sessions; a pin is a few seconds, not a record.
    if (this.pinnedUntil.size > 10_000) {
      for (const [key, until] of this.pinnedUntil) if (until <= this.now()) this.pinnedUntil.delete(key);
    }
  }

  isPinned(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const until = this.pinnedUntil.get(sessionId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.pinnedUntil.delete(sessionId);
    return false;
  }

  route(request: { sql: string; sessionId?: string; inTransaction?: boolean }): RouteDecision {
    const classified = classifySql(request.sql);
    if (classified.kind === 'write') {
      this.counters.writes += 1;
      this.counters.primaryRoutes += 1;
      this.noteWrite(request.sessionId);
      return { target: this.primary, kind: 'write', reason: classified.reason, cacheable: false };
    }
    if (classified.kind === 'session' || classified.kind === 'unknown') {
      this.counters.sessionStatements += 1;
      this.counters.primaryRoutes += 1;
      return {
        target: this.primary,
        kind: classified.kind,
        reason: classified.kind === 'session'
          ? 'session state must stay on one connection'
          : 'statement not understood — the primary is the safe answer',
        cacheable: false,
      };
    }

    this.counters.reads += 1;
    if (classified.cacheable) this.counters.cacheableReads += 1;

    if (request.inTransaction) {
      this.counters.primaryRoutes += 1;
      return { target: this.primary, kind: 'read', reason: 'inside a write transaction: a replica could read a state that transaction has not committed', cacheable: false };
    }
    if (this.isPinned(request.sessionId)) {
      this.counters.primaryRoutes += 1;
      return { target: this.primary, kind: 'read', reason: 'read-your-writes: this session wrote recently', cacheable: classified.cacheable };
    }
    const eligible = this.eligible();
    if (eligible.length === 0) {
      this.counters.primaryRoutes += 1;
      this.counters.replicaFallbacks += 1;
      return {
        target: this.primary,
        kind: 'read',
        reason: this.replicas.length === 0
          ? 'no replicas configured'
          : 'every replica is down, lagging beyond the budget, or inside a breaker cooldown',
        cacheable: classified.cacheable,
      };
    }
    const chosen = eligible[this.cursor % eligible.length]!;
    this.cursor += 1;
    this.counters.replicaRoutes += 1;
    return { target: chosen.id, kind: 'read', reason: `healthy replica ${chosen.id} at ${chosen.lagMs} ms lag`, cacheable: classified.cacheable };
  }

  states(): readonly ReplicaState[] {
    const now = this.now();
    return this.replicas.map((r) => ({
      ...r,
      healthy: r.healthy && !(r.openUntil > now),
    }));
  }

  stats(): ReadRouterStats {
    return { ...this.counters };
  }

  private eligible(): ReplicaState[] {
    const now = this.now();
    return this.replicas
      .filter((replica) => {
        if (!replica.healthy) {
          // A breaker that has cooled down earns one probe; `recordSuccess` closes it.
          if (replica.openUntil > now) return false;
          replica.consecutiveFailures = 0;
          return true;
        }
        return replica.openUntil <= now;
      })
      .filter((replica) => replica.lagMs <= this.lagBudget(replica))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private lagBudget(replica: ReplicaState): number {
    return this.lagOverrides.get(replica.id) ?? this.maxLagMs;
  }

  private find(id: string): ReplicaState {
    const replica = this.replicas.find((r) => r.id === id);
    if (!replica) throw new ReadPlaneError(`unknown replica ${id}`);
    return replica;
  }
}

/* --------------------------------------------------------------------- cache */

export type DataClass = 'reference' | 'money' | 'pii' | 'auth' | 'operational';

export class CacheError extends Error {}

export interface CacheServer {
  readonly id: string;
  readonly weight?: number;
}

export interface CacheOptions {
  readonly servers: readonly CacheServer[];
  readonly namespace: string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly maxValueBytes?: number;
  readonly maxKeyLength?: number;
  readonly maxTtlMs?: number;
  readonly ttlJitter?: number;
  /** Data classes that must never be cached. Money, PII and auth are refused by default. */
  readonly denyDataClasses?: readonly DataClass[];
  readonly defaultTtlMs?: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly expired: number;
  readonly refusals: number;
  readonly loads: number;
  readonly singleFlightJoins: number;
  readonly invalidations: number;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
  readonly bytes: number;
}

const MEMCACHED_MAX_VALUE_BYTES = 1024 * 1024;
const MEMCACHED_MAX_KEY_BYTES = 250;
const MEMCACHED_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function uniform(key: string): number {
  return (Number.parseInt(sha256Hex(key).slice(0, 13), 16) + 1) / (2 ** 52 + 2);
}

export class CacheCluster {
  readonly namespace: string;
  private readonly servers: readonly CacheServer[];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxValueBytes: number;
  private readonly maxKeyLength: number;
  private readonly maxTtlMs: number;
  private readonly jitter: number;
  private readonly deny: ReadonlySet<DataClass>;
  private readonly defaultTtlMs: number;
  private readonly store = new Map<string, Map<string, Entry>>();
  private readonly generations = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private counters = { hits: 0, misses: 0, sets: 0, expired: 0, refusals: 0, loads: 0, singleFlightJoins: 0, invalidations: 0 };

  constructor(options: CacheOptions) {
    if (options.servers.length === 0) throw new CacheError('at least one memcached server is required');
    if (new Set(options.servers.map((s) => s.id)).size !== options.servers.length) {
      throw new CacheError('a memcached server is listed twice');
    }
    if (!options.namespace.trim()) throw new CacheError('a cache namespace is required: two tenants must not share keys');
    this.servers = options.servers;
    this.namespace = options.namespace.trim();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxValueBytes = options.maxValueBytes ?? MEMCACHED_MAX_VALUE_BYTES;
    this.maxKeyLength = options.maxKeyLength ?? MEMCACHED_MAX_KEY_BYTES;
    this.maxTtlMs = options.maxTtlMs ?? MEMCACHED_MAX_TTL_MS;
    this.jitter = options.ttlJitter ?? 0.1;
    this.deny = new Set(options.denyDataClasses ?? ['money', 'pii', 'auth']);
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    for (const server of options.servers) this.store.set(server.id, new Map());
  }

  /** Which memcached box a key lives on — weighted rendezvous, same trick as the shard map. */
  serverFor(key: string): string {
    let bestId = '';
    let best = -Infinity;
    for (const server of this.servers) {
      const weight = server.weight ?? 1;
      const score = Math.pow(uniform(`${key}\u0000${server.id}`), 1 / weight);
      if (score > best || (score === best && server.id < bestId)) {
        best = score;
        bestId = server.id;
      }
    }
    return bestId;
  }

  /** The generation counter for a tag. Bumping it retires every key in that namespace at once. */
  generation(tag: string): number {
    return this.generations.get(tag) ?? 0;
  }

  keyFor(key: string, tag?: string): string {
    if (!key) throw new CacheError('a cache key is required');
    const generation = tag ? this.generation(tag) : 0;
    return tag ? `${this.namespace}:${tag}:${generation}:${key}` : `${this.namespace}:${key}`;
  }

  /**
   * May this statement be cached, given what it returns? Reads of money, PII and auth material are
   * refused by policy; so is any read whose answer depends on `now()` or `random()`, because a
   * cached answer would silently freeze time.
   */
  canCache(sql: string, dataClass: DataClass = 'reference'): { ok: boolean; reason: string } {
    const classified = classifySql(sql);
    if (classified.kind !== 'read') return { ok: false, reason: `not a read (${classified.kind}): ${classified.reason}` };
    if (!classified.cacheable) return { ok: false, reason: classified.reason };
    if (this.deny.has(dataClass)) return { ok: false, reason: `data class "${dataClass}" must not be cached — it changes under the reader` };
    return { ok: true, reason: 'reference read with no volatile functions' };
  }

  get<T = unknown>(key: string, tag?: string): { hit: boolean; value?: T; server: string; reason?: string } {
    const cacheKey = this.keyFor(key, tag);
    const server = this.serverFor(cacheKey);
    const bucket = this.store.get(server)!;
    const entry = bucket.get(cacheKey);
    if (!entry) {
      this.counters.misses += 1;
      return { hit: false, server, reason: 'miss' };
    }
    if (entry.expiresAt <= this.now()) {
      bucket.delete(cacheKey);
      this.counters.expired += 1;
      this.counters.misses += 1;
      return { hit: false, server, reason: 'expired' };
    }
    this.counters.hits += 1;
    return { hit: true, server, value: entry.value as T };
  }

  set(key: string, value: unknown, options: { ttlMs?: number; tag?: string } = {}): { ok: boolean; bytes: number; reason?: string } {
    const cacheKey = this.keyFor(key, options.tag);
    if (cacheKey.length > this.maxKeyLength) {
      this.counters.refusals += 1;
      return { ok: false, bytes: 0, reason: `key is ${cacheKey.length} bytes; memcached allows ${this.maxKeyLength}` };
    }
    let bytes: number;
    try {
      bytes = JSON.stringify(value)?.length ?? 0;
    } catch (error) {
      this.counters.refusals += 1;
      return { ok: false, bytes: 0, reason: `value is not serialisable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (bytes > this.maxValueBytes) {
      this.counters.refusals += 1;
      return { ok: false, bytes, reason: `value is ${bytes} bytes; memcached allows ${this.maxValueBytes}` };
    }
    const requested = options.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(requested) || requested <= 0) {
      this.counters.refusals += 1;
      return { ok: false, bytes, reason: `ttl must be a positive number of ms, got ${String(requested)}` };
    }
    const ttl = Math.min(requested, this.maxTtlMs) * (1 + (this.random() * 2 - 1) * this.jitter);
    let stored: unknown;
    try {
      stored = structuredClone(value);
    } catch (error) {
      this.counters.refusals += 1;
      return { ok: false, bytes, reason: `value cannot be copied out of the caller’s object: ${error instanceof Error ? error.message : String(error)}` };
    }
    const server = this.serverFor(cacheKey);
    this.store.get(server)!.set(cacheKey, { value: stored, expiresAt: this.now() + ttl, bytes });
    this.counters.sets += 1;
    return { ok: true, bytes };
  }

  delete(key: string, tag?: string): boolean {
    const cacheKey = this.keyFor(key, tag);
    return this.store.get(this.serverFor(cacheKey))!.delete(cacheKey);
  }

  /** Invalidate a whole family by moving its generation. No window, no scan, no partial namespace. */
  invalidateTag(tag: string): number {
    const next = this.generation(tag) + 1;
    this.generations.set(tag, next);
    this.counters.invalidations += 1;
    return next;
  }

  /**
   * Read-through with single-flight. One loader runs per key; concurrent callers share its answer.
   * A refusal (money, volatile SQL, oversized value) still runs the loader — it just does not cache.
   */
  async getOrLoad<T>(
    key: string,
    options: { sql: string; dataClass?: DataClass; ttlMs?: number; tag?: string; loader: () => Promise<T> | T },
  ): Promise<{ value: T; cached: boolean; reason: string; server?: string }> {
    const policy = this.canCache(options.sql, options.dataClass ?? 'reference');
    if (!policy.ok) {
      this.counters.refusals += 1;
      const value = await options.loader();
      return { value, cached: false, reason: policy.reason };
    }
    const cached = this.get<T>(key, options.tag);
    if (cached.hit) return { value: cached.value as T, cached: true, reason: 'hit', server: cached.server };

    const cacheKey = this.keyFor(key, options.tag);
    const running = this.inflight.get(cacheKey);
    if (running) {
      this.counters.singleFlightJoins += 1;
      const value = (await running) as T;
      return { value, cached: true, reason: 'joined an in-flight load', server: cached.server };
    }
    const load = (async () => {
      this.counters.loads += 1;
      const value = await options.loader();
      this.set(key, value, { ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}), ...(options.tag ? { tag: options.tag } : {}) });
      return value;
    })();
    this.inflight.set(cacheKey, load);
    try {
      const value = (await load) as T;
      return { value, cached: false, reason: 'loaded and stored', server: cached.server };
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /** Drop expired entries. Memcached does this lazily too; this makes the accounting visible. */
  purgeExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const bucket of this.store.values()) {
      for (const [key, entry] of bucket) {
        if (entry.expiresAt <= now) {
          bucket.delete(key);
          removed += 1;
        }
      }
    }
    this.counters.expired += removed;
    return removed;
  }

  stats(): CacheStats {
    return { ...this.counters };
  }

  /** Bytes currently held per server, for the capacity panel. */
  occupancy(): Array<{ server: string; keys: number; bytes: number }> {
    return [...this.store.entries()].map(([server, bucket]) => ({
      server,
      keys: bucket.size,
      bytes: [...bucket.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    }));
  }
}
