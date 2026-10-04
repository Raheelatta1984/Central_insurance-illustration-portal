import { beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceBand, ProductRules, RiskProfile, UnderwritingEngine, UnderwritingError, CONDITION_RULES, OCCUPATION_DEBITS,
} from './underwriting.js';
import { money, formatAmount } from './money.js';

const bands: EvidenceBand[] = [
  { fromAge: 40, fromSumAssuredMinor: 500_000_00n, requirements: ['blood profile', 'urine analysis'] },
  { fromAge: 55, fromSumAssuredMinor: 100_000_00n, requirements: ['ECG', 'treadmill test'] },
];

const LIFE: ProductRules = {
  productId: 'PROD-LIFE-TERM',
  line: 'life',
  minAge: 18, maxAge: 65, referralMarginYears: 5,
  maxBmi: 32,
  acceptedCountries: ['AE', 'MY', 'GB'],
  standardOccupations: [1, 2, 3],
  baseRatePerThousandMinor: 3_000n,        // 30.00 per 1,000 sum assured a year
  incomeMultiple: 20,
  automaticBindingLimitMinor: 1_000_000_00n,
  facultativeThresholdMinor: 2_000_000_00n,
  evidenceBands: bands,
  aiStraightThroughMinor: 500_000_00n,
};

function profile(overrides: Partial<RiskProfile> = {}): RiskProfile {
  return {
    partyId: 'PTY-0001', age: 38, sex: 'male', smoker: false, heightCm: 178, weightKg: 78,
    occupationClass: 2, pursuits: [], conditions: [], familyHistory: [],
    residenceCountry: 'AE', annualIncome: money(30_000_00n, 'AED'),
    ...overrides,
  };
}

let engine: UnderwritingEngine;

beforeEach(() => {
  engine = new UnderwritingEngine(new Map([[LIFE.productId, LIFE]]), 'AED');
});

describe('pricing a clean risk', () => {
  it('quotes standard terms and a premium that matches the manual rate', () => {
    const app = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(250_000_00n, 'AED'), at: '2026-10-01', profile: profile() });
    const decision = engine.decide(app.id, { at: '2026-10-01', by: 'underwriting-rules' });

    expect(decision.outcome).toBe('standard');
    // Class 2 is inside this product's standard range, so the base rate already prices it.
    expect(decision.extraMortalityBps).toBe(0);
    expect(decision.reasons.find((r) => r.code === 'occupation-class-2')?.detail).toMatch(/no debit/);
    expect(decision.standardPremium.minor).toBe(750_000n);      // 7,500.00 AED: 250 × 30.00
    expect(decision.loadedPremium.minor).toBe(750_000n);
    expect(decision.reinsurance.mode).toBe('automatic');
    expect(decision.evidence).toEqual([]);
  });

  it('calculates BMI from height and weight and loads a heavy build, referring the very heavy', () => {
    expect(engine.bmi(profile())).toBe(24.6);
    const heavy = engine.register({ partyId: 'PTY-0002', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ weightKg: 95 }) });
    const heavyDecision = engine.decide(heavy.id, { at: '2026-10-01', by: 'underwriting-rules' });
    expect(heavyDecision.reasons.map((r) => r.code)).toContain('build-debit');
    expect(heavyDecision.extraMortalityBps).toBe(25);

    const veryHeavy = engine.register({ partyId: 'PTY-0003', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ weightKg: 110 }) });
    const veryHeavyAssessment = engine.assess(veryHeavy.id);
    expect(veryHeavyAssessment.outcome).toBe('referred');
    expect(veryHeavyAssessment.referrals).toContain('senior-underwriter');
  });
});

