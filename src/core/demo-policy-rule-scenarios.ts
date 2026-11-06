/**
 * Illustrative, non-authoritative data for exercising policy rule resolution in tests or demos.
 * These rows are not approvals, are not installed in the rules engine, and must not be used for
 * financial postings. Rates are copied from the existing unit-linked demo schedule; no scoped
 * override is invented. Policy distribution is deliberately synthetic and not a legacy backfill.
 */
import { DEFAULT_CHARGES } from './unitlinked.js';
import type { ChargeRuleKind, ChargeScope, FiledChargeRule } from './charge-rule-resolution.js';

export interface DemoChargeRule extends FiledChargeRule {
  readonly status: 'illustrative-unapproved';
  readonly source: 'DEFAULT_CHARGES';
  readonly calculation: string;
}

export const DEMO_POLICY_SCOPE: ChargeScope = Object.freeze({
  category: 'unit-linked', productId: 'DEMO-PRODUCT', channelCode: 'DEMO-CHANNEL',
  subChannelCode: null, partnerId: null,
});

export function demoPolicyRules(): ReadonlyArray<DemoChargeRule> {
  const common = { scope: 'global' as const, enabled: false, status: 'illustrative-unapproved' as const, source: 'DEFAULT_CHARGES' as const };
  const make = (kind: ChargeRuleKind, calculation: string): DemoChargeRule => ({ ...common, id: `DEMO-GLOBAL-${kind.toUpperCase()}`, kind, calculation });
  return [
    make('allocation', `${DEFAULT_CHARGES.allocationChargeBps} basis points of gross premium`),
    make('administration', `${DEFAULT_CHARGES.adminFeeMonthlyMinor} minor currency units monthly (illustrative 2-decimal currency)`),
    make('mortality', `${DEFAULT_CHARGES.coiPerMilleMonthly} per 1,000 of sum assured monthly`),
  ];
}
