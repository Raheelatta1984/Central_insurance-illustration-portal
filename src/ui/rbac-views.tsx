/**
 * Enterprise Pre-Load Profile Security Gate, Dedicated Role-Based Access & DOA Governance Tab,
 * Active Header Security Strip, Notification Bell Drawer, and Screen Access Guard Banner.
 *
 * Covers all 36 requested operational, governance, technical, finance, fund, agency, Marsh broker,
 * bancassurance, branch, bank, aggregator, direct-customer and referral-partner profiles — with
 * Administration holding permanent unrestricted superuser access across all console tabs, sections and
 * sub-sections, explainable AI role recommendations with Segregation-of-Duties checks, dynamic
 * Entity × Channel × Sub-Channel supervision chains, and real-time DOA approval notifications.
 */
import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import type { AccessLevel, DoaActionKind } from '../core/rbac';
import type { ConsoleTab } from '../core/tour';
import { CONSOLE_TABS } from '../core/tour';
import { api } from './api';
import { SmartComboBox, SmartMultiComboBox } from './combobox';
import { SectionGroup, fields } from './sections';

type SecuritySnap = WorldSnapshot['security'];
type RoleRow = SecuritySnap['roles'][number];

interface AiRecommendationView {
  profileId: string;
  profileName: string;
  confidencePct: number;
  recommendedLandingTab: string;
  recommendedDoaLimit: string;
  recommendedSupervisorProfileId: string | null;
  recommendedEscalationProfileId: string | null;
  piiAccess: string;
  sodWarnings: string[];
  rationale: string;
  tabs: Array<{
    tabId: string;
    label: string;
    level: AccessLevel;
    scorePct: number;
    reason: string;
    sections: Array<{
      sectionId: string;
      label: string;
      level: AccessLevel;
      subSections: Array<{ subSectionId: string; label: string; level: AccessLevel }>;
    }>;
  }>;
}

const ENTITY_SUGGESTIONS = [
  { value: 'ALK-CONV', label: 'ALK-CONV — Al Khaleej Insurance (Conventional)', category: 'UAE CBUAE', badge: 'Entity' },
  { value: 'ALK-TKF', label: 'ALK-TKF — Al Khaleej Takaful Window', category: 'UAE Shariah', badge: 'Entity' },
  { value: 'ALK-MY', label: 'ALK-MY — Al Khaleej Malaysia Subsidiary', category: 'Malaysia BNM', badge: 'Entity' },
  { value: '*', label: '* — All Legal Entities (Group-wide wildcard)', category: 'Global', badge: 'Wildcard' },
];

const CHANNEL_SUGGESTIONS = [
  { value: 'AGENCY', label: 'AGENCY — Tied Agency Network', category: 'Advisory', badge: 'Channel' },
  { value: 'BROKER-MARSH', label: 'BROKER-MARSH — Marsh Corporate & Retail Broker', category: 'Brokerage', badge: 'Channel' },
  { value: 'BANCA', label: 'BANCA — Bancassurance & Partner Bank Network', category: 'Bank', badge: 'Channel' },
  { value: 'AGGREGATOR', label: 'AGGREGATOR — Digital Comparison Aggregators', category: 'Digital', badge: 'Channel' },
  { value: 'DIRECT', label: 'DIRECT — Direct Customer Portal & Mobile App', category: 'Self-service', badge: 'Channel' },
  { value: 'REFERRAL', label: 'REFERRAL — Introducer & Referral Partners', category: 'Lead Gen', badge: 'Channel' },
  { value: 'HEAD-OFFICE', label: 'HEAD-OFFICE — Technical, Claims & Finance Desks', category: 'Internal', badge: 'Channel' },
  { value: '*', label: '* — All Distribution Channels', category: 'Global', badge: 'Wildcard' },
];

const SUB_CHANNEL_SUGGESTIONS = [
  { value: 'AGENCY-DESK-1', label: 'AGENCY-DESK-1 — Tied Agency Desk 1 (Conventional)', category: 'AGENCY', badge: 'Sub-channel' },
  { value: 'AGENCY-DESK-2', label: 'AGENCY-DESK-2 — Tied Agency Desk 2 (Takaful & Life)', category: 'AGENCY', badge: 'Sub-channel' },
  { value: 'MARSH-AGENCY', label: 'MARSH-AGENCY — Marsh Broker Desk (Multi-country)', category: 'BROKER-MARSH', badge: 'Sub-channel' },
  { value: 'BANCA-PREMIER-1', label: 'BANCA-PREMIER-1 — Premier Wealth Bancassurance Desk 1', category: 'BANCA', badge: 'Sub-channel' },
  { value: 'BANCA-PREMIER-2', label: 'BANCA-PREMIER-2 — Islamic Window Bancassurance Desk 2', category: 'BANCA', badge: 'Sub-channel' },
  { value: 'BRANCH-RETAIL-01', label: 'BRANCH-RETAIL-01 — Retail Bank Branch Counter 01', category: 'BANCA', badge: 'Sub-channel' },
  { value: 'AGGREGATOR-API', label: 'AGGREGATOR-API — Instant Quote Comparison API', category: 'AGGREGATOR', badge: 'Sub-channel' },
  { value: 'DIRECT-PORTAL', label: 'DIRECT-PORTAL — Policyholder Self-Service Web/Mobile', category: 'DIRECT', badge: 'Sub-channel' },
  { value: 'REFERRAL-CORP-1', label: 'REFERRAL-CORP-1 — Corporate Introducer Partner 1', category: 'REFERRAL', badge: 'Sub-channel' },
  { value: 'REFERRAL-WEALTH-2', label: 'REFERRAL-WEALTH-2 — Wealth Advisory Introducer 2', category: 'REFERRAL', badge: 'Sub-channel' },
  { value: 'UW-DESK', label: 'UW-DESK — Head Office Underwriting Desk', category: 'HEAD-OFFICE', badge: 'Sub-channel' },
  { value: 'CLAIMS-DESK', label: 'CLAIMS-DESK — Head Office Claims & Settlement Desk', category: 'HEAD-OFFICE', badge: 'Sub-channel' },
  { value: 'FINANCE-DESK', label: 'FINANCE-DESK — Group Finance, Ledger & Cost Control', category: 'HEAD-OFFICE', badge: 'Sub-channel' },
  { value: 'FUNDS-DESK', label: 'FUNDS-DESK — Fund Config & Investment Dealing Desk', category: 'HEAD-OFFICE', badge: 'Sub-channel' },
  { value: '*', label: '* — All Sub-Channels in Channel', category: 'Wildcard', badge: 'Sub-channel' },
];

const DOA_ACTION_OPTIONS: Array<{ value: DoaActionKind; label: string }> = [
  { value: 'quote-high-sum-assured', label: 'High Sum Assured Quotation / Illustration' },
  { value: 'underwriting-approval', label: 'Underwriting Risk Acceptance / Loading Override' },
  { value: 'retention-waiver', label: 'Retention / Surrender Fee Waiver / Conservation Offer' },
  { value: 'endorsement-alteration', label: 'Financial / Non-Financial Endorsement Alteration' },
  { value: 'claim-approval', label: 'Claim Reserve & Adjudication Approval' },
  { value: 'settlement-release', label: 'Cash Claim / Maturity Settlement Release' },
  { value: 'reinsurance-placement', label: 'Treaty Cession / Facultative Placement' },
  { value: 'fund-nav-signoff', label: 'Fund Creation / Daily NAV Publication Sign-Off' },
  { value: 'accounting-voucher', label: 'Accounting Voucher / Batch Run Posting' },
  { value: 'discount-concession', label: 'Partner Commission / Commercial Fee Concession' },
  { value: 'master-config-change', label: 'Master Settings / Product Tariff Filing' },
];

