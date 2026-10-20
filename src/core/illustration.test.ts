/**
 * The illustration tests: the figures a customer is shown have to be the figures the engine can
 * defend — a rate that came from somewhere, a premium that stops when the customer stops paying,
 * and a benefit that never promises more than the policy says.
 */
import { describe, expect, it } from 'vitest';
import { money, parseAmount, formatAmount } from './money.js';
import {
  BUILT_IN_RATES, IllustrationAssumptionTable, IllustrationCharges, IllustrationError,
  buildIllustration, illustrationHeadline, illustrationRows, milestoneYears, rateProblems,
} from './illustration.js';
import { DEFAULT_CHARGES } from './unitlinked.js';

const CHARGES: IllustrationCharges = {
  allocationChargeBps: DEFAULT_CHARGES.allocationChargeBps,
  coiPerMilleMonthly: DEFAULT_CHARGES.coiPerMilleMonthly,
  adminFeeMonthlyMinor: DEFAULT_CHARGES.adminFeeMonthlyMinor,
  surrenderChargeBpsByYear: [...DEFAULT_CHARGES.surrenderChargeBpsByYear],
};

const base = {
  currency: 'AED',
  sumAssured: money(500_000_00n, 'AED'),
  premiumPerFrequency: money(12_000_00n, 'AED'),
  paymentFrequency: 'annual' as const,
  premiumPayingTermYears: 20,
  benefitTermYears: 30,
  entryAge: 35,
  rates: BUILT_IN_RATES,
  charges: CHARGES,
  investmentLinked: true,
  generatedAt: '2026-10-05T12:00:00+04:00',
};

describe('the filed rate table', () => {
  it('gives a scope its own row and reports where each figure came from', () => {
    const table = new IllustrationAssumptionTable();
    table.set({ productId: 'PROD-UL-ENDOW', lowBps: 300, midBps: 600, highBps: 900, by: 'pricing-actuary', at: '2026-10-05T09:00:00+04:00' });
    const resolved = table.resolve({ productId: 'PROD-UL-ENDOW' });
    expect(resolved.rates).toEqual({ lowBps: 300, midBps: 600, highBps: 900 });
    expect(resolved.level).toBe('product');
    // The document prints the source of every assumption, so it must be the filed row, not the floor.
    expect(resolved.sources.lowBps).toBe('the product master');
  });

  it('falls back to the parent row for any figure a narrower scope leaves empty', () => {
    const table = new IllustrationAssumptionTable();
    table.set({ productId: 'P1', lowBps: 400, midBps: 800, highBps: 1200 });
    // A bank counter that is only allowed to show a more optimistic ceiling files one number, not three.
    table.set({ productId: 'P1', channelCode: 'BANCASSURANCE', highBps: 1000 });
    const resolved = table.resolve({ productId: 'P1', channelCode: 'BANCASSURANCE' });
    expect(resolved.rates).toEqual({ lowBps: 400, midBps: 800, highBps: 1000 });
    expect(resolved.sources.highBps).toBe('omni-channel BANCASSURANCE');
    expect(resolved.sources.lowBps).toBe('the product master');
  });

  it('resolves sub-channel over channel over product, and inherits the rest', () => {
    const table = new IllustrationAssumptionTable();
    table.set({ productId: 'P1', lowBps: 400, midBps: 800, highBps: 1200 });
    table.set({ productId: 'P1', channelCode: 'BROKER', midBps: 700 });
    table.set({ productId: 'P1', channelCode: 'BROKER', subChannelCode: 'BROKER-DIFC', lowBps: 350 });
    const narrow = table.resolve({ productId: 'P1', channelCode: 'BROKER', subChannelCode: 'BROKER-DIFC' });
    expect(narrow.rates).toEqual({ lowBps: 350, midBps: 700, highBps: 1200 });
    // A sibling sub-channel with no row of its own sees the channel row, not the product row.
    const sibling = table.resolve({ productId: 'P1', channelCode: 'BROKER', subChannelCode: 'BROKER-APP' });
    expect(sibling.rates).toEqual({ lowBps: 400, midBps: 700, highBps: 1200 });
  });

  it('drops a row when every figure is cleared, so the scope inherits again', () => {
    const table = new IllustrationAssumptionTable();
    table.set({ productId: 'P1', lowBps: 400, midBps: 800, highBps: 1200 });
    table.set({ productId: 'P1', channelCode: 'AGENCY', lowBps: 200, midBps: 500, highBps: 900 });
    table.set({ productId: 'P1', channelCode: 'AGENCY' });
    expect(table.get('P1', 'AGENCY', null)).toBeNull();
    expect(table.resolve({ productId: 'P1', channelCode: 'AGENCY' }).rates).toEqual(BUILT_IN_RATES);
    expect(table.audit().some((e) => e.action === 'cleared')).toBe(true);
  });

  it('refuses a rate nobody could defend, with the figure in the sentence', () => {
    const table = new IllustrationAssumptionTable();
    expect(() => table.set({ productId: 'P1', midBps: 9_000 }))
      .toThrow(/Mid rate must sit between 0% and 30% a year, not 90%/);
  });

  it('refuses a sub-channel row with no parent channel, because it could never be resolved', () => {
    const table = new IllustrationAssumptionTable();
    expect(() => table.set({ productId: 'P1', subChannelCode: 'ORPHAN', midBps: 600 })).toThrow(/needs the omni-channel/);
  });

  it('walks the whole cascade in the audit trail so a filed rate can be traced', () => {
    const table = new IllustrationAssumptionTable();
    table.set({ productId: 'P1', channelCode: 'AGENCY', subChannelCode: 'AGENCY-APP', midBps: 650, by: 'pricing-actuary' });
    const entry = table.audit()[0]!;
    expect(entry.action).toBe('set');
    expect(entry.by).toBe('pricing-actuary');
    expect(entry.detail).toContain('sub-channel row for P1 on AGENCY / AGENCY-APP');
  });
});

