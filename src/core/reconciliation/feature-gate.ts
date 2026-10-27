/**
 * This slice is inert even if an operator requests the flag. No route or workflow
 * consumes it yet. Replace this unconditional release lock only after the documented
 * migration, identity, finance, security, privacy and payment gates are complete.
 */
export function reconciliationFeatureGate(environment: Readonly<Record<string, string | undefined>>): {
  readonly requested: boolean;
  readonly enabled: false;
  readonly reason: 'release_prerequisites_incomplete';
} {
  const requested = environment.PARTNER_COMMISSION_RECONCILIATION_ENABLED?.trim().toLowerCase() === 'true';
  return { requested, enabled: false, reason: 'release_prerequisites_incomplete' };
}
