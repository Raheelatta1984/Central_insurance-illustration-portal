import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from 'pg';
import { adaptPgClient } from '../reconciliation/postgres.js';
import type { SqlConnection, SqlPool } from '../reconciliation/sql.js';
import { FinancialBook } from '../../core/financial/book.js';
import { demoFinancialFixture, demoPolicyId } from '../../core/financial/demo-fixture.js';
import { toJson } from '../../core/persistence.js';
import { initializeFinancialBook, PostgresFinancialStore } from './store.js';
import { runFinancialMigrations, type FinancialMigration } from './migrations.js';

const migration: FinancialMigration = {
  version: '0001_book',
  up: await readFile(new URL('../../../migrations/financial/0001_book.up.sql', import.meta.url), 'utf8'),
  down: await readFile(new URL('../../../migrations/financial/0001_book.down.sql', import.meta.url), 'utf8'),
};
const external = process.env['FINANCE_TEST_DATABASE_URL'];
interface Harness { pool: SqlPool; db: SqlConnection; close(): Promise<void> }
async function embedded(): Promise<Harness> {
  // Separate PGlite instances model separate processes sharing one durable database.
  const clients = [new PGlite(), new PGlite()];
  // PGlite instances are independent; use one instance with serialized connections for embedded tests.
  await clients[1]!.close();
  const pg = clients[0]!; let locked = false; const waiters: Array<() => void> = [];
  const connection = (): SqlConnection => ({
    async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) { return { rows: (await pg.query<T>(sql, [...params])).rows }; },
    async exec(sql) { await pg.exec(sql); },
    release() { const next = waiters.shift(); if (next) next(); else locked = false; },
  });
  return { db: connection(), pool: { async connect() { if (locked) await new Promise<void>((resolve) => waiters.push(resolve)); else locked = true; return connection(); } }, close: () => pg.close() };
}
async function native(): Promise<Harness> {
  const admin = new Client({ connectionString: external }); await admin.connect();
  const name = `finance_test_${randomBytes(6).toString('hex')}`; await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(external!); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  const client = await pool.connect(); const db = adaptPgClient(client);
  return { db, pool: { async connect() { return adaptPgClient(await pool.connect()); } }, async close() { client.release(); await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); } };
}
const targets: Array<[string, () => Promise<Harness>]> = [['PGlite', embedded]];
if (external) targets.push(['native PostgreSQL', native]);
for (const [name, create] of targets) describe(`durable financial commands: ${name}`, () => {
  let h: Harness; let store: PostgresFinancialStore;
  beforeAll(async () => {
    h = await create(); await runFinancialMigrations(h.db, [migration], 'up');
    await initializeFinancialBook(h.db, 'demo');
    const fixture = demoFinancialFixture();
    await h.db.query('UPDATE financial_private.state SET payload=$1::jsonb, fingerprint=$2 WHERE singleton=1', [toJson(fixture), (await import('../../core/persistence.js')).fingerprintOf(JSON.parse(toJson(fixture)))]);
    store = new PostgresFinancialStore(h.pool);
  }, 60000);
  afterAll(async () => { await h?.close(); }, 60000);
  it('migrations are checksum-pinned and repeat without changes', async () => {
    expect((await runFinancialMigrations(h.db, [migration], 'up')).outcome).toBe('unchanged');
    await expect(runFinancialMigrations(h.db, [{ ...migration, up: migration.up + '\n-- changed' }], 'up')).rejects.toThrow(/checksum/);
  });
  it('replays a committed command after a simulated process restart without double posting', async () => {
    const { state } = await store.read(); const policyId = demoPolicyId(state);
    const input = { scope: 'officer:/payments', key: 'restart-key-0001', at: '2026-11-06T09:00:00Z', actor: 'officer', request: { policyId, amountMinor: '10000' } };
    const op = (b: FinancialBook) => b.invest({ policyId, kind: 'topup', amountMinor: '10000', at: input.at, evidence: { provider: 'test', reference: 'RESTART-PAY', policyId, amountMinor: '10000', currency: 'AED', verifiedAt: input.at } }, true);
    const first = await store.command(input, op);
    const restarted = new PostgresFinancialStore(h.pool);
    const replay = await restarted.command(input, () => { throw new Error('must not execute'); });
    expect(replay.replayed).toBe(true); expect(replay.result).toEqual(first.result);
    expect((await restarted.read()).state.transactions).toHaveLength(1);
    const conflict = await restarted.command({ ...input, request: { changed: true } }, op);
    expect(conflict.result.status).toBe(409);
  });
  it('rolls back the aggregate and command receipt together on a pre-commit failure', async () => {
    const before = await store.read();
    const failing = new PostgresFinancialStore(h.pool, { beforeCommit: () => { throw new Error('crash before commit'); } });
    await expect(failing.command({ scope: 'officer:/nav', key: 'failure-key-0001', at: '2026-11-06T09:00:00Z', actor: 'officer', request: {} }, (b) => b.recordNav({ fundId: 'NEW', date: '2026-11-06', priceMicro: '1000000', currency: 'AED', sourceReference: 'TEST' }))).rejects.toThrow(/crash/);
    const after = await store.read(); expect(after.version).toBe(before.version); expect(after.state).toEqual(before.state);
    const retried = await store.command({ scope: 'officer:/nav', key: 'failure-key-0001', at: '2026-11-06T09:00:00Z', actor: 'officer', request: {} }, (b) => b.recordNav({ fundId: 'NEW', date: '2026-11-06', priceMicro: '1000000', currency: 'AED', sourceReference: 'TEST' }));
    expect(retried.replayed).toBe(false); expect((await store.read()).version).toBe(before.version + 1);
  });
  it('persists a configuration block and its P1 request as a replayable non-money result', async () => {
    const { state } = await store.read(); const policyId = demoPolicyId(state);
    const input = { scope: 'officer:/servicing', key: 'blocked-key-0001', at: '2026-11-06T09:00:00Z', actor: 'officer', request: { policyId } };
    // Remove only the staged rule by proposing a new scoped policy would change identity; use a fresh empty book command.
    const blocked = await store.command(input, (b) => b.backfillDistribution({ policyId, evidence: [], sourceRecords: [] }));
    expect(blocked.result.status).toBe(409);
    expect((await store.read()).state.configurationRequests.length).toBeGreaterThan(0);
    expect((await store.command(input, () => { throw new Error('no reexecute'); })).replayed).toBe(true);
  });
  it('refuses rollback once financial facts exist and refuses overwrite initialization', async () => {
    await expect(runFinancialMigrations(h.db, [migration], 'down')).rejects.toThrow();
    await expect(initializeFinancialBook(h.db, 'live')).rejects.toThrow(/already exists/);
    expect((await store.read()).state.environment).toBe('demo');
  });
  it('stops mutations when stored facts do not reconcile', async () => {
    const { state } = await store.read(); state.holdings[0]!.units = '999';
    const encoded = JSON.parse(toJson(state));
    await h.db.query('UPDATE financial_private.state SET payload=$1::jsonb, fingerprint=$2', [toJson(state), (await import('../../core/persistence.js')).fingerprintOf(encoded)]);
    await expect(store.command({ scope: 'x', key: 'tampered-key-0001', at: '2026-11-06T09:00:00Z', actor: 'x', request: {} }, () => null)).rejects.toMatchObject({ status: 503 });
    await expect(store.read()).rejects.toMatchObject({ status: 503 });
  });
});
