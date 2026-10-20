import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { parseAmount } from './money.js';
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

describe('Role authority tiers, DOA change control and the role access tree', () => {
  it('classifies every role into an authority tier and exposes role-first snapshot aliases', () => {
    const w = buildWorld();
    const snap = w.rbac.snapshot();

    expect(snap.roleCount).toBe(36);
    expect(snap.roles).toHaveLength(36);
    expect(snap.roles).toEqual(snap.profiles);
    expect(snap.activeRoleId).toBe(snap.activeProfileId);
    expect(snap.authorities.map((a) => a.id)).toEqual(['officer', 'supervisor', 'manager', 'executive']);
    expect(snap.roles.find((r) => r.id === 'claim-officer')?.authorityLevel).toBe('officer');
    expect(snap.roles.find((r) => r.id === 'claim-manager')?.authorityLevel).toBe('manager');
    expect(snap.roles.find((r) => r.id === 'agent-supervisor')?.authorityLevel).toBe('supervisor');
    expect(snap.roles.find((r) => r.id === 'administration')?.authorityLevel).toBe('executive');
    expect(snap.userProfileLayer.implemented).toBe(false);
    expect(snap.catalogue.some((c) => c.tabId === 'role-matrix')).toBe(true);

    // The visibility tree is a supervisor/manager tool: officer roles never receive the tab.
    expect(w.rbac.canAccessTab('claim-officer', 'role-matrix')).toBe('none');
    expect(w.rbac.canAccessTab('supervisor', 'role-matrix')).toBe('full');
    expect(w.rbac.canAccessTab('claim-manager', 'role-matrix')).toBe('full');
    expect(w.rbac.canAccessTab('administration', 'role-matrix')).toBe('full');
  });

  it('refuses an officer changing its own DOA cap and allows only a higher tier to change it', () => {
    const w = buildWorld();

    expect(() =>
      w.rbac.changeRoleDoa({ roleId: 'claim-officer', doaLimitAed: '900,000.00', actorProfileId: 'claim-officer' }),
    ).toThrow(/Officer-level role/);

    // A supervisor cannot recapped itself or a manager; authority must move downward.
    expect(() =>
      w.rbac.changeRoleDoa({ roleId: 'supervisor', doaLimitAed: '9,000,000.00', actorProfileId: 'supervisor' }),
    ).toThrow(/cannot change DOA authority/);
    expect(() =>
      w.rbac.changeRoleDoa({ roleId: 'claim-manager', doaLimitAed: '9,000,000.00', actorProfileId: 'supervisor' }),
    ).toThrow(/cannot change DOA authority/);

    // A manager may lift an officer's cap, within the manager's own cap.
    const raised = w.rbac.changeRoleDoa({
      roleId: 'claim-officer', doaLimitAed: '250,000.00', actorProfileId: 'claim-manager',
    });
    expect(raised.doaLimitMinor).toBe(parseAmount('250,000.00', 'AED').minor);

    // But not above the manager's own cap of 500k.
    expect(() =>
      w.rbac.changeRoleDoa({ roleId: 'claim-officer', doaLimitAed: '750,000.00', actorProfileId: 'claim-manager' }),
    ).toThrow(/cannot grant a DOA limit above its own cap/);

    // Administration is the executive role and may set any finite cap.
    const executive = w.rbac.changeRoleDoa({
      roleId: 'claim-officer', doaLimitAed: '2,000,000.00', actorProfileId: 'administration',
    });
    expect(executive.doaLimitMinor).toBe(parseAmount('2,000,000.00', 'AED').minor);
    expect(() =>
      w.rbac.changeRoleDoa({ roleId: 'administration', doaLimitAed: '1,000.00', actorProfileId: 'administration' }),
    ).toThrow(/cannot be re-capped/);
  });

  it('lets an officer request a limit increase, routes it to the mapped supervisor and applies the cap only on approval', () => {
    const w = buildWorld();
    const current = w.rbac.getRole('claim-officer').doaLimitMinor;
    expect(current).toBe(parseAmount('50,000.00', 'AED').minor);

    const submitted = w.rbac.submitDoaLimitIncreaseRequest({
      roleId: 'claim-officer',
      requestedLimitAed: '180,000.00',
      reason: 'Hospital cases now routinely exceed the officer cap.',
      actorProfileId: 'claim-officer',
    });
    expect(submitted.request.actionKind).toBe('doa-limit-increase');
    expect(submitted.request.status).toBe('pending');
    expect(submitted.request.assignedApproverProfileId).toBe('claim-manager');
    expect(submitted.currentLimitLabel).toContain('50,000.00');
    expect(submitted.requestedLimitLabel).toContain('180,000.00');
    // The cap must not move on submission.
    expect(w.rbac.getRole('claim-officer').doaLimitMinor).toBe(current);
    expect(w.rbac.snapshot().notifications.some(
      (n) => n.recipientProfileId === 'claim-manager' && n.doaRequestId === submitted.request.id,
    )).toBe(true);
    // No self-approval.
    expect(() =>
      w.rbac.decideDoaRequest({ requestId: submitted.request.id, actorProfileId: 'claim-officer', decision: 'approve' }),
    ).toThrow(SecurityGovernanceError);

    const approved = w.rbac.decideDoaRequest({
      requestId: submitted.request.id,
      actorProfileId: 'claim-manager',
      decision: 'approve',
      note: 'Case mix justifies the uplift.',
    });
    expect(approved.request.status).toBe('approved');
    expect(approved.request.appliedDoaLimitLabel).toContain('180,000.00');
    expect(w.rbac.getRole('claim-officer').doaLimitMinor).toBe(parseAmount('180,000.00', 'AED').minor);
    expect(w.rbac.snapshot().accessAudit.some((a) => a.event === 'doa.limit-increase-applied')).toBe(true);

    // A manager cannot approve an increase for another manager — only an executive tier can.
    const managerRequest = w.rbac.submitDoaLimitIncreaseRequest({
      roleId: 'claim-manager',
      requestedLimitAed: '1,000,000.00',
      reason: 'Portfolio growth.',
      actorProfileId: 'claim-manager',
    });
    expect(() =>
      w.rbac.decideDoaRequest({ requestId: managerRequest.request.id, actorProfileId: 'claim-manager', decision: 'approve' }),
    ).toThrow(SecurityGovernanceError);
  });

  it('edits the tab → section → sub-section tree with inheritance and refuses officer or over-delegation', () => {
    const w = buildWorld();

    // Officer-tier actors cannot touch the tree at all.
    expect(() =>
      w.rbac.setRoleNodeAccess({
        roleId: 'claim-officer', kind: 'tab', key: 'claims', level: 'none', actorProfileId: 'claim-officer',
      }),
    ).toThrow(/Officer-level role/);

    // A supervisor holds claims read-only, so it cannot grant full claims to an officer.
    expect(() =>
      w.rbac.setRoleNodeAccess({
        roleId: 'claim-officer', kind: 'tab', key: 'claims', level: 'full', actorProfileId: 'supervisor',
      }),
    ).toThrow(/cannot grant full/);

    // A manager may hide the whole claims branch for the officer; children then inherit none.
    const hidden = w.rbac.setRoleNodeAccess({
      roleId: 'claim-officer', kind: 'tab', key: 'claims', level: 'none', actorProfileId: 'claim-manager',
    });
    expect(hidden.tabAccess.claims).toBe('none');
    expect(w.rbac.canAccessSection('claim-officer', 'claims', 'adjudication-settlement')).toBe('none');
    expect(w.rbac.canAccessSubSection('claim-officer', 'claims', 'adjudication-settlement', 'claim-approve')).toBe('none');

    // One deliberate exception: make the approval section read-only; its sub-sections inherit read.
    w.rbac.setRoleNodeAccess({
      roleId: 'claim-officer', kind: 'section', key: 'claims:adjudication-settlement', level: 'read', actorProfileId: 'claim-manager',
    });
    expect(w.rbac.canAccessSection('claim-officer', 'claims', 'adjudication-settlement')).toBe('read');
    expect(w.rbac.canAccessSubSection('claim-officer', 'claims', 'adjudication-settlement', 'claim-approve')).toBe('read');

    // Reset the node to inherit and the section follows the hidden tab again.
    w.rbac.setRoleNodeAccess({
      roleId: 'claim-officer', kind: 'section', key: 'claims:adjudication-settlement', level: 'inherit', actorProfileId: 'claim-manager',
    });
    expect(w.rbac.getRole('claim-officer').sectionAccess['claims:adjudication-settlement']).toBeUndefined();
    expect(w.rbac.canAccessSection('claim-officer', 'claims', 'adjudication-settlement')).toBe('none');

    // Nobody can edit a role at or above their own tier.
    expect(() =>
      w.rbac.setRoleNodeAccess({
        roleId: 'claim-manager', kind: 'tab', key: 'claims', level: 'read', actorProfileId: 'claim-manager',
      }),
    ).toThrow(/cannot change section visibility for this role/);
  });

  it('exposes the new role endpoints over HTTP and refuses officer attempts with a 4xx', async () => {
    const state = createRuntimeState(1);

    await expect(dispatchApiRoute(state, 'POST', '/security/role/access', new URLSearchParams(), {
      roleId: 'claim-officer',
      kind: 'tab',
      key: 'claims',
      level: 'none',
      actorRoleId: 'claim-officer',
    })).rejects.toThrow(/Officer-level role/);

    const edited = await dispatchApiRoute(state, 'POST', '/security/role/access', new URLSearchParams(), {
      roleId: 'claim-officer',
      kind: 'section',
      key: 'claims:adjudication-settlement',
      level: 'read',
      actorRoleId: 'claim-manager',
    });
    expect(edited.status).toBe(200);

    const requested = await dispatchApiRoute(state, 'POST', '/security/doa/limit-request', new URLSearchParams(), {
      roleId: 'claim-officer',
      requestedLimitAed: '175,000.00',
      reason: 'Raised through the API contract test.',
      actorRoleId: 'claim-officer',
    });
    expect(requested.status).toBe(200);
    const body = requested.body as { request: { id: string; assignedApproverProfileId: string } };
    expect(body.request.assignedApproverProfileId).toBe('claim-manager');

    const approved = await dispatchApiRoute(state, 'POST', '/security/doa/decide', new URLSearchParams(), {
      requestId: body.request.id,
      actorRoleId: 'claim-manager',
      decision: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(state.world.rbac.getRole('claim-officer').doaLimitMinor).toBe(parseAmount('175,000.00', 'AED').minor);
  });
});
