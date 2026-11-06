/** PostgreSQL financial unit of work. The aggregate and command receipt commit together. */
import { fingerprintOf, fromJson, toJson } from '../../core/persistence.js';
import { FinancialBook, reconcileFinancialState, type FaultInjector } from '../../core/financial/book.js';
import { emptyFinancialState, FinancialError, type CommandResult, type FinancialState } from '../../core/financial/model.js';
import type { SqlConnection, SqlPool } from '../reconciliation/sql.js';

export interface FinancialStoreResult { readonly result: CommandResult; readonly replayed: boolean; readonly version: number }
export interface FinancialStore {
  command(input: { scope: string; key: string; request: unknown; at: string; actor: string }, operation: (book: FinancialBook) => unknown): Promise<FinancialStoreResult>;
  read(): Promise<{ state: FinancialState; version: number }>;
  close(): Promise<void>;
}
interface StateRow extends Record<string, unknown> { version: string; environment: 'live' | 'demo'; payload: unknown; fingerprint: string }
interface CommandRow extends Record<string, unknown> { request_hash: string; status: number; result: unknown; state_version: string }
const hash = (value: unknown) => fingerprintOf(value);

/** Reject edits/deletions of facts that the API promises are immutable, even inside a new command. */
export function assertAppendOnly(before: FinancialState, after: FinancialState): void {
  for (const name of ['transactions', 'receipts', 'journals', 'alterations', 'backfillAudit'] as const) {
    const oldRows = before[name] as unknown[]; const newRows = after[name] as unknown[];
    if (newRows.length < oldRows.length || oldRows.some((row, i) => hash(row) !== hash(newRows[i]))) throw new FinancialError(`append-only ${name} history was modified`, 500);
  }
  for (const rule of before.rules) {
    const next = after.rules.find((r) => r.id === rule.id && r.version === rule.version);
    if (!next) throw new FinancialError('filed rule version was modified', 500);
    // A proposed version may become approved exactly once, with provenance; its economics are immutable.
    if (rule.status === 'proposed' && next.status === 'approved' && next.approval) {
      const { status: _s, approval: _a, ...beforeEconomics } = rule;
      const { status: _ns, approval: _na, ...afterEconomics } = next;
      if (hash(beforeEconomics) !== hash(afterEconomics)) throw new FinancialError('filed rule version was modified', 500);
    } else if (hash(rule) !== hash(next)) throw new FinancialError('filed rule version was modified', 500);
  }
  for (const cycle of before.cycles.filter((c) => c.status === 'posted')) if (hash(cycle) !== hash(after.cycles.find((c) => c.policyId === cycle.policyId && c.cycle === cycle.cycle && c.kind === cycle.kind))) throw new FinancialError('posted cycle was modified', 500);
  for (const policy of before.policies) {
    const next = after.policies.find((p) => p.policyId === policy.policyId);
    if (!next || next.commencement !== policy.commencement || next.category !== policy.category || next.productId !== policy.productId || next.currency !== policy.currency) throw new FinancialError('immutable policy identity or commencement was modified', 500);
  }
}

