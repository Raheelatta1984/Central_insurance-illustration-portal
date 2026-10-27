import { describe, expect, it } from 'vitest';
import { proposeIdentityColumns } from './column-mapping.js';
import { reconciliationFeatureGate } from './feature-gate.js';

describe('identity-only column suggestions', () => {
  it('suggests exact identity headers but never confirms or maps financial fields', () => {
    const result = proposeIdentityColumns(['Policy Number', 'Client Name', 'Insurer', 'Line of Business', 'Commission %', 'Amount']);
    expect(result.map((r) => [r.field, r.status, r.confirmed])).toEqual([
      ['policyNumber', 'suggested', false], ['insuredName', 'suggested', false],
      ['insurer', 'suggested', false], ['insuranceClass', 'suggested', false],
    ]);
    expect(result[0]!.candidates).toEqual([{ index: 0, header: 'Policy Number' }]);
    expect(proposeIdentityColumns(['reference', 'rate', 'amount']).every((r) => r.status === 'unmapped')).toBe(true);
  });

  it('reports duplicate/colliding headers as ambiguous rather than picking the first', () => {
    const result = proposeIdentityColumns(['POLICY NO', 'Policy Number', 'insured']);
    expect(result[0]).toMatchObject({ field: 'policyNumber', status: 'ambiguous', confirmed: false });
    expect(result[0]!.candidates.map((c) => c.index)).toEqual([0, 1]);
  });

  it('rejects oversized and malformed inputs', () => {
    expect(() => proposeIdentityColumns(['X'.repeat(501)])).toThrow('Invalid source header');
    expect(() => proposeIdentityColumns(Array.from({ length: 2001 }, () => 'X'))).toThrow('oversized');
  });
});

describe('unlocked non-financial reconciliation feature gate', () => {
  it('enables the non-financial foundation by default while keeping financial calculations locked', () => {
    expect(reconciliationFeatureGate({})).toEqual({
      requested: false,
      enabled: true,
      financialCalculationsEnabled: false,
      mode: 'non_financial_foundation',
      reason: 'non_financial_foundation_unlocked',
    });
    expect(reconciliationFeatureGate({ PARTNER_COMMISSION_RECONCILIATION_ENABLED: ' true ' })).toEqual({
      requested: true,
      enabled: true,
      financialCalculationsEnabled: false,
      mode: 'non_financial_foundation',
      reason: 'non_financial_foundation_unlocked',
    });
    expect(reconciliationFeatureGate({ PARTNER_COMMISSION_RECONCILIATION_ENABLED: 'false' })).toEqual({
      requested: false,
      enabled: false,
      financialCalculationsEnabled: false,
      mode: 'disabled',
      reason: 'disabled_by_environment',
    });
  });
});
