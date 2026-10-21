/**
 * PgBouncer is only useful if it is deployed with the right mode and a pool that fits. These
 * tests pin the arithmetic (instances × pool size against max_connections), the two refusals that
 * prevent a production incident (double pooling at Neon, session state under transaction pooling),
 * and the fact that no rendered file contains a password.
 */
import { describe, expect, it } from 'vitest';
import {
  PgbouncerError,
  assessPools,
  connectionTopology,
  directTargetUrl,
  parsePostgresTarget,
  planPool,
  pooledTargetUrl,
  renderPgbouncerIni,
  renderUserlist,
  targetUrl,
} from './pgbouncer.js';

const NEON_DIRECT = 'postgresql://portal_user:s3cr3t@ep-cool-1234.eu-central-1.aws.neon.tech/portal?sslmode=require';
const NEON_POOLED = 'postgresql://portal_user:s3cr3t@ep-cool-1234-pooler.eu-central-1.aws.neon.tech/portal?sslmode=require';
const SELF_HOSTED = 'postgres://portal_app:pw@db.internal:5432/portal?sslmode=require&application_name=portal';

describe('parsing a connection URL', () => {
  it('recognises Neon, its pooler host, TLS and the absence of a password field it kept', () => {
    const target = parsePostgresTarget(NEON_POOLED);
    expect(target).toMatchObject({
      scheme: 'postgresql', user: 'portal_user', port: 5432, database: 'portal',
      neon: true, neonPooler: true, hasPassword: true,
    });
    expect(target.params['sslmode']).toBe('require');
    expect(target.host).toContain('-pooler.');
    expect(JSON.stringify(target)).not.toContain('s3cr3t');
    expect(parsePostgresTarget(NEON_DIRECT)).toMatchObject({ neon: true, neonPooler: false });
    expect(parsePostgresTarget(SELF_HOSTED)).toMatchObject({ scheme: 'postgres', port: 5432, neon: false, neonPooler: false });
  });

  it('drops the password from the URL it prints, and can address the direct host', () => {
    const target = parsePostgresTarget(NEON_POOLED);
    expect(targetUrl(target)).not.toContain('s3cr3t');
    expect(directTargetUrl(target)).toBe('postgresql://portal_user@ep-cool-1234.eu-central-1.aws.neon.tech:5432/portal?sslmode=require');
    // A non-pooled host is its own direct endpoint.
    expect(directTargetUrl(parsePostgresTarget(SELF_HOSTED))).toBe('postgres://portal_app@db.internal:5432/portal?sslmode=require&application_name=portal');
    // …and its own pooled endpoint (the pooler's address is configuration, not a hostname trick).
    expect(pooledTargetUrl(parsePostgresTarget(SELF_HOSTED))).toBe(targetUrl(parsePostgresTarget(SELF_HOSTED)));
    expect(pooledTargetUrl(parsePostgresTarget(NEON_DIRECT))).toContain('ep-cool-1234-pooler.eu-central-1.aws.neon.tech');
    expect(pooledTargetUrl(parsePostgresTarget(NEON_POOLED))).toContain('ep-cool-1234-pooler.eu-central-1.aws.neon.tech');
  });

  it('refuses something that is not a usable Postgres URL, with a sentence naming the problem', () => {
    expect(() => parsePostgresTarget('')).toThrow(/empty/);
    expect(() => parsePostgresTarget('not a url')).toThrow(PgbouncerError);
    expect(() => parsePostgresTarget('mysql://u:p@h/d')).toThrow(/postgres/);
    expect(() => parsePostgresTarget('postgres://@h/d')).toThrow(/user/);
    expect(() => parsePostgresTarget('postgres://u@/d')).toThrow(/host/);
    expect(() => parsePostgresTarget('postgres://u@h:99999/d')).toThrow(/valid URL|port/i);
    expect(() => parsePostgresTarget('postgres://u@h/')).toThrow(/database/);
  });
});

