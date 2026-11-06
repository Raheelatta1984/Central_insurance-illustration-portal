import { describe, expect, it } from 'vitest';
import { DEMO_POLICY_SCOPE, demoPolicyRules } from './demo-policy-rule-scenarios.js';
import { resolveChargeRule } from './charge-rule-resolution.js';
import { createRuntimeState } from './routes.js';
import { executeUnitLinkedDeduction } from './unitlinked-statement.js';

describe('illustrative policy rule fixtures', () => {
  it('copies the demo defaults but keeps all samples disabled and unapproved', () => {
    const rules = demoPolicyRules();
    expect(rules.map((r) => r.calculation)).toEqual([
      '500 basis points of gross premium',
      '2500 minor currency units monthly (illustrative 2-decimal currency)',
      '0.9 per 1,000 of sum assured monthly',
    ]);
    expect(rules.every((r) => !r.enabled && r.status === 'illustrative-unapproved' && r.source === 'DEFAULT_CHARGES')).toBe(true);
    for (const rule of rules) {
      expect(resolveChargeRule({ kind: rule.kind, scope: DEMO_POLICY_SCOPE, rules })).toMatchObject({ status: 'blocked', reason: 'missing-global', request: { priority: 'P1' } });
    }
  });
  it('does not backfill actual seed policies or enable deductions', () => {
    const { world } = createRuntimeState();
    expect(world.erp.getPolicy('UL-000123')?.distribution).toBeUndefined();
    expect(() => executeUnitLinkedDeduction(world, { policyId: 'UL-000123', deductionKind: 'admin' })).toThrow(/deduction blocked/);
  });
});
