/**
 * Stop high-level deduction entry points until charge rules are filed and resolved for the
 * policy's full product and distribution scope. The current distribution registry contains
 * mortality uplifts, not a complete, versioned administration/COI charge schedule. Neither a
 * caller-supplied amount nor a global schedule is a substitute for that missing configuration.
 * This guard does not cover the low-level demo transaction engine or other financial paths.
 */
export class MissingPolicyChargeRulesError extends Error {}

export function requirePolicyChargeRules(policyId: string): void {
  throw new MissingPolicyChargeRulesError(`${policyId}: policy-specific charge rules are not available; deduction blocked`);
}
