/** Distribution attribution is evidence, never a guess from a policy number or a transaction. */
import { fingerprintOf } from './persistence.js';

export const NOT_APPLICABLE = 'NA';
export interface PolicyDistribution {
  readonly channelCode: string;
  /** null means unknown; NA means explicitly recorded as not applicable. */
  readonly subChannelCode: string | null;
  readonly partnerId: string | null;
}
export interface DistributionEvidence extends PolicyDistribution {
  readonly sourceRecordId: string;
  readonly sourceDigest: string;
  readonly sourcePolicyId: string;
}
export class PolicyDistributionError extends Error {}
const token = (value: string | null, field: string, allowUnknown = false): string | null => {
  if (value === null && allowUnknown) return null;
  if (typeof value !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(value)) {
    throw new PolicyDistributionError(`${field} must be an uppercase identifier or explicit NA${allowUnknown ? '/null' : ''}`);
  }
  return value;
};
export function validateDistribution(input: PolicyDistribution): PolicyDistribution {
  return Object.freeze({
    channelCode: token(input.channelCode, 'channelCode')!,
    subChannelCode: token(input.subChannelCode, 'subChannelCode', true),
    partnerId: token(input.partnerId, 'partnerId', true),
  });
}
export function distributionComplete(input: Partial<PolicyDistribution> | null | undefined): input is PolicyDistribution {
  return !!input && input.channelCode !== undefined && input.subChannelCode !== undefined && input.partnerId !== undefined;
}
export function sameDistribution(a: PolicyDistribution, b: PolicyDistribution): boolean {
  return a.channelCode === b.channelCode && a.subChannelCode === b.subChannelCode && a.partnerId === b.partnerId;
}
export function validateEvidence(policyId: string, evidence: DistributionEvidence): DistributionEvidence {
  validateDistribution(evidence);
  if (evidence.sourcePolicyId !== policyId || !evidence.sourceRecordId.trim() || !/^[a-f0-9]{64}$/.test(evidence.sourceDigest)) {
    throw new PolicyDistributionError('backfill requires an exact policy link, source record id and SHA-256 source digest');
  }
  if (!distributionComplete(evidence)) throw new PolicyDistributionError('source distribution is incomplete');
  return evidence;
}
export function evidenceDigest(record: unknown): string { return fingerprintOf(record); }

/** Only newly generated IDs use this format. Legacy IDs are immutable. */
export function formatPolicyId(category: string, distribution: PolicyDistribution, sequence: bigint): string {
  validateDistribution(distribution);
  if (!distributionComplete(distribution) || distribution.subChannelCode === null || distribution.partnerId === null) {
    throw new PolicyDistributionError('unknown distribution cannot mint a policy ID');
  }
  if (!/^[A-Z0-9_-]{1,40}$/.test(category) || sequence <= 0n) throw new PolicyDistributionError('invalid policy ID category or sequence');
  return `${category}-${distribution.channelCode}-${distribution.subChannelCode}-${distribution.partnerId}-${sequence.toString().padStart(8, '0')}`;
}
export function distributionScopeKey(category: string, productId: string, d: PolicyDistribution): string {
  return fingerprintOf({ category, productId, ...d });
}
