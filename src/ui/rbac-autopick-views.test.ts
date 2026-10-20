import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { SmartComboBox, SmartMultiComboBox } from './combobox.js';
import { MasterSettingsErp, ProposalManagementPanel } from './erp-views.js';
import { GuideProvider, ScreenGuide } from './guide.js';
import { CustomerJourneyPanel } from './journey.js';
import {
  HeaderSecurityStrip,
  ProfileAccessGuardBanner,
  ProfileSelectionGate,
  RoleAccessAndDoaPanel,
} from './rbac-views.js';

const h = React.createElement;
const noop = async () => {};

describe('RBAC Pre-Load Gate, DOA Panel, Smart ComboBox & Auto-Pick UI Views', () => {
  it('renders the Pre-Load ProfileSelectionGate with all 36 enterprise profiles and Administration unrestricted badge', () => {
    const data = worldSnapshot(buildWorld());
    const html = renderToString(
      h(ProfileSelectionGate, {
        security: data.security,
        tenantName: data.tenant.name,
        busy: false,
        onSelectProfile: noop,
      }),
    );
    expect(html).toContain('Enterprise Security &amp; DOA Governance Gate');
    expect(html).toContain('Select Your Security Profile to Enter');
    expect(html).toContain('Enter as Administration');
    expect(html).toContain('Search all 36 profiles');
    expect(html).toContain('data-select-profile="administration"');
    expect(html).toContain('Marsh');
    expect(html).not.toContain('aria-expanded');
  });

  it('renders RoleAccessAndDoaPanel with curated AI Guide sticky notes and HeaderSecurityStrip notification inbox', () => {
    const data = worldSnapshot(buildWorld());
    const guided = renderToString(
      h(
        GuideProvider,
        { data, enabled: true, tab: 'access-doa' },
        h(
          React.Fragment,
          null,
          h(ScreenGuide),
          h(ProfileAccessGuardBanner, { security: data.security, tab: 'access-doa', onReload: noop, onOpenAccessTab: () => {} }),
          h(RoleAccessAndDoaPanel, { data, onReload: noop, onSwitchProfile: noop, onOpenGate: () => {} }),
        ),
      ),
    );
    expect(guided).toContain('data-guide="screen:access-doa"');
    expect(guided).toContain('data-guide="access-doa:profile-directory"');
    expect(guided).toContain('data-guide="access-doa:ai-advisor"');
    expect(guided).toContain('data-guide="access-doa:matrix-editor"');
    expect(guided).toContain('data-guide="access-doa:supervision-map"');
    expect(guided).toContain('data-guide="access-doa:doa-queue"');

    const strip = renderToString(
      h(HeaderSecurityStrip, {
        security: data.security,
        onSwitchProfile: noop,
        onOpenGate: () => {},
        onOpenAccessTab: () => {},
        onReload: noop,
      }),
    );
    expect(strip).toContain('Profile Gate');
  });

  it('renders SmartComboBox, SmartMultiComboBox, Auto-Pick Proposal Banner, Master Age Rule Gate & Journey Auto-Pick', () => {
    const data = worldSnapshot(buildWorld());

    const comboHtml = renderToString(
      h(SmartComboBox, {
        value: 'Global Wealth Accumulator',
        onChange: () => {},
        suggestions: data.erp.master.smartSuggestions.productNames,
      }),
    );
    expect(comboHtml).toContain('Global Wealth Accumulator');
    expect(comboHtml).not.toContain('aria-expanded');

    const multiHtml = renderToString(
      h(SmartMultiComboBox, {
        values: ['critical-illness', 'waiver-of-premium'],
        onChange: () => {},
        suggestions: data.erp.master.smartSuggestions.dependentProducts,
      }),
    );
    expect(multiHtml).toContain('critical-illness');
    expect(multiHtml).toContain('waiver-of-premium');
    expect(multiHtml).not.toContain('aria-expanded');

    const proposalHtml = renderToString(h(ProposalManagementPanel, { data, onReload: noop, onNavigate: () => {} }));
    expect(proposalHtml).toContain('data-autopick-banner="proposal"');
    expect(proposalHtml).toContain('Smart Auto-Pick Active');

    const masterGuided = renderToString(
      h(
        GuideProvider,
        { data, enabled: true, tab: 'master' },
        h(MasterSettingsErp, { data, onReload: noop, onNavigate: () => {} }),
      ),
    );
    expect(masterGuided).toContain('data-guide="master:age-autopick"');

    const journeyHtml = renderToString(h(CustomerJourneyPanel, { data, onReload: noop }));
    expect(journeyHtml).toContain('Smart Auto-Pick');
    expect(journeyHtml.split('aria-expanded="true"').length - 1).toBe(1);
    expect(journeyHtml.split('aria-expanded="false"').length - 1).toBe(18);
  });
});
