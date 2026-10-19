/**
 * The guide on screen: a sticky note against every section and subsection, and a switch that hides
 * them all.
 *
 * Rendered server-side against the real world snapshot, the way `console.test.ts` does it, because
 * the failure worth catching here is not a wrong sentence — it is a screen with no note on it, a
 * note that pushes a section open, or a switch that hides the notes but leaves their markup behind.
 * The notes are paper: a GUIDE badge, a "Step N · title", a "Do this" line, a hand-drawn arrow, and
 * a close button — and the paper must never be mistaken for an open section, which is why the last
 * test in each group re-counts `aria-expanded`: the rail's "exactly one section open" rule must
 * survive a stack of notes.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { SECTION_GUIDES, TAB_GUIDES } from '../core/guide.js';
import { CONSOLE_TABS } from '../core/tour.js';
import { GuideBanner, GuideHeading, GuideProvider, GuideToggle, ScreenGuide } from './guide.js';
import { SectionGroup, SectionStack, fields } from './sections.js';
import { CustomerJourneyPanel } from './journey.js';
import { DEFAULT_PRODUCT_FORM, JourneyFieldSettingsPanel, MasterSettingsErp, ProductFactoryPanel } from './erp-views.js';

const data = worldSnapshot(buildWorld());
const noop = async () => {};
const nowhere = () => {};
const h = React.createElement;

/** A panel rendered the way the console renders it: inside the provider, on its own tab. */
function withGuide(node: React.ReactElement, tab: string, enabled = true): string {
  return renderToString(h(GuideProvider, { data, tab, enabled, children: node }));
}

/** Server rendering splits adjacent text with comment markers; strip them before reading a sentence. */
const plain = (html: string) => html.replace(/<!--[^>]*-->/g, '');
const notes = (html: string) => html.split('data-guide="').length - 1;
const openSections = (html: string) => html.split('aria-expanded="true"').length - 1;

const CLAIM_GATES = [
  { id: 'register', title: 'Register a claim request', fields: fields(['Claim id', 'CLM-1'], ['Date of loss', '']) },
  { id: 'reserve', title: 'Reserve the claim', fields: fields(['Reserve', '']) },
  { id: 'settle', title: 'Settle, pay and recover', fields: fields(['Settlement', '']) },
];

describe('the note rides with the section', () => {
  it('puts a sticky note in every section, including closed sections', () => {
    const html = withGuide(h(SectionGroup, { gates: CLAIM_GATES }), 'claims');
    // Every rail heading gets its own paper; notes never open the underlying section.
    expect(notes(html)).toBe(3);
    expect(html).toContain('data-guide="claims:reserve"');
    expect(html).toContain('data-guide="claims:settle"');
    expect(html).toContain('aria-label="AI guide for Register a claim request"');
    expect(html).toContain('data-guide="claims:register"');
    expect(html).toContain('data-curated="yes"');
    expect(plain(html)).toContain(SECTION_GUIDES['claims:register']!.headline);
    // And the rail still opens exactly one section: the notes are inside it, not another rail.
    expect(openSections(html)).toBe(1);
  });

  it('composes a note for a section nobody curated, naming the section and its screen', () => {
    const html = withGuide(h(SectionGroup, {
      gates: [{ id: 'a-brand-new-gate', title: 'A brand new gate', fields: fields(['Something', 'x']) }],
    }), 'claims');
    expect(notes(html)).toBe(1);
    expect(html).toContain('data-curated="composed"');
    expect(html).toContain('A brand new gate');
    expect(html).toContain('Claims');
  });

  it('folds the section state into the note: the percentage, what is missing and what stopped it', () => {
    const html = withGuide(h(SectionStack, {
      sections: [{
        id: 'coverage', title: '5. Coverage & premium calculation', status: 'in-progress', percent: 40,
        missing: ['Amount of cover', 'Payment frequency'], blockers: ['The plan is not affordable at the stated budget'],
        autoOpen: true,
      }],
    }), 'journey');
    expect(html).toContain('40% complete');
    expect(html).toContain('Amount of cover, Payment frequency');
    expect(html).toContain('The plan is not affordable at the stated budget');
    expect(html).toContain('in progress');
  });

  it('leaves a panel alone when nothing provides the notes, so an embed or a test renders as before', () => {
    const bare = renderToString(h(SectionGroup, { gates: CLAIM_GATES }));
    expect(notes(bare)).toBe(0);
    expect(openSections(bare)).toBe(1);
  });
});