export class PostgresFinancialStore implements FinancialStore {
  constructor(private readonly pool: SqlPool & { end?: () => Promise<void> }, private readonly hooks: { beforeCommit?: FaultInjector } = {}) {}
  async command(input: { scope: string; key: string; request: unknown; at: string; actor: string }, operation: (book: FinancialBook) => unknown): Promise<FinancialStoreResult> {
    if (!/^[A-Za-z0-9_.:@/ -]{1,300}$/.test(input.scope) || !/^[A-Za-z0-9_.:-]{8,200}$/.test(input.key)) throw new FinancialError('a valid principal scope and durable Idempotency-Key (8–200 characters) are required', 400);
    const db = await this.pool.connect(); let destroy = false;
    try {
      await db.exec('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Transaction-level row lock, never a process-local mutex or session advisory lock.
      const stateResult = await db.query<StateRow>('SELECT version, environment, payload, fingerprint FROM financial_private.state WHERE singleton = 1 FOR UPDATE');
      const row = stateResult.rows[0];
      if (!row) throw new FinancialError('financial book has not be initialized by the explicit migration/setup procedure', 503);
      const requestHash = hash(input.request);
      const prior = await db.query<CommandRow>('SELECT request_hash, status, result, state_version FROM financial_private.commands WHERE scope = $1 AND key = $2', [input.scope, input.key]);
      const previous = prior.rows[0];
      if (previous) {
        await db.exec('COMMIT');
        if (previous.request_hash !== requestHash) return { result: { status: 409, body: { error: 'idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' } }, replayed: false, version: Number(previous.state_version) };
        return { result: { status: previous.status, body: typeof previous.result === 'string' ? fromJson(previous.result) : fromJson(JSON.stringify(previous.result)) }, replayed: true, version: Number(previous.state_version) };
      }
      const encoded = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const state = (typeof encoded === 'string' ? fromJson<FinancialState>(encoded) : fromJson<FinancialState>(JSON.stringify(encoded)));
      if (state.schemaVersion !== 1 || state.environment !== row.environment || hash(encoded) !== row.fingerprint) throw new FinancialError('financial state envelope failed integrity verification', 500);
      const currentProof = reconcileFinancialState(state);
      if (!currentProof.ok) throw new FinancialError('stored financial book does not reconcile; mutations are stopped', 503, 'RECONCILIATION_REQUIRED');
      const commandId = hash({ scope: input.scope, key: input.key });
      const executed = FinancialBook.execute(state, { id: `CMD-${commandId}`, actor: input.actor, at: input.at }, operation);
      assertAppendOnly(state, executed.state);
      const version = Number(row.version) + 1;
      const payload = toJson(executed.state);
      await db.query('UPDATE financial_private.state SET version = $1, payload = $2::jsonb, fingerprint = $3, updated_at = transaction_timestamp() WHERE singleton = 1 AND version = $4', [version, payload, hash(JSON.parse(payload)), row.version]);
      await db.query('INSERT INTO financial_private.commands (scope, key, command_id, request_hash, status, result, state_version, at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)', [input.scope, input.key, commandId, requestHash, executed.result.status, toJson(executed.result.body), version, input.at]);
      this.hooks.beforeCommit?.('configuration', 1);
      await db.exec('COMMIT');
      return { result: executed.result, replayed: false, version };
    } catch (error) {
      // A clean domain refusal rolls back and returns the connection to the pool. Only an
      // uncertain/failed ROLLBACK (lost connection, ambiguous commit) destroys it.
      try { await db.exec('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { db.release(destroy); }
  }
  async read(): Promise<{ state: FinancialState; version: number }> {
    const db = await this.pool.connect();
    try {
      await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows } = await db.query<StateRow>('SELECT version, environment, payload, fingerprint FROM financial_private.state WHERE singleton = 1');
      const row = rows[0]; if (!row) throw new FinancialError('financial book is not initialized', 503);
      const encoded = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (hash(encoded) !== row.fingerprint) throw new FinancialError('financial state fingerprint mismatch', 500);
      const state = (typeof encoded === 'string' ? fromJson<FinancialState>(encoded) : fromJson<FinancialState>(JSON.stringify(encoded)));
      if (state.environment !== row.environment || !reconcileFinancialState(state).ok) throw new FinancialError('financial book does not reconcile', 503);
      await db.exec('COMMIT'); db.release(); return { state, version: Number(row.version) };
    } catch (error) { let destroy = false; try { await db.exec('ROLLBACK'); } catch { destroy = true; } db.release(destroy); throw error; }
  }
  async close(): Promise<void> { await this.pool.end?.(); }
}

/** Explicit setup only. Never seeds live rules, policies, NAVs or approvals. */
export async function initializeFinancialBook(db: SqlConnection, environment: 'live' | 'demo'): Promise<void> {
  await db.exec('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', ['721031584225']);
    const state = emptyFinancialState(environment); const payload = toJson(state);
    const inserted = await db.query('INSERT INTO financial_private.state (singleton, version, environment, payload, fingerprint) VALUES (1, 0, $1, $2::jsonb, $3) ON CONFLICT DO NOTHING RETURNING singleton', [environment, payload, hash(JSON.parse(payload))]);
    await db.exec('COMMIT');
    if (!inserted.rows.length) throw new FinancialError('financial book already exists; refusing to overwrite it');
  } catch (error) { try { await db.exec('ROLLBACK'); } catch { /* caller discards */ } throw error; }
}
