import { describe, expect, it } from 'vitest';
import { FinancialBook, reconcileFinancialState, type FinancialLeg } from './book.js';
import { demoFinancialFixture, demoPayment, demoPolicyId } from './demo-fixture.js';
import { FinancialInProgressError, type FinancialState } from './model.js';
import { financialStatement } from './statement.js';
import { unitsForAmount, type Price } from '../units.js';
import { money } from '../money.js';
import { evidenceDigest } from '../policy-distribution.js';

const price: Price = { micro: 1_000_000_000n, currency: 'AED' };
function execute(state: FinancialState, fn: (b: FinancialBook) => unknown, fault?: (leg: FinancialLeg, n: number) => void) {
  return FinancialBook.execute(state, { id: `TEST-${state.transactions.length}-${state.configurationRequests.length}-${Math.random()}`, actor: 'test-officer', at: '2026-11-06T09:00:00Z', ...(fault ? { fault } : {}) }, fn);
}
function invested() {
  const state = demoFinancialFixture(); const policyId = demoPolicyId(state);
  return execute(state, (b) => b.invest({ policyId, kind: 'allocation', amountMinor: '100000', at: '2026-11-06T08:00:00Z', evidence: demoPayment(policyId, '100000') }, true));
}
describe('staged financial book', () => {
  it('issues a distribution-complete ID and conserves gross cash across charge, units and residual journals', () => {
    const { state, result } = invested(); const id = demoPolicyId(state);
    expect(id).toBe('UNIT_LINKED-DEMO_CHANNEL-NA-NA-00000001');
    expect(result.status).toBe(200);
    expect(state.holdings[0]!.units).toBe(unitsForAmount(money(95000n, 'AED'), price, 'floor').toString());
    expect(state.receipts[0]).toMatchObject({ amountMinor: '100000', feeMinor: '5000', netMinor: '95000' });
    expect(reconcileFinancialState(state).ok).toBe(true);
    const view = financialStatement(state, id, '2026-11-06T09:00:00Z');
    expect(view.summary.grossReceived).toBe('1,000.00 AED');
    expect(view.summary.closingValue).toBe('950.00 AED');
    expect(view.recommendation.available).toBe(false);
  });
  it.each(['policy', 'units', 'receipt', 'journal', 'alteration'] as FinancialLeg[])('rolls back every allocation leg on injected %s failure', (leg) => {
    const before = demoFinancialFixture(); const id = demoPolicyId(before); const original = JSON.stringify(before);
    expect(() => execute(before, (b) => b.invest({ policyId: id, kind: 'allocation', amountMinor: '100000', at: '2026-11-06T08:00:00Z', evidence: demoPayment(id, '100000') }, true), (failed) => { if (failed === leg) throw new FinancialInProgressError(); })).toThrow(FinancialInProgressError);
    expect(JSON.stringify(before)).toBe(original);
  });
  it('refuses a second command that attempts to spend the same provider payment', () => {
    const first = invested();
    expect(() => execute(first.state, (b) => b.invest({ policyId: demoPolicyId(first.state), kind: 'topup', amountMinor: '100000', at: '2026-11-06T08:00:00Z', evidence: demoPayment(demoPolicyId(first.state), '100000') }, true))).toThrow(/already receipted/);
  });
  it('rolls back servicing units, journals and status on a late failure', () => {
    const before = invested().state; const original = JSON.stringify(before);
    expect(() => execute(before, (b) => b.settle({ policyId: demoPolicyId(before), kind: 'surrender', at: '2026-11-06T09:00:00Z' }), (leg) => { if (leg === 'alteration') throw new FinancialInProgressError(); })).toThrow(FinancialInProgressError);
    expect(JSON.stringify(before)).toBe(original);
  });
  it('grosses up a withdrawal for its fee and records a payable, never a bank payment', () => {
    const before = invested().state;
    const { state, result } = execute(before, (b) => b.settle({ policyId: demoPolicyId(before), kind: 'withdrawal', fundId: 'DEMO-FUND', amountMinor: '10000', at: '2026-11-06T09:00:00Z' }));
    expect(result.body).toMatchObject({ status: 'payable-recorded', payableMinor: '10000' });
    expect(reconcileFinancialState(state).ok).toBe(true);
    expect(state.transactions.at(-1)).toMatchObject({ chargeMinor: '256' });
  });
  it('requires a real second-person approval and preserves filed rule versions', () => {
    const state = demoFinancialFixture();
    const rule = { id: 'NEW', kind: 'allocation' as const, scope: 'global' as const, globalFallback: true, basis: 'gross-bps' as const, rate: '100', amountMinor: null, currency: 'AED', effectiveFrom: '2026-12-01', effectiveTo: null, sourceReference: 'TEST-EVIDENCE' };
    const proposed = execute(state, (b) => b.proposeRule(rule)).state;
    expect(() => execute(proposed, (b) => b.approveRule({ ruleId: 'NEW', version: 1, reference: 'x', designatedApprover: 'test-officer' }))).toThrow(/self-approval refused/);
    const approved = FinancialBook.execute(proposed, { id: 'APPROVE', actor: 'named-approver', at: '2026-11-06T09:00:00Z' }, (b) => b.approveRule({ ruleId: 'NEW', version: 1, reference: 'test-approval', designatedApprover: 'named-approver' })).state;
    expect(approved.rules.find((r) => r.id === 'NEW')?.approval?.by).toBe('named-approver');
    expect(reconcileFinancialState(approved).ok).toBe(true);
  });
  it('blocks missing configuration with a durable P1 request and suggestion, then retries after approval', () => {
    const state = demoFinancialFixture(); state.rules = state.rules.filter((r) => r.kind !== 'allocation'); const id = demoPolicyId(state);
    const blocked = execute(state, (b) => b.invest({ policyId: id, kind: 'allocation', amountMinor: '100000', at: '2026-11-06T08:00:00Z', evidence: demoPayment(id, '100000') }, true));
    expect(blocked.result.status).toBe(409);
    expect(blocked.state.transactions).toHaveLength(0);
    expect(blocked.state.configurationRequests[0]).toMatchObject({ priority: 'P1', status: 'open', suggestedConfiguration: { kind: 'allocation', rate: null, approval: null } });
    const retry = execute(blocked.state, (b) => b.invest({ policyId: id, kind: 'allocation', amountMinor: '100000', at: '2026-11-06T08:00:00Z', evidence: demoPayment(id, '100000') }, true));
    expect(retry.state.configurationRequests).toHaveLength(1);
  });
  it('processes each monthly rule once, including leap/month-end catch-up, and persists blocked cycles', () => {
    let state = demoFinancialFixture(); const id = demoPolicyId(state);
    state = execute(state, (b) => b.invest({ policyId: id, kind: 'allocation', amountMinor: '10000000', at: '2025-02-01T08:00:00Z', evidence: demoPayment(id, '10000000', 'FUNDING') }, true)).state;
    state.rules = state.rules.filter((r) => r.kind !== 'mortality');
    const first = execute(state, (b) => b.runMonthly({ policyId: id, through: '2025-03-31', fundId: 'DEMO-FUND' }));
    expect((first.result.body as { posted: Array<{cycle:string;kind:string}> }).posted.map((x) => `${x.cycle}:${x.kind}`)).toEqual(['2025-02:administration', '2025-03:administration']);
    expect((first.result.body as { blocked: Array<{cycle:string;kind:string}> }).blocked.map((x) => `${x.cycle}:${x.kind}`)).toEqual(['2025-02:mortality', '2025-03:mortality']);
    expect(first.state.cycles.filter((c) => c.status === 'posted')).toHaveLength(2);
    const again = execute(first.state, (b) => b.runMonthly({ policyId: id, through: '2025-03-31', fundId: 'DEMO-FUND' }));
    expect(again.result.body).toMatchObject({ skipped: 2 });
    expect((again.result.body as { blocked: unknown[] }).blocked).toHaveLength(2);
    expect(again.state.transactions).toHaveLength(first.state.transactions.length);
    expect(reconcileFinancialState(again.state).ok).toBe(true);
  });
  it('never guesses distribution and accepts only exact-link source evidence', () => {
    let state = demoFinancialFixture(); const id = demoPolicyId(state); Object.assign(state.policies[0]!, { distribution: null });
    const missing = execute(state, (b) => b.backfillDistribution({ policyId: id, evidence: [], sourceRecords: [] }));
    expect(missing.result.status).toBe(409); expect(missing.state.distributionFlags[0]!.reason).toBe('missing-evidence');
    const record = { policyId: id, distribution: { channelCode: 'BANK', subChannelCode: 'NA', partnerId: 'PARTNER' } };
    const evidence = [{ sourcePolicyId: id, sourceRecordId: 'SRC-1', sourceDigest: '0'.repeat(64), ...record.distribution }];
    expect(() => execute(state, (b) => b.backfillDistribution({ policyId: id, evidence, sourceRecords: [record] }))).toThrow(/digest/);
    evidence[0]!.sourceDigest = evidenceDigest(record);
    state = execute(state, (b) => b.backfillDistribution({ policyId: id, evidence, sourceRecords: [record] })).state;
    expect(state.policies[0]!.policyId).toBe(id);
    expect(state.policies[0]!.distribution).toEqual(record.distribution);
    expect(state.backfillAudit).toHaveLength(1);
  });
  it('detects tampered holdings and unbalanced journals rather than reporting healthy', () => {
    const state = invested().state; state.holdings[0]!.units = '1';
    expect(reconcileFinancialState(state).ok).toBe(false);
    const other = invested().state; other.journals[0]!.lines[0]!.amountMinor = '1';
    expect(reconcileFinancialState(other).checks.some((c) => c.name === 'journals-balanced' && !c.ok)).toBe(true);
  });
  it('shows a recorded distinct recommendation for five seconds only', () => {
    const state = invested().state; const id = demoPolicyId(state);
    Object.assign(state.policies[0]!, { recommendation: { id: 'REC-1', recordedAt: '2026-11-06T08:00:00Z', source: 'test', funds: [{ fundId: 'OTHER', weightBps: 10000 }] } });
    expect(financialStatement(state, id, '2026-11-06T09:00:00Z').recommendation).toMatchObject({ available: true, displaySeconds: 5 });
    Object.assign(state.policies[0]!.recommendation!, { funds: [{ fundId: 'DEMO-FUND', weightBps: 10000 }] });
    expect(financialStatement(state, id, '2026-11-06T09:00:00Z').recommendation).toMatchObject({ available: false, displaySeconds: 0 });
  });
});
