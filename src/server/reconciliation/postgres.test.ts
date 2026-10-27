import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runReconciliationMigrations, type Migration } from './migrations.js';
import { adaptPgClient } from './postgres.js';
import { ReconciliationReadRepository, trustedReadContext, type OwnedResourceKind } from './read-repository.js';
import type { SqlConnection, SqlResult } from './sql.js';

const migration: Migration = {
  version: '0001_scope',
  up: await readFile(new URL('../../../migrations/reconciliation/0001_scope.up.sql', import.meta.url), 'utf8'),
  down: await readFile(new URL('../../../migrations/reconciliation/0001_scope.down.sql', import.meta.url), 'utf8'),
};
const externalUrl = process.env.RECON_TEST_DATABASE_URL;
const tables: OwnedResourceKind[] = ['policy', 'source_file', 'reconciliation_run', 'statement', 'payment_instruction'];
const randomName = (prefix: string): string => `${prefix}_${randomBytes(7).toString('hex')}`;

interface Harness {
  readonly db: SqlConnection;
  readonly reader: string;
  readonly databaseUrl?: string;
  markReaderCreated(): void;
  close(): Promise<void>;
}

type HarnessFactory = () => Promise<Harness>;
async function embedded(): Promise<Harness> {
  const pg = new PGlite();
  const db: SqlConnection = {
    async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
      return { rows: (await pg.query<T>(sql, [...params])).rows };
    },
    async exec(sql) { await pg.exec(sql); },
    release() {}, // one dedicated test connection, closed by the harness
  };
  return { db, reader: randomName('recon_reader'), markReaderCreated() {}, async close() { await pg.close(); } };
}

