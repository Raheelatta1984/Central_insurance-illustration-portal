/**
 * Role access matrix — the Tab → Section → Sub-Section switchboard, and the DOA authority desk.
 *
 * Two ideas drive this screen:
 *
 *  1. **A role is not a user account.** The 36 seeded records are roles: the policy office, the
 *     underwriter, the branch officer, the claims manager. Named users, passwords and login will be
 *     provisioned against a role id when the user-profile layer lands; no credentials live here.
 *
 *  2. **Visibility is a tree, not a flat list.** A tab contains sections; a section contains
 *     sub-sections. A node inherits from its parent until an explicit override is filed, and changing
 *     a parent re-seats the branch. That is what stops a hidden section from leaking a visible child.
 *
 * DOA changes are a supervisor / manager act. An officer-tier role never sees this screen and cannot
 * change a cap even by calling the API: it raises a tracked limit-increase request instead, which the
 * mapped supervisor or manager approves and which is the only path that moves the cap.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { ADMIN_ONLY_TAB_IDS, type AccessLevel, type DoaActionKind } from '../core/rbac';
import { api } from './api';
import { SectionStack, type SectionModel } from './sections';

type SecuritySnap = WorldSnapshot['security'];
type RoleRow = SecuritySnap['roles'][number];

const LEVEL_LABEL: Record<AccessLevel, string> = {
  full: 'Full — visible & editable',
  read: 'Read-only — visible, locked',
  none: 'Hidden — not in navigation',
};

const LEVEL_TONE: Record<AccessLevel, 'ok' | 'warn' | 'bad'> = {
  full: 'ok',
  read: 'warn',
  none: 'bad',
};

const DOA_ACTION_OPTIONS: ReadonlyArray<{ value: DoaActionKind; label: string }> = [
  { value: 'quote-high-sum-assured', label: 'High sum-assured quotation / illustration' },
  { value: 'underwriting-approval', label: 'Underwriting acceptance / loading override' },
  { value: 'retention-waiver', label: 'Retention / surrender fee waiver' },
  { value: 'endorsement-alteration', label: 'Financial / non-financial endorsement' },
  { value: 'claim-approval', label: 'Claim reserve & adjudication approval' },
  { value: 'settlement-release', label: 'Cash claim / maturity settlement release' },
  { value: 'reinsurance-placement', label: 'Treaty cession / facultative placement' },
  { value: 'fund-nav-signoff', label: 'Fund creation / daily NAV sign-off' },
  { value: 'accounting-voucher', label: 'Accounting voucher / batch posting' },
  { value: 'discount-concession', label: 'Commission / fee concession' },
  { value: 'master-config-change', label: 'Master settings / tariff filing' },
  { value: 'restricted-section-access', label: 'Restricted section access' },
];

function effectiveTab(role: RoleRow, tabId: string): AccessLevel {
  return role.tabAccess[tabId] ?? 'none';
}

function effectiveSection(role: RoleRow, tabId: string, sectionId: string): AccessLevel {
  return role.sectionAccess[`${tabId}:${sectionId}`] ?? effectiveTab(role, tabId);
}

function effectiveSubSection(role: RoleRow, tabId: string, sectionId: string, subSectionId: string): AccessLevel {
  return role.subSectionAccess[`${tabId}:${sectionId}:${subSectionId}`] ?? effectiveSection(role, tabId, sectionId);
}

const LevelPill: React.FC<{ level: AccessLevel; inherited?: boolean }> = ({ level, inherited }) => (
  <span className={`pill ${LEVEL_TONE[level]}`} style={{ fontSize: 10.5, padding: '1px 6px' }}>
    {level.toUpperCase()}{inherited ? ' · inherit' : ' · explicit'}
  </span>
);

const TierPill: React.FC<{ level: RoleRow['authorityLevel']; rank: number }> = ({ level, rank }) => (
  <span className={`pill ${level === 'executive' ? 'ok' : level === 'manager' ? 'info' : level === 'supervisor' ? 'warn' : ''}`} style={{ fontSize: 10.5 }}>
    {level.toUpperCase()} · L{rank}
  </span>
);

export const RoleAccessMatrixPanel: React.FC<{
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onSwitchRole: (roleId: string) => Promise<void>;
  /** Deep-link / test hook: which section opens first. Defaults to the role directory. */
  initialSection?: 'role-directory' | 'access-tree' | 'doa-limits' | 'role-audit';
}> = ({ data, onReload, onSwitchRole, initialSection = 'role-directory' }) => {
  const security = data.security;
  const roles = security.roles;
  const activeRole = roles.find((r) => r.id === security.activeRoleId) ?? roles[0]!;

  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('claim-officer');
  const [doaLimitDraft, setDoaLimitDraft] = useState('');
  const [doaActionsDraft, setDoaActionsDraft] = useState<DoaActionKind[]>([]);
  const [increaseAmount, setIncreaseAmount] = useState('');
  const [increaseReason, setIncreaseReason] = useState('Operational case volume and case size now exceed the current cap.');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? roles.find((r) => r.id !== 'administration') ?? roles[0]!;

  // Keep the DOA editor in step with the inspected role, without letting a stale draft survive a
  // role change (a cap typed for one role must never be saved onto another).
  useEffect(() => {
    setDoaLimitDraft(selectedRole.doaLimitMinor === null ? 'Unlimited' : selectedRole.doaLimitLabel.replace(/\s+AED$/, ''));
    setDoaActionsDraft([...selectedRole.doaActions]);
    setIncreaseAmount(selectedRole.doaLimitMinor === null ? '' : selectedRole.doaLimitLabel.replace(/\s+AED$/, ''));
    setNotice(null);
    setError(null);
  }, [selectedRole.id, selectedRole.doaLimitMinor, selectedRole.doaLimitLabel, selectedRole.doaActions]);

  const visibleRoles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roles.filter((r) => {
      if (familyFilter !== 'all' && r.family !== familyFilter) return false;
      if (!q) return true;
      return [r.id, r.name, r.title, r.authorityLevel, r.channelScope, r.subChannelScope]
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [roles, familyFilter, search]);

  const selectedIsLowerTier = Boolean(
    activeRole.unrestricted || activeRole.authorityRank > selectedRole.authorityRank,
  );
  const canEditVisibility = Boolean(activeRole.canManageRoleAccess && selectedIsLowerTier);
  const canEditDoa = Boolean(activeRole.canChangeDoa && selectedIsLowerTier);
  const canRequestIncrease = Boolean(
    !selectedRole.unrestricted
      && selectedRole.doaLimitMinor !== null
      && (activeRole.unrestricted || activeRole.id === selectedRole.id || activeRole.authorityRank > selectedRole.authorityRank),
  );
  const pendingIncreases = security.doaRequests.filter(
    (r) => r.actionKind === 'doa-limit-increase' && r.requesterProfileId === selectedRole.id && (r.status === 'pending' || r.status === 'escalated'),
  );

  const run = async (label: string, fn: () => Promise<unknown>) => {
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

  const setNode = (kind: 'tab' | 'section' | 'subSection', key: string, level: AccessLevel | 'inherit') =>
    run(`${kind === 'tab' ? 'Tab' : kind === 'section' ? 'Section' : 'Sub-section'} ${key} on ${selectedRole.name} → ${level.toUpperCase()}`, () =>
      api('/security/role/access', 'POST', {
        roleId: selectedRole.id,
        kind,
        key,
        level,
        actorRoleId: activeRole.id,
      }));

  const saveDoa = () =>
    run(`DOA authority saved for ${selectedRole.name}`, () =>
      api('/security/role/doa', 'POST', {
        roleId: selectedRole.id,
        doaLimitAed: doaLimitDraft.trim().toLowerCase() === 'unlimited' ? null : doaLimitDraft,
        doaActions: doaActionsDraft,
        actorRoleId: activeRole.id,
      }));

  const requestIncrease = () =>
    run(`DOA limit-increase request submitted for ${selectedRole.name}`, () =>
      api('/security/doa/limit-request', 'POST', {
        roleId: selectedRole.id,
        requestedLimitAed: increaseAmount,
        reason: increaseReason,
        actorRoleId: activeRole.id,
      }));

  const toggleAction = (action: DoaActionKind) => {
    setDoaActionsDraft((current) =>
      current.includes(action) ? current.filter((a) => a !== action) : [...current, action],
    );
  };

  const rolesByFamily = security.families.map((fam) => ({
    ...fam,
    count: roles.filter((r) => r.family === fam.id).length,
  }));

  const directory = (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="pills" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={familyFilter === 'all' ? '' : 'ghost'} onClick={() => setFamilyFilter('all')}>
            All roles ({security.roleCount})
          </button>
          {rolesByFamily.map((fam) => (
            <button
              key={fam.id}
              type="button"
              className={familyFilter === fam.id ? '' : 'ghost'}
              onClick={() => setFamilyFilter(fam.id)}
            >
              {fam.label} ({fam.count})
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search roles by name, tier, channel or desk…"
          style={{ minWidth: 280 }}
        />
      </div>

      <div className="pills" style={{ marginBottom: 10, gap: 8 }}>
        {security.authorities.map((tier) => (
          <span key={tier.id} className="pill info" title={tier.description}>
            <b>{tier.label}</b> · rank {tier.rank} · {tier.canChangeDoa ? 'may change DOA' : 'request only'}
          </span>
        ))}
        <span className="pill">{security.userProfileLayer.implemented ? 'user accounts live' : 'roles only — user logins are a later layer'}</span>
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Authority tier</th>
              <th>Entity / Channel / Sub-channel</th>
              <th>DOA cap</th>
              <th>Tabs (Full · Read)</th>
              <th>Landing screen</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRoles.map((role) => (
              <tr key={role.id} style={role.id === selectedRole.id ? { background: 'rgba(62,166,255,.08)' } : undefined}>
                <td>
                  <b>{role.name}</b> <span className="pill" style={{ fontSize: 10 }}>{role.id}</span>
                  <div className="small muted">{role.title}</div>
                </td>
                <td><TierPill level={role.authorityLevel} rank={role.authorityRank} /></td>
                <td className="small">{role.entityScope} / {role.channelScope} / {role.subChannelScope}</td>
                <td><span className={`pill ${role.unrestricted ? 'ok' : 'info'}`}>{role.doaLimitLabel}</span></td>
                <td className="small"><b>{role.fullTabs.length}</b> · <b>{role.readTabs.length}</b></td>
                <td className="small">{role.defaultLandingTab}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="ghost" onClick={() => setSelectedRoleId(role.id)}>
                      Inspect tree
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || role.id === activeRole.id}
                      onClick={() => void onSwitchRole(role.id)}
                    >
                      {role.id === activeRole.id ? 'Active' : 'Switch session'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  const tree = (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="small">
            Editing role{' '}
            <select value={selectedRole.id} onChange={(e) => setSelectedRoleId(e.target.value)}>
              {roles.filter((r) => r.id !== 'administration').map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.id}) — {r.authorityLevel} L{r.authorityRank}</option>
              ))}
            </select>
          </label>
          <TierPill level={selectedRole.authorityLevel} rank={selectedRole.authorityRank} />
          <span className={`pill ${selectedRole.doaLimitMinor === null ? 'ok' : 'info'}`}>DOA {selectedRole.doaLimitLabel}</span>
        </div>
        <div className="pills" style={{ gap: 6 }}>
          <span className={`pill ${canEditVisibility ? 'ok' : 'bad'}`}>
            {canEditVisibility ? `Editable as ${activeRole.name}` : activeRole.canManageRoleAccess ? 'Read-only for this tier' : 'Officer — no access management'}
          </span>
        </div>
      </div>

      {!canEditVisibility && (
        <div className="warnBox small" style={{ marginBottom: 10 }}>
          {activeRole.canManageRoleAccess
            ? <>You may not change a role at or above your own authority tier. A {activeRole.authorityLevel} role can edit roles below it only.</>
            : <>Officer-tier roles cannot change section visibility or DOA limits. Raise a DOA limit-increase request below instead; a supervisor or manager must approve it.</>}
        </div>
      )}

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: '48%' }}>Tab / Section / Sub-section</th>
              <th>Level for {selectedRole.name}</th>
              <th>Effective access</th>
            </tr>
          </thead>
          <tbody>
            {security.catalogue.map((cat) => {
              const adminOnlyTab = ADMIN_ONLY_TAB_IDS.has(cat.tabId);
              const tabLevel = adminOnlyTab && !selectedRole.unrestricted ? 'none' : effectiveTab(selectedRole, cat.tabId);
              return (
                <React.Fragment key={cat.tabId}>
                  <tr>
                    <td>
                      <b>{cat.label}</b> <span className="muted small">({cat.tabId})</span>
                      {adminOnlyTab && <span className="pill warn" style={{ marginLeft: 6, fontSize: 10 }}>Administration only</span>}
                    </td>
                    <td>
                      <select
                        value={tabLevel}
                        disabled={busy || !canEditVisibility || adminOnlyTab}
                        onChange={(e) => void setNode('tab', cat.tabId, e.target.value as AccessLevel)}
                        style={{ minWidth: 210 }}
                      >
                        {(['full', 'read', 'none'] as AccessLevel[]).map((level) => (
                          <option key={level} value={level}>{LEVEL_LABEL[level]}</option>
                        ))}
                      </select>
                    </td>
                    <td><LevelPill level={tabLevel} /></td>
                  </tr>
                  {cat.sections.map((sec) => {
                    const sectionKey = `${cat.tabId}:${sec.id}`;
                    const sectionLevel = adminOnlyTab && !selectedRole.unrestricted ? 'none' : effectiveSection(selectedRole, cat.tabId, sec.id);
                    const sectionExplicit = !adminOnlyTab && selectedRole.sectionAccess[sectionKey] !== undefined;
                    return (
                      <React.Fragment key={sectionKey}>
                        <tr>
                          <td style={{ paddingLeft: 26 }}>
                            <b>{sec.label}</b>
                            <div className="small muted">section · {sec.id}</div>
                          </td>
                          <td>
                            <select
                              value={sectionExplicit ? sectionLevel : 'inherit'}
                              disabled={busy || !canEditVisibility || adminOnlyTab}
                              onChange={(e) => void setNode('section', sectionKey, e.target.value as AccessLevel | 'inherit')}
                              style={{ minWidth: 210 }}
                            >
                              <option value="inherit">inherit from tab → {tabLevel}</option>
                              {(['full', 'read', 'none'] as AccessLevel[]).map((level) => (
                                <option key={level} value={level}>{LEVEL_LABEL[level]}</option>
                              ))}
                            </select>
                          </td>
                          <td><LevelPill level={sectionLevel} inherited={!sectionExplicit} /></td>
                        </tr>
                        {sec.subSections.map((sub) => {
                          const subKey = `${sectionKey}:${sub.id}`;
                          const subLevel = effectiveSubSection(selectedRole, cat.tabId, sec.id, sub.id);
                          const subExplicit = selectedRole.subSectionAccess[subKey] !== undefined;
                          return (
                            <tr key={subKey}>
                              <td style={{ paddingLeft: 52 }} className="small">
                                ↳ {sub.label} <span className="muted">({sub.id})</span>
                              </td>
                              <td>
                                <select
                                  value={subExplicit ? subLevel : 'inherit'}
                                  disabled={busy || !canEditVisibility}
                                  onChange={(e) => void setNode('subSection', subKey, e.target.value as AccessLevel | 'inherit')}
                                  style={{ minWidth: 210 }}
                                >
                                  <option value="inherit">inherit from section → {sectionLevel}</option>
                                  {(['full', 'read', 'none'] as AccessLevel[]).map((level) => (
                                    <option key={level} value={level}>{LEVEL_LABEL[level]}</option>
                                  ))}
                                </select>
                              </td>
                              <td><LevelPill level={subLevel} inherited={!subExplicit} /></td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  const doaLimits = (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="small">
            Role{' '}
            <select value={selectedRole.id} onChange={(e) => setSelectedRoleId(e.target.value)}>
              {roles.filter((r) => r.id !== 'administration').map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({r.id})</option>
              ))}
            </select>
          </label>
          <span className={`pill ${selectedRole.doaLimitMinor === null ? 'ok' : 'info'}`}>Current cap {selectedRole.doaLimitLabel}</span>
          <span className="pill">{selectedRole.doaActions.length} DOA action kind(s)</span>
        </div>
        <span className={`pill ${canEditDoa ? 'ok' : 'warn'}`}>
          {canEditDoa ? 'Supervisor/manager editing enabled' : activeRole.canChangeDoa ? 'Read-only for this target' : 'Officer — request only'}
        </span>
      </div>

      <div className="manualCard" style={{ marginBottom: 12 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Direct DOA change (supervisor / manager only)</div>
        {!activeRole.canChangeDoa && (
          <div className="warnBox small" style={{ marginBottom: 8 }}>
            Your role is officer-tier. You cannot change a DOA cap or grant DOA action kinds; use the
            limit-increase request below. The API refuses direct edits from officer roles as well.
          </div>
        )}
        <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label>
            New DOA cap (AED or “Unlimited”)
            <input
              value={doaLimitDraft}
              disabled={!canEditDoa || busy}
              onChange={(e) => setDoaLimitDraft(e.target.value)}
              style={{ width: 170 }}
            />
          </label>
          <button type="button" disabled={!canEditDoa || busy} onClick={() => void saveDoa()}>
            Save DOA authority
          </button>
          {selectedRole.id === 'administration' && <span className="pill ok">Administration is permanently unlimited</span>}
        </div>
        <div style={{ marginTop: 8 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>DOA action kinds this role may exercise</div>
          <div className="pills" style={{ gap: 6, flexWrap: 'wrap' }}>
            {DOA_ACTION_OPTIONS.map((option) => {
              const checked = doaActionsDraft.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={checked ? '' : 'ghost'}
                  disabled={!canEditDoa || busy}
                  onClick={() => toggleAction(option.value)}
                  title={option.value}
                >
                  {checked ? '✓ ' : '＋ '}{option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="manualCard" style={{ marginBottom: 12 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Request a DOA limit increase (officer path — always routed for approval)</div>
        {!canRequestIncrease && (
          <div className="errorBox small" style={{ marginBottom: 8 }}>
            A limit increase can be requested by the role itself or by a higher-tier role acting for it.
          </div>
        )}
        <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label>
            Requested cap (AED)
            <input
              value={increaseAmount}
              disabled={!canRequestIncrease || busy}
              onChange={(e) => setIncreaseAmount(e.target.value)}
              style={{ width: 150 }}
            />
          </label>
          <label style={{ flex: 1, minWidth: 260 }}>
            Operational reason
            <input
              value={increaseReason}
              disabled={!canRequestIncrease || busy}
              onChange={(e) => setIncreaseReason(e.target.value)}
            />
          </label>
          <button type="button" disabled={!canRequestIncrease || busy} onClick={() => void requestIncrease()}>
            Request limit increase →
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          The request carries the current cap ({selectedRole.doaLimitLabel}) and the requested cap, and routes
          through the Entity × Channel × Sub-channel supervisor / manager chain. Approval is what applies the new cap.
        </div>
        {pendingIncreases.length > 0 && (
          <div className="warnBox small" style={{ marginTop: 8 }}>
            {pendingIncreases.length} pending limit-increase request(s) for this role:{' '}
            {pendingIncreases.map((r) => `${r.id} → ${r.amountLabel} (${r.status})`).join(' · ')}
          </div>
        )}
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Tier</th>
              <th>Current cap</th>
              <th>DOA action kinds</th>
              <th>Pending increase requests</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const pending = security.doaRequests.filter(
                (r) => r.actionKind === 'doa-limit-increase' && r.requesterProfileId === role.id && (r.status === 'pending' || r.status === 'escalated'),
              );
              return (
                <tr key={role.id} style={role.id === selectedRole.id ? { background: 'rgba(62,166,255,.08)' } : undefined}>
                  <td><b>{role.name}</b> <span className="pill" style={{ fontSize: 10 }}>{role.id}</span></td>
                  <td><TierPill level={role.authorityLevel} rank={role.authorityRank} /></td>
                  <td><span className={`pill ${role.unrestricted ? 'ok' : 'info'}`}>{role.doaLimitLabel}</span></td>
                  <td className="small">{role.doaActions.filter((a) => a !== 'doa-limit-increase').length}</td>
                  <td className="small">
                    {pending.length === 0 ? <span className="muted">—</span> : pending.map((r) => `${r.id} · ${r.amountLabel} · ${r.status}`).join(' · ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );

  const audit = (
    <>
      <p className="small muted">
        Role creation, section visibility, DOA authority and approved limit-increase requests are appended to the
        security audit trail with the acting role and the exact node or cap. The table below shows the most recent
        access-related entries.
      </p>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Acting role</th>
              <th>Detail</th>
              <th>At</th>
            </tr>
          </thead>
          <tbody>
            {security.accessAudit.length === 0 ? (
              <tr><td colSpan={4} className="muted">No access changes recorded yet.</td></tr>
            ) : security.accessAudit.map((entry) => (
              <tr key={entry.id}>
                <td><span className="pill info" style={{ fontSize: 10.5 }}>{entry.event}</span></td>
                <td className="small"><b>{entry.actorProfileId}</b></td>
                <td className="small">{entry.detail}</td>
                <td className="small">{entry.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  const sections: SectionModel[] = [
    {
      id: 'role-directory',
      order: 1,
      title: 'Role directory & authority tiers',
      subtitle: `${security.roleCount} roles · ${security.authorities.length} tiers · roles only, no user logins yet`,
      status: 'complete',
      percent: 100,
      autoOpen: initialSection === 'role-directory',
      children: directory,
    },
    {
      id: 'access-tree',
      order: 2,
      title: 'Tab → Section → Sub-section visibility tree',
      subtitle: 'Enable, disable or make read-only any node — children inherit until explicitly overridden',
      status: 'complete',
      percent: 100,
      autoOpen: initialSection === 'access-tree',
      children: tree,
    },
    {
      id: 'doa-limits',
      order: 3,
      title: 'DOA limits & limit-increase requests',
      subtitle: 'Supervisor / manager caps, officer requests, and the approval path that applies them',
      status: 'complete',
      percent: 100,
      autoOpen: initialSection === 'doa-limits',
      children: doaLimits,
    },
    {
      id: 'role-audit',
      order: 4,
      title: 'Access & DOA change audit trail',
      subtitle: `${security.accessAudit.length} recent access-related entries`,
      status: 'complete',
      percent: 100,
      autoOpen: initialSection === 'role-audit',
      children: audit,
    },
  ];

  return (
    <div className="grid">
      <div style={{ gridColumn: '1 / -1' }}>
        {notice && <div className="okBox small" style={{ marginBottom: 10 }}>{notice}</div>}
        {error && <div className="errorBox small" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="scopedBrandBanner" style={{ marginBottom: 12 }}>
          <span className={`pill ${activeRole.authorityLevel === 'officer' ? 'warn' : 'ok'}`}>
            {activeRole.authorityLevel.toUpperCase()} · L{activeRole.authorityRank}
          </span>
          <span className="small">
            Active role <b>{activeRole.name}</b> · can change DOA: <b>{activeRole.canChangeDoa ? 'yes' : 'no — request only'}</b> · can manage access: <b>{activeRole.canManageRoleAccess ? 'yes' : 'no'}</b>
          </span>
          <span className="pill" style={{ marginLeft: 'auto' }}>
            {security.userProfileLayer.description}
          </span>
        </div>
        <SectionStack
          sections={sections}
          title="Role access matrix — tabs, sections, sub-sections & DOA authority"
          headline="Select a role, then switch any tab, section or sub-section between full, read-only and hidden. A role is a permission template; named user accounts and login will reference a role id later."
        />
      </div>
    </div>
  );
};
