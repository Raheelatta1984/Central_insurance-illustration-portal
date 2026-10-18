/**
 * Medical requirements, loadings and riders.
 *
 * What matters here is that a quotation can show its working. Every basis point on the loaded premium
 * has to come from the manual with a sentence attached, the itemisation has to agree with the
 * underwriting engine's own total, and a rider given away without loading has to name the person who
 * gave it away. A medical requirement may be waived, but never silently.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount, parseAmount } from './money.js';
import { ProductRules, UnderwritingEngine } from './underwriting.js';
import {
  OCCUPATION_LABELS, RIDER_CATALOGUE, loadingBreakdown, medicalRequirements, occupationalLoading, priceRiders,
} from './loadings.js';

const AED = 'AED';

const MANUAL: ProductRules = {
  productId: 'PROD-LIFE-TERM', line: 'life', minAge: 18, maxAge: 65, referralMarginYears: 5, maxBmi: 32,
  acceptedCountries: ['AE', 'MY', 'GB'], standardOccupations: [1, 2],
  baseRatePerThousandMinor: 3_000n, incomeMultiple: 20,
  automaticBindingLimitMinor: 1_000_000_00n, facultativeThresholdMinor: 2_000_000_00n,
  evidenceBands: [
    { fromAge: 40, fromSumAssuredMinor: 500_000_00n, requirements: ['blood profile', 'urine analysis'] },
    { fromAge: 55, fromSumAssuredMinor: 100_000_00n, requirements: ['ECG', 'treadmill test'] },
  ],
  aiStraightThroughMinor: 500_000_00n,
};

const profileOf = (over: Partial<Parameters<UnderwritingEngine['register']>[0]['profile']> = {}) => ({
  partyId: 'PTY-0001', age: 41, sex: 'male' as const, smoker: false, heightCm: 178, weightKg: 82,
  occupationClass: 1 as const, pursuits: [], conditions: [], familyHistory: [],
  residenceCountry: 'AE', annualIncome: money(480_000_00n, AED), ...over,
});

function engine(): UnderwritingEngine {
  return new UnderwritingEngine(new Map([[MANUAL.productId, MANUAL]]), AED);
}

describe('occupational loading', () => {
  it('charges nothing inside the standard range and debits outside it, with the reason', () => {
    const standard = occupationalLoading(2, MANUAL.standardOccupations, parseAmount('48,960', AED));
    expect(standard.extraMortalityBps).toBe(0);
    expect(standard.insideStandardRange).toBe(true);
    expect(standard.reason).toMatch(/inside the standard range/);

    const trades = occupationalLoading(3, MANUAL.standardOccupations, parseAmount('48,960', AED));
    expect(trades.extraMortalityBps).toBe(60);
    expect(formatAmount(trades.amount)).toBe('293.76 AED');
    expect(trades.reason).toMatch(/outside the standard range/);
    expect(OCCUPATION_LABELS[3]).toMatch(/skilled trades/);
  });
});

describe('the loading breakdown', () => {
  it('itemises every component in basis points and money, and adds up', () => {
    const b = loadingBreakdown({
      standardPremium: parseAmount('48,960', AED), rules: MANUAL, age: 41, smoker: true, bmi: 33.5,
      occupationClass: 3, conditions: ['diabetes-type-2'], pursuits: ['scuba-diving'], familyHistory: ['early-cardiac-death'],
    });
    const labels = b.components.map((c) => c.label);
    expect(labels).toContain('Smoker loading');
    expect(labels).toContain('Occupational loading');
    expect(labels).toContain('Type 2 diabetes');
    expect(labels).toContain('Build loading (above maximum BMI)');
    // smoker 100 + build 50 + occupation 60 + diabetes 75 + scuba 50 + family 50 = 385 bps
    expect(b.totalExtraBps).toBe(385);
    expect(formatAmount(b.loadedPremium)).toBe(formatAmount(money(48_960_00n + 48_960_00n * 385n / 10_000n, AED)));
    expect(b.components.reduce((sum, c) => sum + c.extraMortalityBps, 0)).toBe(b.totalExtraBps);
    expect(b.exclusions).toEqual([]);
    expect(b.evidenceRequired).toContain('HbA1c result within 6 months');
    expect(b.evidenceRequired).toContain('Occupation and duties declaration');
  });

  it('agrees with the underwriting engine, or says loudly that it does not', () => {
    // The reconciliation is the whole point: a quotation that shows a premium the underwriting file
    // does not carry is a complaint waiting to happen.
    const uw = engine();
    const app = uw.register({
      partyId: 'PTY-0001', productId: MANUAL.productId, sumAssured: money(1_020_000_00n, AED),
      at: '2026-10-05', profile: profileOf({ smoker: true, occupationClass: 3, conditions: ['diabetes-type-2'] }),
    });
    const assessment = uw.assess(app.id);
    const b = loadingBreakdown({
      standardPremium: assessment.standardPremium, rules: MANUAL, age: 41, smoker: true,
      bmi: Math.round((82 / 1.78 ** 2) * 10) / 10, occupationClass: 3, conditions: ['diabetes-type-2'],
      decision: assessment,
    });
    expect(b.reconciliation.agrees).toBe(true);
    expect(b.reconciliation.detail).toMatch(/agree with the underwriting engine/);
    expect(b.totalExtraBps).toBe(assessment.extraMortalityBps);
    expect(formatAmount(b.loadedPremium)).toBe(formatAmount(assessment.loadedPremium));

    const wrong = loadingBreakdown({
      standardPremium: assessment.standardPremium, rules: MANUAL, age: 41, occupationClass: 1, decision: assessment,
    });
    expect(wrong.reconciliation.agrees).toBe(false);
    expect(wrong.reconciliation.detail).toMatch(/MISMATCH/);
  });

  it('refers a human for the components the manual says a machine may not decide', () => {
    const b = loadingBreakdown({
      standardPremium: parseAmount('10,000', AED), rules: MANUAL, age: 41, occupationClass: 4,
      conditions: ['cardiac-history'], pursuits: ['base-jumping'],
    });
    const referring = b.components.filter((c) => c.referToHuman).map((c) => c.label);
    expect(referring).toContain('Occupational loading');
    expect(referring).toContain('Cardiac history');
    expect(referring.join(' ')).toMatch(/not in the manual/);      // base-jumping is unknown to the table
    expect(b.exclusions).toEqual([]);
  });

  it('carries pursuit exclusions onto the document', () => {
    const b = loadingBreakdown({ standardPremium: parseAmount('10,000', AED), rules: MANUAL, age: 30, occupationClass: 1, pursuits: ['motor-racing'] });
    expect(b.exclusions).toContain('Death while competing in motorsport');
    expect(b.components.find((c) => c.code === 'pursuit-motor-racing')!.extraMortalityBps).toBe(0);
  });
});

describe('riders', () => {
  it('prices each rider on the loaded premium and totals them', () => {
    const priced = priceRiders({
      basePremium: parseAmount('48,960', AED), age: 41,
      selections: [{ code: 'critical-illness' }, { code: 'waiver-of-premium' }, { code: 'inpatient-topup' }],
    });
    expect(priced.totalExtraBps).toBe(53);                          // 45 + 8 + 0
    expect(formatAmount(priced.totalRiderPremium)).toBe('259.49 AED');
    expect(priced.lines.find((l) => l.code === 'inpatient-topup')!.amount.minor).toBe(0n);
    expect(priced.evidenceRequired).toContain('Critical illness questionnaire');
    expect(priced.blockers).toEqual([]);
  });

  it('records who gave a loading away, and what it was worth', () => {
    // "Free" is an underwriting decision, not a marketing one: the waiver carries a name and a value.
    const priced = priceRiders({
      basePremium: parseAmount('48,960', AED), age: 41,
      selections: [{ code: 'critical-illness', loadingWaived: { by: 'chief-underwriter', at: '2026-10-05', reason: 'Retained as part of the group scheme pricing agreement of 2026-09-30' } }],
    });
    expect(priced.waivedLoadingBps).toBe(45);
    expect(formatAmount(priced.waivedLoadingValue)).toBe('220.32 AED');
    expect(priced.lines[0]!.waived).toBe(true);
    expect(priced.lines[0]!.amount.minor).toBe(0n);
    expect(priced.totalRiderPremium.minor).toBe(0n);

    expect(() => priceRiders({
      basePremium: parseAmount('48,960', AED),
      selections: [{ code: 'critical-illness', loadingWaived: { by: '', at: '2026-10-05', reason: '' } }],
    })).toThrow(/named person authorises it/);
  });

  it('keeps a non-Shariah rider out of a takaful arrangement, and an adult rider off a child', () => {
    const income = priceRiders({ basePremium: parseAmount('10,000', AED), age: 41, shariahProduct: true, selections: [{ code: 'income-protection' }] });
    expect(income.blockers.join(' ')).toMatch(/not eligible for a Shariah-compliant arrangement/);

    const payor = priceRiders({ basePremium: parseAmount('10,000', AED), age: 41, selections: [{ code: 'payor-benefit' }] });
    expect(payor.blockers.join(' ')).toMatch(/only available up to age 17/);
    const juvenile = priceRiders({ basePremium: parseAmount('10,000', AED), age: 9, selections: [{ code: 'payor-benefit' }] });
    expect(juvenile.blockers).toEqual([]);
  });

  it('refuses a rider nobody has catalogued', () => {
    expect(() => priceRiders({ basePremium: parseAmount('10,000', AED), selections: [{ code: 'free-money' }] })).toThrow(/unknown rider/);
    expect(RIDER_CATALOGUE.every((r) => r.note.length > 20)).toBe(true);
  });

  it('shows waived riders inside the breakdown with the authority attached', () => {
    const b = loadingBreakdown({
      standardPremium: parseAmount('48,960', AED), rules: MANUAL, age: 41, occupationClass: 1,
      riders: [{ code: 'critical-illness', loadingWaived: { by: 'chief-underwriter', at: '2026-10-05', reason: 'Group scheme pricing agreement of 2026-09-30' } }],
    });
    const rider = b.components.find((c) => c.code === 'rider-critical-illness')!;
    expect(rider.extraMortalityBps).toBe(0);
    expect(rider.reason).toMatch(/chief-underwriter/);
    expect(rider.referToHuman).toBe(true);
    expect(formatAmount(b.totalPayable)).toBe(formatAmount(b.loadedPremium));
  });
});

describe('medical requirements', () => {
  it('takes them from the evidence bands, the conditions and the riders, each with its reason', () => {
    const set = medicalRequirements({
      age: 41, sumAssured: money(1_020_000_00n, AED), rules: MANUAL,
      conditions: ['diabetes-type-2'], riders: ['critical-illness'], occupationClass: 3,
    });
    const labels = set.requirements.map((r) => r.label);
    expect(labels).toContain('blood profile');
    expect(labels).toContain('urine analysis');
    expect(labels).toContain('HbA1c result within 6 months');
    expect(labels).toContain('Critical illness questionnaire');
    expect(labels).toContain('Occupation and duties declaration');
    expect(set.complete).toBe(false);
    expect(set.percent).toBe(0);
    expect(set.blockers.length).toBe(set.requirements.length);
    expect(set.requirements.find((r) => r.label === 'blood profile')!.reason).toMatch(/evidence band from age 40/);
  });

  it('requires nothing when the risk is young and small', () => {
    const set = medicalRequirements({ age: 29, sumAssured: money(100_000_00n, AED), rules: MANUAL });
    expect(set.requirements).toEqual([]);
    expect(set.complete).toBe(true);
    expect(set.percent).toBe(100);
  });

  it('counts a requirement as settled only when it is reviewed, or waived by a named person', () => {
    const base = { age: 41, sumAssured: money(1_020_000_00n, AED), rules: MANUAL };
    const ordered = medicalRequirements({ ...base, results: [{ code: 'blood profile', status: 'ordered' }, { code: 'urine analysis', status: 'received', at: '2026-10-04' }] });
    expect(ordered.complete).toBe(false);
    expect(ordered.percent).toBe(0);
    expect(ordered.blockers.join(' ')).toMatch(/ordered, not yet received/);
    expect(ordered.blockers.join(' ')).toMatch(/received, not yet reviewed/);

    const reviewed = medicalRequirements({ ...base, results: [{ code: 'blood profile', status: 'reviewed', at: '2026-10-04', by: 'underwriter-1' }, { code: 'urine analysis', status: 'reviewed', at: '2026-10-04', by: 'underwriter-1' }] });
    expect(reviewed.complete).toBe(true);
    expect(reviewed.percent).toBe(100);
    expect(reviewed.requirements[0]!.reviewedBy).toBe('underwriter-1');

    expect(() => medicalRequirements({ ...base, results: [{ code: 'blood profile', status: 'waived' }] })).toThrow(/cannot be waived without a named person/);
    const waived = medicalRequirements({
      ...base,
      results: [
        { code: 'blood profile', status: 'waived', at: '2026-10-04', by: 'chief-underwriter', waiverReason: 'Recent private blood work supplied directly to the medical desk' },
        { code: 'urine analysis', status: 'reviewed', at: '2026-10-04', by: 'underwriter-1' },
      ],
    });
    expect(waived.requirements[0]!.waiver?.by).toBe('chief-underwriter');
    expect(waived.complete).toBe(true);

    // A waiver on one requirement does not settle the others.
    const partWaived = medicalRequirements({ ...base, results: [{ code: 'blood profile', status: 'waived', at: '2026-10-04', by: 'chief-underwriter', waiverReason: 'Recent private blood work supplied directly to the medical desk' }] });
    expect(partWaived.complete).toBe(false);
    expect(partWaived.percent).toBe(50);
    expect(partWaived.outstanding.map((o) => o.label)).toEqual(['urine analysis']);
  });

  it('sends a condition nobody has catalogued to a human instead of guessing a loading', () => {
    const set = medicalRequirements({ age: 30, sumAssured: money(100_000_00n, AED), rules: MANUAL, conditions: ['rare-vasculitis'] });
    expect(set.requirements[0]!.source).toBe('condition');
    expect(set.requirements[0]!.reason).toMatch(/not in the medical manual/);
  });

  it('asks for a signed acknowledgement where a pursuit is accepted only with an exclusion', () => {
    const set = medicalRequirements({ age: 30, sumAssured: money(100_000_00n, AED), rules: MANUAL, pursuits: ['aviation-private'] });
    expect(set.requirements[0]!.label).toMatch(/Death while piloting a private aircraft/);
    expect(set.requirements[0]!.source).toBe('pursuit');
  });
});