// RECON_TEST_DATABASE_URL is a superuser connection to a disposable CI cluster.
// A randomly named test database is CREATED and DROPPED, never an existing database.
async function nativePostgres(): Promise<Harness> {
  if (!externalUrl) throw new Error('RECON_TEST_DATABASE_URL required');
  const database = randomName('recon_foundation_test');
  const reader = randomName('recon_reader');
  const admin = new Client({ connectionString: externalUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(externalUrl);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const client = await pool.connect();
  const adapted = adaptPgClient(client);
  const db: SqlConnection = { ...adapted, release() {} };
  let readerCreated = false;
  return {
    db, reader, databaseUrl: url.toString(),
    markReaderCreated() { readerCreated = true; },
    async close() {
      try { await db.exec('RESET ROLE'); } finally {
        client.release();
        await pool.end();
        await admin.query(`DROP DATABASE ${database}`);
        if (readerCreated) await admin.query(`DROP ROLE ${reader}`);
        await admin.end();
      }
    },
  };
}

const targets: [string, HarnessFactory][] = [['embedded Postgres (PGlite)', embedded]];
if (externalUrl) targets.push(['native PostgreSQL', nativePostgres]);

async function apply(db: SqlConnection): Promise<void> {
  expect((await runReconciliationMigrations(db, [migration], 'up')).outcome).toBe('applied');
}

async function seed(db: SqlConnection, reader: string): Promise<void> {
  await db.exec(`
    INSERT INTO reconciliation_private.insurer VALUES ('A', 'Insurer A'), ('B', 'Insurer B');
    INSERT INTO reconciliation.channel_type VALUES ('A', 'broker', 'Broker'), ('A', 'new-channel', 'New channel'), ('B', 'bank', 'Bank');
    INSERT INTO reconciliation.subchannel_type VALUES ('A', 'broker', 'agent', 'Agent'), ('B', 'bank', 'branch', 'Branch');
    INSERT INTO reconciliation_private.partner (insurer_id, partner_id, channel_partner_id, parent_partner_id, channel_type_code, subchannel_type_code, name)
    VALUES ('A', 'root', 'root', NULL, 'broker', NULL, 'Root'),
           ('A', 'other-root', 'other-root', NULL, 'new-channel', NULL, 'Other root'),
           ('A', 'child-a', 'root', 'root', 'broker', 'agent', 'Child A'),
           ('A', 'child-b', 'root', 'root', 'broker', 'agent', 'Child B'),
           ('A', 'grandchild', 'root', 'child-a', 'broker', 'agent', 'Grandchild'),
           ('B', 'root', 'root', NULL, 'bank', NULL, 'B root');
    INSERT INTO reconciliation_private.access_grant (insurer_id, subject_id, partner_id, view_self, view_descendants, valid_from, valid_until)
    VALUES ('A', 'root-only', 'root', true, false, now() - interval '1 day', NULL),
           ('A', 'root-tree', 'root', true, true, now() - interval '1 day', NULL),
           ('A', 'desc-only', 'root', false, true, now() - interval '1 day', NULL),
           ('A', 'child-only', 'child-a', true, false, now() - interval '1 day', NULL),
           ('A', 'child-tree', 'child-a', true, true, now() - interval '1 day', NULL),
           ('A', 'other-root', 'other-root', true, true, now() - interval '1 day', NULL),
           ('A', 'expired', 'root', true, true, now() - interval '2 days', now() - interval '1 day'),
           ('A', 'future', 'root', true, true, now() + interval '1 day', NULL),
           ('B', 'b-user', 'root', true, true, now() - interval '1 day', NULL);
  `);
  for (const table of tables) {
    await db.exec(`INSERT INTO reconciliation.${table} (insurer_id, resource_id, channel_partner_id, subpartner_id, owner_partner_id) VALUES
      ('A', 'shared-id', 'root', NULL, 'root'),
      ('A', 'child-a-id', 'root', 'child-a', 'child-a'),
      ('A', 'child-b-id', 'root', 'child-b', 'child-b'),
      ('A', 'grandchild-id', 'root', 'grandchild', 'grandchild'),
      ('A', 'other-id', 'other-root', NULL, 'other-root'),
      ('B', 'shared-id', 'root', NULL, 'root')`);
  }
  await db.exec(`
    CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA reconciliation TO ${reader};
    GRANT SELECT ON ALL TABLES IN SCHEMA reconciliation TO ${reader};
    GRANT EXECUTE ON FUNCTION reconciliation.can_view(text,text,text), reconciliation.can_access_insurer(text) TO ${reader};
  `);
}

for (const [target, create] of targets) {
  describe(`reconciliation database isolation: ${target}`, () => {
    let harness: Harness;
    let db: SqlConnection;
    let repo: ReconciliationReadRepository;
    const context = (subjectId: string, insurerId = 'A') => trustedReadContext({ insurerId, subjectId });
    beforeAll(async () => {
      harness = await create(); db = harness.db;
      await apply(db); await seed(db, harness.reader); harness.markReaderCreated();
      repo = new ReconciliationReadRepository({ async connect() { return db; } });
    }, 60_000);
    beforeEach(async () => { await db.exec(`RESET ROLE; SET ROLE ${harness.reader}`); });
    afterAll(async () => { await harness?.close(); }, 60_000);

    it('denies direct reads without trusted context and forbids direct access to private grants', async () => {
      for (const table of [...tables, 'channel_type', 'subchannel_type']) {
        expect((await db.query(`SELECT * FROM reconciliation.${table}`)).rows).toEqual([]);
      }
      await expect(db.query('SELECT * FROM reconciliation_private.access_grant')).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation.policy (insurer_id, resource_id, channel_partner_id, owner_partner_id) VALUES ('A','hack','root','root')")).rejects.toThrow();
      await expect(db.query("UPDATE reconciliation.policy SET resource_id = 'hack'")).rejects.toThrow();
      await expect(db.query('DELETE FROM reconciliation.policy')).rejects.toThrow();
    });

    it('enforces RLS even when a query omits application-level predicates', async () => {
      await db.exec('BEGIN READ ONLY');
      try {
        await db.query("SELECT set_config('reconciliation.insurer_id', $1, true), set_config('reconciliation.subject_id', $2, true)", ['A', 'child-only']);
        for (const table of tables) {
          const result = await db.query<{ resource_id: string }>(`SELECT resource_id FROM reconciliation.${table} ORDER BY resource_id`);
          expect(result.rows.map((r) => r.resource_id)).toEqual(['child-a-id']);
        }
        await db.exec('COMMIT');
      } catch (error) { await db.exec('ROLLBACK'); throw error; }
    });

    it('requires explicit descendant grants and isolates siblings, roots and guessed ids for every resource', async () => {
      for (const table of tables) {
        expect((await repo.findOwned(context('root-only'), table, 'shared-id'))?.insurerId).toBe('A');
        expect(await repo.findOwned(context('root-only'), table, 'child-a-id')).toBeNull();
        expect((await repo.findOwned(context('root-tree'), table, 'grandchild-id'))?.ownerPartnerId).toBe('grandchild');
        expect(await repo.findOwned(context('root-tree'), table, 'other-id')).toBeNull();
        expect(await repo.findOwned(context('child-only'), table, 'child-a-id')).not.toBeNull();
        expect(await repo.findOwned(context('child-only'), table, 'child-b-id')).toBeNull();
        expect(await repo.findOwned(context('child-only'), table, 'grandchild-id')).toBeNull();
        expect(await repo.findOwned(context('child-tree'), table, 'grandchild-id')).not.toBeNull();
        expect(await repo.findOwned(context('child-tree'), table, 'child-b-id')).toBeNull();
        expect(await repo.findOwned(context('child-only'), table, 'guessed-id')).toBeNull();
        expect(await repo.findOwned(context('desc-only'), table, 'shared-id')).toBeNull();
        expect(await repo.findOwned(context('desc-only'), table, 'child-b-id')).not.toBeNull();
      }
    }, 30_000);

    it('denies scope tampering, missing grants and grants outside their validity interval', async () => {
      for (const subject of ['unknown', 'expired', 'future']) {
        expect(await repo.findOwned(context(subject), 'policy', 'shared-id')).toBeNull();
        expect(await repo.listChannelTypes(context(subject))).toEqual([]);
      }
      expect(await repo.findOwned(context('root-tree', 'B'), 'policy', 'shared-id')).toBeNull();
      expect((await repo.findOwned(context('b-user', 'B'), 'policy', 'shared-id'))?.insurerId).toBe('B');
      expect(await repo.findOwned(context('b-user', 'A'), 'policy', 'shared-id')).toBeNull();
      expect(await repo.findOwned(context('b-user', 'B'), 'policy', 'child-a-id')).toBeNull();
    });

    it('treats grant start as inclusive and grant end as exclusive at the same transaction instant', async () => {
      await db.exec('RESET ROLE; BEGIN');
      try {
        await db.exec(`INSERT INTO reconciliation_private.access_grant
          (insurer_id, subject_id, partner_id, view_self, view_descendants, valid_from, valid_until)
          VALUES ('A', 'starts-now', 'root', true, false, transaction_timestamp(), transaction_timestamp() + interval '1 day'),
                 ('A', 'ends-now', 'root', true, false, transaction_timestamp() - interval '1 day', transaction_timestamp())`);
        await db.exec(`SET LOCAL ROLE ${harness.reader}`);
        await db.query("SELECT set_config('reconciliation.insurer_id', 'A', true), set_config('reconciliation.subject_id', $1, true)", ['starts-now']);
        expect((await db.query("SELECT resource_id FROM reconciliation.policy WHERE resource_id = 'shared-id'")).rows).toHaveLength(1);
        await db.query("SELECT set_config('reconciliation.subject_id', $1, true)", ['ends-now']);
        expect((await db.query("SELECT resource_id FROM reconciliation.policy WHERE resource_id = 'shared-id'")).rows).toHaveLength(0);
      } finally { await db.exec('ROLLBACK'); }
    });

    it('uses insurer-owned configurable channel and subchannel reference rows', async () => {
      expect(await repo.listChannelTypes(context('root-only'))).toEqual([
        { code: 'broker', name: 'Broker' }, { code: 'new-channel', name: 'New channel' },
      ]);
      expect(await repo.listSubchannelTypes(context('b-user', 'B'))).toEqual([
        { code: 'branch', name: 'Branch', channelTypeCode: 'bank' },
      ]);
    });

    it('clears transaction-local identity on both success and failure', async () => {
      await repo.findOwned(context('root-tree'), 'policy', 'shared-id');
      const settings = async () => (await db.query<{ subject: string | null; insurer: string | null }>(
        "SELECT current_setting('reconciliation.subject_id', true) AS subject, current_setting('reconciliation.insurer_id', true) AS insurer",
      )).rows[0]!;
      expect((await settings()).subject || '').toBe('');
      expect((await settings()).insurer || '').toBe('');
      let released: boolean | undefined;
      const failing: SqlConnection = {
        ...db,
        async query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          if (sql.includes('SELECT insurer_id, resource_id')) throw new Error('synthetic failure');
          return db.query<T>(sql, params);
        },
        release(destroy) { released = destroy; },
      };
      const failingRepo = new ReconciliationReadRepository({ async connect() { return failing; } });
      await expect(failingRepo.findOwned(context('child-only'), 'policy', 'child-a-id')).rejects.toThrow('synthetic failure');
      expect(released).toBe(false);
      expect((await settings()).subject || '').toBe('');
      expect((await settings()).insurer || '').toBe('');
    });

    it('destroys a pooled connection if transaction rollback cannot be completed', async () => {
      let destroyed: boolean | undefined;
      const broken: SqlConnection = {
        async exec(sql) { if (sql === 'ROLLBACK') throw new Error('connection lost'); },
        async query() { throw new Error('query failed'); },
        release(destroy) { destroyed = destroy; },
      };
      const failingRepo = new ReconciliationReadRepository({ async connect() { return broken; } });
      await expect(failingRepo.findOwned(context('root-tree'), 'policy', 'shared-id')).rejects.toThrow('query failed');
      expect(destroyed).toBe(true);
    });

    it('rejects malformed contexts, resource names and IDs before accessing the database', async () => {
      expect(() => trustedReadContext({ insurerId: ' A ', subjectId: 'x' })).toThrow('Invalid insurer');
      expect(() => trustedReadContext({ insurerId: 'A', subjectId: '' })).toThrow('Invalid subject');
      await expect(repo.findOwned({ insurerId: 'A', subjectId: 'root-tree' } as never, 'policy', 'shared-id')).rejects.toThrow('Trusted read context');
      await expect(repo.findOwned(context('root-tree'), 'policy;drop table x' as OwnedResourceKind, 'x')).rejects.toThrow('Unknown owned');
      await expect(repo.findOwned(context('root-tree'), 'policy', '\0')).rejects.toThrow('Invalid resource');
    });

    it('rejects a superuser, a writer, private-schema access or disabled RLS rather than trusting deployment', async () => {
      await db.exec('RESET ROLE');
      await expect(repo.findOwned(context('root-tree'), 'policy', 'shared-id')).rejects.toThrow('not safely configured');
      await db.exec(`GRANT INSERT ON reconciliation.policy TO ${harness.reader}; SET ROLE ${harness.reader}`);
      await expect(repo.findOwned(context('root-tree'), 'policy', 'shared-id')).rejects.toThrow('not safely configured');
      await db.exec(`RESET ROLE; REVOKE INSERT ON reconciliation.policy FROM ${harness.reader}; GRANT USAGE ON SCHEMA reconciliation_private TO ${harness.reader}; SET ROLE ${harness.reader}`);
      await expect(repo.findOwned(context('root-tree'), 'policy', 'shared-id')).rejects.toThrow('not safely configured');
      await db.exec(`RESET ROLE; REVOKE USAGE ON SCHEMA reconciliation_private FROM ${harness.reader}; ALTER TABLE reconciliation.policy DISABLE ROW LEVEL SECURITY; SET ROLE ${harness.reader}`);
      await expect(repo.findOwned(context('root-tree'), 'policy', 'shared-id')).rejects.toThrow('not safely configured');
      await db.exec('RESET ROLE; ALTER TABLE reconciliation.policy ENABLE ROW LEVEL SECURITY');
    });

    it('enforces same-insurer/same-root ownership and immutable, acyclic parentage', async () => {
      await db.exec('RESET ROLE');
      await expect(db.query("INSERT INTO reconciliation.policy (insurer_id,resource_id,channel_partner_id,owner_partner_id) VALUES ('A','bad','other-root','child-a')")).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation.policy (insurer_id,resource_id,channel_partner_id,owner_partner_id) VALUES ('B','bad','root','child-a')")).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation.policy (insurer_id,resource_id,channel_partner_id,subpartner_id,owner_partner_id) VALUES ('A','bad','root',NULL,'child-a')")).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation.policy (insurer_id,resource_id,channel_partner_id,subpartner_id,owner_partner_id) VALUES ('A','bad','root','child-b','child-a')")).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation_private.partner VALUES ('A','orphan','root','other-root','broker',NULL,'Orphan')")).rejects.toThrow();
      await expect(db.query("INSERT INTO reconciliation_private.partner VALUES ('A','self','self','self','broker',NULL,'Self')")).rejects.toThrow();
      await expect(db.query("UPDATE reconciliation_private.partner SET parent_partner_id = 'grandchild' WHERE insurer_id = 'A' AND partner_id = 'child-a'")).rejects.toThrow('immutable');
      await expect(db.query("UPDATE reconciliation_private.partner SET channel_partner_id = 'other-root' WHERE insurer_id = 'A' AND partner_id = 'child-a'")).rejects.toThrow('immutable');
    });
  });

  describe(`reconciliation migration lifecycle: ${target}`, () => {
    let harness: Harness;
    let db: SqlConnection;
    beforeAll(async () => { harness = await create(); db = harness.db; }, 60_000);
    afterAll(async () => { await harness?.close(); }, 60_000);

    it('applies once, pins both directions by checksum, and safely reverses an empty schema', async () => {
      expect((await runReconciliationMigrations(db, [migration], 'up')).outcome).toBe('applied');
      expect((await runReconciliationMigrations(db, [migration], 'up')).outcome).toBe('unchanged');
      await expect(runReconciliationMigrations(db, [{ ...migration, down: `${migration.down}\n-- modified` }], 'up')).rejects.toThrow('checksum');
      expect((await runReconciliationMigrations(db, [migration], 'down')).outcome).toBe('reverted');
      expect((await runReconciliationMigrations(db, [migration], 'down')).outcome).toBe('unchanged');
    });

    it('refuses to discard populated data and leaves migration history intact', async () => {
      await runReconciliationMigrations(db, [migration], 'up');
      await db.exec("INSERT INTO reconciliation_private.insurer VALUES ('A','Insurer A')");
      await expect(runReconciliationMigrations(db, [migration], 'down')).rejects.toThrow('refusing reconciliation rollback');
      expect((await db.query('SELECT * FROM reconciliation_private.insurer')).rows).toHaveLength(1);
      expect((await db.query('SELECT version FROM reconciliation_migrations.history')).rows).toHaveLength(1);
      await db.exec('DELETE FROM reconciliation_private.insurer');
      expect((await runReconciliationMigrations(db, [migration], 'down')).outcome).toBe('reverted');
    });

    it('does not cascade into later objects when rolling back an extended schema', async () => {
      await runReconciliationMigrations(db, [migration], 'up');
      await db.exec('CREATE TABLE reconciliation.future_object (id text PRIMARY KEY)');
      await expect(runReconciliationMigrations(db, [migration], 'down')).rejects.toThrow();
      expect((await db.query("SELECT to_regclass('reconciliation.policy') AS name")).rows[0]?.name).toBe('reconciliation.policy');
      expect((await db.query("SELECT to_regclass('reconciliation.future_object') AS name")).rows[0]?.name).toBe('reconciliation.future_object');
      expect((await db.query('SELECT version FROM reconciliation_migrations.history')).rows).toHaveLength(1);
      await db.exec('DROP TABLE reconciliation.future_object');
      expect((await runReconciliationMigrations(db, [migration], 'down')).outcome).toBe('reverted');
    });

    it('refuses unknown histories and malformed migration chains', async () => {
      await db.exec("INSERT INTO reconciliation_migrations.history (version, checksum) VALUES ('9999_unknown', 'unreviewed')");
      await expect(runReconciliationMigrations(db, [migration], 'up')).rejects.toThrow('unrecognized');
      await db.exec('DELETE FROM reconciliation_migrations.history');
      await expect(runReconciliationMigrations(db, [], 'up')).rejects.toThrow('invalid or unordered');
      await expect(runReconciliationMigrations(db, [migration, migration], 'up')).rejects.toThrow('invalid or unordered');
    });
  });
}

