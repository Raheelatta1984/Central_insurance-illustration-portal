import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { FinancialService } from '../../core/financial/service.js';
import { demoFinancialFixture, demoPayment, demoPolicyId } from '../../core/financial/demo-fixture.js';
import { FinancialError } from '../../core/financial/model.js';
import { toJson, fingerprintOf } from '../../core/persistence.js';
import type { SqlConnection, SqlPool } from '../reconciliation/sql.js';
import { PostgresFinancialStore, initializeFinancialBook } from './store.js';
import { runFinancialMigrations, type FinancialMigration } from './migrations.js';
import { startMonthlyScheduler } from './scheduler.js';

const migration: FinancialMigration = {
  version: '0001_book',
  up: await readFile(new URL('../../../migrations/financial/0001_book.up.sql', import.meta.url), 'utf8'),
  down: await readFile(new URL('../../../migrations/financial/0001_book.down.sql', import.meta.url), 'utf8'),
};
async function harness(): Promise<{ pool: SqlPool; db: SqlConnection; close(): Promise<void> }> {
  const pg = new PGlite(); let locked = false; const waiters: Array<() => void> = [];
  const connection = (): SqlConnection => ({
    async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) { return { rows: (await pg.query<T>(sql, [...params])).rows }; },
    async exec(sql) { await pg.exec(sql); },
    release() { const next = waiters.shift(); if (next) next(); else locked = false; },
  });
  return { db: connection(), pool: { async connect() { if (locked) await new Promise<void>((r) => waiters.push(r)); else locked = true; return connection(); } }, close: () => pg.close() };
}
const officer = { name: 'officer', roles: ['finance-officer', 'servicing-officer', 'finance-scheduler'] };
const admin = { name: 'Raheel Atta', roles: ['admin', 'configurator', 'financial-approver', 'data-migration-officer', 'fund-configuration'] };

