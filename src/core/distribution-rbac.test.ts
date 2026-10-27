/**
 * The three new configuration tabs are a governance boundary: navigation, server-side write access
 * and role-builder delegation must agree on who may see and file each scope.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { CONSOLE_TABS, DISTRIBUTION_CONFIG_TAB_IDS } from './tour.js';

const TABS = Object.values(DISTRIBUTION_CONFIG_TAB_IDS);

describe('distribution configuration role governance', () => {
  it('registers all three tabs and grants Administration unrestricted access', () => {
    const ids = new Set(CONSOLE_TABS.map((t) => t.id));
    for (const tabId of TABS) expect(ids.has(tabId), tabId).toBe(true);
    const w = buildWorld();
    for (const tabId of TABS) expect(w.rbac.canAccessTab('administration', tabId)).toBe('full');
  });

  it('keeps the tabs with the Configuration Analyst and the three coordinator templates', () => {
    const w = buildWorld();
    const snap = w.rbac.snapshot();
    expect(snap.roleCount).toBe(39);
    for (const id of ['omni-channel-coordinator', 'partner-coordinator', 'sub-channel-coordinator']) {
      const role = snap.roles.find((r) => r.id === id);
      expect(role, id).toBeDefined();
      expect(role!.family).toBe('distribution-config');
      expect(role!.partnerScope).toBe('*');
    }
    for (const tabId of TABS) expect(w.rbac.canAccessTab('configurator', tabId), tabId).toBe('full');
    for (const roleId of ['supervisor', 'cost-controller', 'agent-1', 'bank-manager', 'direct-customer']) {
      for (const tabId of TABS) expect(w.rbac.canAccessTab(roleId, tabId), `${roleId}/${tabId}`).toBe('none');
    }
  });

  it('gives each coordinator write access to its own scope and read-only sight of the other two', () => {
    const w = buildWorld();
    const expectations: Record<string, string> = {
      'omni-channel-coordinator': DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'],
      'partner-coordinator': DISTRIBUTION_CONFIG_TAB_IDS.partner,
      'sub-channel-coordinator': DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner'],
    };
    for (const [roleId, ownTab] of Object.entries(expectations)) {
      expect(w.rbac.canAccessTab(roleId, ownTab), roleId).toBe('full');
      for (const tabId of TABS) {
        if (tabId !== ownTab) expect(w.rbac.canAccessTab(roleId, tabId), `${roleId}/${tabId}`).toBe('read');
      }
    }
  });

  it('refuses to delegate a configuration tab to an unrelated role, but allows scoped coordinator clones', () => {
    const w = buildWorld();
    expect(() => w.rbac.setRoleNodeAccess({
      roleId: 'agent-1', kind: 'tab', key: DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'],
      level: 'full', actorProfileId: 'administration',
    })).toThrow(/restricted to the Configuration Analyst/);

    expect(() => w.rbac.upsertProfile({
      id: 'rogue-configurator', cloneFromProfileId: 'agent-1', by: 'administration',
      tabAccess: { [DISTRIBUTION_CONFIG_TAB_IDS.partner]: 'full' },
    })).toThrow(/restricted to the Configuration Analyst/);

    const cloned = w.rbac.upsertProfile({
      id: 'agency-channel-coordinator', cloneFromProfileId: 'omni-channel-coordinator',
      channelScope: 'AGENCY', subChannelScope: 'AGENCY-DESK-1', partnerScope: '*',
      by: 'administration',
    });
    expect(cloned.family).toBe('distribution-config');
    expect(cloned.partnerScope).toBe('*');
    expect(w.rbac.canAccessTab(cloned.id, DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'])).toBe('full');
  });
});