describe('the connection budget', () => {
  const target = parsePostgresTarget(SELF_HOSTED);

  it('derives a pool that fits max_connections, and refuses one that does not', () => {
    const plan = planPool({ target, platformMaxConnections: 100, instances: 4, reservedConnections: 10 });
    expect(plan.refusals).toEqual([]);
    expect(plan.serverPoolSize * plan.instances + plan.reserved).toBeLessThanOrEqual(100);
    expect(plan.headroom).toBeGreaterThanOrEqual(0);

    const tooBig = planPool({ target, platformMaxConnections: 100, instances: 10, reservedConnections: 10, serverPoolSize: 20 });
    expect(tooBig.refusals.join(' ')).toMatch(/200 backends.*only 90 fit/);
    expect(() => renderPgbouncerIni(target, tooBig)).toThrow(/refusing to render/);
  });

  it('refuses a reserve that leaves nothing, and a nonsensical instance count', () => {
    expect(planPool({ target, platformMaxConnections: 100, reservedConnections: 100 }).refusals.join(' ')).toMatch(/nothing to serve/);
    expect(planPool({ target, instances: 0 }).refusals.join(' ')).toMatch(/instances/);
    expect(planPool({ target, platformMaxConnections: 1 }).refusals.join(' ')).toMatch(/max_connections/);
  });

  it('refuses transaction pooling when the application needs session state, and says which mode to use', () => {
    const broken = planPool({ target, usesSessionState: true, poolMode: 'transaction' });
    expect(broken.refusals.join(' ')).toMatch(/session state.*pool_mode=session/);
    const session = planPool({ target, usesSessionState: true, poolMode: 'session' });
    expect(session.refusals).toEqual([]);
    expect(session.settings['pool_mode']).toBe('session');
    expect(session.settings['server_reset_query']).toBe('DISCARD ALL');
    expect(session.warnings.join(' ')).toMatch(/holds a server connection/);
    const statement = planPool({ target, poolMode: 'statement' });
    expect(statement.warnings.join(' ')).toMatch(/multi-statement/);
  });

  it('refuses to pool twice in front of Neon’s own PgBouncer, unless the operator insists', () => {
    const pooled = parsePostgresTarget(NEON_POOLED);
    const refused = planPool({ target: pooled });
    expect(refused.refusals.join(' ')).toMatch(/already behind a pooler/);
    const allowed = planPool({ target: pooled, allowDoublePooling: true });
    expect(allowed.refusals).toEqual([]);
  });

  it('refuses an unencrypted Neon connection', () => {
    const noTls = parsePostgresTarget('postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/portal');
    expect(planPool({ target: noTls }).refusals.join(' ')).toMatch(/requires TLS/);
    const tls = planPool({ target: parsePostgresTarget(NEON_DIRECT) });
    expect(tls.refusals).toEqual([]);
  });

  it('warns honestly about prepared statements and small pools', () => {
    const zeroPrepared = planPool({ target, maxPreparedStatements: 0 });
    expect(zeroPrepared.warnings.join(' ')).toMatch(/max_prepared_statements=0/);
    const tracked = planPool({ target });
    expect(tracked.warnings.join(' ')).toMatch(/tracks prepared statements/);
    expect(tracked.settings['max_prepared_statements']).toBe(100);
    const tiny = planPool({ target, platformMaxConnections: 20, reservedConnections: 5, instances: 1, serverPoolSize: 2 });
    expect(tiny.warnings.join(' ')).toMatch(/small|headroom/);
  });

  it('describes the application path in one sentence, direct or pooled', () => {
    const selfHosted = connectionTopology({ target, platformMaxConnections: 100, instances: 2 });
    expect(selfHosted.mode).toBe('pooled');
    expect(selfHosted.summary).toMatch(/2 instance\(s\) × \d+ server connection/);
    const pooled = connectionTopology({ target: parsePostgresTarget(NEON_POOLED) });
    expect(pooled.mode).toBe('direct');
    expect(pooled.summary).toMatch(/already behind a pooler/);
    expect(pooled.ini).toBe('');
  });
});

