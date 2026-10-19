/**
 * The guide on screen: a note at the top of every section, and a switch that hides them all.
 *
 * Rendered server-side against the real world snapshot, the way `console.test.ts` does it, because the
 * failure worth catching here is not a wrong sentence — it is a screen with no note on it, a note that
 * pushes a section open, or a switch that hides the notes but leaves their markup behind. The last test
 * in each group re-counts `aria-expanded`, which is how the rail's "exactly one section open" rule is
 * proved: the notes must not disturb it.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { SECTION_GUIDES, TAB_GUIDES } from '../core/guide.js';
import { CONSOLE_TABS } from '../core/tour.js';
import { GuideBanner, GuideProvider, GuideToggle, ScreenGuide } from './guide.js';
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

describe('the note rides with the section', () => {
  it('puts exactly one note in the one section a rail opens, and none in the closed ones', () => {
    const html = withGuide(h(SectionGroup, {
      gates: [
        { id: 'register', title: 'Register a claim request', fields: fields(['Claim id', 'CLM-1'], ['Date of loss', '']) },
        { id: 'reserve', title: 'Reserve the claim', fields: fields(['Reserve', '']) },
        { id: 'settle', title: 'Settle, pay and recover', fields: fields(['Settlement', '']) },
      ],
    }), 'claims');
    // One note, in the open section, keyed to the curated entry for it.
    expect(notes(html)).toBe(1);
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
    const bare = renderToString(h(SectionGroup, {
      gates: [{ id: 'register', title: 'Register a claim request', fields: fields(['Claim id', 'CLM-1']) }],
    }));
    expect(notes(bare)).toBe(0);
    expect(openSections(bare)).toBe(1);
  });
});

describe('the switch', () => {
  it('hides every note when it is off, and says so on the button', () => {
    const node = h(SectionGroup, { gates: [{ id: 'register', title: 'Register a claim request', fields: fields(['Claim id', 'CLM-1']) }] });
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
      gates: [{ id: 'register', title: 'Register a claim request', fields: fields(['Claim id', 'CLM-1']) }],
    })), 'claims');
    expect(html).toContain('data-guide="screen:claims"');
    expect(html).toContain('guideNote screen');
    expect(plain(html)).toContain(`${Object.keys(SECTION_GUIDES).length} section notes on file`);
    expect(notes(html)).toBe(2);
  });
});

describe('every screen of the console', () => {
  it('has a screen note, so no tab is left without one', () => {
    for (const tab of CONSOLE_TABS) {
      const html = withGuide(h(ScreenGuide, {}), tab.id);
      expect(html, tab.id).toContain(`data-guide="screen:${tab.id}"`);
      expect(html, tab.id).toContain(TAB_GUIDES[tab.id]!.headline);
    }
  });

  it('renders the whole journey rail with a note in its open section and nothing else disturbed', () => {
    const html = withGuide(h(CustomerJourneyPanel, { data, onReload: noop, onNavigate: nowhere }), 'journey');
    expect(html).toContain('data-guide="journey:coverage"');
    expect(html).toContain('Section 5 of 19');
    expect(openSections(html)).toBe(1);
    expect(html.split('aria-expanded="false"').length - 1).toBe(18);
    expect(notes(html)).toBe(1);
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
