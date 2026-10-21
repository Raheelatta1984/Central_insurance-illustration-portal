/**
 * The data plane as one report: what the environment says about Postgres, the pooler, the replicas,
 * the cache, the image shards and the id generator — validated, and honest about what is missing.
 *
 * The demo runs in memory on purpose (see `docs/18-DATA-PLANE.md`). Nothing here pretends a
 * database exists: with no `DATABASE_URL` the report says `mode: "in-memory"` and still describes
 * the id layout, so the shape of a durable deployment is reviewable before it is bought. With a
 * URL, every paragraph of the plan is computed from configuration and the refusals are the things
 * that would fail in production (a second pooler, a session-scoped feature under transaction
 * pooling, more backends than the database allows, a replica budget with no fresh replica).
 *
 * This module is also the parser for the environment, so there is exactly one place where a
 * variable name is spelled. If a setting is not read here, it is not a setting.
 */
import { ID_COUNTER_LIMIT, ID_EPOCH_MS, ID_EPOCH_END_MS, ID_SHARD_LIMIT, ID_TIMESTAMP_BITS, IdGenerator, parseId } from './idgen.js';
import { CacheCluster, DataClass, ReadRouter, ReplicaSpec } from './readplane.js';
import { connectionTopology, parsePostgresTarget, pooledTargetUrl, PoolMode, PoolPlan, PostgresTarget, targetUrl } from './pgbouncer.js';
import { DEFAULT_LOGICAL_SHARDS, DEFAULT_REPLICAS, MAX_LOGICAL_SHARDS, parseMachineList, ShardMap, ShardMapReport } from './shardmap.js';

export interface DataPlaneOptions {
  /** Injectable clock so the report (and its sample id) is reproducible in tests and replays. */
  readonly now?: () => number;
  /** Include the rendered pgbouncer.ini/userlist placeholders. Off by default: they are deploy files. */
  readonly includeIni?: boolean;
}

export interface DataPlaneReport {
  readonly configured: boolean;
  readonly mode: 'in-memory' | 'postgres';
  readonly database?: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly neon: boolean;
    readonly neonPooler: boolean;
    readonly tls: string;
    /** Redacted: no password, ever. */
    readonly url: string;
  };
  readonly pooling?: {
    readonly mode: PoolMode;
    readonly instances: number;
    readonly serverPoolSize: number;
    readonly serverConnections: number;
    readonly budget: number;
    readonly reserved: number;
    readonly headroom: number;
    readonly directUrl: string;
    readonly appUrl: string;
    readonly summary: string;
    readonly refusals: readonly string[];
    readonly warnings: readonly string[];
    readonly settings: Readonly<Record<string, string | number>>;
    readonly ini?: string;
    readonly userlist?: string;
  };
  readonly readPlane?: {
    readonly primary: string;
    readonly maxLagMs: number;
    readonly replicas: ReadonlyArray<{ id: string; zone: string; lagMs: number; healthy: boolean }>;
    readonly rules: readonly string[];
  };
  readonly cache?: {
    readonly namespace: string;
    readonly servers: readonly string[];
    readonly defaultTtlMs: number;
    readonly deniedDataClasses: readonly DataClass[];
    readonly rules: readonly string[];
  };
  readonly shards?: {
    readonly logicalShards: number;
    readonly replicas: number;
    readonly report: ShardMapReport;
    readonly rules: readonly string[];
  };
  readonly ids: {
    readonly layout: { timestampBits: number; shardBits: number; counterBits: number; totalBits: number };
    readonly epoch: string;
    readonly epochEndsAt: string;
    readonly maxShards: number;
    readonly idsPerMillisecondPerShard: number;
    readonly shard: number;
    readonly sample?: { id: string; issuedAt: string; shard: number; counter: number; bits: string };
  };
  readonly refusals: readonly string[];
  readonly notes: readonly string[];
}

