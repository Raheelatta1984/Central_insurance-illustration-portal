/**
 * Stop high-level deduction entry points until charge rules are filed and resolved for the
 * policy's full product and distribution scope, or an explicitly configured global fallback.
 * The current registry does not yet resolve a complete, approved charge schedule with that
 * precedence. The engine's demo defaults are not evidence of a filed global rule, and caller
 * amounts are not configuration. This guard does not cover low-level or other financial paths.
 */
export class MissingPolicyChargeRulesError extends Error {}

export function requirePolicyChargeRules(policyId: string): void {
  throw new MissingPolicyChargeRulesError(`${policyId}: policy-specific charge rules are not available; deduction blocked`);
}