describe('the projection', () => {
  it('keeps charging nothing after the paying term while the benefit keeps running', () => {
    const illustration = buildIllustration(base);
    const year20 = illustration.rows[19]!;
    const year21 = illustration.rows[20]!;
    expect(year20.payingPremium).toBe(true);
    expect(year21.payingPremium).toBe(false);
    // The customer pays for 20 years and is covered for 30: the last ten rows must show no premium.
    expect(year21.premiumThisYear.minor).toBe(0n);
    expect(illustration.rows[29]!.cumulativePremium.minor).toBe(year20.cumulativePremium.minor);
    expect(illustration.rows.length).toBe(30);
  });

  it('totals the premiums the customer actually pays, to the minor unit', () => {
    const illustration = buildIllustration(base);
    // 20 annual premiums of 12,000.00, exactly.
    expect(illustration.totals.premiumPayable.minor).toBe(20n * 12_000_00n);
    expect(formatAmount(illustration.totals.premiumPayable)).toBe('240,000.00 AED');
  });

  it('invests the contribution net of the allocation charge and never loses a minor unit', () => {
    const illustration = buildIllustration(base);
    const first = illustration.rows[0]!;
    // 5% of 12,000.00 is 600.00, so 11,400.00 is invested.
    expect(formatAmount(first.allocatedThisYear)).toBe('11,400.00 AED');
    const allocated = illustration.rows.reduce((s, r) => s + r.allocatedThisYear.minor, 0n);
    expect(allocated).toBe(illustration.totals.allocatedToFund.minor);
    expect(allocated).toBe(20n * 11_400_00n);
  });

  it('orders the three scenarios the way the rates are ordered, every year', () => {
    const illustration = buildIllustration(base);
    for (const row of illustration.rows) {
      expect(row.fundValue.low.minor).toBeLessThanOrEqual(row.fundValue.mid.minor);
      expect(row.fundValue.mid.minor).toBeLessThanOrEqual(row.fundValue.high.minor);
    }
  });

  it('refuses to project on rates that do not hold together', () => {
    expect(() => buildIllustration({ ...base, rates: { lowBps: 1_200, midBps: 800, highBps: 400 } }))
      .toThrow(/pessimistic rate \(12.00%\) is above the mid rate \(8.00%\)/);
    expect(rateProblems({ lowBps: 400, midBps: 800, highBps: 1_200 })).toEqual([]);
  });

  it('never pays out less than the sum assured on death', () => {
    const illustration = buildIllustration({ ...base, premiumPerFrequency: money(100_00n, 'AED') });
    for (const row of illustration.rows) {
      // A small premium is eaten by the cost of insurance; the guarantee is still the guarantee.
      expect(row.deathBenefit.low.minor).toBeGreaterThanOrEqual(base.sumAssured.minor);
      expect(row.fundValue.mid.minor).toBeGreaterThanOrEqual(0n);
    }
  });

  it('takes the surrender charge off in the early years and nothing after the schedule', () => {
    const illustration = buildIllustration(base);
    const year1 = illustration.rows[0]!;
    const year7 = illustration.rows[6]!;
    expect(year1.surrenderValue.mid.minor).toBeLessThan(year1.fundValue.mid.minor);
    // The schedule ends after year 6, so from year 7 the surrender value is the fund value.
    expect(year7.surrenderValue.mid.minor).toBe(year7.fundValue.mid.minor);
  });

  it('prices a single premium once and covers the whole term for it', () => {
    const illustration = buildIllustration({
      ...base, paymentFrequency: 'single', premiumPerFrequency: money(40_000_00n, 'AED'), premiumPayingTermYears: 1,
    });
    expect(illustration.rows[0]!.premiumThisYear.minor).toBe(40_000_00n);
    expect(illustration.rows[1]!.premiumThisYear.minor).toBe(0n);
    expect(illustration.totals.premiumPayable.minor).toBe(40_000_00n);
    expect(illustration.paymentTermsLabel).toMatch(/single premium/);
  });

  it('shows a benefit and no fund value on cover with no investment component', () => {
    const illustration = buildIllustration({ ...base, investmentLinked: false });
    for (const row of illustration.rows) {
      expect(row.fundValue.mid.minor).toBe(0n);
      expect(row.surrenderValue.mid.minor).toBe(0n);
      expect(row.deathBenefit.mid.minor).toBe(base.sumAssured.minor);
    }
    expect(illustration.assumptions.join(' ')).toMatch(/no investment component/);
  });

  it('is deterministic: the same inputs give the same figures', () => {
    const a = buildIllustration(base);
    const b = buildIllustration(base);
    expect(a.rows.map((r) => r.fundValue.mid.minor)).toEqual(b.rows.map((r) => r.fundValue.mid.minor));
  });
});

