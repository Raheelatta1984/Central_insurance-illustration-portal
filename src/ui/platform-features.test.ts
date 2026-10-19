import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { FundsAccountingPanel } from './funds-accounting-views.js';
import { SuperFundsPanel } from './super-funds-views.js';
import { WarehousePanel } from './warehouse-views.js';
import { EntityThemeOnboardingPanel, OmniThemePanel, PartnerThemePanel } from './theme-views.js';
import { OmniChannelPanel } from './channel-views.js';

const h = React.createElement;
const reload = async () => {};
const run = async (_label: string, fn: () => Promise<unknown>) => fn();

const world = buildWorld();
const data = worldSnapshot(world);

describe('expanded operational tabs render from the live world', () => {
  it('renders country standards and navigation for the accounting workflows', () => {
    const html = renderToString(h(FundsAccountingPanel, { data, onReload: reload }));
    expect(html).toContain('country standards');
    expect(html).toContain('Country accounting configurations');
    expect(html).toContain('Saudi Arabia');
    expect(html).toContain('3. Dynamic mappings');
    expect(html).toContain('4. Event → voucher simulator');
  });

  it('renders super fund products and navigation for member and processing workflows', () => {
    const html = renderToString(h(SuperFundsPanel, { data, onReload: reload }));
    expect(html).toContain('PROD-SUPER-ACCUM');
    expect(html).toContain('Super investment products');
    expect(html).toContain('2. Member policies &amp; contributions');
    expect(html).toContain('3. Monthly processing charges');
    expect(html).toContain('4. Investment income allocation');
  });

  it('renders warehouse facts, exports and navigation to connector recipes', () => {
    const html = renderToString(h(WarehousePanel, { data, onReload: reload }));
    expect(html).toContain('policy-fact');
    expect(html).toContain('voucher-fact');
    expect(html).toContain('Power BI');
    expect(html).toContain('recipes, not authenticated live external connections');
    expect(html).toContain('4. Connectors (Power BI → Data Fabric)');
    expect(html).toContain('Download complete CSV');
  });

  it('renders the three onboarding scopes and a child route under a channel', () => {
    for (const Panel of [EntityThemeOnboardingPanel, PartnerThemePanel, OmniThemePanel]) {
      expect(renderToString(h(Panel, { data, onReload: reload }))).toContain('Upload identity');
    }
    const configured = buildWorld();
    configured.erp.channels.bootstrap('', 'test');
    const channelData = worldSnapshot(configured);
    const channelHtml = renderToString(h(OmniChannelPanel, { data: channelData, busy: false, onRun: run }));
    expect(channelHtml).toContain('Sub-channels — named routes inside an omni-channel');
    expect(channelHtml).toContain('Parent channel');
  });
});
