import { Pool } from 'pg';
import { FinancialService } from '../../core/financial/service.js';
import { PostgresFinancialStore } from './store.js';
import { adaptPgClient } from '../reconciliation/postgres.js';
import { startMonthlyScheduler } from './scheduler.js';
import { createFinancialAdapters } from './adapters.js';
export const FINANCE_DATABASE_URL = 'FINANCE_DATABASE_URL';
/** No connection, migration or seed is attempted in demo mode. Storage errors never select a demo book. */
export async function createFinancialRuntime(env: NodeJS.ProcessEnv, log: (line: string) => void = console.error) {
  const url = env[FINANCE_DATABASE_URL]?.trim();
  if (!url) {
    if (env['NODE_ENV'] === 'production' && env['PORTAL_ALLOW_DEMO'] !== '1') throw new Error('FINANCE_DATABASE_URL required');
    return undefined;
  }
  const pool = new Pool({ connectionString: url, max: Number(env['FINANCE_POOL_SIZE'] ?? 8), connectionTimeoutMillis: 10000, statement_timeout: 20000 });
  const store = new PostgresFinancialStore({ connect: async () => adaptPgClient(await pool.connect()), end: () => pool.end() });
  // Readiness probe only. Never migrate, initialize or seed at startup.
  await store.read();
  const service = new FinancialService({ store, designatedApprover: env['FINANCE_APPROVER_NAME']?.trim(), ...createFinancialAdapters(env) });
  return {
    service,
    startScheduler() { if (env['FINANCE_SCHEDULER'] === '1') return startMonthlyScheduler(service, { log }); },
    async close() { await store.close(); },
  };
}
