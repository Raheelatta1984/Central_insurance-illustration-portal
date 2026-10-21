/**
 * PgBouncer: the connection budget, the pool mode, and the two failure modes that make a pooler
 * look like a database bug.
 *
 * Postgres allocates a *process* per connection. One Node process with a 20-connection pool is
 * fine; forty autoscaled instances with that pool is 800 backends against a limit of 100, and the
 * failure is not "slow" — it is `FATAL: sorry, too many clients already`, after which every retry
 * makes it worse. A pooler exists to break that multiplication: many client connections in front,
 * a small fixed number of server connections behind.
 *
 * This module is the **plan**, not a driver. It answers, from configuration alone:
 *
 *   - how many server connections the fleet will actually open, and whether that fits the
 *     database's `max_connections` with a reserve for superuser surgery, monitoring and migrations;
 *   - whether **transaction** pooling is safe for this application, or whether it needs **session**
 *     pooling because it uses `SET`, `LISTEN`, temp tables, advisory locks or cursors — all of
 *     which are scoped to a connection, not to a transaction;
 *   - whether the target is already pooled. **Neon's `-pooler` endpoint is PgBouncer.** Pointing a
 *     self-hosted PgBouncer at it pools twice, which hides the real server count, burns pooler
 *     slots and gives two places to debug a `prepared statement "S_1" already exists` error;
 *   - what prepared statements will do. Transaction pooling means the server connection under a
 *     client changes, so a named prepared statement is not where the driver left it unless the
 *     pooler (PgBouncer ≥ 1.21, `max_prepared_statements > 0`) tracks it;
 *   - what the pool looks like under load — `cl_waiting` growing is saturation, `sv_idle_in_transaction`
 *     is a leaked transaction holding an old snapshot.
 *
 * `renderPgbouncerIni()` emits a deployable config **without a password in it**: pgbouncer.ini is
 * committed, so the password belongs in `userlist.txt` (mode 0600, generated per environment) and
 * never in this file. The renderer refuses a target whose identifiers would break the ini syntax
 * rather than escaping them into something surprising.
 */

export class PgbouncerError extends Error {}

export interface PostgresTarget {
  readonly scheme: 'postgres' | 'postgresql';
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly params: Readonly<Record<string, string>>;
  readonly hasPassword: boolean;
  /** Host is a Neon endpoint (`*.neon.tech`). */
  readonly neon: boolean;
  /** Neon's pooler endpoint, which is itself PgBouncer (`…-pooler.…`). */
  readonly neonPooler: boolean;
}

function safeDecode(value: string, what: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PgbouncerError(`${what} is not valid URL encoding: ${value}`);
  }
}

/** Parse a `postgres://` URL without ever keeping the password in the returned object. */
export function parsePostgresTarget(url: string): PostgresTarget {
  const trimmed = url.trim();
  if (!trimmed) throw new PgbouncerError('DATABASE_URL is empty');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PgbouncerError('DATABASE_URL is not a valid URL (expected postgres://user:password@host:5432/db?sslmode=require)');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    throw new PgbouncerError(`DATABASE_URL must use postgres:// or postgresql://, not ${scheme || '(none)'}://`);
  }
  if (!parsed.hostname) throw new PgbouncerError('DATABASE_URL has no host — a Neon endpoint looks like ep-xxx.region.aws.neon.tech');
  const user = safeDecode(parsed.username, 'the user name');
  if (!user) throw new PgbouncerError('DATABASE_URL has no user');
  const database = safeDecode(parsed.pathname.replace(/^\//, ''), 'the database name');
  if (!database) throw new PgbouncerError('DATABASE_URL has no database name');
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PgbouncerError(`DATABASE_URL has an invalid port ${parsed.port}`);
  const params: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) params[key] = value;
  const host = parsed.hostname;
  const neon = /\.neon\.tech$/i.test(host);
  return {
    scheme,
    user,
    host,
    port,
    database,
    params,
    hasPassword: parsed.password !== '',
    neon,
    neonPooler: neon && /-pooler\./i.test(host),
  };
}

/** The same target as a URL, with the password omitted on purpose. */
export function targetUrl(target: PostgresTarget, host: string = target.host): string {
  const params = new URLSearchParams(target.params).toString();
  return `${target.scheme}://${encodeURIComponent(target.user)}@${host}:${target.port}/${encodeURIComponent(target.database)}${params ? `?${params}` : ''}`;
}

