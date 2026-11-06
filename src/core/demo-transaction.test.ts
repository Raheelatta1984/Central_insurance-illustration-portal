/**
 * The demo financial boundary is copy-on-failure, not durable storage. These tests prove that a
 * failed simulated command leaves policy, unit, receipt, journal and round-up state untouched, so a
 * retry cannot inherit a half-applied demo mutation. They do not claim provider or crash safety.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { withDemoFinancialTransaction } from './demo-transaction.js';
import { toJson } from './persistence.js';

describe('demo financial transaction boundary', () => {
  it('restores every captured store when a simulated financial command fails late', async () => {
    const w = buildWorld();
    const before = toJson({
      policies: [...w.erp.snapshot(w).policies],
      journals: w.ledger.allJournals(),
      txns: w.unitLinked.transactions('UL-000123'),
      roundUp: w.roundUp.snapshot(w),
    });
    await expect(withDemoFinancialTransaction(w, () => {
      w.erp.receivePremium(w, { policyId: 'UL-000123', amount: '100.00', at: '2026-10-05T10:00:00+04:00', by: 'test' });
      throw new Error('simulated late failure');
    })).rejects.toThrow('simulated late failure');
    const after = toJson({
      policies: [...w.erp.snapshot(w).policies],
      journals: w.ledger.allJournals(),
      txns: w.unitLinked.transactions('UL-000123'),
      roundUp: w.roundUp.snapshot(w),
    });
    expect(after).toBe(before);
  });
  it('keeps a successful simulated command and does not roll it back', async () => {
    const w = buildWorld();
    const before = w.unitLinked.transactions('UL-000123').length;
    await withDemoFinancialTransaction(w, () => {
      w.erp.receivePremium(w, { policyId: 'UL-000123', amount: '100.00', at: '2026-10-05T10:00:00+04:00', by: 'test' });
    });
    expect(w.unitLinked.transactions('UL-000123').length).toBeGreaterThan(before);
  });
});
