#!/usr/bin/env node
/** Explicit privileged migration. Never invoked by server startup. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { adaptPgClient } from '../dist-server/server/reconciliation/postgres.js';
import { runFinancialMigrations, FinancialMigrationError } from '../dist-server/server/financial/migrations.js';
const direction = process.argv[2]; const url = process.env.FINANCE_MIGRATION_DATABASE_URL?.trim();
if (!['up','down'].includes(direction) || !url) { console.error('Set FINANCE_MIGRATION_DATABASE_URL, then npm run finance:migrate -- up|down'); process.exitCode = 2; }
else {
  const root = new URL('../migrations/financial/', import.meta.url);
  const migration = { version: '0001_book', up: await readFile(new URL('0001_book.up.sql', root), 'utf8'), down: await readFile(new URL('0001_book.down.sql', root), 'utf8') };
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 }); let db; let discard = false;
  try { db = adaptPgClient(await pool.connect()); console.log(`Financial migration: ${(await runFinancialMigrations(db, [migration], direction)).outcome}.`); }
  catch (error) { discard = true; console.error(error instanceof FinancialMigrationError || (error instanceof Error && error.message.startsWith('refusing financial rollback:')) ? error.message : 'Financial migration failed; inspect secure database diagnostics.'); process.exitCode = 1; }
  finally { db?.release(discard); await pool.end(); }
}
