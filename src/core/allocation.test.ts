/**
 * Allocation: money into funds, proceeds to beneficiaries, and drift once the policy is in force.
 *
 * The failure these tests guard against is a set of percentages that looks plausible and does not add
 * up. A plan that totals 99% must report itself incomplete rather than be silently re-scaled, the
 * split of the contribution must lose nothing, and a minor beneficiary with no guardian must stop the
 * section — a claim paid to a child with nobody authorised to receive it cannot be settled.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount, parseAmount } from './money.js';
import { priceFromDecimal } from './units.js';
import {
  DEFAULT_DRIFT_TOLERANCE_BPS, TOTAL_WEIGHT_BPS, addMonths, allocationProgress, allocateInvestment,
  monthsBetween, validateBeneficiaries, FundOption,
} from './allocation.js';

const AED = 'AED';
const funds: FundOption[] = [
  { fundId: 'FGLOBAL', name: 'Global Growth Fund', currency: AED, shariahScreened: false, riskGrade: 'growth', navPerUnit: '10.627173', price: priceFromDecimal('0.10627173', AED), navDate: '2026-10-05', fmcBpsAnnual: 150 },
  { fundId: 'FBAL', name: 'Balanced Income Fund', currency: AED, shariahScreened: false, riskGrade: 'balanced', navPerUnit: '10.510493', price: priceFromDecimal('0.10510493', AED), navDate: '2026-10-05', fmcBpsAnnual: 110 },
  { fundId: 'TKF-EQ', name: 'Al Khaleej Shariah Equity Fund', currency: AED, shariahScreened: true, riskGrade: 'balanced', navPerUnit: '10.526865', price: priceFromDecimal('0.10526865', AED), navDate: '2026-10-05', fmcBpsAnnual: 140 },
];

describe('the investment allocation', () => {
  it('accepts weights that total exactly 100% and splits the money with nothing lost', () => {
    const plan = allocateInvestment({
      investable: parseAmount('49219.49', AED),
      funds,
      weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }],
      appetite: 'growth',
    });
    expect(plan.totalWeightBps).toBe(TOTAL_WEIGHT_BPS);
    expect(plan.complete).toBe(true);
    expect(plan.balances).toBe(true);
    expect(plan.blockers).toEqual([]);
    // Largest remainder: the two lines add back to the contribution, fil for fil.
    expect(formatAmount(plan.allocatedTotal)).toBe('49,219.49 AED');
    expect(plan.lines.map((l) => l.amountLabel)).toEqual(['29,531.69 AED', '19,687.80 AED']);
    expect(plan.lines[0]!.units).toMatch(/^\d+\.\d+$/);
  });

  it('reports a plan that does not total 100% instead of re-scaling it', () => {
    // Re-scaling would invest money the customer never allocated, and the signed document would not
    // match the units actually bought.
    const short = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 30 }] });
    expect(short.complete).toBe(false);
    expect(short.percent).toBeLessThan(100);
    expect(short.blockers.join(' ')).toMatch(/must total exactly 10000 bps/);

    const over = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'FGLOBAL', weightPct: 110 }] });
    expect(over.complete).toBe(false);
    expect(over.blockers.join(' ')).toMatch(/110\.00%/);
  });

  it('refuses a fund that is not defined, and a duplicate line', () => {
    const unknown = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'FNOPE', weightPct: 100 }] });
    expect(unknown.complete).toBe(false);
    expect(unknown.blockers.join(' ')).toMatch(/Unknown fund FNOPE/);

    const twice = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'FGLOBAL', weightPct: 50 }, { fundId: 'FGLOBAL', weightPct: 50 }] });
    expect(twice.blockers.join(' ')).toMatch(/appears more than once/);
  });

  it('will not put an unscreened fund inside a Shariah arrangement', () => {
    const plan = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'FGLOBAL', weightPct: 100 }], shariahRequired: true });
    expect(plan.shariahAgrees).toBe(false);
    expect(plan.blockers.join(' ')).toMatch(/not Shariah-screened/);

    const screened = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [{ fundId: 'TKF-EQ', weightPct: 100 }], shariahRequired: true });
    expect(screened.shariahAgrees).toBe(true);
    expect(screened.complete).toBe(true);
  });

  it('flags a mix that outruns the customer’s appetite, and what they must acknowledge', () => {
    const plan = allocateInvestment({
      investable: money(10_000_00n, AED), funds, appetite: 'cautious',
      weights: [{ fundId: 'FGLOBAL', weightPct: 80 }, { fundId: 'FBAL', weightPct: 20 }],
    });
    expect(plan.appetiteAgrees).toBe(false);
    expect(plan.warnings.join(' ')).toMatch(/graded "growth" while the customer's stated appetite is "cautious"/);
    expect(plan.acknowledgementsRequired.join(' ')).toMatch(/acknowledge in writing/);
  });

  it('keeps a fund’s own minimum and maximum weight', () => {
    const capped: FundOption[] = [{ ...funds[0]!, minWeightBps: 2000, maxWeightBps: 8000 }];
    const tooSmall = allocateInvestment({ investable: money(10_000_00n, AED), funds: capped, weights: [{ fundId: 'FGLOBAL', weightBps: 1000 }, { fundId: 'FBAL', weightBps: 9000 }] });
    expect(tooSmall.blockers.join(' ')).toMatch(/minimum weight of 2000 bps/);
    const tooBig = allocateInvestment({ investable: money(10_000_00n, AED), funds: capped, weights: [{ fundId: 'FGLOBAL', weightBps: 10_000 }] });
    expect(tooBig.blockers.join(' ')).toMatch(/maximum weight of 8000 bps/);
  });

  it('reports no selection at all as an empty, incomplete plan', () => {
    const plan = allocateInvestment({ investable: money(10_000_00n, AED), funds, weights: [] });
    expect(plan.percent).toBe(0);
    expect(plan.complete).toBe(false);
    expect(plan.blockers.join(' ')).toMatch(/at least one fund/);
  });

  it('charges the weighted fund management charge, not the loudest one', () => {
    const plan = allocateInvestment({
      investable: money(10_000_00n, AED), funds,
      weights: [{ fundId: 'FGLOBAL', weightPct: 75 }, { fundId: 'FBAL', weightPct: 25 }],
    });
    expect(plan.weightedChargeBps).toBe(Math.round(150 * 0.75 + 110 * 0.25));
  });
});

describe('the beneficiary designation', () => {
  it('needs primary shares that total exactly 100%', () => {
    const short = validateBeneficiaries({
      proceeds: money(1_020_000_00n, AED), asOf: '2026-10-05',
      beneficiaries: [{ name: 'Salem', relationship: 'spouse', sharePct: 60 }],
    });
    expect(short.complete).toBe(false);
    expect(short.blockers.join(' ')).toMatch(/must total exactly 10000 bps/);

    const whole = validateBeneficiaries({
      proceeds: money(1_020_000_00n, AED), asOf: '2026-10-05',
      beneficiaries: [{ name: 'Salem', relationship: 'spouse', sharePct: 60 }, { name: 'Hessa', relationship: 'daughter', sharePct: 40 }],
    });
    expect(whole.complete).toBe(true);
    expect(whole.percent).toBe(100);
    expect(formatAmount(whole.primaries[0]!.shareOfProceeds!)).toBe('612,000.00 AED');
    expect(formatAmount(whole.primaries[1]!.shareOfProceeds!)).toBe('408,000.00 AED');
  });

  it('stops at a minor beneficiary with no guardian', () => {
    // The proceeds would have nowhere to go: a claim to a child is unsettled until someone is named.
    const orphan = validateBeneficiaries({
      asOf: '2026-10-05',
      beneficiaries: [{ name: 'Hessa', relationship: 'daughter', sharePct: 100, dateOfBirth: '2015-04-02' }],
    });
    expect(orphan.complete).toBe(false);
    expect(orphan.blockers.join(' ')).toMatch(/needs a named guardian/);

    const guarded = validateBeneficiaries({
      asOf: '2026-10-05',
      beneficiaries: [{ name: 'Hessa', relationship: 'daughter', sharePct: 100, dateOfBirth: '2015-04-02', guardian: 'Salem Al Mansoori' }],
    });
    expect(guarded.complete).toBe(true);
    expect(guarded.primaries[0]!.age).toBe(11);
  });

  it('requires a name, a relationship and a share that means something', () => {
    const set = validateBeneficiaries({
      beneficiaries: [
        { name: '', relationship: 'spouse', sharePct: 50 },
        { name: 'Salem', relationship: '', sharePct: 30 },
        { name: 'Hessa', relationship: 'daughter', sharePct: 0 },
      ],
    });
    expect(set.complete).toBe(false);
    expect(set.blockers.join(' ')).toMatch(/cannot be recorded/);
    expect(set.blockers.join(' ')).toMatch(/relationship to the life assured is mandatory/);
    expect(set.blockers.join(' ')).toMatch(/is not a designation/);
    expect(set.percent).toBe(0);
  });

  it('warns on a duplicate primary and on contingent shares that do not total 100%', () => {
    const set = validateBeneficiaries({
      beneficiaries: [
        { name: 'Salem Al Mansoori', relationship: 'spouse', sharePct: 50 },
        { name: 'Salem Al Mansoori', relationship: 'spouse', sharePct: 50 },
        { name: 'Hessa', relationship: 'daughter', sharePct: 50, kind: 'contingent' },
      ],
    });
    expect(set.complete).toBe(true);
    expect(set.warnings.join(' ')).toMatch(/appears 2 times/);
    expect(set.warnings.join(' ')).toMatch(/Contingent shares total 5000 bps/);
    expect(set.contingentTotalBps).toBe(5000);
  });
});

describe('allocation progress in force', () => {
  const contributions = parseAmount('49219.49', AED);
  const holdings = [
    { fundId: 'FGLOBAL', fundName: 'Global Growth Fund', units: '439990.202474', price: '10.627173', value: parseAmount('46758.52', AED), priceAsOf: '2026-10-05' },
  ];

  it('measures value, gain or loss and drift against the signed targets', () => {
    const report = allocationProgress({
      policyId: 'UL-000101', contributionsToDate: contributions, holdings,
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 6000 }, { fundId: 'FBAL', weightBps: 4000 }],
      commencement: '2026-10-05', asOf: '2026-10-05',
    });
    expect(formatAmount(report.currentValue)).toBe('46,758.52 AED');
    expect(formatAmount(report.gainLoss)).toBe('-2,460.97 AED');
    expect(report.gainLossPct).toBe(-5);
    // The whole first contribution went into one fund against a 60/40 signature: 4,000 bps of drift.
    expect(report.maxDriftBps).toBe(4000);
    expect(report.withinTolerance).toBe(false);
    expect(report.rebalanceRecommended).toBe(true);
    expect(report.rebalanceReason).toMatch(/trim/);
    expect(report.holdings.find((h) => h.fundId === 'FGLOBAL')!.action).toBe('trim');
    expect(report.warnings.join(' ')).toMatch(/FBAL is a 4000 bps target but holds no units/);
  });

  it('calls a policy inside tolerance complete, and one outside it not quite', () => {
    const inLine = allocationProgress({
      policyId: 'UL-1', contributionsToDate: contributions, holdings,
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 10_000 }], commencement: '2026-10-05', asOf: '2026-10-05',
    });
    expect(inLine.withinTolerance).toBe(true);
    expect(inLine.percent).toBe(100);
    expect(inLine.complete).toBe(true);

    const drifted = allocationProgress({
      policyId: 'UL-2', contributionsToDate: contributions, holdings,
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 6000 }, { fundId: 'FBAL', weightBps: 4000 }],
      commencement: '2026-10-05', asOf: '2026-10-05',
    });
    expect(drifted.percent).toBe(90);
  });

  it('cannot measure drift without target weights, and says so', () => {
    const report = allocationProgress({ policyId: 'UL-3', contributionsToDate: contributions, holdings, targetWeights: [], commencement: '2026-10-05', asOf: '2026-10-05' });
    expect(report.complete).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/No target weights/);
  });

  it('knows when the periodic review is overdue', () => {
    const report = allocationProgress({
      policyId: 'UL-4', contributionsToDate: contributions, holdings,
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 10_000 }],
      commencement: '2025-01-15', asOf: '2026-10-05', reviewEveryMonths: 12,
    });
    expect(report.nextReviewDate).toBe('2026-01-15');
    expect(report.reviewOverdue).toBe(true);
    expect(report.monthsInForce).toBe(20);
  });

  it('flags holdings priced before the reporting date rather than pretending they are current', () => {
    const report = allocationProgress({
      policyId: 'UL-5', contributionsToDate: contributions,
      holdings: [{ ...holdings[0]!, priceAsOf: '2026-10-01' }],
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 10_000 }], commencement: '2026-10-01', asOf: '2026-10-05',
    });
    expect(report.warnings.join(' ')).toMatch(/priced before 2026-10-05/);
  });

  it('does calendar arithmetic on review dates without drifting through month lengths', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-10-05', 12)).toBe('2027-10-05');
    expect(monthsBetween('2026-10-05', '2026-10-05')).toBe(0);
    expect(monthsBetween('2025-11-30', '2026-10-05')).toBe(10);
    expect(DEFAULT_DRIFT_TOLERANCE_BPS).toBe(500);
  });
});
