#!/usr/bin/env node
/** Idempotent Render pre-deploy bootstrap: migrate up, then initialize an empty book only if absent.
 * Never seeds rates, policies, NAVs, approvals or demo data. An existing book with a different
 * environment is a hard refusal, not an overwrite. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { adaptPgClient } from '../dist-server/server/reconciliation/postgres.js';
import { runFinancialMigrations } from '../dist-server/server/financial/migrations.js';
import { initializeFinancialBook } from '../dist-server/server/financial/store.js';

const url = process.env.FINANCE_MIGRATION_DATABASE_URL?.trim();
const environment = process.env.FINANCE_ENVIRONMENT?.trim();
if (!url || !['live', 'demo'].includes(environment)) {
  console.error('Set FINANCE_MIGRATION_DATABASE_URL and FINANCE_ENVIRONMENT=live|demo');
  process.exitCode = 2;
} else {
  const root = new URL('../migrations/financial/', import.meta.url);
  const migration = {
    version: '0001_book',
    up: await readFile(new URL('0001_book.up.sql', root), 'utf8'),
    down: await readFile(new URL('0001_book.down.sql', root), 'utf8'),
  };
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 });
  let db; let discard = false;
  try {
    db = adaptPgClient(await pool.connect());
    const migrated = await runFinancialMigrations(db, [migration], 'up');
    const existing = await db.query('SELECT environment FROM financial_private.state WHERE singleton = 1');
    if (existing.rows.length === 0) {
      await initializeFinancialBook(db, environment);
      console.log(`Financial bootstrap: migration ${migrated.outcome}; empty ${environment} book initialized.`);
    } else if (existing.rows[0].environment !== environment) {
      discard = true;
      console.error(`Financial bootstrap refused: existing book is ${existing.rows[0].environment}, requested ${environment}.`);
      process.exitCode = 1;
    } else {
      console.log(`Financial bootstrap: migration ${migrated.outcome}; existing ${environment} book left unchanged.`);
    }
  } catch (error) {
    discard = true;
    console.error(error instanceof Error && /financial|migration|book/i.test(error.message) ? error.message : 'Financial bootstrap failed; inspect secure database diagnostics.');
    process.exitCode = 1;
  } finally {
    db?.release(discard);
    await pool.end();
  }
}