describe('the years the customer is shown', () => {
  it('prints every ten years, the end of the term, and the year the life reaches 100', () => {
    expect(milestoneYears({ benefitTermYears: 30, entryAge: 35 })).toEqual([10, 20, 30]);
    // A whole-of-life style term runs past 100: that row is the one customers ask about by name.
    expect(milestoneYears({ benefitTermYears: 70, entryAge: 30 })).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(milestoneYears({ benefitTermYears: 45, entryAge: 55 })).toEqual([10, 20, 30, 40, 45]);
  });

  it('always prints the final year, however short the term', () => {
    expect(milestoneYears({ benefitTermYears: 4, entryAge: 40 })).toEqual([4]);
  });

  it('labels each milestone with the age the customer will be', () => {
    const illustration = buildIllustration(base);
    const labels = illustration.milestones.map((m) => `${m.year}:${m.age}`);
    expect(labels).toEqual(['10:45', '20:55', '30:65']);
    expect(illustration.milestones.at(-1)!.label).toMatch(/End of the 30-year benefit term/);
  });

  it('renders the same figures in the table as in the rows', () => {
    const illustration = buildIllustration(base);
    const { milestoneRows } = illustrationRows(illustration);
    const last = illustration.milestones.at(-1)!;
    expect(milestoneRows.at(-1)).toEqual([
      'End of the 30-year benefit term', '30', '65', formatAmount(last.row.cumulativePremium),
      formatAmount(last.row.fundValue.low), formatAmount(last.row.fundValue.mid),
      formatAmount(last.row.fundValue.high), formatAmount(last.row.deathBenefit.mid),
    ]);
  });

  it('summarises the projection in one sentence a card or an email can quote', () => {
    const illustration = buildIllustration(base);
    expect(illustrationHeadline(illustration)).toMatch(/projected at the mid rate/);
    expect(illustrationHeadline(buildIllustration({ ...base, investmentLinked: false }))).toMatch(/of cover at end of the 30-year benefit term/);
  });

  it('carries the customer’s payment terms in the assumptions', () => {
    const illustration = buildIllustration({ ...base, paymentFrequency: 'monthly', premiumPayingTermYears: 10, premiumPerFrequency: money(1_000_00n, 'AED') });
    expect(illustration.paymentTermsLabel).toMatch(/every month for 10 year\(s\)/);
    expect(illustration.assumptions.join(' ')).toMatch(/Assumed growth, before charges: pessimistic 4.00%, mid 8.00%, optimistic 12.00%./);
  });

  it('takes the premium straight off the quotation currency without a float in sight', () => {
    const illustration = buildIllustration({ ...base, premiumPerFrequency: parseAmount('1,234.56', 'AED') });
    expect(illustration.rows[0]!.premiumThisYear.minor).toBe(123_456n);
  });
});
