#!/usr/bin/env node
/** Explicit, opt-in migration runner. Normal application startup never invokes this. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { adaptPgClient } from '../dist-server/server/reconciliation/postgres.js';
import { runReconciliationMigrations, ReconciliationMigrationError } from '../dist-server/server/reconciliation/migrations.js';

const direction = process.argv[2];
const url = process.env.RECON_MIGRATION_DATABASE_URL?.trim();
if ((direction !== 'up' && direction !== 'down') || !url) {
  console.error('Usage: set RECON_MIGRATION_DATABASE_URL to the direct Postgres URL, then run npm run recon:migrate -- up|down');
  process.exitCode = 2;
} else {
  const root = new URL('../migrations/reconciliation/', import.meta.url);
  const migration = {
    version: '0001_scope',
    up: await readFile(new URL('0001_scope.up.sql', root), 'utf8'),
    down: await readFile(new URL('0001_scope.down.sql', root), 'utf8'),
  };
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 });
  let db;
  let discard = false;
  try {
    db = adaptPgClient(await pool.connect());
    const result = await runReconciliationMigrations(db, [migration], direction);
    console.log(`Reconciliation migration: ${result.outcome}${result.versions.length ? ` (${result.versions.join(', ')})` : ''}.`);
  } catch (error) {
    discard = true;
    // Do not print connection strings, credentials, SQL or data-bearing database errors.
    const safe = error instanceof ReconciliationMigrationError || (error instanceof Error && error.message.startsWith('refusing reconciliation rollback:'));
    console.error(safe ? error.message : 'Reconciliation migration failed; inspect the secure database diagnostics and runbook.');
    process.exitCode = 1;
  } finally {
    db?.release(discard);
    await pool.end();
  }
}
