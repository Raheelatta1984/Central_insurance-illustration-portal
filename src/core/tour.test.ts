import { describe, expect, it } from 'vitest';
import { CONSOLE_TABS, TOUR, ConsoleTab, tourByTab, tourMinutes } from './tour.js';

describe('the 60-minute tour', () => {
  it('adds up to exactly an hour', () => {
    expect(tourMinutes()).toBe(60);
  });

  it('starts at 00:00 and never goes backwards', () => {
    expect(TOUR[0]!.at).toBe('00:00');
    const minutes = TOUR.map((s) => Number(s.at.slice(0, 2)) * 60 + Number(s.at.slice(3, 5)));
    for (let i = 1; i < minutes.length; i += 1) expect(minutes[i]!).toBeGreaterThan(minutes[i - 1]!);
  });

  it('tells you where to go, what to do and what you will see, every time', () => {
    for (const step of TOUR) {
      expect(step.title.length, step.at).toBeGreaterThan(10);
      expect(step.why.length, step.at).toBeGreaterThan(40);
      expect(step.doThis.length, step.at).toBeGreaterThanOrEqual(1);
      expect(step.expect.length, step.at).toBeGreaterThanOrEqual(1);
      expect(step.minutes, step.at).toBeGreaterThan(0);
    }
  });

  it('only sends you to tabs that exist in the console', () => {
    const known = new Set<string>(CONSOLE_TABS.map((t) => t.id));
    for (const step of TOUR) expect(known.has(step.tab), `${step.at} → ${step.tab}`).toBe(true);
  });

  it('covers the money-moving tabs, not just the pretty ones', () => {
    const tabs = new Set<ConsoleTab>(TOUR.map((s) => s.tab as ConsoleTab));
    for (const required of ['overview', 'policyholder', 'decisions', 'cover', 'funds', 'takaful', 'group', 'underwriting', 'claims', 'durability'] as ConsoleTab[]) {
      expect(tabs.has(required), `tour must include ${required}`).toBe(true);
    }
  });

  it('groups consecutive steps on the same tab', () => {
    const groups = tourByTab();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g.steps.every((s) => s.tab === g.tab)).toBe(true);
    expect(groups.flatMap((g) => g.steps).length).toBe(TOUR.length);
  });
});
