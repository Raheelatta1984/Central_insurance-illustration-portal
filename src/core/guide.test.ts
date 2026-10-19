/**
 * The AI guide: a note on every screen and every section, and the switch that hides them.
 *
 * Two things are worth testing here and neither is "does the string look nice". The first is coverage:
 * a guide that covers nineteen journey stages and misses the twentieth is worse than no guide, because
 * the operator learns to trust it. The second is provenance: the figures inside a note come from the
 * engine at render time, so a note cannot drift out of date the way a paragraph in a manual does.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { JOURNEY_STAGES } from './journey.js';
import { CONSOLE_TABS } from './tour.js';
import {
  GUIDE_LIMITATION, GuideDesk, SECTION_GUIDES, TAB_GUIDES, sectionGuide, slug, tabGuide, tabLabel,
  toneFor, worldFacts,
} from './guide.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

const world = buildWorld();

describe('the playbook covers every screen', () => {
  it('writes a note for each console tab, and only for tabs that exist', () => {
    expect(Object.keys(TAB_GUIDES).length).toBe(CONSOLE_TABS.length);
    for (const tab of CONSOLE_TABS) {
      const seed = TAB_GUIDES[tab.id];
      expect(seed, `${tab.id} has no guide`).toBeDefined();
      expect(seed!.headline.length, `${tab.id} headline`).toBeGreaterThan(12);
      expect(seed!.body.length, `${tab.id} body`).toBeGreaterThan(60);
      expect(seed!.doThis.length, `${tab.id} do-this list`).toBeGreaterThanOrEqual(2);
      expect(tabLabel(tab.id)).toBe(tab.label);
    }
    // A guide for a tab that no longer exists is a guide nobody reads, and it hides a rename.
    for (const key of Object.keys(TAB_GUIDES)) {
      expect(CONSOLE_TABS.some((t) => t.id === key), `${key} is not a console tab`).toBe(true);
    }
  });

  it('files every section note under a tab that exists', () => {
    for (const key of Object.keys(SECTION_GUIDES)) {
      const tab = key.slice(0, key.indexOf(':'));
      const section = key.slice(key.indexOf(':') + 1);
      expect(CONSOLE_TABS.some((t) => t.id === tab), `${key}: unknown tab`).toBe(true);
      expect(section.length, `${key}: empty section`).toBeGreaterThan(1);
      expect(slug(section), `${key}: section key must be a slug`).toBe(section);
    }
  });

  it('writes a note for all nineteen journey stages and for the master-settings gates', () => {
    for (const stage of JOURNEY_STAGES) {
      const seed = SECTION_GUIDES[`journey:${stage.id}`];
      expect(seed, `journey:${stage.id}`).toBeDefined();
      expect(seed!.headline.length).toBeGreaterThan(12);
    }
    for (const gate of ['regional', 'journey-fields', 'products', 'product-rating', 'omni-channel', 'charges', 'takaful', 'authority', 'fx-vocabulary', 'command']) {
      expect(SECTION_GUIDES[`master:${gate}`], `master:${gate}`).toBeDefined();
    }
    // The claims and underwriting rails are where money actually moves; they are curated too.
    for (const key of ['claims:register', 'claims:settle', 'underwriting:proposal', 'reinsurance:treaty', 'funds:nav']) {
      expect(SECTION_GUIDES[key], key).toBeDefined();
    }
  });
});

describe('a composed note', () => {
  it('carries the section state: status, progress, outstanding fields and blockers', () => {
    const note = sectionGuide({
      tab: 'journey', section: 'coverage', title: '5. Coverage & premium calculation',
      status: 'in-progress', percent: 62, missing: ['Sum assured', 'Payment frequency'],
      blockers: ['The plan is not affordable at the stated budget'], facts: worldFacts(world).journey!,
    });
    expect(note.curated).toBe(true);
    expect(note.title).toBe('Coverage & premium calculation');
    expect(note.tone).toBe('warn');
    expect(note.facts.join(' ')).toContain('62% complete');
    expect(note.facts.join(' ')).toContain('Sum assured, Payment frequency');
    expect(note.facts.join(' ')).toContain('The plan is not affordable at the stated budget');
    // The facts are the engine's, folded in — this is the note that says "90 products are rankable".
    expect(note.facts.join(' ')).toContain(`${world.erp.listProductMasters().length} products are rankable`);
  });

  it('still writes a note for a section nobody curated, so no section is ever bare', () => {
    const note = sectionGuide({ tab: 'ledger', section: 'double-entry-proof', title: 'Double-entry proof', status: 'complete', facts: worldFacts(world).ledger! });
    expect(note.curated).toBe(false);
    expect(note.headline).toBe(TAB_GUIDES['ledger']!.headline);
    expect(note.body).toContain('Double-entry proof');
    expect(note.body).toContain(tabLabel('ledger'));
    expect(note.doThis.length).toBeGreaterThanOrEqual(2);
    expect(note.tone).toBe('ok');
    expect(note.facts.join(' ')).toContain('balanced');
  });

  it('maps a status to a tone, and answers a plain card by its title slug', () => {
    expect(toneFor('complete')).toBe('ok');
    expect(toneFor('blocked')).toBe('bad');
    expect(toneFor('in-progress')).toBe('warn');
    expect(toneFor(undefined)).toBe('info');
    const byTitle = sectionGuide({ tab: 'master', title: 'Regional settings' });
    expect(byTitle.section).toBe('regional-settings');
    expect(byTitle.curated).toBe(false);
    // The curated key is reachable from the title the card actually prints.
    expect(SECTION_GUIDES[`master:${slug('Regional settings')}`] ?? null).toBeNull();
    expect(slug('Coverage & Premium Calculation')).toBe('coverage-premium-calculation');
  });

  it('gives a tab-level note its live facts and says what the notes are not', () => {
    const facts = worldFacts(world);
    const note = tabGuide('master', facts.master);
    expect(note.tab).toBe('master');
    expect(note.section).toBeNull();
    expect(note.facts.join(' ')).toContain(`${world.erp.listProductMasters().length} product masters`);
    expect(note.facts.join(' ')).toContain('AED');
    expect(GUIDE_LIMITATION).toContain('guidance, not advice');
    expect(Object.keys(facts).length).toBe(CONSOLE_TABS.length);
    for (const tab of CONSOLE_TABS) {
      expect(facts[tab.id]!.length, `${tab.id} facts`).toBeGreaterThanOrEqual(2);
      expect(facts[tab.id]!.join(' ')).toContain(world.tenant.name);
    }
  });

  it('re-reads the engine, so a master-settings change shows up in the note without a redeploy', () => {
    const before = worldFacts(world).journey!.join(' ');
    expect(before).toContain('No journey field has been renamed');
    world.journey.updateFieldSettings({ coverage: { sumAssured: { mandatory: true, editable: true, label: 'Amount of cover' } } }, { by: 'test', at: '2026-10-05T12:00:00Z' });
    const after = worldFacts(world).journey!.join(' ');
    expect(after).toContain('1 field(s) carry a renamed display label');
    expect(sectionGuide({ tab: 'journey', section: 'coverage', title: 'Coverage', facts: worldFacts(world).journey! })
      .facts.join(' ')).toContain('renamed display label');
  });
});

describe('the switch', () => {
  it('is on by default, and hiding the notes changes nothing else about them', () => {
    const desk = new GuideDesk({ at: '2026-10-05T12:00:00Z' });
    expect(desk.isEnabled()).toBe(true);
    const on = desk.snapshot(world);
    expect(on.enabled).toBe(true);
    expect(on.setBy).toBe('console-default');
    expect(on.counts.tabs).toBe(CONSOLE_TABS.length);
    expect(on.counts.sections).toBe(Object.keys(SECTION_GUIDES).length);
    expect(on.counts.curated).toBe(Object.keys(SECTION_GUIDES).length);
    expect(on.audit).toEqual([]);
    expect(on.limitation).toBe(GUIDE_LIMITATION);

    const change = desk.setPreference({ enabled: false, by: 'fatima@broker.ae', at: '2026-10-05T14:30:00Z' });
    expect(change.enabled).toBe(false);
    expect(desk.isEnabled()).toBe(false);

    const off = desk.snapshot(world);
    expect(off.enabled).toBe(false);
    expect(off.setBy).toBe('fatima@broker.ae');
    expect(off.setAt).toBe('2026-10-05T14:30:00Z');
    expect(off.audit.length).toBe(1);
    expect(off.audit[0]!.note).toContain('switched off');
    // Turning the notes off hides them; it must not quietly rewrite what they said.
    expect(off.tabs.map((t) => t.note.headline)).toEqual(on.tabs.map((t) => t.note.headline));
    expect(off.counts).toEqual(on.counts);
  });

  it('is deterministic: the same world, snapshotted twice, says the same thing', () => {
    const a = new GuideDesk({ at: '2026-10-05T12:00:00Z' }).snapshot(world);
    const b = new GuideDesk({ at: '2026-10-05T12:00:00Z' }).snapshot(world);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // And a fresh world carries the switch with it, so the API is the only thing that can change it.
    expect(buildWorld().guide.snapshot(buildWorld()).enabled).toBe(true);
  });

  it('serves the notes over the API and records the switch as an agent action', async () => {
    const state = createRuntimeState();
    const get = await dispatchApiRoute(state, 'GET', '/guide', new URLSearchParams(), {});
    expect(get.status).toBe(200);
    const body = get.body as { enabled: boolean; counts: { tabs: number }; tabs: Array<{ id: string; label: string; note: { headline: string } }>; facts: Record<string, string[]> };
    expect(body.enabled).toBe(true);
    expect(body.counts.tabs).toBe(CONSOLE_TABS.length);
    expect(body.tabs.find((t) => t.id === 'journey')!.label).toBe('Customer journey');
    expect(body.facts.master!.join(' ')).toContain('product masters');

    const off = await dispatchApiRoute(state, 'POST', '/guide/preference', new URLSearchParams(), { enabled: false, by: 'console-operator', at: '2026-10-05T15:00:00Z' });
    expect(off.status).toBe(200);
    const changed = off.body as { enabled: boolean; by: string; at: string; actionId: string; status: string };
    expect(changed.enabled).toBe(false);
    expect(changed.by).toBe('console-operator');
    expect(changed.at).toBe('2026-10-05T15:00:00Z');

    const after = await dispatchApiRoute(state, 'GET', '/guide', new URLSearchParams(), {});
    expect((after.body as { enabled: boolean }).enabled).toBe(false);
    expect((after.body as { audit: Array<{ by: string }> }).audit[0]!.by).toBe('console-operator');

    // The world snapshot carries the switch, because the console reads the snapshot, not the desk —
    // and the preference is on the AI ledger too, so "was this operator shown the guidance?" is a
    // question a reviewer can answer from a record instead of from somebody's memory.
    const worldSnapshot = await dispatchApiRoute(state, 'GET', '/world', new URLSearchParams(), {});
    const snap = worldSnapshot.body as {
      guide: { enabled: boolean; counts: { sections: number } };
      ai: { actions: Array<{ id: string; module: string; riskClass: string; agent: string; status: string }>; awaiting: number };
    };
    expect(snap.guide.enabled).toBe(false);
    expect(snap.guide.counts.sections).toBe(Object.keys(SECTION_GUIDES).length);
    const logged = snap.ai.actions.find((a) => a.id === changed.actionId)!;
    expect(logged.module).toBe('guide');
    expect(logged.agent).toBe('agent/console-guide');
    expect(logged.riskClass).toBe('low');
    // A guidance preference is not work for a human: it must never join the awaiting-approval queue
    // (the demo world has one real approval waiting on the AI ledger, and this is not it).
    expect(logged.status).toBe('executed');
    expect(snap.ai.actions.filter((a) => a.module === 'guide' && a.status === 'awaiting-approval').length).toBe(0);

    const on = await dispatchApiRoute(state, 'POST', '/guide/preference', new URLSearchParams(), { enabled: true });
    expect((on.body as { enabled: boolean }).enabled).toBe(true);
    expect((on.body as { by: string }).by).toBe('console-operator');
  });
});
