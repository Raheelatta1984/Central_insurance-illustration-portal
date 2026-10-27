import { Pool, type PoolClient } from 'pg';
import type { SqlConnection, SqlPool, SqlResult } from './sql.js';

/** Adapt node-postgres without exposing raw clients to the domain. */
export function adaptPgClient(client: PoolClient): SqlConnection {
  return {
    async query<T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<SqlResult<T>> {
      const result = await client.query(sql, [...parameters]);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string): Promise<void> { await client.query(sql); },
    release(destroy = false): void { client.release(destroy); },
  };
}

/** The caller owns the Pool and must close it on process shutdown. */
export function reconciliationPool(pool: Pool): SqlPool {
  return { async connect() { return adaptPgClient(await pool.connect()); } };
}
