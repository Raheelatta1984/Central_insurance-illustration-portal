import { describe, expect, it } from 'vitest';
import { SuperFundsRegistry } from './super-funds.js';

describe('super funds investment policy administration', () => {
  it('files accumulation, pension and TTR products with eligible funds and currency', () => {
    const registry = new SuperFundsRegistry();
    registry.bootstrapDefaults();
    expect(registry.listProducts().map(p => p.variant)).toEqual(['accumulation', 'pension', 'transition-to-retirement']);
    expect(registry.listProducts().every(p => p.currency === 'AUD')).toBe(true);
    expect(() => registry.createMemberPolicy({ partyId: 'P-1', productId: 'PROD-SUPER-ACCUM', fundId: 'SUPER-CONSERV' })).toThrow(/not in/);
  });

  it('runs monthly processing once per member and separates currencies', () => {
    const registry = new SuperFundsRegistry();
    registry.bootstrapDefaults();
    const runs = registry.runMonthlyCharges({ at: '2026-10-05T10:00:00Z' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.currency).toBe('AUD');
    expect(runs[0]?.policyCharges).toHaveLength(2);
    expect(runs[0]?.totalChargedMinor).toBeGreaterThan(0n);
    expect(registry.listPolicies().every(p => p.lastChargeAt === '2026-10-05T10:00:00Z')).toBe(true);
    expect(() => registry.runMonthlyCharges({ at: '2026-10-24T10:00:00Z' })).toThrow(/already ran/);

    registry.upsertProduct({ productId: 'PROD-SUPER-AED', name: 'UAE Super Balance', currency: 'AED', defaultFunds: ['SUPER-BAL'] });
    registry.createMemberPolicy({ policyId: 'SUPER-AED-1', partyId: 'PTY-AED', productId: 'PROD-SUPER-AED', fundId: 'SUPER-BAL', currency: 'AED', initialContribution: '5000' });
    const nextMonth = registry.runMonthlyCharges({ at: '2026-11-05T10:00:00Z' });
    expect(nextMonth.map(r => r.currency).sort()).toEqual(['AED', 'AUD']);
  });

  it('allocates investment gains/losses exactly by balance through premium post-adjustment', () => {
    const registry = new SuperFundsRegistry();
    registry.bootstrapDefaults();
    registry.createMemberPolicy({ policyId: 'SUPER-000003', partyId: 'PTY-0003', productId: 'PROD-SUPER-ACCUM', fundId: 'SUPER-BAL', initialContribution: '10000', currency: 'AUD' });
    const before = registry.listPolicies().filter(p => p.fundId === 'SUPER-BAL').reduce((n, p) => n + p.balanceMinor, 0n);
    const gain = registry.allocateIncome({ fundId: 'SUPER-BAL', period: '2026-10', gainAmount: '0.05', currency: 'AUD' });
    expect(gain.method).toBe('premium-post-adjustment');
    expect(gain.allocatedMinor).toBe(5n);
    expect(gain.policyAllocations.reduce((n, p) => n + p.amountMinor, 0n)).toBe(5n);
    expect(registry.listPolicies().filter(p => p.fundId === 'SUPER-BAL').reduce((n, p) => n + p.balanceMinor, 0n)).toBe(before + 5n);
    expect(() => registry.allocateIncome({ fundId: 'SUPER-BAL', period: '2026-10', gainAmount: '1.00', currency: 'AUD' })).toThrow(/already allocated/);
    expect(() => registry.allocateIncome({ fundId: 'SUPER-BAL', period: '2026-11', gainAmount: '-999999999.00', currency: 'AUD' })).toThrow(/cannot exceed/);
  });

  it('refuses negative contributions and a monthly charge with no active policies', () => {
    const registry = new SuperFundsRegistry();
    registry.bootstrapDefaults();
    expect(() => registry.createMemberPolicy({ partyId: 'P-1', productId: 'PROD-SUPER-ACCUM', initialContribution: '-1' })).toThrow(/cannot be negative/);
    expect(() => registry.runMonthlyCharges({ policyIds: ['UNKNOWN'], at: '2026-10-01' })).toThrow(/no active/);
  });
});