function tabTitleOf(tabId: string): string {
  return CONSOLE_TABS.find((t) => t.id === tabId)?.label ?? tabId;
}

/* ============================================================================
 * 1. PRE-LOAD SECURITY & PROFILE SELECTION GATE (SHOWN PRIOR TO WORKSPACE LOAD)
 * ========================================================================== */
export const ProfileSelectionGate: React.FC<{
  security: SecuritySnap;
  tenantName: string;
  onSelectProfile: (profileId: string) => Promise<void> | void;
  busy?: boolean;
}> = ({ security, tenantName, onSelectProfile, busy }) => {
  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState<string>(security.activeRoleId || 'administration');

  const adminProfile = security.roles.find((p) => p.id === 'administration') ?? security.roles[0]!;
  const previewProfile = security.roles.find((p) => p.id === previewId) ?? adminProfile;

  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return security.roles.filter((p) => {
      if (familyFilter !== 'all' && p.family !== familyFilter) return false;
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.badge.toLowerCase().includes(q) ||
        p.channelScope.toLowerCase().includes(q) ||
        p.subChannelScope.toLowerCase().includes(q)
      );
    });
  }, [security.roles, familyFilter, search]);

  return (
    <div className="securityGateWrap" data-security-gate="open">
      <div className="securityGateHero">
        <div>
          <div className="pills" style={{ marginBottom: 6 }}>
            <span className="pill ok">⚿ Enterprise Security &amp; DOA Governance Gate</span>
            <span className="pill info">{security.roleCount} Configured Roles</span>
            <span className="pill info">{security.authorities.length} Authority Tiers</span>
            <span className="pill info">{security.supervisionMappings.length} Entity × Channel × Sub-Channel Chains</span>
            <span className="pill warn">
              {security.doaRequests.filter((r) => r.status === 'pending' || r.status === 'escalated').length} Live DOA Approvals Queued
            </span>
          </div>
          <h1>Select Your Security Role to Enter {tenantName}</h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: 880 }}>
            Every session loads tailored <b>Tabs → Sections → Sub-Sections</b> recommended by the AI Access &amp; Segregation-of-Duties
            engine, enforces decimal Delegation-of-Authority (DOA) limits, and routes approvals to the mapped Supervisor &amp; Manager
            with instant notifications. Choose <b>Administration</b> for complete unrestricted full access across the entire ERP.
          </p>
          <p className="small muted" style={{ margin: '6px 0 0', maxWidth: 880 }}>
            These records are <b>roles</b> (the policy office, the underwriter, the branch officer), not named user accounts.
            Login credentials, individual user profiles and provisioning will be added in a later layer and will reference a role id.
            Officer-tier roles can request a DOA limit increase; only supervisor- and manager-tier roles can approve or change one.
          </p>
        </div>
        <div className="securityAdminQuickBox">
          <div className="small muted" style={{ marginBottom: 6 }}>Superuser Full-Access Entry</div>
          <button
            type="button"
            className="primaryHeroBtn"
            data-select-profile="administration"
            disabled={busy}
            onClick={() => void onSelectProfile('administration')}
          >
            ⚿ Enter as Administration (Complete Full Access · All {CONSOLE_TABS.length} Tabs)
          </button>
          <div className="small muted" style={{ marginTop: 6 }}>
            Unrestricted R/W on all {CONSOLE_TABS.length} tabs, sections, sub-sections, master settings &amp; DOA overrides
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="pills" style={{ gap: 6 }}>
            <button
              type="button"
              className={familyFilter === 'all' ? '' : 'ghost'}
              onClick={() => setFamilyFilter('all')}
            >
              All Roles ({security.roleCount})
            </button>
            {security.families.map((fam) => {
              const count = security.roles.filter((p) => p.family === fam.id).length;
              return (
                <button
                  key={fam.id}
                  type="button"
                  className={familyFilter === fam.id ? '' : 'ghost'}
                  onClick={() => setFamilyFilter(fam.id)}
                >
                  {fam.label} ({count})
                </button>
              );
            })}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all 36 roles (e.g. Marsh, Underwriter, Retention, Banca, Fund, Branch, Claim)…"
            style={{ minWidth: 320 }}
          />
        </div>
      </div>

      {/* Main Split: 36 Role Cards + Live AI Access & DOA Inspector */}
      <div className="securityGateGrid">
        <div className="securityCardsGrid">
          {filteredProfiles.map((p) => {
            const selected = p.id === previewProfile.id;
            return (
              <div
                key={p.id}
                className={`profileGateCard${selected ? ' is-selected' : ''}${p.unrestricted ? ' is-admin' : ''}`}
                onMouseEnter={() => setPreviewId(p.id)}
                onClick={() => setPreviewId(p.id)}
              >
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                  <div>
                    <span className={`pill ${p.unrestricted ? 'ok' : 'info'}`}>{p.badge}</span>{' '}
                    <span className={`pill ${p.authorityLevel === 'officer' ? '' : p.authorityLevel === 'executive' ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
                      {p.authorityLabel}
                    </span>
                  </div>
                  <div className="pills" style={{ gap: 4 }}>
                    {p.pendingApprovals > 0 && <span className="pill warn">{p.pendingApprovals} DOA</span>}
                    {p.unreadNotifications > 0 && <span className="pill bad">🔔 {p.unreadNotifications}</span>}
                  </div>
                </div>
                <h3 style={{ margin: '6px 0 2px', fontSize: 15 }}>{p.name}</h3>
                <div className="small muted" style={{ marginBottom: 8 }}>{p.title}</div>
                <div className="small" style={{ marginBottom: 8 }}>
                  <span className="muted">Scope:</span> <b>{p.entityScope}</b> · <b>{p.channelScope}</b> · <b>{p.subChannelScope}</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                  <span className="small">
                    DOA: <b>{p.doaLimitLabel}</b> · <b>{p.allowedTabs.length}</b> tabs
                  </span>
                  <button
                    type="button"
                    data-select-profile={p.id}
                    data-select-role={p.id}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onSelectProfile(p.id);
                    }}
                  >
                    Enter as {p.name} →
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Sticky Live AI Access & DOA Preview Inspector */}
        <aside className="securityPreviewPane card">
          <div className="pills">
            <span className={`pill ${previewProfile.unrestricted ? 'ok' : 'info'}`}>{previewProfile.badge}</span>
            <span className={`pill ${previewProfile.authorityLevel === 'officer' ? '' : 'warn'}`}>{previewProfile.authorityLabel} · L{previewProfile.authorityRank}</span>
            <span className="pill ok">AI Confidence {previewProfile.aiConfidencePct}%</span>
            <span className="pill">PII: {previewProfile.piiAccess}</span>
          </div>
          <h3 style={{ fontSize: 17, marginTop: 8 }}>{previewProfile.name}</h3>
          <p className="muted small" style={{ marginTop: 2 }}>{previewProfile.title}</p>
          <p className="small">{previewProfile.summary}</p>

          <div className="stat"><span>Landing Screen</span><b>{tabTitleOf(previewProfile.defaultLandingTab)}</b></div>
          <div className="stat"><span>Entity × Channel × Sub</span><b>{previewProfile.entityScope} / {previewProfile.channelScope} / {previewProfile.subChannelScope}</b></div>
          <div className="stat"><span>DOA Authority Cap</span><b>{previewProfile.doaLimitLabel}</b></div>
          <div className="stat"><span>DOA change authority</span><b>{previewProfile.canChangeDoa ? 'Yes — supervisor/manager' : 'No — request only'}</b></div>
          <div className="stat">
            <span>Supervisor → Escalation</span>
            <b>
              {previewProfile.unrestricted
                ? 'Final Executive Authority'
                : `${previewProfile.reportsToProfileId ?? 'administration'} → ${previewProfile.escalationProfileId ?? 'administration'}`}
            </b>
          </div>

          <div className="manualCard" style={{ marginTop: 10 }}>
            <b className="small">AI Optimal Access Rationale</b>
            <p className="small muted" style={{ margin: '4px 0 0' }}>{previewProfile.aiRationale}</p>
          </div>

          <div style={{ marginTop: 10 }}>
            <b className="small">Full Read/Write Tabs ({previewProfile.fullTabs.length})</b>
            <div className="pills" style={{ marginTop: 5 }}>
              {previewProfile.fullTabs.map((t) => (
                <span key={t} className="pill ok">{tabTitleOf(t)}</span>
              ))}
            </div>
          </div>

          {previewProfile.readTabs.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <b className="small">Read-Only Context Tabs ({previewProfile.readTabs.length})</b>
              <div className="pills" style={{ marginTop: 5 }}>
                {previewProfile.readTabs.map((t) => (
                  <span key={t} className="pill info">{tabTitleOf(t)} (RO)</span>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              style={{ width: '100%' }}
              disabled={busy}
              onClick={() => void onSelectProfile(previewProfile.id)}
            >
              Launch ERP Session as {previewProfile.name} →
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};

/* ============================================================================
 * 2. HEADER SECURITY STRIP + APPROVER NOTIFICATION INBOX DRAWER
 * ========================================================================== */
export const HeaderSecurityStrip: React.FC<{
  security: SecuritySnap;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onOpenGate: () => void;
  onOpenAccessTab: () => void;
  onReload: () => Promise<void>;
}> = ({ security, onSwitchProfile, onOpenGate, onOpenAccessTab, onReload }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const active = security.roles.find((p) => p.id === security.activeRoleId) ?? security.roles[0]!;
  const myNotifications = security.notifications.filter(
    (n) => active.unrestricted || n.recipientProfileId === active.id,
  );
  const unreadCount = myNotifications.filter((n) => !n.read).length;
  const pendingMyApprovals = security.doaRequests.filter(
    (r) =>
      (r.status === 'pending' || r.status === 'escalated') &&
      (active.unrestricted || r.assignedApproverProfileId === active.id),
  );

  const quickDecide = async (requestId: string, decision: 'approve' | 'reject' | 'escalate') => {
    setBusy(true);
    try {
      await api('/security/doa/decide', 'POST', {
        requestId,
        actorProfileId: active.id,
        decision,
        note: `${decision.toUpperCase()} from header approver inbox by ${active.name}`,
      });
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  const markRead = async () => {
    setBusy(true);
    try {
      await api('/security/notifications/read', 'POST', { profileId: active.id });
      await onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="headerSecurityBar">
      <span className={`pill ${active.unrestricted ? 'ok' : 'info'}`} title={active.title}>
        ⚿ <b>{active.name}</b> · {active.authorityLabel} · DOA {active.doaLimitLabel}
      </span>
      <select
        aria-label="Active security role"
        value={active.id}
        disabled={busy}
        onChange={(e) => void onSwitchProfile(e.target.value)}
        style={{ maxWidth: 225, padding: '3px 8px', fontSize: 12 }}
      >
        {security.roles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.authorityLabel} ({p.doaLimitLabel}){p.pendingApprovals > 0 ? ` · ${p.pendingApprovals} DOA` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ghost"
        data-open-profile-gate="true"
        onClick={onOpenGate}
        style={{ padding: '3px 9px', minHeight: 26, fontSize: 12 }}
      >
        ⇄ Role Gate ({security.roleCount})
      </button>
      <button
        type="button"
        className={pendingMyApprovals.length > 0 || unreadCount > 0 ? '' : 'ghost'}
        data-open-notifications="true"
        onClick={() => setDrawerOpen((v) => !v)}
        style={{ padding: '3px 10px', minHeight: 26, fontSize: 12 }}
      >
        🔔 Inbox ({unreadCount} unread · {pendingMyApprovals.length} DOA)
      </button>

      {drawerOpen && (
        <div className="notifDrawer card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Approver DOA Queue &amp; Notifications ({active.name})</b>
            <div className="row" style={{ gap: 6 }}>
              {unreadCount > 0 && (
                <button type="button" className="ghost" disabled={busy} onClick={() => void markRead()}>
                  Mark all read
                </button>
              )}
              {active.unrestricted && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setDrawerOpen(false);
                    onOpenAccessTab();
                  }}
                >
                  Open Access &amp; DOA Tab →
                </button>
              )}
              <button type="button" className="ghost" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
          </div>

          {pendingMyApprovals.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Pending DOA Approvals Assigned to You</div>
              {pendingMyApprovals.slice(0, 4).map((req) => (
                <div key={req.id} className="notifItem">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <b>{req.id} · {req.amountLabel} — {req.subjectRef}</b>
                    <span className="pill warn">{req.status}</span>
                  </div>
                  <div className="small muted">
                    From <b>{req.requesterName}</b> ({req.entityId}/{req.channelCode}/{req.subChannelCode}) · {req.reason}
                  </div>
                  {req.requesterProfileId !== active.id || active.unrestricted ? (
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button type="button" disabled={busy} onClick={() => void quickDecide(req.id, 'approve')}>
                        ✓ Approve
                      </button>
                      <button type="button" className="ghost" disabled={busy} onClick={() => void quickDecide(req.id, 'escalate')}>
                        ↑ Escalate
                      </button>
                      <button type="button" className="ghost" disabled={busy} onClick={() => void quickDecide(req.id, 'reject')}>
                        ✕ Reject
                      </button>
                    </div>
                  ) : (
                    <div className="small muted">Awaiting supervisor sign-off (four-eyes rule prevents self-approval).</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            <div className="small muted" style={{ marginBottom: 4 }}>Recent Notifications ({myNotifications.length})</div>
            {myNotifications.slice(0, 5).map((n) => (
              <div key={n.id} className={`notifItem${n.read ? ' is-read' : ''}`}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b className="small">{n.title}</b>
                  <span className={`pill ${n.read ? 'info' : 'bad'}`}>{n.read ? 'read' : 'new'}</span>
                </div>
                <div className="small muted">{n.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 3. ACTIVE TAB PERMISSION & 1-CLICK DOA REQUEST BAR FOR NON-ADMIN PROFILES
 * ========================================================================== */
export const ProfileAccessGuardBanner: React.FC<{
  security: SecuritySnap;
  tab: ConsoleTab;
  onReload: () => Promise<void>;
  onOpenAccessTab: () => void;
}> = ({ security, tab, onReload, onOpenAccessTab }) => {
  const active = security.roles.find((p) => p.id === security.activeRoleId) ?? security.roles[0]!;
  const [reqAmount, setReqAmount] = useState('650,000.00');
  const [reqReason, setReqReason] = useState('Customer cover / settlement exceeds officer DOA cap');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showIncrease, setShowIncrease] = useState(false);
  const [increaseAmount, setIncreaseAmount] = useState('');
  const [increaseReason, setIncreaseReason] = useState('Case volume and average case size now exceed the current DOA cap.');
  const [increaseNotice, setIncreaseNotice] = useState<string | null>(null);

  if (active.unrestricted || tab === 'access-doa') return null;

  const level: AccessLevel = active.tabAccess[tab] ?? 'none';

  const submitQuickDoa = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api<{
        autoApproved: boolean;
        requestId: string;
        notificationsSent: Array<{ recipientProfileId: string; title: string }>;
      }>('/security/doa/request', 'POST', {
        requesterProfileId: active.id,
        actionKind: tab === 'claims' ? 'claim-approval' : tab === 'underwriting' ? 'underwriting-approval' : 'quote-high-sum-assured',
        subjectRef: `${tab.toUpperCase()}-CASE`,
        tabId: tab,
        entityId: active.entityScope === '*' ? 'ALK-CONV' : active.entityScope,
        channelCode: active.channelScope === '*' ? 'HEAD-OFFICE' : active.channelScope,
        subChannelCode: active.subChannelScope,
        amount: reqAmount,
        reason: reqReason,
      });
      await onReload();
      setNotice(
        res.autoApproved
          ? `${res.requestId} authorized automatically within ${active.name}'s DOA cap.`
          : `${res.requestId} routed for DOA approval — instant notification sent to ${res.notificationsSent.map((n) => n.recipientProfileId).join(', ')}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitIncrease = async () => {
    setBusy(true);
    setIncreaseNotice(null);
    try {
      const res = await api<{ requestId: string; currentLimitLabel: string; requestedLimitLabel: string }>('/security/doa/limit-request', 'POST', {
        roleId: active.id,
        requestedLimitAed: increaseAmount,
        reason: increaseReason,
        actorRoleId: active.id,
      });
      await onReload();
      setIncreaseNotice(`${res.requestId} submitted: ${res.currentLimitLabel} → ${res.requestedLimitLabel}. A supervisor or manager must approve it before the cap moves.`);
    } catch (e) {
      setIncreaseNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scopedBrandBanner" style={{ marginBottom: 12 }}>
      <span className={`pill ${level === 'full' ? 'ok' : level === 'read' ? 'warn' : 'bad'}`}>
        {level === 'full' ? 'FULL R/W ACCESS' : level === 'read' ? 'READ-ONLY VIEW' : 'RESTRICTED'}
      </span>
      <span className={`pill ${active.authorityLevel === 'officer' ? 'warn' : 'ok'}`}>
        {active.authorityLabel} · L{active.authorityRank}
      </span>
      <span className="small">
        Active role <b>{active.name}</b> ({active.entityScope}/{active.channelScope}/{active.subChannelScope}) · DOA cap{' '}
        <b>{active.doaLimitLabel}</b> · Supervisor: <b>{active.reportsToProfileId ?? 'Administration'}</b>
      </span>
      <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
        <input
          value={reqAmount}
          onChange={(e) => setReqAmount(e.target.value)}
          placeholder="Amount (AED)"
          style={{ width: 120, padding: '3px 7px', fontSize: 12 }}
        />
        <input
          value={reqReason}
          onChange={(e) => setReqReason(e.target.value)}
          placeholder="Reason for DOA approval"
          style={{ width: 220, padding: '3px 7px', fontSize: 12 }}
        />
        <button type="button" disabled={busy} onClick={() => void submitQuickDoa()} style={{ padding: '4px 10px', fontSize: 12 }}>
          Raise DOA Approval →
        </button>
        {active.doaLimitMinor !== null && (
          <button type="button" className="ghost" onClick={() => setShowIncrease((v) => !v)} style={{ padding: '4px 9px', fontSize: 12 }}>
            {showIncrease ? '× Close limit request' : 'Request DOA limit increase'}
          </button>
        )}
      </div>
      {showIncrease && active.doaLimitMinor !== null && (
        <div className="row" style={{ width: '100%', gap: 6, marginTop: 6 }}>
          <span className="pill info">Current cap {active.doaLimitLabel}</span>
          <input
            value={increaseAmount}
            onChange={(e) => setIncreaseAmount(e.target.value)}
            placeholder="Requested cap (AED)"
            style={{ width: 150, padding: '3px 7px', fontSize: 12 }}
          />
          <input
            value={increaseReason}
            onChange={(e) => setIncreaseReason(e.target.value)}
            placeholder="Reason for the increase"
            style={{ flex: 1, minWidth: 220, padding: '3px 7px', fontSize: 12 }}
          />
          <button type="button" disabled={busy || !increaseAmount.trim()} onClick={() => void submitIncrease()} style={{ padding: '4px 10px', fontSize: 12 }}>
            Submit limit-increase request →
          </button>
        </div>
      )}
      {increaseNotice && <div className="small okText" style={{ width: '100%' }}>{increaseNotice}</div>}
      {notice && <div className="small okText" style={{ width: '100%' }}>{notice}</div>}
    </div>
  );
};

/* ============================================================================
 * 4. DEDICATED TOP-LEVEL CONSOLE TAB: ROLE-BASED ACCESS & DOA GOVERNANCE HUB
 * ========================================================================== */
export const RoleAccessAndDoaPanel: React.FC<{
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onOpenGate: () => void;
}> = ({ data, onReload, onSwitchProfile, onOpenGate }) => {
  const security = data.security;
  const activeProfile = security.roles.find((p) => p.id === security.activeRoleId) ?? security.roles[0]!;

  // Directory & clone state
  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string>('agent-marsh');
  const [cloneId, setCloneId] = useState('agent-vip-desk');
  const [cloneName, setCloneName] = useState('VIP Wealth Advisor');
  const [cloneTitle, setCloneTitle] = useState('Private Client Wealth & Takaful Advisor');
  const [cloneDoa, setCloneDoa] = useState('750,000.00');

  // AI Advisor state
  const [advisorRoleText, setAdvisorRoleText] = useState('');
  const [aiResult, setAiResult] = useState<AiRecommendationView | null>(null);

  // Entity × Channel × Sub-Channel Supervision Mapper state
  const [mapEntity, setMapEntity] = useState('ALK-CONV');
  const [mapChannel, setMapChannel] = useState('BROKER-MARSH');
  const [mapSubChannel, setMapSubChannel] = useState('MARSH-AGENCY');
  const [mapDept, setMapDept] = useState('Marsh Corporate & Retail Brokerage Desk');
  const [mapOfficers, setMapOfficers] = useState<string[]>(['agent-marsh']);
  const [mapSupervisor, setMapSupervisor] = useState('agent-supervisor');
  const [mapManager, setMapManager] = useState('underwriter-manager');
  const [mapSupDoa, setMapSupDoa] = useState('1,500,000.00');
  const [mapMgrDoa, setMapMgrDoa] = useState('10,000,000.00');
  const [mapNote, setMapNote] = useState('Marsh sub-channel routes first to Agent Supervisor, then Underwriter Manager.');

  // DOA Simulator & Request state
  const [doaRequester, setDoaRequester] = useState('agent-marsh');
  const [doaAction, setDoaAction] = useState<DoaActionKind>('quote-high-sum-assured');
  const [doaEntity, setDoaEntity] = useState('ALK-CONV');
  const [doaChannel, setDoaChannel] = useState('BROKER-MARSH');
  const [doaSubChannel, setDoaSubChannel] = useState('MARSH-AGENCY');
  const [doaSubject, setDoaSubject] = useState('QUO-MARSH-9921 (Key-Person UL 1.2M AED)');
  const [doaAmount, setDoaAmount] = useState('1,200,000.00');
  const [doaReason, setDoaReason] = useState('Marsh corporate key-person unit-linked quotation above 500k AED broker DOA');
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [decisionNote, setDecisionNote] = useState('Reviewed exposure, income multiple and treaty capacity — approved.');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspectedProfile: RoleRow =
    security.roles.find((p) => p.id === selectedProfileId) ?? security.roles[1] ?? security.roles[0]!;
  const canManageRoles = activeProfile.canManageRoleAccess;
  const canEditInspected = canManageRoles && (activeProfile.unrestricted || activeProfile.authorityRank > inspectedProfile.authorityRank);

  const profileSuggestions = useMemo(
    () =>
      security.roles.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.id})`,
        category: p.doaLimitLabel,
        description: `${p.title} · ${p.entityScope}/${p.channelScope}/${p.subChannelScope}`,
        badge: p.unrestricted ? 'Superuser' : 'Role',
      })),
    [security.roles],
  );

  const visibleProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return security.roles.filter((p) => {
      if (familyFilter !== 'all' && p.family !== familyFilter) return false;
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.channelScope.toLowerCase().includes(q) ||
        p.subChannelScope.toLowerCase().includes(q)
      );
    });
  }, [security.roles, familyFilter, search]);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await onReload();
      setNotice(label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setPermissionLevel = (
    patchKind: 'tab' | 'section' | 'subSection',
    key: string,
    level: AccessLevel,
  ) =>
    runAction(`Updated ${inspectedProfile.name} permission ${key} → ${level.toUpperCase()}`, () =>
      api('/security/profile', 'POST', {
        id: inspectedProfile.id,
        ...(patchKind === 'tab' ? { tabAccess: { [key]: level } } : {}),
        ...(patchKind === 'section' ? { sectionAccess: { [key]: level } } : {}),
        ...(patchKind === 'subSection' ? { subSectionAccess: { [key]: level } } : {}),
        by: activeProfile.id,
      }),
    );

  return (
    <div className="grid">
      <div style={{ gridColumn: '1 / -1' }}>
        {notice && <div className="okBox small" style={{ marginBottom: 10 }}>{notice}</div>}
        {error && <div className="errorBox small" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="scopedBrandBanner" style={{ marginBottom: 10 }}>
          <span className={`pill ${activeProfile.authorityLevel === 'officer' ? 'warn' : 'ok'}`}>
            {activeProfile.authorityLabel} · L{activeProfile.authorityRank}
          </span>
          <span className="small">
            Active role <b>{activeProfile.name}</b> · access changes: <b>{canManageRoles ? 'permitted' : 'not permitted'}</b> · DOA changes: <b>{activeProfile.canChangeDoa ? 'permitted within tier' : 'request only'}</b>
          </span>
          {!canManageRoles && (
            <span className="pill warn" style={{ marginLeft: 'auto' }}>
              Officer tier — use the DOA limit-increase request in the header banner
            </span>
          )}
        </div>
        <SectionGroup
          title="Enterprise Security, AI Role Access Matrix & DOA Governance"
          gates={[
            /* -------------------- GATE 1: 36-PROFILE DIRECTORY & CLONER -------------------- */
            {
              id: 'profile-directory',
              title: `Security role directory & instant session switcher (${security.roleCount} roles)`,
              subtitle: 'Administration holds permanent complete access; switch into any of the 36 operational, technical, finance, fund, agency, Marsh, banca, branch, aggregator, direct or referral roles, or clone a custom variant. Roles are templates; named user logins are a later layer.',
              fields: fields(
                ['Active session role', activeProfile.name],
                ['Inspected role', inspectedProfile.name],
                ['Configured roles', String(security.roleCount)],
                ['Clone ID', cloneId],
                ['Clone name', cloneName],
                ['Clone DOA cap', cloneDoa],
              ),
              children: (
                <>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                    <div className="pills">
                      <button type="button" className={familyFilter === 'all' ? '' : 'ghost'} onClick={() => setFamilyFilter('all')}>
                        All ({security.roleCount})
                      </button>
                      {security.families.map((fam) => (
                        <button
                          key={fam.id}
                          type="button"
                          className={familyFilter === fam.id ? '' : 'ghost'}
                          onClick={() => setFamilyFilter(fam.id)}
                        >
                          {fam.label} ({security.roles.filter((p) => p.family === fam.id).length})
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter 36 roles by name, tier, channel or sub-channel…"
                        style={{ minWidth: 260 }}
                      />
                      <button type="button" className="ghost" onClick={onOpenGate}>
                        Launch Pre-Load Role Selector Gate
                      </button>
                    </div>
                  </div>

                  <div className="tableWrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Entity / Channel / Sub-Channel</th>
                          <th>Landing Screen</th>
                          <th>DOA Authority Cap</th>
                          <th>Supervisor → Manager Chain</th>
                          <th>Tabs (R/W · RO)</th>
                          <th>Inbox / Queue</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleProfiles.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <b>{p.name}</b> <span className="pill">{p.id}</span>
                              <div className="small muted">{p.title}</div>
                            </td>
                            <td className="small">
                              <b>{p.entityScope}</b> / {p.channelScope} / {p.subChannelScope}
                            </td>
                            <td className="small">{tabTitleOf(p.defaultLandingTab)}</td>
                            <td>
                              <span className={`pill ${p.unrestricted ? 'ok' : 'info'}`}>{p.doaLimitLabel}</span>
                            </td>
                            <td className="small">
                              {p.unrestricted
                                ? 'Unrestricted Executive Final Authority'
                                : `${p.reportsToProfileId ?? 'administration'} → ${p.escalationProfileId ?? 'administration'}`}
                            </td>
                            <td className="small">
                              <b>{p.fullTabs.length}</b> Full · <b>{p.readTabs.length}</b> Read
                            </td>
                            <td>
                              {p.pendingApprovals > 0 && <span className="pill warn">{p.pendingApprovals} DOA</span>}{' '}
                              {p.unreadNotifications > 0 && <span className="pill bad">🔔 {p.unreadNotifications}</span>}
                              {p.pendingApprovals === 0 && p.unreadNotifications === 0 && <span className="muted small">clear</span>}
                            </td>
                            <td>
                              <div className="row" style={{ gap: 5 }}>
                                <button
                                  type="button"
                                  disabled={busy || activeProfile.id === p.id}
                                  onClick={() => void onSwitchProfile(p.id)}
                                >
                                  {activeProfile.id === p.id ? 'Active ✓' : 'Switch'}
                                </button>
                                <button
                                  type="button"
                                  className="ghost"
                                  onClick={() => setSelectedProfileId(p.id)}
                                >
                                  Inspect
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="subGrid">
                    <h4>Clone or create a custom regional / desk role</h4>
                    <div className="row" style={{ marginTop: 8 }}>
                      <label>
                        Clone base role
                        <select value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}>
                          {security.roles.map((p) => (
                            <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        New role ID
                        <input value={cloneId} onChange={(e) => setCloneId(e.target.value)} />
                      </label>
                      <label>
                        Display Name
                        <input value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
                      </label>
                      <label>
                        Role Title
                        <input value={cloneTitle} onChange={(e) => setCloneTitle(e.target.value)} style={{ minWidth: 230 }} />
                      </label>
                      <label>
                        DOA Limit (AED)
                        <input value={cloneDoa} onChange={(e) => setCloneDoa(e.target.value)} style={{ width: 135 }} />
                      </label>
                      <button
                        type="button"
                        disabled={busy || !canManageRoles}
                        onClick={() =>
                          void runAction(`Cloned role ${cloneName} (${cloneId})`, () =>
                            api('/security/profile', 'POST', {
                              id: cloneId,
                              name: cloneName,
                              title: cloneTitle,
                              cloneFromProfileId: selectedProfileId,
                              doaLimitAed: cloneDoa,
                              by: activeProfile.id,
                            }),
                          )
                        }
                      >
                        + Clone &amp; Save Role
                      </button>
                    </div>
                  </div>
                </>
              ),
            },

            /* -------------------- GATE 2: AI ROLE ACCESS & SOD ADVISOR -------------------- */
            {
              id: 'ai-advisor',
              title: 'AI optimal access recommender & Segregation-of-Duties (SoD) advisor',
              subtitle: `Scores all ${CONSOLE_TABS.length} tabs, sections and sub-sections per role, recommends DOA caps and reporting chains, flags toxic SoD pairs, and applies with one click`,
              fields: fields(
                ['Target role', inspectedProfile.name],
                ['AI confidence', `${inspectedProfile.aiConfidencePct}%`],
                ['Recommended DOA', inspectedProfile.doaLimitLabel],
                ['Recommended landing tab', tabTitleOf(inspectedProfile.defaultLandingTab)],
              ),
              children: (
                <>
                  <div className="row">
                    <label>
                      Target security role
                      <select value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}>
                        {security.roles.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} — {p.title}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ flex: 1, minWidth: 280 }}>
                      Optional Free-Text Role Mandate (for AI Archetype Matching)
                      <input
                        value={advisorRoleText}
                        onChange={(e) => setAdvisorRoleText(e.target.value)}
                        placeholder="e.g. Senior Marsh bancassurance wealth specialist handling Takaful & UL up to 500k AED"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError(null);
                        try {
                          const res = await api<{ recommendation: AiRecommendationView }>('/security/ai/recommend', 'POST', {
                            profileId: selectedProfileId,
                            roleDescription: advisorRoleText,
                          });
                          setAiResult(res.recommendation);
                          await onReload();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      ✦ Run AI Access &amp; SoD Advisor
                    </button>
                    {!inspectedProfile.unrestricted && (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || !canEditInspected}
                        onClick={() =>
                          void runAction(`Applied AI optimal permissions to ${inspectedProfile.name}`, async () => {
                            const res = await api<{ recommendation: AiRecommendationView }>('/security/ai/apply', 'POST', {
                              profileId: inspectedProfile.id,
                              actor: activeProfile.id,
                            });
                            setAiResult(res.recommendation);
                          })
                        }
                      >
                        ✓ Apply AI Recommendation to {inspectedProfile.name}
                      </button>
                    )}
                  </div>

                  {aiResult && (
                    <div className="manualCard" style={{ marginTop: 12 }}>
                      <div className="pills">
                        <span className="pill ok">AI Confidence {aiResult.confidencePct}%</span>
                        <span className="pill info">Role: {aiResult.profileName}</span>
                        <span className="pill info">Recommended DOA: {aiResult.recommendedDoaLimit}</span>
                        <span className="pill info">Landing: {tabTitleOf(aiResult.recommendedLandingTab)}</span>
                        <span className="pill">
                          Chain: {aiResult.recommendedSupervisorProfileId ?? 'None'} → {aiResult.recommendedEscalationProfileId ?? 'Admin'}
                        </span>
                      </div>
                      <p className="small" style={{ marginTop: 8 }}>{aiResult.rationale}</p>
                      {aiResult.sodWarnings.length > 0 ? (
                        <div className="errorBox small">
                          <b>Segregation-of-Duties Alert:</b> {aiResult.sodWarnings.join(' | ')}
                        </div>
                      ) : (
                        <div className="okBox small">
                          ✓ Clean Segregation-of-Duties check — zero toxic approval/settlement/master-config combinations on this role.
                        </div>
                      )}
                      <div className="tableWrap" style={{ marginTop: 10 }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Tab</th>
                              <th>Recommended Level</th>
                              <th>AI Fit Score</th>
                              <th>Sections &amp; Sub-Sections Included</th>
                              <th>Explainable Rationale</th>
                            </tr>
                          </thead>
                          <tbody>
                            {aiResult.tabs.filter((t) => t.level !== 'none').map((t) => (
                              <tr key={t.tabId}>
                                <td><b>{t.label}</b></td>
                                <td><span className={`pill ${t.level === 'full' ? 'ok' : 'info'}`}>{t.level.toUpperCase()}</span></td>
                                <td>{t.scorePct}%</td>
                                <td className="small">
                                  {t.sections.map((s) => `${s.label} [${s.level}] (${s.subSections.length} sub)`).join(' · ')}
                                </td>
                                <td className="small muted">{t.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              ),
            },

            /* -------------------- GATE 3: 3-TIER RBAC MATRIX EDITOR -------------------- */
            {
              id: 'matrix-editor',
              title: `Granular 3-tier access matrix: Tab → Section → Sub-Section (${inspectedProfile.name})`,
              subtitle: 'Toggle Full Read/Write, Read-Only or Hidden on any tab, section or sub-section with instant persistence',
              fields: fields(
                ['Editing role', inspectedProfile.name],
                ['Full tabs', String(inspectedProfile.fullTabs.length)],
                ['Read-only tabs', String(inspectedProfile.readTabs.length)],
                ['PII visibility', inspectedProfile.piiAccess],
              ),
              children: (
                <>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <label>
                      Editing security role
                      <select value={inspectedProfile.id} onChange={(e) => setSelectedProfileId(e.target.value)}>
                        {security.roles.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                        ))}
                      </select>
                    </label>
                    {inspectedProfile.unrestricted && (
                      <span className="pill ok">
                        Administration holds permanent complete Full Access across all {CONSOLE_TABS.length} tabs, sections and sub-sections
                      </span>
                    )}
                    {!canEditInspected && (
                      <span className="pill warn">
                        {canManageRoles
                          ? 'Read-only: this role is at or above your own authority tier.'
                          : 'Read-only: officer-tier roles cannot change access. Use the DOA limit-increase request instead.'}
                      </span>
                    )}
                  </div>
                  <div className="tableWrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Top-Level Tab</th>
                          <th>Tab Access</th>
                          <th>Sections &amp; Granular Sub-Sections (Click to Toggle Full / Read / Hidden)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {security.catalogue.map((cat) => {
                          const tLevel: AccessLevel = inspectedProfile.unrestricted
                            ? 'full'
                            : (inspectedProfile.tabAccess[cat.tabId] ?? 'none');
                          return (
                            <tr key={cat.tabId}>
                              <td>
                                <b>{cat.label}</b> <span className="muted small">({cat.tabId})</span>
                              </td>
                              <td>
                                <div className="row" style={{ gap: 4 }}>
                                  {(['full', 'read', 'none'] as AccessLevel[]).map((lvl) => (
                                    <button
                                      key={lvl}
                                      type="button"
                                      disabled={busy || inspectedProfile.unrestricted || !canEditInspected}
                                      className={tLevel === lvl ? '' : 'ghost'}
                                      style={{ padding: '3px 8px', fontSize: 11 }}
                                      onClick={() => void setPermissionLevel('tab', cat.tabId, lvl)}
                                    >
                                      {lvl}
                                    </button>
                                  ))}
                                </div>
                              </td>
                              <td>
                                {cat.sections.map((sec) => {
                                  const sKey = `${cat.tabId}:${sec.id}`;
                                  const sLevel: AccessLevel = inspectedProfile.unrestricted
                                    ? 'full'
                                    : (inspectedProfile.sectionAccess[sKey] ?? tLevel);
                                  return (
                                    <div key={sKey} style={{ marginBottom: 6 }}>
                                      <div className="row" style={{ gap: 6 }}>
                                        <span className="small"><b>{sec.label}</b>:</span>
                                        {(['full', 'read', 'none'] as AccessLevel[]).map((lvl) => (
                                          <button
                                            key={lvl}
                                            type="button"
                                            disabled={busy || inspectedProfile.unrestricted || !canEditInspected}
                                            className={sLevel === lvl ? '' : 'ghost'}
                                            style={{ padding: '2px 6px', minHeight: 22, fontSize: 10.5 }}
                                            onClick={() => void setPermissionLevel('section', sKey, lvl)}
                                          >
                                            {lvl}
                                          </button>
                                        ))}
                                        {sec.subSections.map((sub) => {
                                          const subKey = `${sKey}:${sub.id}`;
                                          const subLevel: AccessLevel = inspectedProfile.unrestricted
                                            ? 'full'
                                            : (inspectedProfile.subSectionAccess[subKey] ?? sLevel);
                                          const nextLvl: AccessLevel =
                                            subLevel === 'full' ? 'read' : subLevel === 'read' ? 'none' : 'full';
                                          return (
                                            <button
                                              key={subKey}
                                              type="button"
                                              className="ghost"
                                              disabled={busy || inspectedProfile.unrestricted || !canEditInspected}
                                              title={`Click to cycle sub-section "${sub.label}" (${subLevel} → ${nextLvl})`}
                                              style={{ padding: '2px 7px', minHeight: 22, fontSize: 10.5 }}
                                              onClick={() => void setPermissionLevel('subSection', subKey, nextLvl)}
                                            >
                                              {sub.label}: <b>{subLevel}</b>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ),
            },

            /* -------------------- GATE 4: ENTITY × CHANNEL × SUB-CHANNEL MAPPER -------------------- */
            {
              id: 'supervision-map',
              title: `Entity × Channel × Sub-Channel supervisor & manager hierarchy (${security.supervisionMappings.length} chains)`,
              subtitle: 'Determines which Supervisor and Escalation Manager receive DOA approval requests and notifications for every legal entity, distribution channel and sub-channel desk',
              fields: fields(
                ['Entity', mapEntity],
                ['Channel', mapChannel],
                ['Sub-channel', mapSubChannel],
                ['First-line supervisor', mapSupervisor],
                ['Escalation manager', mapManager],
                ['Supervisor DOA cap', mapSupDoa],
                ['Manager DOA cap', mapMgrDoa],
              ),
              children: (
                <>
                  <div className="row">
                    <label>
                      Legal Entity
                      <SmartComboBox value={mapEntity} onChange={setMapEntity} suggestions={ENTITY_SUGGESTIONS} style={{ width: 200 }} />
                    </label>
                    <label>
                      Channel
                      <SmartComboBox value={mapChannel} onChange={setMapChannel} suggestions={CHANNEL_SUGGESTIONS} style={{ width: 215 }} />
                    </label>
                    <label>
                      Sub-Channel / Desk
                      <SmartComboBox value={mapSubChannel} onChange={setMapSubChannel} suggestions={SUB_CHANNEL_SUGGESTIONS} style={{ width: 220 }} />
                    </label>
                    <label>
                      Department / Desk Label
                      <input value={mapDept} onChange={(e) => setMapDept(e.target.value)} style={{ minWidth: 230 }} />
                    </label>
                  </div>
                  <div className="row">
                    <label style={{ minWidth: 280 }}>
                      Officer / frontline roles covered
                      <SmartMultiComboBox values={mapOfficers} onChange={setMapOfficers} suggestions={profileSuggestions} />
                    </label>
                    <label>
                      1st-line supervisor role
                      <SmartComboBox value={mapSupervisor} onChange={setMapSupervisor} suggestions={profileSuggestions} style={{ width: 200 }} />
                    </label>
                    <label>
                      Supervisor DOA (AED)
                      <input value={mapSupDoa} onChange={(e) => setMapSupDoa(e.target.value)} style={{ width: 130 }} />
                    </label>
                    <label>
                      2nd-line manager role
                      <SmartComboBox value={mapManager} onChange={setMapManager} suggestions={profileSuggestions} style={{ width: 200 }} />
                    </label>
                    <label>
                      Manager DOA (AED)
                      <input value={mapMgrDoa} onChange={(e) => setMapMgrDoa(e.target.value)} style={{ width: 130 }} />
                    </label>
                    <label style={{ flex: 1, minWidth: 220 }}>
                      Routing Note
                      <input value={mapNote} onChange={(e) => setMapNote(e.target.value)} />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !canManageRoles}
                      onClick={() =>
                        void runAction(`Saved Entity × Channel × Sub-Channel rule (${mapEntity}/${mapChannel}/${mapSubChannel})`, () =>
                          api('/security/mapping', 'POST', {
                            entityId: mapEntity,
                            channelCode: mapChannel,
                            subChannelCode: mapSubChannel,
                            department: mapDept,
                            officerProfileIds: mapOfficers,
                            supervisorProfileId: mapSupervisor,
                            managerProfileId: mapManager,
                            supervisorDoaLimitAed: mapSupDoa,
                            managerDoaLimitAed: mapMgrDoa,
                            note: mapNote,
                            by: activeProfile.id,
                          }),
                        )
                      }
                    >
                      + Save Supervision Chain
                    </button>
                  </div>

                  <div className="tableWrap" style={{ marginTop: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Rule ID</th>
                          <th>Entity</th>
                          <th>Channel</th>
                          <th>Sub-Channel</th>
                          <th>Department / Desk</th>
                          <th>Officers Covered</th>
                          <th>1st-Line Supervisor (DOA)</th>
                          <th>2nd-Line Manager (DOA)</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {security.supervisionMappings.map((m) => (
                          <tr key={m.id}>
                            <td><b>{m.id}</b></td>
                            <td><span className="pill info">{m.entityId}</span></td>
                            <td><b>{m.channelCode}</b></td>
                            <td><code>{m.subChannelCode}</code></td>
                            <td className="small">{m.department}</td>
                            <td className="small">{m.officerProfileIds.join(', ')}</td>
                            <td className="small">
                              <b>{m.supervisorProfileId}</b> ({m.supervisorDoaLimitLabel})
                            </td>
                            <td className="small">
                              <b>{m.managerProfileId}</b> ({m.managerDoaLimitLabel})
                            </td>
                            <td>
                              <button
                                type="button"
                                className="ghost"
                                disabled={busy || !canManageRoles}
                                onClick={() =>
                                  void runAction(`Removed mapping ${m.id}`, () =>
                                    api('/security/mapping/delete', 'POST', { id: m.id, by: activeProfile.id }),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ),
            },

            /* -------------------- GATE 5: DOA APPROVAL WORKFLOW & NOTIFICATIONS -------------------- */
            {
              id: 'doa-queue',
              title: `DOA authority simulator, approval queue & approver notifications (${security.doaRequests.length} requests · ${security.notifications.length} notifications)`,
              subtitle: 'Evaluate authority before execution, submit DOA approval requests with real-time approver notifications, and approve, escalate or reject with full four-eyes audit trail',
              fields: fields(
                ['Requester role', doaRequester],
                ['Action kind', doaAction],
                ['Entity / Channel / Sub', `${doaEntity} / ${doaChannel} / ${doaSubChannel}`],
                ['Subject reference', doaSubject],
                ['Amount (AED)', doaAmount],
                ['Decision note', decisionNote],
              ),
              children: (
                <>
                  <div className="row">
                    <label>
                      Requester role
                      <select value={doaRequester} onChange={(e) => setDoaRequester(e.target.value)}>
                        {security.roles.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} (DOA {p.doaLimitLabel})</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      DOA Action Category
                      <select value={doaAction} onChange={(e) => setDoaAction(e.target.value as DoaActionKind)}>
                        {DOA_ACTION_OPTIONS.map((a) => (
                          <option key={a.value} value={a.value}>{a.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Entity
                      <SmartComboBox value={doaEntity} onChange={setDoaEntity} suggestions={ENTITY_SUGGESTIONS} style={{ width: 150 }} />
                    </label>
                    <label>
                      Channel
                      <SmartComboBox value={doaChannel} onChange={setDoaChannel} suggestions={CHANNEL_SUGGESTIONS} style={{ width: 175 }} />
                    </label>
                    <label>
                      Sub-Channel
                      <SmartComboBox value={doaSubChannel} onChange={setDoaSubChannel} suggestions={SUB_CHANNEL_SUGGESTIONS} style={{ width: 185 }} />
                    </label>
                  </div>
                  <div className="row">
                    <label>
                      Case / Reference ID
                      <input value={doaSubject} onChange={(e) => setDoaSubject(e.target.value)} style={{ minWidth: 230 }} />
                    </label>
                    <label>
                      Transaction Amount (AED)
                      <input value={doaAmount} onChange={(e) => setDoaAmount(e.target.value)} style={{ width: 145 }} />
                    </label>
                    <label style={{ flex: 1, minWidth: 250 }}>
                      Justification / Underwriting Note
                      <input value={doaReason} onChange={(e) => setDoaReason(e.target.value)} />
                    </label>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const res = await api<{ evaluation: Record<string, unknown> }>('/security/doa/evaluate', 'POST', {
                            requesterProfileId: doaRequester,
                            actionKind: doaAction,
                            entityId: doaEntity,
                            channelCode: doaChannel,
                            subChannelCode: doaSubChannel,
                            amount: doaAmount,
                          });
                          setSimResult(res.evaluation);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Simulate DOA Routing
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction('DOA request submitted and approver notified', () =>
                          api('/security/doa/request', 'POST', {
                            requesterProfileId: doaRequester,
                            actionKind: doaAction,
                            subjectRef: doaSubject,
                            tabId: 'underwriting',
                            entityId: doaEntity,
                            channelCode: doaChannel,
                            subChannelCode: doaSubChannel,
                            amount: doaAmount,
                            reason: doaReason,
                          }),
                        )
                      }
                    >
                      Submit DOA Request &amp; Notify Approver →
                    </button>
                  </div>

                  {simResult && (
                    <div className="manualCard" style={{ marginTop: 8 }}>
                      <b>DOA Evaluation Preview:</b>{' '}
                      <span className={`pill ${simResult['authorizedWithinDoa'] ? 'ok' : 'warn'}`}>
                        {simResult['authorizedWithinDoa'] ? 'WITHIN AUTHORITY' : 'REQUIRES DOA APPROVAL'}
                      </span>{' '}
                      <span className="small">{String(simResult['explanation'] ?? '')}</span>
                    </div>
                  )}

                  <div className="row" style={{ marginTop: 12 }}>
                    <label style={{ flex: 1 }}>
                      Approver Decision Note (recorded on immutable DOA trail &amp; sent back to requester)
                      <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} />
                    </label>
                  </div>

                  <div className="tableWrap" style={{ marginTop: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Request ID</th>
                          <th>Requester &amp; Scope</th>
                          <th>Action &amp; Reference</th>
                          <th>Amount vs Cap</th>
                          <th>Assigned Approver → Escalation</th>
                          <th>Status &amp; History</th>
                          <th>Approver Decision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {security.doaRequests.map((req) => (
                          <tr key={req.id}>
                            <td><b>{req.id}</b></td>
                            <td className="small">
                              <b>{req.requesterName}</b>
                              <div className="muted">{req.entityId} / {req.channelCode} / {req.subChannelCode}</div>
                            </td>
                            <td className="small">
                              <b>{req.subjectRef}</b>
                              <div className="muted">{req.actionKind} · {req.reason}</div>
                            </td>
                            <td className="small">
                              <b>{req.amountLabel}</b>
                              <div className="muted">Cap: {req.requesterLimitLabel}</div>
                            </td>
                            <td className="small">
                              <b>{req.assignedApproverName}</b> → {req.escalationApproverName}
                              {req.matchedMappingId && <div className="muted">Rule {req.matchedMappingId}</div>}
                            </td>
                            <td className="small">
                              <span
                                className={`pill ${
                                  req.status === 'approved'
                                    ? 'ok'
                                    : req.status === 'rejected'
                                      ? 'bad'
                                      : 'warn'
                                }`}
                              >
                                {req.status}
                              </span>
                              <div className="muted">{req.history[req.history.length - 1]?.note}</div>
                            </td>
                            <td>
                              {req.status === 'pending' || req.status === 'escalated' ? (
                                <div className="row" style={{ gap: 5 }}>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void runAction(`Approved ${req.id} as ${activeProfile.name}`, () =>
                                        api('/security/doa/decide', 'POST', {
                                          requestId: req.id,
                                          actorProfileId: activeProfile.id,
                                          decision: 'approve',
                                          note: decisionNote,
                                        }),
                                      )
                                    }
                                  >
                                    ✓ Approve
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                      void runAction(`Escalated ${req.id} to next-tier manager`, () =>
                                        api('/security/doa/decide', 'POST', {
                                          requestId: req.id,
                                          actorProfileId: activeProfile.id,
                                          decision: 'escalate',
                                          note: decisionNote,
                                        }),
                                      )
                                    }
                                  >
                                    ↑ Escalate
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                      void runAction(`Rejected ${req.id}`, () =>
                                        api('/security/doa/decide', 'POST', {
                                          requestId: req.id,
                                          actorProfileId: activeProfile.id,
                                          decision: 'reject',
                                          note: decisionNote,
                                        }),
                                      )
                                    }
                                  >
                                    ✕ Reject
                                  </button>
                                </div>
                              ) : (
                                <span className="muted small">Finalised</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="subGrid">
                    <h4>Approver Notification Log &amp; Security Audit Trail</h4>
                    <div className="tableWrap" style={{ marginTop: 8 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Notification ID</th>
                            <th>Recipient role</th>
                            <th>Sender</th>
                            <th>Title &amp; Delivery Summary</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {security.notifications.slice(0, 12).map((n) => (
                            <tr key={n.id}>
                              <td><b>{n.id}</b></td>
                              <td><span className="pill info">{n.recipientProfileId}</span></td>
                              <td className="small">{n.senderProfileId}</td>
                              <td className="small">
                                <b>{n.title}</b>
                                <div className="muted">{n.body}</div>
                              </td>
                              <td>
                                <span className={`pill ${n.read ? 'ok' : 'warn'}`}>{n.read ? 'read' : 'unread'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
};


/* Role-first component aliases. The old names remain so existing integrations and tests keep working. */
export const RoleSelectionGate = ProfileSelectionGate;
export const RoleAccessGuardBanner = ProfileAccessGuardBanner;