function numberFrom(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

function parsePoolMode(value: string | undefined): PoolMode {
  if (!value) return 'transaction';
  if (value === 'session' || value === 'transaction' || value === 'statement') return value;
  throw new Error(`PGBOUNCER_POOL_MODE must be session, transaction or statement — got ${JSON.stringify(value)}`);
}

export function dataPlaneReport(env: Record<string, string | undefined> = {}, options: DataPlaneOptions = {}): DataPlaneReport {
  const now = options.now ?? (() => Date.now());
  const refusals: string[] = [];
  const notes: string[] = [];

  /* ------------------------------------------------------------------ ids */
  const rawShard = numberFrom(env, 'ID_SHARD') ?? 0;
  const shard = Number.isInteger(rawShard) && rawShard >= 0 && rawShard < ID_SHARD_LIMIT ? rawShard : 0;
  if (shard !== rawShard) refusals.push(`ID_SHARD must be an integer in 0–${ID_SHARD_LIMIT - 1} (13 bits), got ${String(rawShard)}`);
  const generator = new IdGenerator({ shard, clock: now });
  const sampleId = generator.next();
  const sample = parseId(sampleId);
  const ids: DataPlaneReport['ids'] = {
    layout: { timestampBits: ID_TIMESTAMP_BITS, shardBits: 13, counterBits: 10, totalBits: 64 },
    epoch: new Date(ID_EPOCH_MS).toISOString(),
    epochEndsAt: new Date(ID_EPOCH_END_MS).toISOString(),
    maxShards: ID_SHARD_LIMIT,
    idsPerMillisecondPerShard: ID_COUNTER_LIMIT,
    shard,
    sample: { id: sample.id, issuedAt: sample.issuedAt, shard: sample.shard, counter: sample.counter, bits: sample.bits },
  };

  /* ------------------------------------------------------------ shard map */
  let shards: DataPlaneReport['shards'];
  const machineSpec = env['SHARD_MAP']?.trim();
  const logicalShards = numberFrom(env, 'LOGICAL_SHARDS') ?? DEFAULT_LOGICAL_SHARDS;
  const shardReplicas = numberFrom(env, 'SHARD_REPLICAS') ?? DEFAULT_REPLICAS;
  if (machineSpec) {
    try {
      const machines = parseMachineList(machineSpec);
      const map = new ShardMap({ machines, logicalShards, replicas: shardReplicas });
      if (shard >= map.logicalShards) {
        refusals.push(`ID_SHARD ${shard} is outside the ${map.logicalShards} logical shard(s) in SHARD_MAP`);
      }
      shards = {
        logicalShards: map.logicalShards,
        replicas: map.replicas,
        report: map.report(),
        rules: [
          'a blob is placed by sha256(blob id) into a fixed logical shard; the shard number never changes',
          'the owner machine is chosen by weighted rendezvous hashing, so every node computes the same map without a lookup service',
          'copies go to another zone first, then to any machine with room — a second copy survives a dead disk either way',
          'adding a machine moves about 1/(n+1) of the shards; the rebalance plan lists every shard before anything moves',
        ],
      };
      if (!shards.report.ok) {
        for (const problem of shards.report.problems) refusals.push(`shard map: ${problem}`);
      }
    } catch (error) {
      refusals.push(`SHARD_MAP: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push(`no SHARD_MAP: images have no machine map yet. Set SHARD_MAP (JSON machine list) and LOGICAL_SHARDS (1–${MAX_LOGICAL_SHARDS}) to plan placement.`);
  }

  /* ---------------------------------------------------------------- cache */
  const cacheServers = csv(env['MEMCACHED_SERVERS']);
  let cache: DataPlaneReport['cache'];
  if (cacheServers.length > 0) {
    try {
      const cluster = new CacheCluster({
        servers: cacheServers.map((id) => ({ id })),
        namespace: env['MEMCACHED_NAMESPACE']?.trim() || 'portal',
        ...(numberFrom(env, 'CACHE_DEFAULT_TTL_MS') !== undefined ? { defaultTtlMs: numberFrom(env, 'CACHE_DEFAULT_TTL_MS')! } : {}),
      });
      const ttl = numberFrom(env, 'CACHE_DEFAULT_TTL_MS');
      cache = {
        namespace: cluster.namespace,
        servers: cacheServers,
        defaultTtlMs: ttl ?? 60_000,
        deniedDataClasses: ['money', 'pii', 'auth'],
        rules: [
          'only reference reads are cached: money, PII and auth material are refused by data class',
          'a read that calls now()/random() is never cached — a cached answer would freeze the clock',
          'invalidation is a generation counter per tag, so a catalogue edit retires every old key at once',
          'single-flight collapses a stampede into one load; TTLs jitter ±10% so they do not expire together',
        ],
      };
    } catch (error) {
      refusals.push(`MEMCACHED_SERVERS: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push('no MEMCACHED_SERVERS: repeated reference reads would go to Postgres every time.');
  }

  /* ------------------------------------------------------------- database */
  const databaseUrl = env['DATABASE_URL']?.trim();
  if (!databaseUrl) {
    notes.push('no DATABASE_URL: the API still runs the in-memory demo world; the pool, replica and cache plans below are configuration, not connections.');
    return {
      configured: false,
      mode: 'in-memory',
      ...(shards ? { shards } : {}),
      ...(cache ? { cache } : {}),
      ids,
      refusals,
      notes,
    };
  }

  let target: PostgresTarget | undefined;
  try {
    target = parsePostgresTarget(databaseUrl);
  } catch (error) {
    refusals.push(`DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!target) {
    return { configured: false, mode: 'in-memory', ...(shards ? { shards } : {}), ...(cache ? { cache } : {}), ids, refusals, notes };
  }

  const database: NonNullable<DataPlaneReport['database']> = {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    neon: target.neon,
    neonPooler: target.neonPooler,
    tls: target.params['sslmode'] ?? 'prefer',
    url: targetUrl(target),
  };

  /* --------------------------------------------------------------- pooler */
  const instances = numberFrom(env, 'INSTANCE_COUNT') ?? 1;
  let pooling: DataPlaneReport['pooling'];
  let plan: PoolPlan | undefined;
  try {
    const topology = connectionTopology({
      target,
      instances,
      poolMode: parsePoolMode(env['PGBOUNCER_POOL_MODE']),
      ...(numberFrom(env, 'DATABASE_MAX_CONNECTIONS') !== undefined ? { platformMaxConnections: numberFrom(env, 'DATABASE_MAX_CONNECTIONS')! } : {}),
      ...(numberFrom(env, 'DATABASE_RESERVED_CONNECTIONS') !== undefined ? { reservedConnections: numberFrom(env, 'DATABASE_RESERVED_CONNECTIONS')! } : {}),
      ...(numberFrom(env, 'PGBOUNCER_POOL_SIZE') !== undefined ? { serverPoolSize: numberFrom(env, 'PGBOUNCER_POOL_SIZE')! } : {}),
      ...(numberFrom(env, 'PGBOUNCER_MAX_CLIENT_CONN') !== undefined ? { maxClientConn: numberFrom(env, 'PGBOUNCER_MAX_CLIENT_CONN')! } : {}),
      ...(numberFrom(env, 'PGBOUNCER_MAX_PREPARED_STATEMENTS') !== undefined ? { maxPreparedStatements: numberFrom(env, 'PGBOUNCER_MAX_PREPARED_STATEMENTS')! } : {}),
      usesSessionState: env['APP_USES_SESSION_STATE'] === '1',
    });
    plan = topology.plan;
    // What the app should connect to: an explicit pooler URL, else Neon's own pooled host, else the
    // target as given (a self-hosted pooler's address is the operator's to name).
    const appUrl = env['PGBOUNCER_URL']?.trim() || pooledTargetUrl(target);
    pooling = {
      mode: plan.mode,
      instances: plan.instances,
      serverPoolSize: plan.serverPoolSize,
      serverConnections: plan.serverConnections,
      budget: plan.budget,
      reserved: plan.reserved,
      headroom: plan.headroom,
      directUrl: plan.directUrl,
      appUrl,
      summary: topology.summary,
      refusals: plan.refusals,
      warnings: plan.warnings,
      settings: plan.settings,
      ...(options.includeIni && plan.refusals.length === 0 ? { ini: topology.ini, userlist: topology.userlist } : {}),
    };
    for (const refusal of plan.refusals) refusals.push(`pooling: ${refusal}`);
    if (target.neon && !target.neonPooler) {
      notes.push('this is a Neon direct host: the application should use the -pooler host reported as appUrl (Neon runs PgBouncer there), and this direct host is for migrations and session-scoped maintenance.');
    }
    if (target.neonPooler) {
      notes.push('this is a Neon pooled host: the pooler is already in the path, so do not add another one between the app and Neon.');
    }
  } catch (error) {
    refusals.push(`pooling: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* -------------------------------------------------------------- replicas */
  const replicaUrls = csv(env['READ_REPLICA_URLS']);
  const maxLagMs = numberFrom(env, 'MAX_REPLICA_LAG_MS') ?? 2_000;
  let readPlane: DataPlaneReport['readPlane'];
  if (replicaUrls.length > 0) {
    const specs: ReplicaSpec[] = [];
    for (const url of replicaUrls) {
      try {
        const replica = parsePostgresTarget(url);
        if (replica.host === target.host) {
          refusals.push(`READ_REPLICA_URLS: ${replica.host} is the primary host — a replica must be a different endpoint`);
          continue;
        }
        const zone = replica.params['zone'] ?? 'replica';
        specs.push({ id: replica.host, zone });
      } catch (error) {
        refusals.push(`READ_REPLICA_URLS: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (specs.length === 0) {
      notes.push('no usable READ_REPLICA_URLS: reads stay on the primary until a distinct replica host is configured.');
    } else {
      try {
        const router = new ReadRouter({ primary: target.host, replicas: specs, maxLagMs, now });
        readPlane = {
          primary: router.primary,
          maxLagMs,
          replicas: router.states().map((state) => ({ id: state.id, zone: state.zone, lagMs: state.lagMs, healthy: state.healthy })),
          rules: [
            'writes, row locks, sequences and session state go to the primary — always',
            'a read inside a write transaction, or from a session that just wrote, goes to the primary (read-your-writes)',
            'a replica is used only while its lag is inside MAX_REPLICA_LAG_MS and its breaker is closed',
            'when no replica qualifies the read falls back to the primary: a slow answer beats a stale one',
          ],
        };
      } catch (error) {
        refusals.push(`replicas: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    notes.push('no READ_REPLICA_URLS: every read goes to the primary. Add replicas before the reporting screens start to hurt.');
  }

  const configured = refusals.length === 0;
  return {
    configured,
    mode: 'postgres',
    database,
    ...(pooling ? { pooling } : {}),
    ...(readPlane ? { readPlane } : {}),
    ...(cache ? { cache } : {}),
    ...(shards ? { shards } : {}),
    ids,
    refusals,
    notes,
  };
}

export interface MintedId {
  readonly id: string;
  readonly issuedAt: string;
  readonly shard: number;
  readonly counter: number;
  readonly bits: string;
}

/** Mint `count` ids for one shard. Used by `POST /api/infra/ids` and by the deployment doctor. */
export function mintIds(
  options: { count: number; shard?: number; now?: () => number },
): { ids: MintedId[]; shard: number; layout: DataPlaneReport['ids']['layout'] } {
  const shard = options.shard ?? 0;
  if (!Number.isInteger(shard) || shard < 0 || shard >= ID_SHARD_LIMIT) {
    throw new Error(`shard must be an integer in 0–${ID_SHARD_LIMIT - 1}, got ${String(shard)}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 1_000) {
    throw new Error(`count must be an integer in 1–1000, got ${String(options.count)}`);
  }
  const generator = new IdGenerator({ shard, ...(options.now ? { clock: options.now } : {}) });
  const ids: MintedId[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const parsed = parseId(generator.next());
    ids.push({ id: parsed.id, issuedAt: parsed.issuedAt, shard: parsed.shard, counter: parsed.counter, bits: parsed.bits });
  }
  return { ids, shard, layout: { timestampBits: ID_TIMESTAMP_BITS, shardBits: 13, counterBits: 10, totalBits: 64 } };
}
