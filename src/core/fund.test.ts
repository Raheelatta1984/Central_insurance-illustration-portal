import { describe, expect, it } from 'vitest';
import { addBusinessDays, DEFAULT_CALENDAR, isBusinessDay, NavEngine, nextBusinessDay, resolveDealingPoint, singlePriceFund } from './fund.js';
import { add, money } from './money.js';
import { unitsFromDecimal, unitsToDecimal, valueOfUnits, unitsForAmount, unitsToRealise, priceFromDecimal, priceToDecimal as priceToDecimalTest } from './units.js';

const uaeRule = { cutoff: '15:00', utcOffsetMinutes: 240, afterCutoff: 'next-business-day' as const };

describe('fund — calendars and dealing cut-offs', () => {
  it('knows weekends and holidays', () => {
    expect(isBusinessDay('2026-10-01', DEFAULT_CALENDAR)).toBe(true);   // Thursday
    expect(isBusinessDay('2026-10-03', DEFAULT_CALENDAR)).toBe(false);  // Saturday
    const withHoliday = { ...DEFAULT_CALENDAR, holidays: ['2026-10-05'] };
    expect(isBusinessDay('2026-10-05', withHoliday)).toBe(false);
    expect(nextBusinessDay('2026-10-02', DEFAULT_CALENDAR)).toBe('2026-10-05'); // skips the weekend
    expect(nextBusinessDay('2026-10-03', DEFAULT_CALENDAR)).toBe('2026-10-05');
    expect(addBusinessDays('2026-10-01', 2, DEFAULT_CALENDAR)).toBe('2026-10-05');
  });

  it('resolves instructions before the cut-off to the same day', () => {
    const dp = resolveDealingPoint(uaeRule, '2026-10-01T14:59:00+04:00', DEFAULT_CALENDAR);
    expect(dp.valuationDate).toBe('2026-10-01');
    expect(dp.sameDay).toBe(true);
    expect(dp.explanation).toMatch(/before the 15:00 cut-off/);
  });

  it('resolves instructions after the cut-off to the next dealing day', () => {
    const dp = resolveDealingPoint(uaeRule, '2026-10-01T16:20:00+04:00', DEFAULT_CALENDAR);
    expect(dp.valuationDate).toBe('2026-10-02');
    expect(resolveDealingPoint(uaeRule, '2026-10-02T16:20:00+04:00', DEFAULT_CALENDAR).valuationDate).toBe('2026-10-05');
    expect(dp.sameDay).toBe(false);
    expect(dp.explanation).toMatch(/next dealing day/);
  });

  it('rolls a non-business day forward', () => {
    const dp = resolveDealingPoint(uaeRule, '2026-10-03T10:00:00+04:00', DEFAULT_CALENDAR);
    expect(dp.valuationDate).toBe('2026-10-05');
    expect(dp.sameDay).toBe(false);
  });
});

