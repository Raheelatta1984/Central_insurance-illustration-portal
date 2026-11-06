import { describe, expect, it, vi } from 'vitest';
import { buildWorld } from './demo.js';
import { money } from './money.js';
import { buildUnitLinkedStatement, executeUnitLinkedInvestmentPayment, splitMoneyByWeights, validateBpsWeights } from './unitlinked-statement.js';

describe('unit-linked statement and allocations', () => {
  it('allocates every minor unit and rejects invalid weights', () => {
    const weights = [{ fundId: 'A', bps: 7000 }, { fundId: 'B', bps: 3000 }];
    const legs = splitMoneyByWeights(money(101n, 'AED'), weights);
    expect(legs.reduce((sum, leg) => sum + leg.amount.minor, 0n)).toBe(101n);
    expect(validateBpsWeights([{ fundId: 'A', bps: 5000 }, { fundId: 'A', bps: 5000 }]).valid).toBe(false);
    expect(() => splitMoneyByWeights(money(101n, 'AED'), [{ fundId: 'A', bps: 2000 }])).toThrow();
  });

  it('checks every fund price before any policy changes or payment legs', () => {
    const world = buildWorld();
    const policy = world.erp.getPolicy('UL-000123')!;
    const before = { frequency: policy.paymentFrequency, targets: policy.targetWeights, journals: world.ledger.allJournals().length, txns: world.unitLinked.transactions(policy.policyId).length, alterations: world.erp.snapshot(world).alterations.length };
    const priceAt = world.nav.priceAt.bind(world.nav);
    vi.spyOn(world.nav, 'priceAt').mockImplementation((fundId, date) => {
      if (fundId === 'FBAL') throw new Error('missing second fund NAV');
      return priceAt(fundId, date);
    });
    expect(() => executeUnitLinkedInvestmentPayment(world, {
      policyId: policy.policyId, paymentKind: 'ad-hoc-topup', amount: '100.00', at: '2026-10-05T11:15:00+04:00',
      billingFrequency: 'quarterly', updatePolicyFrequency: true, saveAsStandingAllocations: true,
      allocations: [{ fundId: 'FGLOBAL', weightBps: 5000 }, { fundId: 'FBAL', weightBps: 5000 }],
    })).toThrow('missing second fund NAV');
    expect(policy.paymentFrequency).toBe(before.frequency);
    expect(policy.targetWeights).toEqual(before.targets);
    expect(world.ledger.allJournals()).toHaveLength(before.journals);
    expect(world.unitLinked.transactions(policy.policyId)).toHaveLength(before.txns);
    vi.restoreAllMocks();
    expect(world.erp.snapshot(world).alterations).toHaveLength(before.alterations);
  });

  it('rejects a zero payment without changing frequency', () => {
    const world = buildWorld();
    const policy = world.erp.getPolicy('UL-000123')!;
    const frequency = policy.paymentFrequency;
    expect(() => executeUnitLinkedInvestmentPayment(world, { policyId: policy.policyId, paymentKind: 'ad-hoc-topup', amount: '0', billingFrequency: 'annual', updatePolicyFrequency: true })).toThrow(/greater than zero/);
    expect(policy.paymentFrequency).toBe(frequency);
  });

  it('builds a reproducible statement for the seeded unit-linked policy', () => {
    const world = buildWorld();
    const statement = buildUnitLinkedStatement(world, 'UL-000123');
    expect(statement.policyId).toBe('UL-000123');
    expect(world.unitLinked.reproduce('UL-000123').ok).toBe(true);
    const times = statement.lines.map((line) => Date.parse(line.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(statement.recommendedFunds).toEqual([{ fundId: 'FGLOBAL', fundName: expect.any(String), weightPct: '60.00%' }, { fundId: 'FBAL', fundName: expect.any(String), weightPct: '40.00%' }]);
    expect(statement.fundHistory[0]).toMatchObject({ date: '2026-09-29', daysSinceCommencement: 0 });
    expect(statement.fundHistory.at(-1)?.funds.map((fund) => fund.fundId).sort()).toEqual(['FBAL', 'FGLOBAL']);
    expect(() => buildUnitLinkedStatement(world, 'MTR-0441')).toThrow();
  });
});
