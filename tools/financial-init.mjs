#!/usr/bin/env node
/** Explicit empty-book initialization. No rates, policies, NAVs or approvals are seeded. */
import { Pool } from 'pg';
import { adaptPgClient } from '../dist-server/server/reconciliation/postgres.js';
import { initializeFinancialBook } from '../dist-server/server/financial/store.js';
const url = process.env.FINANCE_MIGRATION_DATABASE_URL?.trim(); const environment = process.env.FINANCE_ENVIRONMENT;
if (!url || !['live','demo'].includes(environment)) { console.error('Set FINANCE_MIGRATION_DATABASE_URL and FINANCE_ENVIRONMENT=live|demo'); process.exitCode = 2; }
else {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 }); const db = adaptPgClient(await pool.connect()); let discard = false;
  try { await initializeFinancialBook(db, environment); console.log(`Empty ${environment} financial book initialized. No configuration or approval was seeded.`); }
  catch (error) { discard = true; console.error(error instanceof Error && error.message.includes('already exists') ? error.message : 'Financial initialization failed; inspect secure database diagnostics.'); process.exitCode = 1; }
  finally { db.release(discard); await pool.end(); }
}
