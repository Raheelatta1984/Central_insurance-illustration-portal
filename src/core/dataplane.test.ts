/**
 * The data plane report is what the deployment doctor and the console read. These tests pin the
 * two things that matter most about it: it never prints a credential, and it never calls a
 * configuration "configured" while a refusal is outstanding.
 */
import { describe, expect, it } from 'vitest';
import { dataPlaneReport, mintIds } from './dataplane.js';
import { ID_EPOCH_MS } from './idgen.js';

const AT = (offsetMs: number) => ID_EPOCH_MS + offsetMs;
const NEON = 'postgresql://portal_user:s3cr3t@ep-cool-1234.eu-central-1.aws.neon.tech/portal?sslmode=require';
const NEON_POOLED = 'postgresql://portal_user:s3cr3t@ep-cool-1234-pooler.eu-central-1.aws.neon.tech/portal?sslmode=require';

describe('without a database', () => {
  it('says in-memory, shows the id layout, and does not pretend to be connected', () => {
    const report = dataPlaneReport({}, { now: () => AT(1_000) });
    expect(report.configured).toBe(false);
    expect(report.mode).toBe('in-memory');
    expect(report.database).toBeUndefined();
    expect(report.ids).toMatchObject({ shard: 0, maxShards: 8_192, idsPerMillisecondPerShard: 1_024 });
    expect(report.ids.layout).toEqual({ timestampBits: 41, shardBits: 13, counterBits: 10, totalBits: 64 });
    expect(report.ids.sample!.bits.split('|').map((part) => part.length)).toEqual([41, 13, 10]);
    expect(report.notes.join(' ')).toMatch(/no DATABASE_URL/);
    expect(report.notes.join(' ')).toMatch(/no MEMCACHED_SERVERS/);
    expect(report.refusals).toEqual([]);
  });

  it('still plans the image shards and the cache from environment alone', () => {
    const report = dataPlaneReport({
      SHARD_MAP: '[{"id":"img-a","zone":"a"},{"id":"img-b","zone":"b"},{"id":"img-c","zone":"c"}]',
      LOGICAL_SHARDS: '128',
      SHARD_REPLICAS: '1',
      MEMCACHED_SERVERS: 'mc1:11211,mc2:11211',
      MEMCACHED_NAMESPACE: 'acme',
    }, { now: () => AT(1) });
    expect(report.shards).toMatchObject({ logicalShards: 128, replicas: 1 });
    expect(report.shards!.report.machines).toHaveLength(3);
    expect(report.shards!.report.ok).toBe(true);
    expect(report.cache).toMatchObject({ namespace: 'acme', servers: ['mc1:11211', 'mc2:11211'] });
    expect(report.ids.shard).toBe(0);
  });
});

