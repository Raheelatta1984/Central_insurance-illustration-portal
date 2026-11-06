import { describe, expect, it } from 'vitest';
import { createRuntimeState } from './routes.js';

describe('policy distribution attribution', () => {
  it('backfills only an exact recorded journey link, keeps the old ID and audits the source', () => {
    const { world } = createRuntimeState();
    const policy = world.erp.getPolicy('UL-000123')!;
    const journey = world.journey.open(world);
    journey.artefacts = { policyId: policy.policyId, applicationId: policy.applicationId };
    journey.distribution = { channelCode: 'BROKER', subChannelCode: null, partnerId: 'BROKER-1' };
    const result = world.erp.backfillPolicyDistribution(world, { by: 'ops', at: '2026-10-05T12:00:00Z' });
    expect(result.updated).toEqual(['UL-000123']);
    expect(result.unknown).toContain('MTR-0441');
    expect(policy.distribution).toEqual({ ...journey.distribution, sourceJourneyCaseId: journey.caseId });
    expect(policy.policyId).toBe('UL-000123');
    expect(world.erp.policyDistributionAudit()).toEqual([{ policyId: policy.policyId, sourceJourneyCaseId: journey.caseId, by: 'ops', at: '2026-10-05T12:00:00Z' }]);
    expect(world.erp.backfillPolicyDistribution(world, { by: 'ops', at: '2026-10-05T12:00:00Z' }).updated).toEqual([]);
    expect(world.erp.policyDistributionAudit()).toHaveLength(1);
  });
  it('flags conflicting links without inferring a value or overwriting any policy', () => {
    const { world } = createRuntimeState();
    const first = world.journey.open(world);
    const second = world.journey.open(world);
    first.artefacts = { policyId: 'UL-000123' };
    second.artefacts = { policyId: 'UL-000123' };
    first.distribution = { channelCode: 'BROKER', subChannelCode: null, partnerId: 'A' };
    second.distribution = { channelCode: 'BROKER', subChannelCode: null, partnerId: 'B' };
    expect(world.erp.backfillPolicyDistribution(world, { by: 'ops', at: '2026-10-05T12:00:00Z' }).conflicts).toContain('UL-000123');
    expect(world.erp.getPolicy('UL-000123')?.distribution).toBeUndefined();
    expect(world.erp.policyDistributionAudit()).toEqual([]);
  });
});