describe('the paper', () => {
  it('reads like the sketch: a GUIDE badge, a step title, a Do this line and an arrow down at the form', () => {
    const html = withGuide(h(SectionGroup, { gates: CLAIM_GATES }), 'claims');
    expect(html).toContain('class="stickyBadge"');
    expect(plain(html)).toContain('GUIDE');
    // The open section is step one, so its paper says so.
    expect(plain(html)).toContain('Step 1 · Register a claim request');
    expect(plain(html)).toContain('Do this:');
    // The closed sections behind it are numbered too.
    expect(plain(html)).toContain('Step 2 · Reserve the claim');
    expect(plain(html)).toContain('Step 3 · Settle, pay and recover');
    // Every note carries the hand-drawn arrow and the × in a circle.
    expect(html.split('class="stickyArrow"').length - 1).toBe(3);
    expect(html.split('aria-label="Dismiss this guide note"').length - 1).toBe(3);
    // And a fresh render has not dismissed anything: no reshow pin anywhere.
    expect(html).not.toContain('stickyReshow');
    // The paper never carries the rail's own state attribute: exactly one aria-expanded per section
    // toggle, none on the notes — the rail's "exactly one open" rule survives a stack of papers.
    expect((html.match(/aria-expanded=/g) ?? []).length).toBe(3);
    expect(openSections(html)).toBe(1);
  });

  it('keeps the curated words on the compact paper too, trimmed by CSS rather than dropped', () => {
    const html = withGuide(h(SectionGroup, { gates: CLAIM_GATES }), 'claims');
    // The closed sections' notes are the compact ones — and they still say what to watch for.
    const idx = html.indexOf('data-guide="claims:reserve"');
    const noteStart = html.lastIndexOf('class="guideNote', idx);
    const reserveNote = html.slice(noteStart, idx + 3000);
    expect(reserveNote.slice(0, 120)).toContain('compact');
    expect(plain(reserveNote)).toContain(SECTION_GUIDES['claims:reserve']!.watch ?? 'Watch');
    expect(reserveNote).toContain('Watch:');
  });

  it('keeps each arrow inside the note it belongs to', () => {
    const html = withGuide(h(SectionGroup, { gates: CLAIM_GATES }), 'claims');
    const starts = CLAIM_GATES.map((g) => html.indexOf(`data-guide="claims:${g.id}"`));
    starts.forEach((start, i) => {
      expect(start, CLAIM_GATES[i]!.id).toBeGreaterThan(-1);
      const end = i + 1 < starts.length ? starts[i + 1]! : html.length;
      expect(html.slice(start, end)).toContain('class="stickyArrow"');
    });
  });
});

describe('the switch', () => {
  it('hides every note when it is off, and says so on the button', () => {
    const node = h(SectionGroup, { gates: [CLAIM_GATES[0]!] });
    expect(notes(withGuide(node, 'claims', false))).toBe(0);
    expect(notes(withGuide(node, 'claims', true))).toBe(1);
    // The rail's own behaviour is untouched either way.
    expect(openSections(withGuide(node, 'claims', false))).toBe(1);

    const on = renderToString(h(GuideToggle, { enabled: true, onToggle: nowhere }));
    expect(on).toContain('aria-pressed="true"');
    expect(plain(on)).toContain('AI guide: on');
    const off = renderToString(h(GuideToggle, { enabled: false, onToggle: nowhere }));
    expect(off).toContain('aria-pressed="false"');
    expect(plain(off)).toContain('AI guide: off');
  });

  it('writes a note for the screen itself, above its sections', () => {
    const html = withGuide(h('div', null, h(ScreenGuide, {}), h(SectionGroup, {
      gates: [CLAIM_GATES[0]!],
    })), 'claims');
    expect(html).toContain('data-guide="screen:claims"');
    expect(html).toContain('guideNote info screen');
    expect(notes(html)).toBe(2);
  });
});

