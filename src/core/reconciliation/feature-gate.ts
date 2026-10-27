export interface ReconciliationFeatureGateState {
  readonly requested: boolean;
  readonly enabled: boolean;
  readonly financialCalculationsEnabled: false;
  readonly mode: 'non_financial_foundation' | 'disabled';
  readonly reason: 'non_financial_foundation_unlocked' | 'disabled_by_environment';
}

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);
const ENABLED_VALUES = new Set(['true', '1', 'on', 'yes']);

/**
 * Evaluates availability of the non-financial reconciliation foundation.
 *
 * The non-financial foundation (insurer-owned channel/sub-channel reference types,
 * partner hierarchy ownership metadata, identity-only column mapping proposals with
 * explicit human confirmation, and deterministic scoped policy identity matching) is
 * unlocked by default unless disabled via PARTNER_COMMISSION_RECONCILIATION_ENABLED=false.
 *
 * Financial commission, free-look, clawback, payable statement and AP payment
 * calculations remain unconditionally disabled until insurer business rules and
 * release gates are approved.
 */
export function reconciliationFeatureGate(
  environment: Readonly<Record<string, string | undefined>> = {},
): ReconciliationFeatureGateState {
  const raw = environment.PARTNER_COMMISSION_RECONCILIATION_ENABLED?.trim().toLowerCase();
  const requested = raw !== undefined && ENABLED_VALUES.has(raw);
  if (raw !== undefined && DISABLED_VALUES.has(raw)) {
    return {
      requested: false,
      enabled: false,
      financialCalculationsEnabled: false,
      mode: 'disabled',
      reason: 'disabled_by_environment',
    };
  }
  return {
    requested,
    enabled: true,
    financialCalculationsEnabled: false,
    mode: 'non_financial_foundation',
    reason: 'non_financial_foundation_unlocked',
  };
}
