import { createHash } from 'node:crypto';
import type { SqlConnection } from '../reconciliation/sql.js';
export interface FinancialMigration { readonly version: string; readonly up: string; readonly down: string }
export class FinancialMigrationError extends Error {}
export const financialMigrationChecksum = (m: FinancialMigration) => createHash('sha256').update(m.up).update('\0').update(m.down).digest('hex');
/** Explicit privileged migration only; startup never calls this. */
export async function runFinancialMigrations(db: SqlConnection, migrations: readonly FinancialMigration[], direction: 'up' | 'down') {
  if (!migrations.length || migrations.some((m, i) => !/^\d{4}_[a-z0-9_]+$/.test(m.version) || !m.up.trim() || !m.down.trim() || (i > 0 && migrations[i - 1]!.version >= m.version))) throw new FinancialMigrationError('invalid or unordered financial migrations');
  await db.exec('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', ['721031584225']);
    await db.exec(`CREATE SCHEMA IF NOT EXISTS financial_migrations; REVOKE ALL ON SCHEMA financial_migrations FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS financial_migrations.history (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT transaction_timestamp());`);
    const { rows } = await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM financial_migrations.history ORDER BY version');
    for (const [i, row] of rows.entries()) {
      const expected = migrations[i];
      if (!expected || expected.version !== row.version) throw new FinancialMigrationError('unrecognized financial migration history');
      if (financialMigrationChecksum(expected) !== row.checksum) throw new FinancialMigrationError('financial migration checksum differs from applied history');
    }
    let changed = false;
    if (direction === 'up') for (const m of migrations.slice(rows.length)) { await db.exec(m.up); await db.query('INSERT INTO financial_migrations.history (version, checksum) VALUES ($1,$2)', [m.version, financialMigrationChecksum(m)]); changed = true; }
    else if (rows.length) { const m = migrations[rows.length - 1]!; await db.exec(m.down); await db.query('DELETE FROM financial_migrations.history WHERE version=$1', [m.version]); changed = true; }
    await db.exec('COMMIT'); return { outcome: changed ? direction === 'up' ? 'applied' : 'reverted' : 'unchanged' } as const;
  } catch (error) { try { await db.exec('ROLLBACK'); } catch { /* caller destroys connection */ } throw error; }
}