describe('financial service boundary', () => {
  let h: Awaited<ReturnType<typeof harness>>; let store: PostgresFinancialStore; let service: FinancialService;
  beforeAll(async () => {
    h = await harness(); await runFinancialMigrations(h.db, [migration], 'up'); await initializeFinancialBook(h.db, 'demo');
    const fixture = demoFinancialFixture(); const encoded = JSON.parse(toJson(fixture));
    await h.db.query('UPDATE financial_private.state SET payload=$1::jsonb, fingerprint=$2 WHERE singleton=1', [toJson(fixture), fingerprintOf(encoded)]);
    store = new PostgresFinancialStore(h.pool);
    service = new FinancialService({ store, now: () => '2026-11-06T09:00:00Z', designatedApprover: 'Raheel Atta' });
  }, 60000);
  afterAll(async () => { await h?.close(); }, 60000);

  it('requires authenticated roles and a durable idempotency key before money moves', async () => {
    const id = demoPolicyId((await store.read()).state);
    await expect(service.dispatch({ name: 'partner', roles: ['partner:x'] }, 'GET', '/policies', new URLSearchParams(), {}, undefined)).rejects.toMatchObject({ status: 403 });
    await expect(service.dispatch({ name: 'reader', roles: ['claims-officer'] }, 'POST', '/payments', new URLSearchParams(), {}, 'service-key-0001')).rejects.toMatchObject({ status: 403 });
    await expect(service.dispatch(officer, 'POST', '/payments', new URLSearchParams(), { policyId: id }, undefined)).rejects.toMatchObject({ status: 400 });
    await expect(service.dispatch(officer, 'POST', '/payments', new URLSearchParams(), { policyId: id }, 'service-key-0001')).rejects.toMatchObject({ status: 503, code: 'PROVIDER_REQUIRED' });
    expect((await store.read()).state.transactions).toHaveLength(0);
  });
  it('replays the same principal/key and refuses a changed request', async () => {
    const id = demoPolicyId((await store.read()).state);
    const body = { fundId: 'SERVICE-NAV', date: '2026-11-06', priceMicro: '1000000000', currency: 'AED', sourceReference: 'SERVICE-TEST' };
    const first = await service.dispatch(admin, 'POST', '/nav', new URLSearchParams(), body, 'service-nav-key-0001');
    const replay = await service.dispatch(admin, 'POST', '/nav', new URLSearchParams(), body, 'service-nav-key-0001');
    expect(first.status).toBe(200); expect(replay.replayed).toBe(true); expect(replay.body).toEqual(first.body);
    const conflict = await service.dispatch(admin, 'POST', '/nav', new URLSearchParams(), { ...body, date: '2026-11-07' }, 'service-nav-key-0001');
    expect(conflict.status).toBe(409);
    expect((await store.read()).state.nav.filter((n) => n.fundId === 'SERVICE-NAV')).toHaveLength(1);
    expect(id).toBeTruthy();
  });
  it('refuses backfill without an authoritative source reader and never accepts caller-supplied approver identity', async () => {
    const id = demoPolicyId((await store.read()).state);
    await expect(service.dispatch(admin, 'POST', '/distribution/backfill', new URLSearchParams(), { policyId: id, sourceRecordIds: ['SRC-1'] }, 'service-backfill-key-1')).rejects.toMatchObject({ status: 503, code: 'SOURCE_REQUIRED' });
    const proposed = await service.dispatch(admin, 'POST', '/rules/propose', new URLSearchParams(), { id: 'SERVICE-RULE', kind: 'topup', scope: 'global', globalFallback: true, basis: 'gross-bps', rate: '100', amountMinor: null, currency: 'AED', effectiveFrom: '2026-12-01', effectiveTo: null, sourceReference: 'SERVICE-TEST', proposedBy: 'attacker' }, 'service-rule-key-0001');
    expect(proposed.status).toBe(200);
    const state = (await store.read()).state; const rule = state.rules.find((r) => r.id === 'SERVICE-RULE')!;
    expect(rule.proposedBy).toBe('Raheel Atta');
    await expect(service.dispatch(admin, 'POST', '/rules/approve', new URLSearchParams(), { ruleId: 'SERVICE-RULE', version: 1, reference: 'SELF', approvedBy: 'someone-else' }, 'service-approve-key-1')).rejects.toMatchObject({ status: 403 });
  });
  it('persists a second-person approval through the durable store and replays it without re-approving', async () => {
    // The configurator proposes; the designated human approver is a different authenticated principal.
    const proposer = { name: 'config-user', roles: ['configurator'] };
    const proposed = await service.dispatch(proposer, 'POST', '/rules/propose', new URLSearchParams(), { id: 'SERVICE-APPROVED-RULE', kind: 'topup', scope: 'global', globalFallback: true, basis: 'gross-bps', rate: '75', amountMinor: null, currency: 'AED', effectiveFrom: '2026-12-01', effectiveTo: null, sourceReference: 'SERVICE-APPROVAL-TEST' }, 'service-approved-propose-1');
    expect(proposed.status).toBe(200);
    const approvalBody = { ruleId: 'SERVICE-APPROVED-RULE', version: 1, reference: 'HUMAN-APPROVAL-REF-1' };
    const approved = await service.dispatch(admin, 'POST', '/rules/approve', new URLSearchParams(), approvalBody, 'service-approved-key-0001');
    expect(approved.status).toBe(200);
    const rule = (await store.read()).state.rules.find((r) => r.id === 'SERVICE-APPROVED-RULE')!;
    expect(rule).toMatchObject({ status: 'approved', proposedBy: 'config-user', approval: { by: 'Raheel Atta', reference: 'HUMAN-APPROVAL-REF-1' } });
    const replay = await service.dispatch(admin, 'POST', '/rules/approve', new URLSearchParams(), approvalBody, 'service-approved-key-0001');
    expect(replay.replayed).toBe(true); expect(replay.body).toEqual(approved.body);
    await expect(service.dispatch(admin, 'POST', '/rules/approve', new URLSearchParams(), approvalBody, 'service-approved-key-0002')).rejects.toMatchObject({ status: 409 });
  });
  it('reads statements, reconciliation and configuration requests without mutating', async () => {
    const id = demoPolicyId((await store.read()).state); const before = await store.read();
    const statement = await service.dispatch(officer, 'GET', '/statement', new URLSearchParams({ policyId: id }), {}, undefined);
    expect(statement.status).toBe(200); expect(statement.body).toMatchObject({ policyId: id, simulated: true, recommendation: { available: false } });
    const recon = await service.dispatch(officer, 'GET', '/reconciliation', new URLSearchParams(), {}, undefined);
    expect(recon.body).toMatchObject({ ok: true, simulated: true });
    const requests = await service.dispatch(officer, 'GET', '/configuration-requests', new URLSearchParams(), {}, undefined);
    expect(requests.status).toBe(200);
    expect((await store.read()).version).toBe(before.version);
  });
  it('scheduler catch-up is exactly once across repeated ticks and restarts', async () => {
    const fundingId = demoPolicyId((await store.read()).state);
    await store.command({ scope: 'officer:/payments', key: 'scheduler-funding-key-1', at: '2025-02-01T08:00:00Z', actor: 'officer', request: { policyId: fundingId } }, (b) => b.invest({ policyId: fundingId, kind: 'allocation', amountMinor: '10000000', at: '2025-02-01T08:00:00Z', evidence: { ...demoPayment(fundingId, '10000000', 'SCHEDULER-FUNDING'), verifiedAt: '2025-01-31T08:00:00Z' } }, true));
    const schedulerService = new FinancialService({ store, now: () => '2025-03-31T12:00:00Z' });
    const scheduler = startMonthlyScheduler(schedulerService, { intervalMs: 60_000, log: () => {}, now: () => '2025-03-31T12:00:00Z' });
    try {
      const first = await scheduler.tick(); const second = await scheduler.tick();
      expect(first.failed).toBe(0); expect(second.failed).toBe(0);
      const state = (await store.read()).state;
      expect(state.cycles.filter((c) => c.status === 'posted' && c.kind === 'mortality').map((c) => c.cycle)).toEqual(['2025-02', '2025-03']);
      const restarted = startMonthlyScheduler(schedulerService, { intervalMs: 60_000, log: () => {}, now: () => '2025-03-31T12:00:00Z' });
      try { await restarted.tick(); } finally { restarted.stop(); }
      expect((await store.read()).state.cycles.filter((c) => c.status === 'posted')).toHaveLength(4);
    } finally { scheduler.stop(); }
  });
  it('unknown financial paths fail closed', async () => {
    await expect(service.dispatch(admin, 'POST', '/not-a-route', new URLSearchParams(), {}, 'service-unknown-key-1')).rejects.toBeInstanceOf(FinancialError);
  });
});
