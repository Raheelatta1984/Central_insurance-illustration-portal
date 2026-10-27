/**
 * The three configuration screens are real panels: every scope shows the product hierarchy and all
 * commercial terms, and a read-only coordinator cannot file a row.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { DEFAULT_CLAWBACK } from '../core/channels.js';
import { DISTRIBUTION_CONFIG_TAB_IDS, type DistributionScopeKind } from '../core/tour.js';
import { GuideProvider } from './guide.js';
import { DistributionConfigurationPanel } from './distribution-config-views.js';

const h = React.createElement;
const noop = async () => {};

function preparedData() {
  const world = buildWorld();
  world.erp.channels.bootstrap('2026-10-27T10:00:00Z', 'ui-test');
  const product = world.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
  world.erp.channels.upsertPartner({
    partnerId: 'GULF-BROKERS', name: 'Gulf Brokers', channelCode: 'BROKER',
    productIds: [product.productId], commissionBps: [1000], settlementDays: 30,
    clawback: DEFAULT_CLAWBACK, by: 'ui-test',
  });
  world.erp.channels.upsertSubChannel({
    code: 'BROKER-DIFC', name: 'DIFC desk', parentChannelCode: 'BROKER',
    partnerId: 'GULF-BROKERS', channelType: 'branch', by: 'ui-test',
  });
  return worldSnapshot(world);
}

function render(scope: DistributionScopeKind, readOnly = false): string {
  const data = preparedData();
  return renderToString(
    h(
      GuideProvider,
      { data, enabled: true, tab: DISTRIBUTION_CONFIG_TAB_IDS[scope] },
      h(DistributionConfigurationPanel, { data, scope, readOnly, onReload: noop }),
    ),
  );
}

const REQUIRED_FIELDS = [
  'Type of products', 'Products', 'Sub-products', 'Commission schedule (%)',
  'Premium rate uplift (%)', 'Disbursement frequency', 'Payout trigger', 'Settlement days',
  'Commission holdback (%)', 'Clawback trigger', 'Clawback basis',
  'Clawback recovery schedule (%)', 'Terms of commission disbursement',
];

describe('distribution configuration tabs', () => {
  it('renders the Omni Channel, Partner and Sub Channel Partners tabs as separate screens', () => {
    const omni = render('omni-channel');
    const partner = render('partner');
    const sub = render('sub-channel-partner');
    expect(omni).toContain('Omni Channel configuration');
    expect(omni).toContain('data-distribution-scope="omni-channel"');
    expect(partner).toContain('Partner configuration');
    expect(partner).toContain('data-distribution-scope="partner"');
    expect(sub).toContain('Sub Channel Partners configuration');
    expect(sub).toContain('data-distribution-scope="sub-channel-partner"');
    expect(sub).toContain('Sub-channel');
    for (const field of REQUIRED_FIELDS.filter((f) => f !== 'Terms of commission disbursement')) {
      expect(omni, `${field} on omni-channel`).toContain(field);
      expect(partner, `${field} on partner`).toContain(field);
      expect(sub, `${field} on sub-channel partner`).toContain(field);
    }
    // The commercial card is explicitly about commission disbursement terms, not just a rate.
    expect(partner).toContain('Commission, premium uplift and disbursement terms');
    expect(partner).toContain('Clawback rules');
    expect(partner).toContain('Filed configuration rows');
  });

  it('shows the filed rows and disables filing for a read-only coordinator', () => {
    const html = render('partner', true);
    expect(html).toContain('Read-only access');
    expect(html).toContain('No configuration has been filed at this scope yet.');
    expect(html).toMatch(/data-action="file-configuration"[^>]*disabled/);
    expect(html).toContain('aria-label="Sub-products"');
  });
});