/**
 * The **direct** endpoint — what migrations, `CREATE INDEX CONCURRENTLY` and any session-scoped
 * maintenance must use. Neon's pooled and direct hosts differ only by the `-pooler` label.
 */
export function directTargetUrl(target: PostgresTarget): string {
  const directHost = target.host.replace(/-pooler\./i, '.');
  return targetUrl(target, directHost);
}

/**
 * The **pooled** endpoint — what the application should normally use. On Neon that is the same host
 * with `-pooler` before the region, and Neon's pooler is PgBouncer, so no second one is needed.
 * A self-hosted target has no pooled hostname of its own: the pooler's address is configuration
 * (`PGBOUNCER_URL`), and this returns the target unchanged.
 */
export function pooledTargetUrl(target: PostgresTarget): string {
  if (target.neonPooler) return targetUrl(target);
  if (!target.neon) return targetUrl(target);
  const pooledHost = target.host.replace(/^([^.]+)\./, '$1-pooler.');
  return targetUrl(target, pooledHost);
}

export type PoolMode = 'session' | 'transaction' | 'statement';

export interface PoolPlanInput {
  readonly target: PostgresTarget;
  /** The database's `max_connections` (Neon shows it per compute size; self-hosted default 100). */
  readonly platformMaxConnections?: number;
  /** Backends kept for superuser, monitoring and migrations. Default 5, or 10% of the budget. */
  readonly reservedConnections?: number;
  /** Application instances (pods/processes) that will each open a pool. */
  readonly instances?: number;
  readonly poolMode?: PoolMode;
  readonly maxClientConn?: number;
  /** Desired server connections per instance. Derived from the budget when omitted. */
  readonly serverPoolSize?: number;
  readonly maxPreparedStatements?: number;
  /** The application issues SET / LISTEN / temp tables / advisory locks / cursors. */
  readonly usesSessionState?: boolean;
  /** A local PgBouncer in front of an already-pooled endpoint (Neon `-pooler`). */
  readonly allowDoublePooling?: boolean;
}

export interface PoolPlan {
  readonly mode: PoolMode;
  readonly instances: number;
  readonly serverPoolSize: number;
  readonly serverConnections: number;
  readonly budget: number;
  readonly reserved: number;
  readonly headroom: number;
  readonly maxClientConn: number;
  readonly directUrl: string;
  readonly pooledUrl: string;
  readonly settings: Readonly<Record<string, string | number>>;
  /** Sentences that mean "do not deploy this". */
  readonly refusals: readonly string[];
  /** Sentences that mean "deploy it, but read this first". */
  readonly warnings: readonly string[];
}

const DEFAULT_MAX_CONNECTIONS = 100;

