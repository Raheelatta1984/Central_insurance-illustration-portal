/**
 * The three new master-settings grids, rendered the way the console renders them.
 *
 * These panels are the answer to a straightforward complaint: the product shelf was a read-only table with
 * a form underneath it, there was nowhere at all to file a tariff by age band, and the omni-channel did not
 * exist unless somebody had written it in code. Each is now a grid you can edit, copy a row in, and fill in
 * bulk from a sheet. What this file checks is the part a screenshot would miss: that a page of the real
 * filed master arrives with the real numbers on it, in the currency's own notation, that the row actions
 * are on every row, and that adding a stack of grids does not add a second "open section" to the rail.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import type { WorldSnapshot } from '../core/demo.js';
import {
  copyIdFor, DEFAULT_PRODUCT_FORM, draftIssues, draftOf, PRODUCT_PAGE_SIZE, ProductConfigGrid, toRowInput,
} from './product-grid';
import { ProductFactoryPanel } from './erp-views';
import { RatingTablesPanel } from './rating-views';
import { OmniChannelPanel } from './channel-views';
import { GuideProvider } from './guide.js';

const h = React.createElement;
const run = async (_label: string, fn: () => Promise<unknown>) => fn();

/** Server rendering splits adjacent text with comment markers; strip them before reading a sentence. */
const plain = (html: string) => html.replace(/<!--[^>]*-->/g, '');

function render(node: React.ReactElement, data: WorldSnapshot): string {
  return renderToString(h(GuideProvider, { data, tab: 'master', enabled: false, children: node }));
}

const data = worldSnapshot(buildWorld());

/** The same world, with the omni-channel set up and a partner holding terms — the state after one button. */
const configuredWorld = buildWorld();
configuredWorld.erp.channels.bootstrap('2026-10-05T13:00:00Z', 'distribution-desk');
configuredWorld.erp.channels.upsertPartner({
  partnerId: 'GULF-BROKERS', name: 'Gulf Brokers', channelCode: 'BROKER', country: 'AE',
  commissionBps: [1500, 500, 250], productIds: ['PROD-UL-GLOBAL', 'PROD-LIFE-TERM'],
  at: '2026-10-05T13:00:00Z', by: 'distribution-desk',
});
configuredWorld.erp.channels.upsertOffer({
  partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', secondaryName: 'Gulf Elite Life',
  premiumUpliftBps: 250, enabled: true, at: '2026-10-05T13:00:00Z', by: 'distribution-desk',
});
const configured = worldSnapshot(configuredWorld);

