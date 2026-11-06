import { describe, expect, it } from 'vitest';
import { createRuntimeState } from './routes.js';
import { executeUnitLinkedDeduction } from './unitlinked-statement.js';

describe('policy-specific deduction gate', () => {
  it('blocks both deduction paths, including caller amount overrides, without a transaction or alteration', () => {
    const { world } = createRuntimeState();
    const policyId = 'UL-000123';
    const beforeTransactions = world.unitLinked.transactions(policyId).length;
    const beforeAlterations = world.erp.snapshot(world).alterations.length;
    for (const deductionKind of ['coi', 'admin', 'monthly-cycle'] as const) {
      expect(() => executeUnitLinkedDeduction(world, { policyId, deductionKind, amount: '1.00' })).toThrow(/policy-specific charge rules.*deduction blocked/);
    }
    for (const chargeCode of ['coi', 'admin'] as const) {
      expect(() => world.erp.alterPolicyFinancial(world, { policyId, kind: 'policy-charge', chargeCode, amount: '1.00' })).toThrow(/policy-specific charge rules.*deduction blocked/);
    }
    expect(world.unitLinked.transactions(policyId)).toHaveLength(beforeTransactions);
    expect(world.erp.snapshot(world).alterations).toHaveLength(beforeAlterations);
  });
});
