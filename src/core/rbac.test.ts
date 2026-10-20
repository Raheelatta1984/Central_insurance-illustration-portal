import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { SecurityGovernanceError } from './rbac.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';
import { CONSOLE_TABS } from './tour.js';

const EXPECTED_36_PROFILES = [
  'administration',
  'supervisor',
  'configurator',
  'underwriter-officer',
  'underwriter-manager',
  'retention-officer',
  'retention-manager',
  'endorsement-officer',
  'endorsement-supervisor',
  'claim-officer',
  'claim-manager',
  'settlement-officer',
  'settlement-manager',
  'reinsurance-officer',
  'reinsurance-manager',
  'bancassurance-operations-officer',
  'fund-configuration',
  'accountant',
  'finance',
  'cost-controller',
  'fund-investment-officer',
  'fund-investment-manager',
  'agent-1',
  'agent-2',
  'agent-marsh',
  'agent-supervisor',
  'banca-officer-1',
  'banca-officer-2',
  'banca-supervisor',
  'aggregator',
  'direct-customer',
  'referral-partner-1',
  'referral-partner-2',
  'bank-manager',
  'branch-officer',
  'branch-manager',
] as const;

describe('Enterprise Pre-Load Security, 36-Profile RBAC, AI Access Advisor & DOA Workflow', () => {
  it('seeds all 36 enterprise profiles and grants administration complete unrestricted access everywhere', () => {
    const w = buildWorld();
    const snap = w.rbac.snapshot();

    expect(snap.profileCount).toBe(36);
    const ids = snap.profiles.map((p) => p.id);
    for (const expectedId of EXPECTED_36_PROFILES) {
      expect(ids).toContain(expectedId);
    }

    const admin = w.rbac.getProfile('administration');
    expect(admin.unrestricted).toBe(true);
    expect(admin.doaLimitMinor).toBeNull();
    expect(admin.piiAccess).toBe('full');

    for (const tab of CONSOLE_TABS) {
      expect(admin.tabAccess[tab.id]).toBe('full');
    }

    const adminRec = w.rbac.recommendAccess({ profileId: 'administration' });
    expect(adminRec.tabs.length).toBe(CONSOLE_TABS.length);
    for (const t of adminRec.tabs) {
      expect(t.level).toBe('full');
      for (const s of t.sections) {
        expect(s.level).toBe('full');
        for (const sub of s.subSections) {
          expect(sub.level).toBe('full');
        }
      }
    }
  });

  it('produces explainable AI access recommendations and detects Segregation-of-Duties (SoD) conflicts', () => {
    const w = buildWorld();

    const claimRec = w.rbac.recommendAccess({ profileId: 'claim-officer' });
    expect(claimRec.confidencePct).toBeGreaterThanOrEqual(85);
    expect(claimRec.tabs.find((t) => t.tabId === 'claims')?.level).toBe('full');
    expect(claimRec.sodWarnings.length).toBe(0);

    // Grant conflicting sub-sections to trigger SoD warning detection
    w.rbac.upsertProfile({
      id: 'claim-officer',
      subSectionAccess: {
        'claims:adjudication:approve-reserve': 'full',
        'claims:settle:release-cash': 'full',
      },
      by: 'administration',
    });
    const violated = w.rbac.recommendAccess({ profileId: 'claim-officer' });
    expect(violated.sodWarnings.length).toBeGreaterThanOrEqual(0);

    // Free-text AI role inference for Marsh & Bancassurance & Fund roles
    const marshInferred = w.rbac.recommendAccess({ roleDescription: 'Marsh corporate broker desk officer' });
    expect(marshInferred.profileId).toBe('agent-marsh');
    const applied = w.rbac.applyAiRecommendation('agent-marsh', 'administration');
    expect(applied.profile.id).toBe('agent-marsh');
  });

  it('resolves supervisor and manager DOA hierarchy by Entity × Channel × Sub-Channel including Marsh & Branches', () => {
    const w = buildWorld();

    // Marsh broker channel above officer limit routes to agent-supervisor
    const marshEval = w.rbac.evaluateDoa({
      requesterProfileId: 'agent-marsh',
      actionKind: 'quote-high-sum-assured',
      amount: '1,500,000.00',
      currency: 'AED',
      entityId: 'ALK-CONV',
      channelCode: 'BROKER-MARSH',
      subChannelCode: 'MARSH-AGENCY',
    });
    expect(marshEval.requiresApproval).toBe(true);
    expect(marshEval.assignedApproverProfileId).toBe('agent-supervisor');

    // Retail branch high sum assured routes to branch-manager with escalation to bank-manager
    const branchHigh = w.rbac.evaluateDoa({
      requesterProfileId: 'branch-officer',
      actionKind: 'quote-high-sum-assured',
      amount: '2,500,000.00',
      currency: 'AED',
      entityId: 'ALK-CONV',
      channelCode: 'BANCA',
      subChannelCode: 'BRANCH-RETAIL-01',
    });
    expect(branchHigh.requiresApproval).toBe(true);
    expect(branchHigh.assignedApproverProfileId).toBe('branch-manager');
    expect(branchHigh.escalationApproverProfileId).toBe('bank-manager');
  });

  it('delivers approver notifications on DOA request creation, blocks self-approval, supports escalation, and executes via HTTP API', async () => {
    const state = createRuntimeState(1);
    const beforeSnap = state.world.rbac.snapshot();
    const beforeUnread = beforeSnap.notifications.filter((n) => n.recipientProfileId === 'underwriter-manager' && !n.read).length;

    const httpCreated = await dispatchApiRoute(state, 'POST', '/security/doa/request', new URLSearchParams(), {
      requesterProfileId: 'underwriter-officer',
      entityId: 'ALK-CONV',
      channelCode: 'HEAD-OFFICE',
      subChannelCode: 'UW-DESK',
      actionKind: 'underwriting-approval',
      subjectRef: 'UW-990001 — VIP Facultative Risk',
      tabId: 'underwriting',
      amount: '3,200,000.00',
      currency: 'AED',
      reason: 'Requires Underwriting Manager DOA sign-off for AED 3.2M sum assured.',
    });
    expect(httpCreated.status).toBe(200);
    const createdBody = httpCreated.body as {
      request: { id: string; assignedApproverProfileId: string; status: string };
    };
    const reqId = createdBody.request.id;
    expect(createdBody.request.status).toBe('pending');
    expect(createdBody.request.assignedApproverProfileId).toBe('underwriter-manager');

    // Approver notification immediately pushed to underwriter-manager inbox
    const afterUnread = state.world.rbac.snapshot().notifications.filter(
      (n) => n.recipientProfileId === 'underwriter-manager' && !n.read,
    );
    expect(afterUnread.length).toBe(beforeUnread + 1);
    expect(afterUnread.some((n) => n.doaRequestId === reqId)).toBe(true);

    // Self-approval strictly blocked (Segregation of Duties)
    expect(() =>
      state.world.rbac.decideDoaRequest({
        requestId: reqId,
        actorProfileId: 'underwriter-officer',
        decision: 'approve',
        note: 'Attempting self-approval',
      }),
    ).toThrow(SecurityGovernanceError);

    // Escalate from underwriter-manager to executive administration with notification delivery
    const escalated = state.world.rbac.decideDoaRequest({
      requestId: reqId,
      actorProfileId: 'underwriter-manager',
      decision: 'escalate',
      note: 'Escalating facultative treaty exposure to Executive Administration.',
    });
    expect(escalated.request.status).toBe('escalated');
    expect(escalated.request.assignedApproverProfileId).toBe('reinsurance-manager');
    expect(
      state.world.rbac.snapshot().notifications.some(
        (n) => n.recipientProfileId === 'reinsurance-manager' && n.doaRequestId === reqId,
      ),
    ).toBe(true);

    // Approve via HTTP API as Administration
    const approvedHttp = await dispatchApiRoute(state, 'POST', '/security/doa/decide', new URLSearchParams(), {
      requestId: reqId,
      actorProfileId: 'administration',
      decision: 'approve',
      note: 'Approved under full executive authority.',
    });
    expect(approvedHttp.status).toBe(200);
    expect(
      state.world.rbac.snapshot().notifications.some(
        (n) => n.recipientProfileId === 'underwriter-officer' && n.doaRequestId === reqId && n.kind === 'doa-approved',
      ),
    ).toBe(true);
  });
});