export function planPool(input: PoolPlanInput): PoolPlan {
  const { target } = input;
  const mode = input.poolMode ?? 'transaction';
  const budget = input.platformMaxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const instances = input.instances ?? 1;
  const reserved = input.reservedConnections ?? Math.max(5, Math.round(budget * 0.1));
  const refusals: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(budget) || budget < 2) refusals.push(`max_connections must be an integer ≥ 2, got ${String(budget)}`);
  if (!Number.isInteger(instances) || instances < 1) refusals.push(`instances must be an integer ≥ 1, got ${String(instances)}`);
  if (!Number.isInteger(reserved) || reserved < 0) refusals.push(`reserved connections must be a non-negative integer, got ${String(reserved)}`);
  if (reserved >= budget) refusals.push(`reserving ${reserved} of ${budget} connections leaves nothing to serve requests`);

  if (mode === 'transaction' && input.usesSessionState) {
    refusals.push('transaction pooling cannot carry session state (SET, LISTEN, temp tables, advisory locks, cursors) — use pool_mode=session, or remove the session state');
  }
  if (mode === 'statement' && input.usesSessionState) {
    refusals.push('statement pooling cannot carry session state and forbids multi-statement transactions — use session pooling');
  }
  if (mode === 'session') {
    warnings.push('session pooling still multiplexes clients but holds a server connection for the whole session — plan for fewer clients, not fewer backends');
  }
  if (target.neonPooler && !input.allowDoublePooling) {
    refusals.push('this endpoint is already behind a pooler (Neon’s -pooler host is PgBouncer): point the application at the pooled host and use the direct host only for migrations, or set allowDoublePooling to accept the extra hop');
  }
  if (target.neon && !/^(require|verify-ca|verify-full)$/i.test(target.params['sslmode'] ?? '')) {
    refusals.push('Neon requires TLS: add ?sslmode=require (or verify-full) to DATABASE_URL');
  }
  if (mode === 'statement') {
    warnings.push('statement pooling forbids multi-statement transactions — every BEGIN/COMMIT would need its own round trip and would not be one unit');
  }

  const usable = Math.max(0, budget - reserved);
  const derived = instances > 0 ? Math.floor(usable / Math.max(instances, 1)) : 0;
  const requested = input.serverPoolSize;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    refusals.push(`serverPoolSize must be an integer ≥ 1, got ${String(requested)}`);
  }
  const serverPoolSize = requested ?? Math.max(1, Math.min(derived, 20));
  if (requested !== undefined && requested > derived) {
    refusals.push(`${instances} instance(s) × ${requested} server connection(s) = ${instances * requested} backends, but only ${usable} fit after reserving ${reserved} of ${budget}`);
  }
  const maxClientConn = input.maxClientConn ?? Math.max(50, serverPoolSize * 10);
  if (!Number.isInteger(maxClientConn) || maxClientConn < 1) {
    refusals.push(`maxClientConn must be an integer ≥ 1, got ${String(maxClientConn)}`);
  }
  if (maxClientConn < serverPoolSize) {
    warnings.push(`maxClientConn (${maxClientConn}) is below default_pool_size (${serverPoolSize}) — clients will queue before the pool is full`);
  }

  const serverConnections = instances * serverPoolSize;
  const headroom = budget - reserved - serverConnections;
  if (serverConnections > usable) {
    refusals.push(`${serverConnections} server connections exceed the ${usable} usable backends`);
  } else if (headroom < Math.max(2, Math.round(usable * 0.2))) {
    warnings.push(`only ${headroom} backend(s) of headroom after ${serverConnections} pooled + ${reserved} reserved — a failover or a second pooler will run out`);
  }
  if (serverPoolSize < 4 && usable >= 8) {
    warnings.push(`default_pool_size ${serverPoolSize} is small for ${instances} instance(s); raise it, or clients will wait on a pool that has capacity above it`);
  }

  const maxPrepared = input.maxPreparedStatements ?? (mode === 'session' ? 0 : 100);
  if (!Number.isInteger(maxPrepared) || maxPrepared < 0) {
    refusals.push(`maxPreparedStatements must be an integer ≥ 0, got ${String(maxPrepared)}`);
  }
  if (mode !== 'session' && maxPrepared === 0) {
    warnings.push('max_prepared_statements=0 disables named prepared statements through the pooler — configure the driver to use unnamed statements (node-postgres already does)');
  }
  if (mode !== 'session' && maxPrepared > 0) {
    warnings.push(`max_prepared_statements=${maxPrepared} tracks prepared statements across server connections; raise it if a single client prepares more than that`);
  }

  const settings: Record<string, string | number> = {
    pool_mode: mode,
    max_client_conn: maxClientConn,
    default_pool_size: serverPoolSize,
    min_pool_size: 0,
    reserve_pool_size: Math.max(1, Math.round(serverPoolSize / 4)),
    reserve_pool_timeout: 5,
    max_db_connections: Math.max(1, usable),
    server_idle_timeout: 60,
    server_lifetime: 3600,
    server_connect_timeout: 10,
    query_wait_timeout: 15,
    client_idle_timeout: 300,
    tcp_keepalive: 30,
    application_name_add_host: 1,
    max_prepared_statements: maxPrepared,
    ignore_startup_parameters: 'extra_float_digits,options',
  };
  if (mode === 'session') settings['server_reset_query'] = 'DISCARD ALL';

  return {
    mode,
    instances,
    serverPoolSize,
    serverConnections,
    budget,
    reserved,
    headroom,
    maxClientConn,
    directUrl: directTargetUrl(target),
    pooledUrl: targetUrl(target),
    settings,
    refusals,
    warnings,
  };
}

const SAFE_HOST = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_NAME = /^[A-Za-z0-9_.@-]+$/;

export interface RenderIniOptions {
  readonly listenAddress?: string;
  readonly listenPort?: number;
  readonly authType?: 'scram-sha-256' | 'md5' | 'trust';
  readonly adminUsers?: readonly string[];
  readonly statsUsers?: readonly string[];
  readonly logConnections?: boolean;
}

/**
 * A pgbouncer.ini for this plan. There is no password in the output: `[databases]` names the host
 * and database, and the credential lives in `userlist.txt` (0600, generated per environment). The
 * header says which file is which so nobody pastes a password into the committed one.
 */