describe('fund — NAV and unit pricing', () => {
  function engine() {
    const nav = new NavEngine();
    nav.defineFund(singlePriceFund('F1', 'Growth', 'AED', { fmcBpsAnnual: 150 }));
    nav.defineInstrument({ id: 'A', name: 'Asset A', assetClass: 'equity', shariahScreened: true });
    nav.defineInstrument({ id: 'B', name: 'Bond B', assetClass: 'bond', shariahScreened: false });
    nav.recordMarketPrice({ instrumentId: 'A', asOf: '2026-10-01', price: 12.5, currency: 'AED' });
    nav.recordMarketPrice({ instrumentId: 'B', asOf: '2026-10-01', price: 99.1, currency: 'AED' });
    return nav;
  }

  it('prices so that rounding never favours the insurer, and keeps the residual', () => {
    const nav = engine();
    const valuation = nav.publishValuation({
      fundId: 'F1', valuationDate: '2026-10-01', grossAssets: money(1_000_000n, 'AED'), liabilities: money(1234n, 'AED'),
      unitsInIssue: unitsFromDecimal('77777.123456'), source: 'test',
    });
    expect(valuation.pricePerUnit.micro <= (valuation.netAssetValue.minor * 1_000_000n * 1_000_000n) / valuation.unitsInIssue).toBe(true);
    const recheck = nav.reconcile('F1', '2026-10-01');
    expect(recheck.ok).toBe(true);
    const representedPlusResidual = add(recheck.represented, recheck.residual);
    expect(representedPlusResidual.minor).toBe(recheck.nav.minor);
    expect(recheck.residual.minor).toBeLessThanOrEqual(valuation.unitsInIssue / 1_000_000n + 1n);
  });

  it('refuses to price a fund with no units, and refuses non-dealing days', () => {
    const nav = engine();
    expect(() => nav.publishValuation({ fundId: 'F1', valuationDate: '2026-10-01', grossAssets: money(100n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: 0n, source: 'test' })).toThrow();
    expect(() => nav.publishValuation({ fundId: 'F1', valuationDate: '2026-10-03', grossAssets: money(100n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: 10n, source: 'test' })).toThrow(/not a dealing day/);
  });

  it('reports staleness and returns the latest published price', () => {
    const nav = engine();
    nav.publishValuation({ fundId: 'F1', valuationDate: '2026-10-01', grossAssets: money(10_000n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: unitsFromDecimal('1000'), source: 'test' });
    expect(nav.stalenessDays('F1', '2026-10-01')).toBe(0);
    expect(nav.stalenessDays('F1', '2026-10-02')).toBe(1);
    expect(nav.priceAt('F1', '2026-10-01').micro).toBe(10n * 1_000_000n);
  });

  it('keeps revision history and lets the latest revision win', () => {
    const nav = engine();
    nav.publishValuation({ fundId: 'F1', valuationDate: '2026-10-01', grossAssets: money(10_000n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: unitsFromDecimal('1000'), source: 'first pass' });
    nav.publishValuation({ fundId: 'F1', valuationDate: '2026-10-01', grossAssets: money(11_000n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: unitsFromDecimal('1000'), source: 'corrected price file', revisionOf: 'first pass' });
    expect(nav.valuationHistory('F1')).toHaveLength(2);
    expect(nav.priceAt('F1', '2026-10-01').micro).toBe(11n * 1_000_000n);
  });

  it('penetrates a holding down to instruments, with market prices', () => {
    const nav = engine();
    nav.defineFund(singlePriceFund('F2', 'Mixed', 'AED', {
      composition: [{ instrumentId: 'A', weightBps: 6000 }, { instrumentId: 'B', weightBps: 4000 }],
    }));
    nav.publishValuation({ fundId: 'F2', valuationDate: '2026-10-01', grossAssets: money(1_000_000n, 'AED'), liabilities: money(0n, 'AED'), unitsInIssue: unitsFromDecimal('10000'), source: 'test' });
    const rows = nav.lookThrough('F2', unitsFromDecimal('100'), '2026-10-01');
    expect(rows.map((r) => r.instrument.id)).toEqual(['A', 'B']);
    expect(rows[1]!.value.minor).toBe(4000n);  // 100 units at 1.00 = 100.00 AED, 40% weight
    expect(rows[0]!.value.minor).toBe(6000n);  // 60% weight
    expect(rows[0]!.marketPrice).toBe(12.5);
    expect(rows[0]!.marketAsOf).toBe('2026-10-01');
  });

  it('warns when a Shariah fund holds a non-screened instrument', () => {
    const nav = engine();
    nav.defineFund(singlePriceFund('F3', 'Islamic', 'AED', {
      shariahScreened: true,
      composition: [{ instrumentId: 'A', weightBps: 5000 }, { instrumentId: 'B', weightBps: 5000 }],
    }));
    const warnings = nav.compositionWarnings('F3');
    expect(warnings.some((w) => w.includes('B is not Shariah-screened'))).toBe(true);
  });

  it('accrues the fund management charge before pricing', () => {
    const nav = engine();
    const accrued = nav.accrueFmc('F1', money(1_000_000n, 'AED'), 30);
    expect(accrued.minor).toBeGreaterThan(0n);
    expect(accrued.minor).toBeLessThan(5000n);
  });
});

describe('units — conversion invariants', () => {
  it('round-trips amount to units within one minor unit', () => {
    const price = priceFromDecimal('12.345678', 'AED');
    const amount = money(100_000n, 'AED');
    const units = unitsForAmount(amount, price);
    const back = valueOfUnits(units, price);
    expect(back.minor).toBe(amount.minor);
    expect(unitsToDecimal(units)).toBe('81.000007');   // 1,000.00 / 12.345678
    const realised = unitsToRealise(amount, price);
    expect(valueOfUnits(realised, price).minor).toBeGreaterThanOrEqual(amount.minor);
    expect(priceToDecimalTest(price)).toBe('12.345678');
  });
});
