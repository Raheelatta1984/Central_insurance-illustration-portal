import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { FundsAccountingPanel } from './funds-accounting-views.js';
import { SuperFundsPanel } from './super-funds-views.js';
import { WarehousePanel } from './warehouse-views.js';
import { EntityThemeOnboardingPanel, OmniThemePanel, PartnerThemePanel } from './theme-views.js';
import { OmniChannelPanel } from './channel-views.js';
import { BatchPanel } from './batch-views.js';
import { WhatsNewPanel } from './whatsnew-views.js';
import { ApplicationThemePanel } from './theme-tab.js';

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

  it('renders batch processing, the top-level theme tab and whats-new from the live world', () => {
    const batch = renderToString(h(BatchPanel, { data, onReload: reload }));
    expect(batch).toContain('Batch processing — quotations, issuance');
    expect(batch).toContain('Monthly anniversary — mortality');
    expect(batch).toContain('skipped-terminal');
    expect(batch).toContain('UL-LAPSED-001');

    const theme = renderToString(h(ApplicationThemePanel, { data, onReload: reload }));
    expect(theme).toContain('Application theme — brand the whole application');
    expect(theme).toContain('previously only reachable inside Master settings');
    expect(theme).toContain('One-click brand presets');
    expect(theme).toContain('Royal Takaful Emerald');
    expect(theme).toContain('Theme audit trail');

    const whatsNew = renderToString(h(WhatsNewPanel, { data, onReload: reload }));
    expect(whatsNew).toContain("What&#x27;s New");
    expect(whatsNew).toContain('What you need to do');
    expect(whatsNew).toContain('What&#x27;s New publication corrected');
    expect(whatsNew).toContain('Partner reconciliation foundation — not yet available');
    expect(whatsNew.indexOf('What&#x27;s New publication corrected')).toBeLessThan(whatsNew.indexOf('Partner reconciliation foundation — not yet available'));
    expect(whatsNew).toContain('PR #38');
    expect(whatsNew).toContain('merging a PR does not automatically add one');
    expect(whatsNew).toContain('Snowflake, Excel and Access warehouse connections');

    const warehouse = renderToString(h(WarehousePanel, { data, onReload: reload }));
    expect(warehouse).toContain('5. Connections — Snowflake / Excel / Access + PII masking');
    expect(warehouse).toContain('Data warehouse — single tab');
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

    // The rates a quotation is allowed to assume: filed per product, narrowed per channel and
    // sub-channel, with a figure left blank meaning "inherit it from the parent".
    const ratesHtml = renderToString(h(OmniChannelPanel, { data: channelData, busy: false, onRun: run }));
    expect(ratesHtml).toContain('Illustration rates');
    expect(ratesHtml).toContain('Pessimistic');
    expect(ratesHtml).toContain('Optimistic');
    expect(ratesHtml).toContain('File these rates');
    expect(ratesHtml).toContain('inherit');
  });
});