export function renderPgbouncerIni(target: PostgresTarget, plan: PoolPlan, options: RenderIniOptions = {}): string {
  if (!SAFE_HOST.test(target.host)) throw new PgbouncerError(`host ${JSON.stringify(target.host)} cannot be written into pgbouncer.ini safely`);
  if (!SAFE_NAME.test(target.database)) throw new PgbouncerError(`database ${JSON.stringify(target.database)} cannot be written into pgbouncer.ini safely`);
  if (!SAFE_NAME.test(target.user)) throw new PgbouncerError(`user ${JSON.stringify(target.user)} cannot be written into pgbouncer.ini safely`);
  if (plan.refusals.length > 0) {
    throw new PgbouncerError(`refusing to render a configuration that would not work: ${plan.refusals.join(' | ')}`);
  }
  const sslmode = target.params['sslmode'];
  const listenPort = options.listenPort ?? 6432;
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new PgbouncerError(`listenPort ${String(listenPort)} is invalid`);
  const authType = options.authType ?? 'scram-sha-256';
  // The admin console needs a user that exists in userlist.txt; the deployment only writes the
  // database user there, so default to it rather than to a name with no credential.
  const adminUsers = options.adminUsers ?? [target.user];
  const statsUsers = options.statsUsers ?? [];
  for (const user of [...adminUsers, ...statsUsers]) {
    if (!SAFE_NAME.test(user)) throw new PgbouncerError(`user ${JSON.stringify(user)} cannot be written into pgbouncer.ini safely`);
  }

  const lines: string[] = [
    ';; Generated by src/core/pgbouncer.ts (npm run infra:plan -- --ini) — review before deploying.',
    ';; This file contains NO password. Put credentials in userlist.txt (chmod 600) and point',
    ';; auth_file at it. Committing a password here would put the database in the git history.',
    `;; Pool mode: ${plan.mode}. Server connections: ${plan.instances} instance(s) × ${plan.serverPoolSize} = ${plan.serverConnections} of ${plan.budget} (${plan.reserved} reserved, ${plan.headroom} headroom).`,
    '',
    '[databases]',
  ];
  const dbHost = `${target.host}:${target.port}`;
  const dbName = target.database === target.user ? '' : ` dbname=${target.database}`;
  lines.push(`${target.database} = host=${dbHost}${dbName}${sslmode ? ` sslmode=${sslmode}` : target.neon ? ' sslmode=require' : ''}`);
  if (target.neonPooler) {
    lines.push(`; direct (migrations, DDL, session-scoped maintenance): ${new URL(directTargetUrl(target)).host}`);
  }
  lines.push('', '[pgbouncer]', `listen_addr = ${options.listenAddress ?? '0.0.0.0'}`, `listen_port = ${listenPort}`);
  lines.push(`auth_type = ${authType}`, 'auth_file = /etc/pgbouncer/userlist.txt', `admin_users = ${adminUsers.join(', ')}`);
  if (statsUsers.length > 0) lines.push(`stats_users = ${statsUsers.join(', ')}`);
  lines.push(`log_connections = ${options.logConnections === false ? 0 : 1}`, 'log_disconnections = 1', 'log_pooler_errors = 1', '');
  for (const [key, value] of Object.entries(plan.settings)) lines.push(`${key} = ${value}`);
  lines.push('');
  for (const warning of plan.warnings) lines.push(`; WARNING: ${warning}`);
  return lines.join('\n');
}

/**
 * `userlist.txt`, with a placeholder where the credential goes. With `auth_type = scram-sha-256`
 * PgBouncer accepts a plain password here (it derives the verifier itself) or a stored SCRAM
 * verifier; either way this file **is** a credential, so the deployment writes it at start-up from
 * the secret store, `chmod 600`, and never commits it. `auth_query` against a dedicated auth user
 * is the alternative when the list would be large.
 */
export function renderUserlist(target: PostgresTarget): string {
  if (!SAFE_NAME.test(target.user)) throw new PgbouncerError(`user ${JSON.stringify(target.user)} cannot be written into userlist.txt safely`);
  return [
    ';; Placeholder — the deployment writes the real file at start-up, chmod 600, from the secret store.',
    ';; PgBouncer accepts a plain password here with auth_type = scram-sha-256, or a stored verifier;',
    ';; either way this file is a credential and must never be committed.',
    `"${target.user}" "REPLACE_WITH_PASSWORD_OR_SCRAM_VERIFIER"`,
    '',
  ].join('\n');
}

