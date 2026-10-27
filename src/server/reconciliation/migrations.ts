import { createHash } from 'node:crypto';
import type { SqlConnection } from './sql.js';

/** A reviewed migration and its guarded rollback; both are pinned in history. */
export interface Migration {
  readonly version: string;
  readonly up: string;
  readonly down: string;
}

export class ReconciliationMigrationError extends Error {}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.up, 'utf8').update('\0').update(migration.down, 'utf8').digest('hex');
}

type History = Record<string, unknown> & { version: string; checksum: string };

/**
 * Apply all known migrations, or reverse the latest one, atomically. A shared
 * advisory lock serializes deployers; applied migration text must be byte-identical
 * and history must be a prefix of the reviewed chain. Rollback refuses populated
 * schemas in the migration itself.
 *
 * Never invoked on server startup: use a direct privileged migration connection.
 */
export async function runReconciliationMigrations(
  db: SqlConnection, migrations: readonly Migration[], direction: 'up' | 'down',
): Promise<{ readonly outcome: 'applied' | 'reverted' | 'unchanged'; readonly versions: readonly string[] }> {
  if (migrations.length === 0 || migrations.some((m, i) =>
    !/^[0-9]{4}_[a-z0-9_]+$/.test(m.version) || !m.up.trim() || !m.down.trim()
    || (i > 0 && migrations[i - 1]!.version >= m.version))) {
    throw new ReconciliationMigrationError('invalid or unordered reconciliation migrations');
  }
  await db.exec('BEGIN');
  try {
    // Stable, feature-specific PostgreSQL bigint lock id, held only until commit/rollback.
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', ['721031584224']);
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS reconciliation_migrations;
      REVOKE ALL ON SCHEMA reconciliation_migrations FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS reconciliation_migrations.history (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      );
    `);
    const { rows } = await db.query<History>('SELECT version, checksum FROM reconciliation_migrations.history ORDER BY version');
    for (const [index, row] of rows.entries()) {
      const expected = migrations[index];
      if (!expected || expected.version !== row.version) {
        throw new ReconciliationMigrationError('unrecognized or incomplete reconciliation migration history');
      }
      if (migrationChecksum(expected) !== row.checksum) {
        throw new ReconciliationMigrationError('reconciliation migration checksum differs from applied history');
      }
    }
    let outcome: 'applied' | 'reverted' | 'unchanged' = 'unchanged';
    const versions: string[] = [];
    if (direction === 'up') {
      for (const migration of migrations.slice(rows.length)) {
        await db.exec(migration.up);
        await db.query('INSERT INTO reconciliation_migrations.history (version, checksum) VALUES ($1, $2)', [migration.version, migrationChecksum(migration)]);
        versions.push(migration.version);
      }
      if (versions.length) outcome = 'applied';
    } else if (rows.length) {
      const migration = migrations[rows.length - 1]!;
      await db.exec(migration.down);
      await db.query('DELETE FROM reconciliation_migrations.history WHERE version = $1', [migration.version]);
      versions.push(migration.version);
      outcome = 'reverted';
    }
    await db.exec('COMMIT');
    return { outcome, versions };
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch { /* Callers discard a failed migration connection. */ }
    throw error;
  }
}