describe('debits and exclusions', () => {
  it('adds a smoker debit and a medical debit with the evidence the manual demands', () => {
    const app = engine.register({
      partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(300_000_00n, 'AED'), at: '2026-10-01',
      profile: profile({ smoker: true, conditions: ['diabetes-type-2'] }),
    });
    const decision = engine.decide(app.id, { at: '2026-10-01', by: 'underwriting-rules' });
    expect(decision.extraMortalityBps).toBe(175);   // smoker 100 + type 2 diabetes 75
    expect(decision.evidence).toContain('HbA1c result within 6 months');
    expect(decision.outcome).toBe('rated');
    expect(decision.reasons.find((r) => r.code === 'condition-diabetes-type-2')?.detail).toMatch(/75 basis points/);
  });

  it('turns a hazardous pursuit into an exclusion rather than a decline', () => {
    const app = engine.register({
      partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(200_000_00n, 'AED'), at: '2026-10-01',
      profile: profile({ pursuits: ['aviation-private', 'scuba-diving'] }),
    });
    const decision = engine.decide(app.id, { at: '2026-10-01', by: 'underwriting-rules' });
    expect(decision.exclusions).toContain('Death while piloting a private aircraft');
    expect(decision.extraMortalityBps).toBe(50);    // scuba diving only; the private aircraft loading is an exclusion
    expect(decision.outcome).toBe('excluded');
  });

  it('refers an unknown condition instead of guessing', () => {
    const app = engine.register({
      partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(200_000_00n, 'AED'), at: '2026-10-01',
      profile: profile({ conditions: ['something-not-in-the-manual'] }),
    });
    const assessment = engine.assess(app.id);
    expect(assessment.outcome).toBe('referred');
    expect(assessment.reasons.find((r) => r.code === 'condition-unknown-something-not-in-the-manual')?.detail).toMatch(/must be read by a human/);
  });

  it('declines territory and age outside the issued range, and refers age inside the margin', () => {
    const abroad = engine.register({ partyId: 'PTY-0009', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ residenceCountry: 'XX' }) });
    expect(engine.assess(abroad.id).outcome).toBe('declined');

    const old = engine.register({ partyId: 'PTY-0010', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ age: 68 }) });
    const oldAssessment = engine.assess(old.id);
    expect(oldAssessment.outcome).toBe('referred');
    expect(oldAssessment.referrals).toContain('senior-underwriter');
    // A named human can take the case, and the referral they set aside is recorded against them.
    const taken = engine.decide(old.id, { at: '2026-10-02', by: 'senior-underwriter' });
    expect(taken.outcome).toBe('standard');
    expect(taken.reasons.find((r) => r.code === 'referral-waived')?.detail).toMatch(/age-referral/);

    const tooOld = engine.register({ partyId: 'PTY-0011', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ age: 75 }) });
    expect(engine.assess(tooOld.id).outcome).toBe('declined');
  });
});

describe('financial underwriting and evidence bands', () => {
  it('refers a sum assured that busts the income multiple and demands the evidence for the age band', () => {
    const app = engine.register({
      partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(700_000_00n, 'AED'), at: '2026-10-01',
      profile: profile({ age: 56, annualIncome: money(30_000_00n, 'AED') }),
    });
    const assessment = engine.assess(app.id);
    expect(assessment.referrals).toContain('financial-underwriter');
    expect(assessment.reasons.find((r) => r.code === 'financial-underwriting')?.detail).toMatch(/above the 20× cap/);
    expect(assessment.evidence).toEqual(expect.arrayContaining(['ECG', 'treadmill test', 'blood profile']));
  });
});

describe('reinsurance referral', () => {
  it('flags a policy over the facultative threshold before issue', () => {
    const app = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(2_500_000_00n, 'AED'), at: '2026-10-01', profile: profile({ annualIncome: money(400_000_00n, 'AED') }) });
    const assessment = engine.assess(app.id);
    expect(assessment.reinsurance.mode).toBe('facultative');
    expect(assessment.reasons.some((r) => r.code === 'reinsurance-facultative')).toBe(true);
  });

  it('flags the second policy on a life once the aggregate passes the automatic binding limit', () => {
    const first = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(600_000_00n, 'AED'), at: '2026-09-01', profile: profile() });
    engine.decide(first.id, { at: '2026-09-01', by: 'underwriting-rules' });
    const second = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(600_000_00n, 'AED'), at: '2026-10-01', profile: profile() });

    const exposure = engine.aggregateExposure('PTY-0001', LIFE);
    expect(exposure.policies).toBe(1);
    expect(exposure.totalSumAssured.minor).toBe(600_000_00n);
    expect(exposure.withinAutomaticLimit).toBe(true);

    // The second application takes the life past the binding limit once accepted.
    const secondDecision = engine.decide(second.id, { at: '2026-10-01', by: 'underwriting-rules' });
    expect(secondDecision.outcome).toBe('standard');
    const after = engine.aggregateExposure('PTY-0001', LIFE);
    expect(after.policies).toBe(2);
    expect(after.withinAutomaticLimit).toBe(false);
  });
});