describe('every screen of the console', () => {
  it('has a screen note, so no tab is left without one', () => {
    for (const tab of CONSOLE_TABS) {
      const html = withGuide(h(ScreenGuide, {}), tab.id);
      expect(html, tab.id).toContain(`data-guide="screen:${tab.id}"`);
      expect(plain(html), tab.id).toContain(TAB_GUIDES[tab.id]!.headline);
    }
  });

  it('renders the whole journey rail with notes in all nineteen headings and one open section', () => {
    const html = withGuide(h(CustomerJourneyPanel, { data, onReload: noop, onNavigate: nowhere }), 'journey');
    expect(html).toContain('data-guide="journey:coverage"');
    expect(html).toContain('Section 5 of 19');
    expect(openSections(html)).toBe(1);
    expect(html.split('aria-expanded="false"').length - 1).toBe(18);
    expect(html).toContain('data-guide="journey:identity"');
    expect(html).toContain('data-guide="journey:recommendation"');
    expect(notes(html)).toBeGreaterThanOrEqual(19);
    // The open section of the journey is step five: its paper says so.
    expect(plain(html)).toContain('Step 5 · Coverage &amp; premium calculation');
  });

  it('places a subsection note next to its heading, using the same switch', () => {
    const node = h(GuideHeading, { title: 'What the engine computed' });
    const html = withGuide(node, 'journey');
    expect(html).toContain('<h4 class="small">What the engine computed</h4>');
    expect(html).toContain('data-guide="journey:what-the-engine-computed"');
    expect(plain(html)).toContain('Do this:');
    expect(withGuide(node, 'journey', false)).not.toContain('data-guide');
  });

  it('connects personal details to suitability without recommending a product from identity alone', () => {
    const html = withGuide(h(SectionStack, { sections: [
      { id: 'identity', title: 'Personal information', status: 'complete', percent: 100 },
      { id: 'profile', title: 'Customer profile', status: 'complete', percent: 100 },
      { id: 'needs', title: 'Needs analysis', status: 'ready', percent: 0, autoOpen: true },
      { id: 'recommendation', title: 'Product recommendation', status: 'locked', percent: 0 },
    ] }), 'journey');
    expect(html).toContain('data-guide="journey:identity"');
    expect(html).toContain('not a product recommendation on their own');
    expect(html).toContain('suitability is assessed against the stated needs');
    expect(html).toContain('ranked against the evaluated need');
    expect(html).toContain('data-guide="journey:recommendation"');
    expect(openSections(html)).toBe(1);
  });

  it('opens master settings on the regional panel: country, region, time zone, date order and money', () => {
    const html = withGuide(h(MasterSettingsErp, { data, onReload: noop, onNavigate: nowhere }), 'master');
    expect(html).toContain('data-guide="master:regional"');
    expect(html).toContain('1. Country, region, calendar, time zone and currencies');
    expect(html).toContain('Time zone');
    expect(html).toContain('Local currency');
    expect(html).toContain('Date format');
    expect(plain(html)).toContain('Foreign currencies on the rate card');
    expect(html).toContain('Quote currency');
    expect(plain(html)).toContain('United Arab Emirates (AE)');
    expect(html).toContain('Asia/Kuala_Lumpur');
    // Every country, time zone and currency the tenant may choose from is offered, not typed in.
    for (const country of data.erp.master.regional.choices.countries) {
      expect(html, country.code).toContain(`value="${country.code}"`);
    }
    for (const fx of data.erp.master.regional.foreignCurrencies) {
      expect(plain(html), fx.code).toContain(fx.rate);
    }
    expect(openSections(html)).toBe(1);
  });

  it('renames a field on the same screen that decides whether it is required', () => {
    const html = renderToString(h(JourneyFieldSettingsPanel, { journey: data.journey, busy: false, onSave: noop }));
    expect(html).toContain('Display name (rename)');
    expect(plain(html)).toContain('fields renamed on file');
    expect(html).toContain('aria-label="Display name for Sum assured"');
    expect(html).toContain('value="Sum assured"');
    expect(html).toContain('maxLength="80"');
    // All nineteen stages are listed, so a rename is reachable from one screen.
    expect(html.split('<details').length - 1).toBe(19);
  });

  it('lists the whole product shelf, by line, and quotes it in the local currency', () => {
    const html = renderToString(h(ProductFactoryPanel, {
      data, busy: false, form: DEFAULT_PRODUCT_FORM, setForm: () => {}, onSave: () => {},
    }));
    expect(html).toContain('Filed variety');
    expect(plain(html)).toContain(`${data.erp.master.catalogueSize} varieties on file`);
    for (const line of data.erp.master.productLines) {
      expect(html, `${line.line} in the shelf filter`).toContain(`<option value="${line.line}">`);
      expect(plain(html), `${line.line} optgroup`).toContain(line.label.replace(/&/g, '&amp;'));
    }
    // A marine hull variety is on the shelf: the lines this platform did not used to write are writable.
    expect(html).toContain('PROD-HULL-MARINE');
    expect(plain(html)).toContain('Hull &amp; machinery');
    expect(plain(html)).toContain(`Base Rate / 1,000 (${data.erp.master.regional.localCurrency})`);
    // Every filed variety is a row, so the screen shows what the engines will actually underwrite.
    expect(html.split('<tr>').length - 1).toBe(data.erp.master.products.length + 1);
  });
});