describe('the product shelf is an editable grid', () => {
  const html = render(h(ProductConfigGrid, { data, busy: false, onRun: run }), data);
  const body = plain(html);

  it('shows a page of the filed varieties, not a wall of ninety-six', () => {
    const rows = (html.match(/class="gridRow/g) ?? []).length;
    expect(rows).toBe(Math.min(PRODUCT_PAGE_SIZE, data.erp.master.products.length));
    expect(data.erp.master.products.length).toBeGreaterThan(PRODUCT_PAGE_SIZE);
    expect(body).toContain('page 1 of');
    expect(body).toContain('Save this page');
    expect(body).toContain('Add a product row');
  });

  it('has a column for every field of the master, including the omni-channel name', () => {
    for (const column of ['Product ID', 'Product name', 'Omni-channel name', 'Book', 'Line of business',
      'Age from', 'Age to', 'Max BMI', 'Base rate per 1000', 'Income multiple', 'Automatic binding limit',
      'Facultative threshold', 'AI straight-through limit', 'Tariff', 'Distribution']) {
      expect(body, `${column} is a column`).toContain(column);
    }
    // A cell you can type in, not a cell you can only read.
    expect(html).toContain('aria-label="Omni-channel name"');
  });

  it('offers the copy, the bulk sheet and the paging on every row', () => {
    expect(html).toContain('⧉ Copy line');
    expect(html).toContain('Sample sheet');
    expect(html).toContain('Upload sheet');
    expect(html).toContain('What is on file');
    const page = Math.min(PRODUCT_PAGE_SIZE, data.erp.master.products.length);
    expect((html.match(/aria-label="Copy this line into a new row"/g) ?? []).length, 'a copy on every row').toBe(page);
    expect((html.match(/>Save<\/button>/g) ?? []).length, 'a save on every row').toBe(page);
    // A variety that is on file cannot be deleted from a cell — it has quotations, and in time policies,
    // pointing at it. Only a row nobody has filed yet offers a remove.
    expect((html.match(/aria-label="Remove this row"/g) ?? []).length).toBe(0);
  });

  it('quotes the tariff and the distribution of each row from the master itself', () => {
    const prod = data.erp.master.products.find((p) => p.productId === 'PROD-UL-GLOBAL')!;
    expect(prod.rateRows).toBeGreaterThan(0);
    expect(body).toContain(`${prod.rateRows} rate row(s)`);
    // Nothing is set up yet in this world, so the shelf column says so rather than pretending.
    expect(body).toContain('0 partner(s)');
  });

  it('keeps the section rail honest: a stack of grids adds no open section', () => {
    expect(html.split('aria-expanded="true"').length - 1).toBe(0);
    const panel = render(h(ProductFactoryPanel, {
      data, busy: false, form: DEFAULT_PRODUCT_FORM, setForm: () => {}, onSave: () => {}, onRun: run,
    }), data);
    expect(panel.split('aria-expanded="true"').length - 1).toBe(0);
    expect(plain(panel)).toContain('varieties on file');
  });
});

describe('the grid keeps money and ages in the notation the master uses', () => {
  const filed = data.erp.master.products.find((p) => p.productId === 'PROD-UL-GLOBAL')!;
  const draft = draftOf(filed);

  it('strips the currency label from a cell without inventing a number', () => {
    expect(filed.baseRatePerThousand).toContain('AED');
    expect(draft.baseRatePerThousand).toBe(filed.baseRatePerThousand.replace(' AED', ''));
    expect(/^[0-9.]+$/.test(draft.baseRatePerThousand), 'a plain decimal').toBe(true);
    expect(draft.productId).toBe('PROD-UL-GLOBAL');
    expect(draft.category).toBe('unit-linked');
    expect(draft.secondaryName).toBe(filed.secondaryName ?? '');
  });

  it('round-trips a row back into the payload the API files', () => {
    const payload = toRowInput(draft) as Record<string, unknown>;
    expect(payload['productId']).toBe('PROD-UL-GLOBAL');
    expect(payload['category']).toBe('unit-linked');
    expect(payload['minAge']).toBe(filed.minAge);
    expect(String(payload['automaticBindingLimit'])).not.toContain('AED');
    // An untouched row is never flagged: only a row that cannot even be a number is stopped at the cell.
    expect(draftIssues(draft)).toEqual([]);
  });

  it('names a copy after its source, and never on top of a row that exists', () => {
    const taken = new Set(data.erp.master.products.map((p) => p.productId));
    const first = copyIdFor('PROD-UL-GLOBAL', taken);
    expect(first).toBe('PROD-UL-GLOBAL-COPY');
    expect(taken.has(first)).toBe(false);
    expect(copyIdFor('PROD-UL-GLOBAL', new Set([...taken, first]))).toBe('PROD-UL-GLOBAL-COPY-1');
    // The stem is stripped, so copying a copy does not stack suffixes forever.
    expect(copyIdFor(first, taken)).toBe('PROD-UL-GLOBAL-COPY');
    expect(copyIdFor('', taken)).toBe('PROD-COPY');
  });

  it('refuses the arithmetic in the cell before the bulk call is made', () => {
    expect(draftIssues({ ...draft, minAge: '70', maxAge: '20' }).join(' ')).toContain('admits nobody');
    expect(draftIssues({ ...draft, baseRatePerThousand: '' }).join(' ')).toContain('cannot be quoted');
    expect(draftIssues({ ...draft, productId: '  ' }).join(' ')).toContain('Product ID');
    expect(draftIssues({ ...draft, name: '' }).join(' ')).toContain('named');
  });
});

describe('the rating table prices a life by age, gender, rank and sum assured', () => {
  const html = render(h(RatingTablesPanel, { data, busy: false, onRun: run }), data);
  const body = plain(html);

  const priced = render(h(RatingTablesPanel, { data, busy: false, onRun: run, productId: 'PROD-UL-GLOBAL' }), data);

  it('opens on a product that has a tariff, and shows the rows in editable cells', () => {
    expect(body).toContain('190 row(s) on file');
    expect(html).toContain('aria-label="Age from"');
    expect(html).toContain('aria-label="Rate per 1000"');
    expect(html).toContain('aria-label="Occupation class"');
    // The seeded bands are 18–26, 27–35 … 56–65: the first page is the first of them.
    expect(html).toContain('value="18"');
    expect(body).toContain('Rate per 1000');
  });

  it('separates the premium from the cost of insurance, and says which one deducts monthly', () => {
    expect(body).toContain('Premium · per year');
    expect(body).toContain('Mortality · per month');
    expect(body).toContain('Base tariff and every override');
    // The conventional book has no monthly deduction to file…
    expect(body).toContain('not a unit-linked book');
    // …and the unit-linked one does, asked for by id the way the product shelf asks for it.
    const unitLinked = plain(priced);
    expect(unitLinked).toContain('mortality charged monthly from this grid');
    expect(unitLinked).toContain('PROD-UL-GLOBAL');
    expect(unitLinked).toContain('Price a life from this tariff');
  });

  it('offers the sample sheet, the bulk upload and the price-a-life probe', () => {
    expect(body).toContain('Rate sample template');
    expect(body).toContain('Bulk upload');
    expect(body).toContain('Upload these rows');
    expect(body).toContain('Price a life from this tariff');
    expect(html).toContain('aria-label="Rate rows, pasted from a spreadsheet"');
    expect(html).toContain('aria-label="Probe sum assured"');
  });

  it('counts channel and partner overrides so a desk can see the scoped rows', () => {
    expect(body).toContain('channel-specific');
    expect(body).toContain('partner-specific');
  });
});

describe('the omni-channel screen sets up what is not there, and edits what is', () => {
  it('says so plainly when nothing is set up, and offers the one button', () => {
    const html = plain(render(h(OmniChannelPanel, { data, busy: false, onRun: run }), data));
    expect(html).toContain('Omni-channel is not set up.');
    expect(html).toContain('Set up the 6 standard omni-channels');
    expect(html).toContain('Add a channel');
    expect(html).toContain('0 channel(s)');
  });

  it('shows the channels, the partners on them and each partner’s terms once it is set up', () => {
    const html = render(h(OmniChannelPanel, { data: configured, busy: false, onRun: run }), configured);
    const body = plain(html);
    expect(body).not.toContain('Omni-channel is not set up.');
    for (const code of ['DIRECT-PORTAL', 'AGENCY', 'BROKER', 'BANCASSURANCE', 'AGGREGATOR', 'EMBEDDED']) {
      expect(body, `${code} is a row`).toContain(code);
    }
    expect(body).toContain('Gulf Brokers');
    // Commission and clawback are schedules: one figure per year, shown as the sheet writes them.
    expect(body).toContain('1500, 500, 250');
    expect(body).toContain('10000, 5000, 2500');
    expect(body).toContain('Commission ceiling');
    expect(body).toContain('Clawback basis');
    expect(body).toContain('per policy year');
    // The partner's own shelf, with the name the plan carries there.
    expect(body).toContain('Gulf Elite Life');
    expect(body).toContain('+250 bps premium · +0 bps mortality');
    expect(html).toContain('aria-label="Commission schedule bps"');
    expect(html).toContain('aria-label="Shelf name"');
    // The money probe is part of the shelf: premium in, commission and clawback out, with the year of
    // the schedule it came from named in the answer.
    expect(body).toContain('What does a sale earn?');
    expect(html).toContain('aria-label="Gross premium"');
    expect(html).toContain('aria-label="Policy year"');
    expect(body).toContain('Check the money');
  });

  it('refuses a partner above the ceiling, in words the panel can quote back', () => {
    const world = buildWorld();
    world.erp.channels.bootstrap('', 'desk');
    // The grid's per-row refusals come from the same rule the registry enforces, so a row that files at
    // the API and a row refused on screen can never disagree about the number.
    expect(() => world.erp.channels.upsertPartner({
      partnerId: 'OVER-PAID', name: 'Over Paid', channelCode: 'DIRECT-PORTAL', commissionBps: [500], by: 'desk',
    })).toThrow(/ceiling/);
    // And what the registry advises is quoted on the screen, not kept in it: a channel with no partner on
    // it is the next thing the desk has to do, and the panel says so in the registry's own words.
    const snap = worldSnapshot(world);
    expect(snap.erp.master.channels.next.length).toBeGreaterThan(0);
    expect(plain(render(h(OmniChannelPanel, { data: snap, busy: false, onRun: run }), snap))).toContain('has no partner filed on it yet');
  });
});