describe('AI authority', () => {
  it('lets an AI accept a small clean risk and refuses to let it decline anything', () => {
    const small = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile() });
    const aiDecision = engine.decide(small.id, { at: '2026-10-01', by: 'agent/quote-bot', isAi: true });
    expect(aiDecision.outcome).toBe('standard');
    expect(aiDecision.decidedByAi).toBe(true);
    expect(aiDecision.decidedBy).toBe('agent/quote-bot');

    const terrible = engine.register({ partyId: 'PTY-0009', productId: LIFE.productId, sumAssured: money(100_000_00n, 'AED'), at: '2026-10-01', profile: profile({ residenceCountry: 'XX' }) });
    const refused = engine.decide(terrible.id, { at: '2026-10-01', by: 'agent/quote-bot', isAi: true });
    expect(refused.outcome).toBe('referred');
    expect(refused.reasons.find((r) => r.code === 'ai-authority')?.detail).toMatch(/no cover is issued on an AI decision/);
    expect(engine.application(terrible.id).decision?.outcome).toBe('referred');
  });

  it('refuses an AI acceptance above its straight-through limit', () => {
    const big = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(800_000_00n, 'AED'), at: '2026-10-01', profile: profile({ annualIncome: money(200_000_00n, 'AED') }) });
    const decision = engine.decide(big.id, { at: '2026-10-01', by: 'agent/quote-bot', isAi: true });
    expect(decision.outcome).toBe('referred');
    expect(decision.reasons.find((r) => r.code === 'ai-authority')?.detail).toMatch(/above its straight-through limit/);

    // The same case, decided by a human, goes through.
    const human = engine.decide(big.id, { at: '2026-10-01', by: 'senior-underwriter' });
    expect(human.outcome).toBe('standard');
    expect(human.decidedByAi).toBe(false);
  });

  it('records the referral points a human waived, by name', () => {
    const heavy = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(150_000_00n, 'AED'), at: '2026-10-01', profile: profile({ weightKg: 110 }) });
    const waived = engine.decide(heavy.id, { at: '2026-10-02', by: 'senior-underwriter' });
    const waiver = waived.reasons.find((r) => r.code === 'referral-waived');
    expect(waiver?.detail).toMatch(/senior-underwriter decided the case with 1 referral point\(s\) waived: build-referral/);

    // Accepting the point instead of waiving it leaves no waiver behind.
    const light = engine.register({ partyId: 'PTY-0006', productId: LIFE.productId, sumAssured: money(150_000_00n, 'AED'), at: '2026-10-01', profile: profile({ weightKg: 110 }) });
    const accepted = engine.decide(light.id, { at: '2026-10-02', by: 'senior-underwriter', acceptReferralReasonCodes: ['build-referral'] });
    expect(accepted.reasons.find((r) => r.code === 'referral-waived')).toBeUndefined();
  });
});

describe('the book', () => {
  it('separates standard from loaded premium, keeps the referral queue and shows the cession schedule', () => {
    const clean = engine.register({ partyId: 'PTY-0001', productId: LIFE.productId, sumAssured: money(200_000_00n, 'AED'), at: '2026-09-01', profile: profile() });
    engine.decide(clean.id, { at: '2026-09-01', by: 'underwriting-rules' });
    const rated = engine.register({ partyId: 'PTY-0004', productId: LIFE.productId, sumAssured: money(200_000_00n, 'AED'), at: '2026-09-02', profile: profile({ smoker: true }) });
    engine.decide(rated.id, { at: '2026-09-02', by: 'underwriting-rules' });
    const waiting = engine.register({ partyId: 'PTY-0005', productId: LIFE.productId, sumAssured: money(2_500_000_00n, 'AED'), at: '2026-09-03', profile: profile({ age: 60, annualIncome: money(500_000_00n, 'AED'), conditions: ['cardiac-history'] }) });

    const book = engine.bookPremium();
    expect(book.policies).toBe(2);
    expect(book.standard.minor).toBe(600_000n + 600_000n);   // 6,000.00 each: 200 × 30.00
    expect(book.loaded.minor).toBe(600_000n + 606_000n);     // the smoker carries 100bps
    expect(book.extra.minor).toBe(book.loaded.minor - book.standard.minor);

    const queue = engine.queue();
    expect(queue.map((q) => q.applicationId)).toEqual([waiting.id]);
    expect(queue[0]!.waitingOn).toContain('senior-underwriter');
    expect(queue[0]!.reasonCodes).toContain('condition-cardiac-history');

    const cessions = engine.reinsuranceShare(2_500); // 25% quota share
    expect(cessions).toHaveLength(1);
    expect(cessions[0]!.ceded.minor).toBe(100_000_00n);   // 25% of 400,000.00
    expect(cessions[0]!.retained.minor).toBe(300_000_00n);
    expect(engine.cessionSchedule()).toHaveLength(2);
  });

  it('refuses an application for a product with no manual', () => {
    expect(() => engine.rulesFor('PROD-UNKNOWN')).toThrow(UnderwritingError);
    expect(CONDITION_RULES.find((c) => c.code === 'cardiac-history')?.referToHuman).toBe(true);
  });
});