describe('with a Postgres URL', () => {
  it('reports the pool plan, the direct URL and a redacted connection string', () => {
    const report = dataPlaneReport({
      DATABASE_URL: NEON,
      INSTANCE_COUNT: '4',
      DATABASE_MAX_CONNECTIONS: '100',
      DATABASE_RESERVED_CONNECTIONS: '10',
      READ_REPLICA_URLS: 'postgresql://reader:shh@ep-cool-1234-replica.eu-central-1.aws.neon.tech/portal?sslmode=require&zone=eu-central',
      MEMCACHED_SERVERS: 'mc1:11211',
    }, { now: () => AT(5) });

    expect(report.configured).toBe(true);
    expect(report.mode).toBe('postgres');
    expect(report.pooling).toMatchObject({ mode: 'transaction', instances: 4, budget: 100, reserved: 10 });
    expect(report.pooling!.serverConnections + report.pooling!.reserved).toBeLessThanOrEqual(100);
    expect(report.pooling!.directUrl).not.toContain('s3cr3t');
    expect(report.pooling!.appUrl).not.toContain('s3cr3t');
    // The application is pointed at Neon's own pooler; migrations keep the direct host.
    expect(report.pooling!.appUrl).toContain('-pooler.');
    expect(report.pooling!.directUrl).not.toContain('-pooler.');
    expect(report.readPlane).toMatchObject({ primary: 'ep-cool-1234.eu-central-1.aws.neon.tech', maxLagMs: 2_000 });
    expect(report.readPlane!.replicas[0]).toMatchObject({ id: 'ep-cool-1234-replica.eu-central-1.aws.neon.tech', zone: 'eu-central', healthy: true });
    expect(report.refusals).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
    expect(JSON.stringify(report)).not.toContain('shh');
    expect(report.notes.join(' ')).toMatch(/Neon direct host/);
  });

  it('refuses a second pooler in front of Neon’s own, and returns no deployable mode', () => {
    const report = dataPlaneReport({ DATABASE_URL: NEON_POOLED }, { now: () => AT(5) });
    expect(report.configured).toBe(false);
    expect(report.mode).toBe('postgres');
    expect(report.refusals.join(' ')).toMatch(/already behind a pooler/);
    expect(report.notes.join(' ')).toMatch(/do not add another/);
  });

  it('refuses an unencrypted Neon URL and an impossible backend budget', () => {
    const noTls = dataPlaneReport({ DATABASE_URL: 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/portal' }, { now: () => AT(1) });
    expect(noTls.refusals.join(' ')).toMatch(/requires TLS/);
    const tooMany = dataPlaneReport({
      DATABASE_URL: NEON,
      DATABASE_MAX_CONNECTIONS: '20',
      INSTANCE_COUNT: '5',
      PGBOUNCER_POOL_SIZE: '10',
    }, { now: () => AT(1) });
    expect(tooMany.refusals.join(' ')).toMatch(/backends/);
  });

  it('refuses to treat the primary host as its own replica', () => {
    const report = dataPlaneReport({
      DATABASE_URL: NEON,
      READ_REPLICA_URLS: NEON,
    }, { now: () => AT(1) });
    expect(report.refusals.join(' ')).toMatch(/is the primary host/);
    expect(report.readPlane).toBeUndefined();
  });

  it('surfaces a malformed replica URL and a malformed shard map instead of dropping them', () => {
    const report = dataPlaneReport({
      DATABASE_URL: NEON,
      READ_REPLICA_URLS: 'mysql://nope',
      SHARD_MAP: '[{"id":""}]',
      MEMCACHED_SERVERS: 'mc1:11211',
    }, { now: () => AT(1) });
    expect(report.refusals.join(' ')).toMatch(/READ_REPLICA_URLS/);
    expect(report.refusals.join(' ')).toMatch(/SHARD_MAP/);
    expect(report.configured).toBe(false);
  });

  it('refuses an ID_SHARD outside the 13-bit field, and clamps the sample to a usable one', () => {
    const report = dataPlaneReport({ ID_SHARD: '9000' }, { now: () => AT(2) });
    expect(report.refusals.join(' ')).toMatch(/ID_SHARD/);
    expect(report.ids.shard).toBe(0);
    expect(report.ids.sample!.shard).toBe(0);

    const inRange = dataPlaneReport({ ID_SHARD: '8191' }, { now: () => AT(2) });
    expect(inRange.refusals).toEqual([]);
    expect(inRange.ids.sample!.shard).toBe(8_191);
  });

  it('refuses an ID_SHARD that the shard map does not cover', () => {
    const report = dataPlaneReport({
      SHARD_MAP: '[{"id":"img-a","zone":"a"},{"id":"img-b","zone":"b"}]',
      LOGICAL_SHARDS: '16',
      ID_SHARD: '99',
    }, { now: () => AT(1) });
    expect(report.refusals.join(' ')).toMatch(/outside the 16 logical shard/);
  });

  it('includes the deploy files only when asked', () => {
    const silent = dataPlaneReport({ DATABASE_URL: NEON }, { now: () => AT(1) });
    expect(silent.pooling!.ini).toBeUndefined();
    const withFiles = dataPlaneReport({ DATABASE_URL: NEON }, { now: () => AT(1), includeIni: true });
    expect(withFiles.pooling!.ini).toContain('[pgbouncer]');
    expect(withFiles.pooling!.ini).not.toContain('s3cr3t');
    expect(withFiles.pooling!.userlist).toContain('REPLACE_WITH_PASSWORD_OR_SCRAM_VERIFIER');
  });
});

describe('minting ids for the API', () => {
  it('returns N unique, ordered ids with their decoded fields', () => {
    const minted = mintIds({ count: 3, shard: 17, now: () => AT(42) });
    expect(minted.ids).toHaveLength(3);
    expect(minted.shard).toBe(17);
    expect(minted.ids.map((id) => id.counter)).toEqual([0, 1, 2]);
    expect(new Set(minted.ids.map((id) => id.id)).size).toBe(3);
    expect(minted.ids[0]!.issuedAt).toBe(new Date(AT(42)).toISOString());
    expect(minted.layout.totalBits).toBe(64);
  });

  it('refuses a count or shard outside the contract', () => {
    expect(() => mintIds({ count: 0 })).toThrow(/count/);
    expect(() => mintIds({ count: 1_001 })).toThrow(/count/);
    expect(() => mintIds({ count: 1.5 })).toThrow(/count/);
    expect(() => mintIds({ count: 1, shard: 8_192 })).toThrow(/shard/);
    expect(() => mintIds({ count: 1, shard: -1 })).toThrow(/shard/);
  });
});