describe('rendering the configuration', () => {
  const target = parsePostgresTarget(SELF_HOSTED);
  const plan = planPool({ target, platformMaxConnections: 100, instances: 4, reservedConnections: 10 });

  it('writes a deployable pgbouncer.ini with no password in it', () => {
    const ini = renderPgbouncerIni(target, plan, { adminUsers: ['pgbouncer'], statsUsers: ['monitor'] });
    expect(ini).toContain('[databases]');
    expect(ini).toContain('db.internal:5432');
    expect(ini).toContain('pool_mode = transaction');
    expect(ini).toContain(`default_pool_size = ${plan.serverPoolSize}`);
    expect(ini).toContain('admin_users = pgbouncer');
    expect(ini).toContain('stats_users = monitor');
    expect(ini).toContain('auth_file = /etc/pgbouncer/userlist.txt');
    expect(ini).not.toContain('s3cr3t');
    expect(ini).not.toContain('pw@');
    expect(ini).toContain('WARNING:');
    expect(renderPgbouncerIni(target, plan, { listenPort: 6543 })).toContain('listen_port = 6543');
    expect(() => renderPgbouncerIni(target, plan, { listenPort: 0 })).toThrow(/listenPort/);
  });

  it('names the direct host on a Neon pooler config so migrations have somewhere to go', () => {
    const pooled = parsePostgresTarget(NEON_POOLED);
    const ini = renderPgbouncerIni(pooled, planPool({ target: pooled, allowDoublePooling: true }));
    expect(ini).toMatch(/direct \(migrations, DDL/);
    expect(ini).toContain('ep-cool-1234.eu-central-1.aws.neon.tech');
  });

  it('refuses to write an identifier that would break the ini syntax', () => {
    const hostile = { ...target, host: 'db.internal\nlisten_port = 1' };
    expect(() => renderPgbouncerIni(hostile, plan)).toThrow(/safely/);
    const hostileUser = { ...target, user: 'user" quoted' };
    expect(() => renderUserlist(hostileUser)).toThrow(/safely/);
  });

  it('renders a userlist placeholder, never a credential', () => {
    const userlist = renderUserlist(target);
    expect(userlist).toContain('"portal_app" "REPLACE_WITH_PASSWORD_OR_SCRAM_VERIFIER"');
    expect(userlist).not.toContain('pw');
    expect(userlist).toMatch(/never be committed/);
  });
});

describe('pool health', () => {
  it('calls a quiet pool ok', () => {
    const assessment = assessPools([
      { name: 'portal', clActive: 4, clWaiting: 0, svActive: 3, svIdle: 5, svIdleInTransaction: 0, maxWaitSeconds: 0 },
    ]);
    expect(assessment.verdict).toBe('ok');
    expect(assessment.findings).toEqual([]);
    expect(assessment.waitRatio).toBe(0);
  });

  it('says queueing is saturation, and how long the queue has waited', () => {
    const assessment = assessPools([
      { name: 'portal', clActive: 30, clWaiting: 4, svActive: 20, svIdle: 0, svIdleInTransaction: 0, maxWaitSeconds: 2 },
    ]);
    expect(assessment.verdict).toBe('degraded');
    expect(assessment.findings[0]).toMatchObject({ metric: 'cl_waiting', severity: 'warning' });
    expect(assessment.findings[0]!.detail).toMatch(/saturated/);
    expect(assessment.waitRatio).toBeCloseTo(4 / 34);
    const critical = assessPools([
      { name: 'portal', clActive: 30, clWaiting: 12, svActive: 20, svIdle: 0, svIdleInTransaction: 0, maxWaitSeconds: 9 },
    ]);
    expect(critical.verdict).toBe('critical');
  });

  it('calls an idle-in-transaction connection what it is: a leaked transaction', () => {
    const assessment = assessPools([
      { name: 'portal', clActive: 1, clWaiting: 0, svActive: 0, svIdle: 3, svIdleInTransaction: 2, maxWaitSeconds: 0 },
    ]);
    expect(assessment.verdict).toBe('critical');
    expect(assessment.findings.find((f) => f.metric === 'sv_idle_in_transaction')!.detail).toMatch(/forgot to COMMIT/);
  });

  it('notes a pool with no server connection at all', () => {
    const assessment = assessPools([
      { name: 'portal', clActive: 0, clWaiting: 0, svActive: 0, svIdle: 0, svIdleInTransaction: 0, maxWaitSeconds: 0 },
    ]);
    expect(assessment.findings[0]).toMatchObject({ metric: 'sv_total', severity: 'info' });
    expect(assessment.findings[0]!.detail).toMatch(/auth_file/);
  });

  it('refuses a negative sample instead of reporting a cheerful zero', () => {
    expect(() => assessPools([
      { name: 'portal', clActive: -1, clWaiting: 0, svActive: 0, svIdle: 0, svIdleInTransaction: 0, maxWaitSeconds: 0 },
    ])).toThrow(PgbouncerError);
  });
});