export interface PoolSample {
  readonly name: string;
  readonly clActive: number;
  readonly clWaiting: number;
  readonly svActive: number;
  readonly svIdle: number;
  readonly svIdleInTransaction: number;
  readonly maxWaitSeconds: number;
}

export interface PoolFinding {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly pool: string;
  readonly metric: string;
  readonly detail: string;
}

export interface PoolAssessment {
  readonly verdict: 'ok' | 'degraded' | 'critical';
  readonly findings: readonly PoolFinding[];
  /** Requests waiting ÷ clients busy — the number to watch on a dashboard. */
  readonly waitRatio: number;
}

/**
 * Read a `SHOW POOLS` sample the way an operator should. The three sentences that matter:
 * clients queueing means the server pool is too small for the traffic (or a query is slow);
 * a server connection *idle in transaction* means an application bug is holding a snapshot and
 * blocking vacuum; a wait above a couple of seconds is already a customer-visible latency event.
 */
export function assessPools(samples: readonly PoolSample[]): PoolAssessment {
  const findings: PoolFinding[] = [];
  let active = 0;
  let waiting = 0;
  for (const sample of samples) {
    for (const metric of ['clActive', 'clWaiting', 'svActive', 'svIdle', 'svIdleInTransaction', 'maxWaitSeconds'] as const) {
      const value = sample[metric];
      if (!Number.isFinite(value) || value < 0) throw new PgbouncerError(`pool ${sample.name}: ${metric} must be a non-negative number, got ${String(value)}`);
    }
    active += sample.clActive;
    waiting += sample.clWaiting;
    if (sample.clWaiting > 0) {
      findings.push({
        severity: sample.clWaiting >= 10 || sample.maxWaitSeconds >= 5 ? 'critical' : 'warning',
        pool: sample.name,
        metric: 'cl_waiting',
        detail: `${sample.clWaiting} client(s) waiting up to ${sample.maxWaitSeconds}s — the server pool is saturated or one query is slow; raise default_pool_size only after ruling out the slow query`,
      });
    }
    if (sample.svIdleInTransaction > 0) {
      findings.push({
        severity: 'critical',
        pool: sample.name,
        metric: 'sv_idle_in_transaction',
        detail: `${sample.svIdleInTransaction} server connection(s) idle inside a transaction — the application forgot to COMMIT/ROLLBACK, and the snapshot blocks vacuum`,
      });
    }
    if (sample.svActive + sample.svIdle === 0) {
      findings.push({
        severity: 'info',
        pool: sample.name,
        metric: 'sv_total',
        detail: 'no server connection is open on this pool — the pooler is not connecting (check auth_file and the host)',
      });
    }
  }
  const waitRatio = active + waiting === 0 ? 0 : waiting / (active + waiting);
  const verdict = findings.some((f) => f.severity === 'critical')
    ? 'critical'
    : findings.some((f) => f.severity === 'warning')
      ? 'degraded'
      : 'ok';
  return { verdict, findings, waitRatio };
}

export interface ConnectionTopology {
  readonly target: PostgresTarget;
  readonly plan: PoolPlan;
  readonly ini: string;
  readonly userlist: string;
  readonly mode: 'direct' | 'pooled';
  readonly summary: string;
}

/**
 * What the application should do, in one sentence, given the environment. This is the function the
 * topology endpoint and the deployment doctor both call, so there is one answer and not two.
 */
export function connectionTopology(input: PoolPlanInput): ConnectionTopology {
  const plan = planPool(input);
  const mode = plan.refusals.length === 0 && !input.target.neonPooler && plan.mode !== 'session' ? 'pooled' : 'direct';
  const summary = plan.refusals.length > 0
    ? `not deployable: ${plan.refusals[0]}`
    : mode === 'pooled'
      ? `${plan.instances} instance(s) × ${plan.serverPoolSize} server connection(s) through PgBouncer (${plan.mode} mode), ${plan.headroom} backend(s) of headroom; migrations use the direct URL`
      : input.target.neonPooler
        ? 'use the Neon pooled host directly (it is PgBouncer); no second pooler in the path'
        : `session mode required: point the application through PgBouncer on ${plan.serverPoolSize} server connection(s) per instance`;
  return {
    target: input.target,
    plan,
    ini: plan.refusals.length > 0 ? '' : renderPgbouncerIni(input.target, plan),
    userlist: plan.refusals.length > 0 ? '' : renderUserlist(input.target),
    mode,
    summary,
  };
}
