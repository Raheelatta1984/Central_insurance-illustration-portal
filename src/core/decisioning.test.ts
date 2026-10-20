/**
 * The decision theatre shows customers switch/withdrawal outcomes and projections. It had no
 * dedicated tests; these pin the properties a customer (and a regulator reading the
 * illustration) relies on: scenario ordering, contributions accounted, "illustration" labelling.
 */
import { describe, expect, it } from 'vitest';
import { project } from './decisioning.js';
import { money } from './money.js';

describe('projections', () => {
  const illustration = project({
    startValue: money(100_000_00n, 'AED'),
    monthlyContribution: money(1_000_00n, 'AED'),
    years: 5,
    disclaimer: 'Illustration only — not a guarantee.',
  });

  it('orders adverse ≤ central ≤ favourable in every year', () => {
    for (const row of illustration.rows) {
      expect(row.adverse.minor).toBeLessThanOrEqual(row.central.minor);
      expect(row.central.minor).toBeLessThanOrEqual(row.favourable.minor);
    }
  });

  it('accounts every contribution exactly once', () => {
    const last = illustration.rows.at(-1)!;
    expect(last.contributionsToDate.minor).toBe(100_000_00n + 5n * 12n * 1_000_00n);
  });

  it('labels itself an illustration with the mandated disclaimer and one row per year', () => {
    expect(illustration.isIllustration).toBe(true);
    expect(illustration.disclaimer).toMatch(/not a guarantee/);
    expect(illustration.rows.map((r) => r.year)).toEqual([1, 2, 3, 4, 5]);
    expect(illustration.currency).toBe('AED');
  });
});