if (externalUrl) {
  describe('native PostgreSQL deployment safeguards', () => {
    let harness: Harness;
    beforeEach(async () => { harness = await nativePostgres(); }, 60_000);
    afterEach(async () => { await harness?.close(); }, 60_000);

    it('serializes concurrent deployers with the advisory lock', async () => {
      const pool = new Pool({ connectionString: harness.databaseUrl!, max: 2 });
      const [one, two] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const outcomes = await Promise.all([
          runReconciliationMigrations(adaptPgClient(one), [migration], 'up'),
          runReconciliationMigrations(adaptPgClient(two), [migration], 'up'),
        ]);
        expect(outcomes.map((o) => o.outcome).sort()).toEqual(['applied', 'unchanged']);
      } finally { one.release(); two.release(); await pool.end(); }
    }, 30_000);

    it('runs the explicit CLI idempotently and rolls an empty schema back', async () => {
      const cli = fileURLToPath(new URL('../../../tools/reconciliation-migrate.mjs', import.meta.url));
      const run = promisify(execFile);
      const env = { ...process.env, RECON_MIGRATION_DATABASE_URL: harness.databaseUrl! };
      expect((await run(process.execPath, [cli, 'up'], { env })).stdout).toContain('applied');
      expect((await run(process.execPath, [cli, 'up'], { env })).stdout).toContain('unchanged');
      expect((await run(process.execPath, [cli, 'down'], { env })).stdout).toContain('reverted');
      expect((await run(process.execPath, [cli, 'down'], { env })).stdout).toContain('unchanged');
      expect((await run(process.execPath, [cli, 'up'], { env })).stdout).toContain('applied');
      await harness.db.exec("INSERT INTO reconciliation_private.insurer VALUES ('A', 'Insurer A')");
      await expect(run(process.execPath, [cli, 'down'], { env })).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('refusing reconciliation rollback'),
      });
      expect((await harness.db.query('SELECT insurer_id FROM reconciliation_private.insurer')).rows).toHaveLength(1);
      await harness.db.exec('DELETE FROM reconciliation_private.insurer');
      expect((await run(process.execPath, [cli, 'down'], { env })).stdout).toContain('reverted');
    }, 30_000);
  });
}
