import { describe, expect, it } from 'vitest';
import { ReconciliationFoundationError, ReconciliationFoundationWorkspace } from './workspace.js';

describe('unlocked non-financial reconciliation workspace', () => {
  it('boots unlocked with seeded insurer hierarchy, confirmed sample identity mapping and non-financial run', () => {
    const ws = new ReconciliationFoundationWorkspace('2026-10-05T09:00:00Z');
    const snap = ws.snapshot();
    expect(snap.featureGate).toEqual({
      requested: false,
      enabled: true,
      financialCalculationsEnabled: false,
      mode: 'non_financial_foundation',
      reason: 'non_financial_foundation_unlocked',
    });
    expect(snap.mappings).toHaveLength(1);
    expect(snap.mappings[0]!.confirmed).toBe(true);
    expect(snap.mappings[0]!.ignoredNonIdentityHeaders.map((h) => h.header)).toEqual([
      'Gross Premium',
      'Commission %',
      'Net Payable',
    ]);
    expect(snap.runs).toHaveLength(1);
    expect(snap.runs[0]!.summary).toMatchObject({
      exactMatchCount: 1,
      safeVariantMatchCount: 1,
      quarantinedFindingCount: 1,
      pendingProposalCount: 1,
    });
  });

  it('adds insurer-owned channel and sub-channel types without schema/enum churn', () => {
    const ws = new ReconciliationFoundationWorkspace('2026-10-05T09:00:00Z');
    const channel = ws.addChannelType({
      insurerId: 'ALK-CONV',
      code: 'affinity-partner',
      name: 'Corporate Affinity Scheme',
      by: 'administration',
    });
    expect(channel).toEqual({
      insurerId: 'ALK-CONV',
      code: 'affinity-partner',
      name: 'Corporate Affinity Scheme',
    });

    const sub = ws.addChannelType({
      insurerId: 'ALK-CONV',
      parentChannelTypeCode: 'affinity-partner',
      code: 'airline-loyalty',
      name: 'Airline Loyalty Desk',
      by: 'administration',
    });
    expect(sub).toEqual({
      insurerId: 'ALK-CONV',
      channelTypeCode: 'affinity-partner',
      code: 'airline-loyalty',
      name: 'Airline Loyalty Desk',
    });
  });

  it('keeps header mapping unconfirmed until explicit human confirmation and rejects duplicate column assignments', () => {
    const ws = new ReconciliationFoundationWorkspace('2026-10-05T09:00:00Z');
    const proposed = ws.proposeMapping({
      insurerId: 'ALK-CONV',
      sourceLabel: 'BROKER-FEED.csv',
      headers: ['Policy No', 'Insured', 'Commission Amount', 'Payable Net'],
      by: 'ops-analyst',
    });
    expect(proposed.confirmed).toBe(false);
    expect(proposed.ignoredNonIdentityHeaders.map((h) => h.header)).toEqual(['Commission Amount', 'Payable Net']);

    expect(() =>
      ws.confirmMapping({
        mappingId: proposed.mappingId,
        assignments: { policyNumber: 0, insuredName: 0 },
        by: 'ops-analyst',
      }),
    ).toThrow(ReconciliationFoundationError);

    const confirmed = ws.confirmMapping({
      mappingId: proposed.mappingId,
      assignments: { policyNumber: 0, insuredName: 1 },
      by: 'ops-analyst',
    });
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.confirmedAssignments).toEqual({
      policyNumber: { index: 0, header: 'Policy No' },
      insuredName: { index: 1, header: 'Insured' },
    });
  });

  it('enforces partner/sub-partner ownership scope and supports auditable human review of tentative proposals', () => {
    const ws = new ReconciliationFoundationWorkspace('2026-10-05T09:00:00Z');
    expect(() =>
      ws.runIdentityMatch({
        scope: {
          insurerId: 'ALK-CONV',
          channelPartnerId: 'MARSH-UAE',
          subpartnerId: 'PREMIER-DESK-1', // belongs to PREMIER-BANK, not MARSH-UAE
          insuranceClass: 'life',
        },
        partnerRows: [],
        insurerRows: [],
      }),
    ).toThrow(ReconciliationFoundationError);

    const seededRun = ws.snapshot().runs[0]!;
    const pending = seededRun.proposals[0]!;
    expect(pending.status).toBe('pending_review');

    const reviewed = ws.reviewProposal({
      runId: seededRun.runId,
      leftRowId: pending.leftRowId,
      rightRowId: pending.rightRowId,
      decision: 'confirm',
      note: 'Verified endorsement policy typo with broker bordereau schedule',
      by: 'administration',
    });
    expect(reviewed.proposals[0]).toMatchObject({
      status: 'confirmed',
      reviewedBy: 'administration',
    });
    expect(reviewed.summary.confirmedProposalCount).toBe(1);
    expect(reviewed.summary.pendingProposalCount).toBe(0);
  });

  it('refuses foundation mutations when explicitly disabled by environment', () => {
    const ws = new ReconciliationFoundationWorkspace('2026-10-05T09:00:00Z', {
      PARTNER_COMMISSION_RECONCILIATION_ENABLED: 'false',
    });
    expect(ws.snapshot().featureGate.enabled).toBe(false);
    expect(ws.snapshot().runs).toHaveLength(0);
    expect(() =>
      ws.proposeMapping({
        sourceLabel: 'BLOCKED.csv',
        headers: ['Policy Number'],
      }),
    ).toThrow(ReconciliationFoundationError);
  });
});
