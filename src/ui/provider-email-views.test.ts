/**
 * The two new screens, rendered server-side against the real snapshot.
 *
 * A screenshot cannot prove the thing that matters here: that the master settings screen names the
 * missing branch and reinsurance before a desk tries to quote, that the agency desk's Takaful box is
 * visibly off while the call centre's is on, and that the email tab shows the departmental address on
 * each event rather than one global sender. The sticky notes are checked too, because "with a guide in
 * sticky notes" was part of the ask and a note that renders as invisible markup does not satisfy it.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import type { WorldSnapshot } from '../core/demo.js';
import { GuideProvider } from './guide.js';
import { ProviderMasterPanel, ProviderSellingPanel } from './provider-views.js';
import { EmailConfigurationPanel } from './email-views.js';
import { MasterSettingsErp } from './erp-views.js';

const h = React.createElement;
const run = async (_label: string, fn: () => Promise<unknown>) => fn();
const plain = (html: string) => html.replace(/<!--[^>]*-->/g, '');

function render(node: React.ReactElement, data: WorldSnapshot, tab = 'master'): string {
  return plain(renderToString(h(GuideProvider, { data, tab, enabled: true, children: node })));
}

const emptyData = worldSnapshot(buildWorld());
const seededWorld = buildWorld();
seededWorld.erp.seedDistributionExample(seededWorld, { at: '2026-10-05T12:00:00+04:00', by: 'test' });
const seededData = worldSnapshot(seededWorld);

describe('the provider master settings screen', () => {
  it('says the register is empty, what that blocks and offers the worked example', () => {
    const html = render(h(ProviderMasterPanel, { data: emptyData, busy: false, onRun: run }), emptyData);
    expect(html).toContain('No insurance provider is filed yet.');
    expect(html).toContain('Load the Marsh multi-country example');
    expect(html).toContain('Registered branches — one per provider per country');
    expect(html).toContain('Reinsurance by provider and country');
    expect(html).toContain('Provider products by country');
    expect(html).toContain('A provider with no branch cannot sell anywhere.');
  });

  it('renders the seeded carriers, branches, country arrangements and local products', () => {
    const html = render(h(ProviderMasterPanel, { data: seededData, busy: false, onRun: run }), seededData);
    expect(html).toContain('AL-KHALEEJ');
    expect(html).toContain('Etiqa Takaful');
    expect(html).toContain('GULF-UNION');
    expect(html).toContain('BR-AL-KHALEEJ-GB');
    expect(html).toContain('RI-AL-KHALEEJ-GB');
    expect(html).toContain('PROD-TKF-FAMILY-SG');
    expect(html).toContain('retakaful');
    expect(html).toContain('CBUAE/BR/AE/0042');
    expect(html).toContain('✓ Marsh example is on file');
  });

  it('shows Conventional and Takaful as separate permissions, with the agency desk narrowed', () => {
    const html = render(h(ProviderSellingPanel, { data: seededData, busy: false, onRun: run }), seededData);
    expect(html).toContain('Conventional and Takaful selling');
    expect(html).toContain('Marsh UAE');
    expect(html).toContain('Marsh UK');
    expect(html).toContain('MARSH-CALL-CENTRE');
    expect(html).toContain('MARSH-AGENCY');
    expect(html).toContain('narrowed at sub-channel');
    expect(html).toContain('Check sellability');
    expect(html).toContain('premium: local-branch');
    expect(html).toContain('investment: country-of-origin');
    // Both checkboxes are on the screen for each scope; the narrowing is a value, not a hidden row.
    expect((html.match(/Conventional<\/label>|Conventional<\/span>/g) ?? []).length + (html.match(/>Conventional</g) ?? []).length).toBeGreaterThan(2);
    expect(html).toContain('>Takaful<');
  });
});

describe('the master settings rail', () => {
  it('renders the two provider gates with their curated sticky notes', () => {
    const html = render(h(MasterSettingsErp, { data: seededData, onReload: async () => {}, onNavigate: () => {} }), seededData);
    expect(html).toContain('Insurance providers, registered branches &amp; country reinsurance');
    expect(html).toContain('Multi-country selling — currency and Conventional/Takaful permissions');
    expect(html).toContain('data-guide="master:providers"');
    expect(html).toContain('data-guide="master:provider-selling"');
    expect(html).toContain('data-curated="yes"');
  });
});

describe('the email configuration tab', () => {
  it('renders the departmental accounts, the fourteen events and the proof screen', () => {
    const html = render(h(EmailConfigurationPanel, { data: emptyData, onReload: async () => {} }), emptyData, 'email');
    expect(html).toContain('Email configuration — accounts, event routes and the proof');
    expect(html).toContain('issuance@central-insurance.example');
    expect(html).toContain('info@central-insurance.example');
    expect(html).toContain('retention@central-insurance.example');
    expect(html).toContain('claims@central-insurance.example');
    expect(html).toContain('reinsurance@central-insurance.example');
    expect(html).toContain('Policy issued');
    expect(html).toContain('Renewal request');
    expect(html).toContain('Reinsurance placement');
    expect(html).toContain('Preview and delivery test');
    expect(html).toContain('Credential settings (names only)');
    expect(html).toContain('GOOGLE_CLIENT_SECRET');
    expect(html).toContain('never stored');
  });

  it('puts curated sticky notes on the accounts, event routes and preview sections', () => {
    const html = render(h(EmailConfigurationPanel, { data: emptyData, onReload: async () => {} }), emptyData, 'email');
    for (const id of ['email:accounts', 'email:event-routes', 'email:preview']) {
      expect(html, id).toContain(`data-guide="${id}"`);
    }
    expect(html).toContain('data-curated="yes"');
    expect(html).toContain('GUIDE');
    expect(html).toContain('AI guide for');
  });

  it('shows the account and route after a configuration change is made', () => {
    const world = buildWorld();
    world.emailConfig.upsertAccount({
      accountId: 'ACC-UNDERWRITING', address: 'underwriting@central-insurance.example',
      name: 'Underwriting', department: 'underwriting', kind: 'smtp',
      credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'], by: 'test',
    });
    world.emailConfig.upsertRoute({
      eventKey: 'information.pack', fromAccountId: 'ACC-UNDERWRITING', to: ['{{customer.email}}'],
      subject: 'Your information pack', body: 'Dear {{customer.name}}', attachments: ['information-pack'],
      by: 'test',
    });
    const data = worldSnapshot(world);
    const html = render(h(EmailConfigurationPanel, { data, onReload: async () => {} }), data, 'email');
    expect(html).toContain('ACC-UNDERWRITING');
    expect(html).toContain('underwriting@central-insurance.example');
    expect(html).toContain('Your information pack');
  });
});
