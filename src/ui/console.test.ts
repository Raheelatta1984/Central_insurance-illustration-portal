/**
 * The console renders — and renders closed.
 *
 * These are the tests that catch a panel which throws on arrival or, worse, one that quietly opens
 * every section at once: each panel is server-rendered against the real world snapshot and counted.
 * One section open, the rest closed, is the whole point of the change.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { CustomerJourneyPanel } from './journey.js';
import {
  ClaimsManagementPanel, CustomerManagementPanel, FundNavManagementPanel, MasterSettingsErp,
  PolicyAdministrationPanel, ProposalManagementPanel, ReinsuranceManagementPanel,
} from './erp-views.js';

const data = worldSnapshot(buildWorld());
const noop = async () => {};
const nowhere = () => {};
const h = React.createElement;

describe('the console renders', () => {
  it('renders the journey rail closed, with exactly one section open', () => {
    const html = renderToString(h(CustomerJourneyPanel, { data, onReload: noop }));
    expect(html).toContain('Customer onboarding &amp; identity verification');
    expect(html).toContain('Investment allocations &amp; progress');
    expect(html).toContain('Section 5 of 19');
    expect(html.split('aria-expanded="true"').length - 1).toBe(1);
    expect(html.split('aria-expanded="false"').length - 1).toBe(18);
    expect(html).toContain('Coverage &amp; premium calculation');
    expect(html).toContain('closed — waiting on');
  });

  it('renders every retrofitted panel without throwing, each with one section open', () => {
    const panels: Array<[string, React.ReactElement]> = [
      ['customer', h(CustomerManagementPanel, { data, onReload: noop })],
      ['proposal', h(ProposalManagementPanel, { data, onReload: noop, onNavigate: nowhere })],
      ['policy', h(PolicyAdministrationPanel, { data, onReload: noop })],
      ['claims', h(ClaimsManagementPanel, { data, onReload: noop })],
      ['funds', h(FundNavManagementPanel, { data, onReload: noop })],
      ['reinsurance', h(ReinsuranceManagementPanel, { data, onReload: noop })],
      ['master', h(MasterSettingsErp, { data, onReload: noop, onNavigate: nowhere })],
    ];
    for (const [name, node] of panels) {
      const html = renderToString(node);
      expect(html.length, name).toBeGreaterThan(2000);
      expect(html.split('aria-expanded="true"').length - 1, `${name} open sections`).toBe(1);
    }
    const claims = renderToString(h(ClaimsManagementPanel, { data, onReload: noop }));
    expect(claims).toContain('Register a claim request');
    expect(claims).toContain('Settle, pay and recover');
    const journey = renderToString(h(CustomerJourneyPanel, { data, onReload: noop }));
    expect(journey).toContain('Mandatory fields still outstanding');
  });
});
