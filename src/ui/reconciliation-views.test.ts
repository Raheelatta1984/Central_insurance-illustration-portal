import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { createRuntimeState, dispatchApiRoute } from '../core/routes.js';
import { GuideProvider, ScreenGuide } from './guide.js';
import { ReconciliationPanel } from './reconciliation-views.js';

const h = React.createElement;
const noop = async () => {};

describe('Partner reconciliation panel & HTTP endpoints (unlocked non-financial foundation)', () => {
  it('renders ReconciliationPanel with one open section, non-financial badges and curated guide notes', () => {
    const data = worldSnapshot(buildWorld());
    const html = renderToString(
      h(
        GuideProvider,
        { data, enabled: true, tab: 'reconciliation' },
        h(React.Fragment, null, h(ScreenGuide), h(ReconciliationPanel, { data, onReload: noop })),
      ),
    );
    expect(html).toContain('Foundation: UNLOCKED (non-financial)');
    expect(html).toContain('Financial commission / clawback / AP calculations: LOCKED');
    expect(html.split('aria-expanded="true"').length - 1).toBe(1);
    expect(html).toContain('data-guide="screen:reconciliation"');
    expect(html).toContain('data-guide="reconciliation:scope-hierarchy"');
    expect(html).toContain('data-guide="reconciliation:column-mapping"');
    expect(html).toContain('data-guide="reconciliation:identity-matching"');
    expect(html).toContain('data-guide="reconciliation:proposal-review"');
  });

  it('serves GET and POST /reconciliation/* endpoints deterministically without financial fields', async () => {
    const state = createRuntimeState(1, () => '2026-10-27T10:00:00Z');

    const snap = await dispatchApiRoute(state, 'GET', '/reconciliation', new URLSearchParams(), {});
    expect(snap.status).toBe(200);
    expect((snap.body as { featureGate: { enabled: boolean; financialCalculationsEnabled: boolean } }).featureGate).toEqual({
      requested: false,
      enabled: true,
      financialCalculationsEnabled: false,
      mode: 'non_financial_foundation',
      reason: 'non_financial_foundation_unlocked',
    });

    const addChannel = await dispatchApiRoute(state, 'POST', '/reconciliation/channel-type', new URLSearchParams(), {
      insurerId: 'ALK-CONV',
      code: 'corporate-affinity',
      name: 'Corporate Affinity Channel',
    });
    expect(addChannel.status).toBe(200);

    const proposed = await dispatchApiRoute(state, 'POST', '/reconciliation/columns/propose', new URLSearchParams(), {
      insurerId: 'ALK-CONV',
      sourceLabel: 'AFFINITY-OCT.csv',
      headers: ['Policy Number', 'Client Name', 'Commission Amount', 'Tax'],
    });
    expect(proposed.status).toBe(200);
    const mappingId = (proposed.body as { mapping: { mappingId: string; confirmed: boolean } }).mapping.mappingId;
    expect((proposed.body as { mapping: { confirmed: boolean } }).mapping.confirmed).toBe(false);

    const confirmed = await dispatchApiRoute(state, 'POST', '/reconciliation/columns/confirm', new URLSearchParams(), {
      mappingId,
      assignments: { policyNumber: 0, insuredName: 1 },
    });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { mapping: { confirmed: boolean } }).mapping.confirmed).toBe(true);

    const matched = await dispatchApiRoute(state, 'POST', '/reconciliation/identity/match', new URLSearchParams(), {
      scope: {
        insurerId: 'ALK-CONV',
        channelPartnerId: 'MARSH-UAE',
        subpartnerId: 'MARSH-UAE-AGENCY',
        insuranceClass: 'life',
      },
      partnerRows: [
        { rowId: 'L-1', policyNumber: 'pol-501', insuredName: 'Noor Al Ameri' },
        { rowId: 'L-2', policyNumber: 'POL-2026-00911', insuredName: 'Saeed Al Shamsi' },
      ],
      insurerRows: [
        { rowId: 'R-1', policyNumber: 'POL-000501', insuredName: 'NOOR AL AMERI' },
        { rowId: 'R-2', policyNumber: 'POL-2026-00912', insuredName: 'Saeed Al Shamsee' },
      ],
    });
    expect(matched.status).toBe(200);
    const run = (matched.body as {
      run: {
        runId: string;
        summary: { safeVariantMatchCount: number; pendingProposalCount: number };
        proposals: Array<{ leftRowId: string; rightRowId: string }>;
      };
    }).run;
    expect(run.summary.safeVariantMatchCount).toBe(1);
    expect(run.summary.pendingProposalCount).toBe(1);

    const reviewed = await dispatchApiRoute(state, 'POST', '/reconciliation/proposals/review', new URLSearchParams(), {
      runId: run.runId,
      leftRowId: run.proposals[0]!.leftRowId,
      rightRowId: run.proposals[0]!.rightRowId,
      decision: 'confirm',
      note: 'Confirmed policy endorsement suffix against signed schedule',
    });
    expect(reviewed.status).toBe(200);
    expect((reviewed.body as { run: { summary: { confirmedProposalCount: number } } }).run.summary.confirmedProposalCount).toBe(1);
  });
});
