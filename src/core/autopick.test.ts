import { describe, expect, it } from 'vitest';
import {
  AgeCalculationRegistry,
  calculateActuarialAge,
  resolveCustomerAutoPick,
} from './autopick.js';
import { buildWorld } from './demo.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

describe('Actuarial DOB-to-Age Engine (Nearest / Age Next / Age Last) & Zero-Duplicate Auto-Pick', () => {
  it('computes exact Age Last (ALB), Age Nearest (ANB), and Age Next (ANxB) from Date of Birth', () => {
    // Sara Khalifa: DOB 1990-11-02 evaluated on 2026-10-20 (> 6 months past 35th birthday -> ALB 35, ANB 36, ANxB 36)
    const alb = calculateActuarialAge('1990-11-02', '2026-10-20', 'age-last');
    const anb = calculateActuarialAge('1990-11-02', '2026-10-20', 'age-nearest');
    const anxb = calculateActuarialAge('1990-11-02', '2026-10-20', 'age-next');

    expect(alb.effectiveAge).toBe(35);
    expect(anb.effectiveAge).toBe(36);
    expect(anxb.effectiveAge).toBe(36);

    // Ahmed Al Mansoori: DOB 1985-04-12 evaluated on 2026-09-01 (< 6 months past 41st birthday -> ALB 41, ANB 41, ANxB 42)
    const ahmedAlb = calculateActuarialAge('1985-04-12', '2026-09-01', 'age-last');
    const ahmedAnb = calculateActuarialAge('1985-04-12', '2026-09-01', 'age-nearest');
    const ahmedAnxb = calculateActuarialAge('1985-04-12', '2026-09-01', 'age-next');

    expect(ahmedAlb.effectiveAge).toBe(41);
    expect(ahmedAnb.effectiveAge).toBe(41);
    expect(ahmedAnxb.effectiveAge).toBe(42);

    // Exact birthday: ALB === ANB === ANxB
    const exactBday = calculateActuarialAge('1985-10-20', '2026-10-20', 'age-next');
    expect(exactBday.exactBirthdayToday).toBe(true);
    expect(exactBday.effectiveAge).toBe(41);

    // Leap-year birthday (Feb 29) evaluated cleanly in non-leap year
    const leap = calculateActuarialAge('1992-02-29', '2026-10-20', 'age-nearest');
    expect(leap.ageLast).toBe(34);
    expect(leap.ageNearest).toBe(35);
    expect(leap.ageNext).toBe(35);
  });

  it('supports Master Settings global basis changes and per-product age basis overrides via Registry & HTTP API', async () => {
    const reg = new AgeCalculationRegistry();
    expect(reg.snapshot().defaultBasis).toBe('age-nearest');

    reg.update({ defaultBasis: 'age-last', halfYearRule: 'days', by: 'actuary' });
    expect(reg.calculate('1990-11-02', '2026-10-20').effectiveAge).toBe(35);

    reg.update({ productOverrides: { 'PROD-UL-GLOBAL': 'age-next' }, by: 'actuary' });
    expect(reg.calculate('1985-04-12', '2026-09-01', 'PROD-UL-GLOBAL').effectiveAge).toBe(42);
    expect(reg.calculate('1985-04-12', '2026-09-01', 'PROD-LIFE-TERM').effectiveAge).toBe(41);

    const state = createRuntimeState(1);
    const res = await dispatchApiRoute(state, 'POST', '/master/age-calculation', new URLSearchParams(), {
      defaultBasis: 'age-next',
      halfYearRule: 'six-months',
    });
    expect(res.status).toBe(200);
    expect(state.world.erp.ageCalculation.snapshot().defaultBasis).toBe('age-next');
  });

  it('auto-picks previously provided customer fields (DOB, Age, Height, Weight, BMI, Dependent Products) with zero duplicate entry', async () => {
    const w = buildWorld();
    const resolved = resolveCustomerAutoPick(w, {
      partyId: 'PTY-0001',
      productId: 'PROD-UL-GLOBAL',
    });

    expect(resolved.partyId).toBe('PTY-0001');
    expect(resolved.dob).toBe('1985-04-12');
    expect(resolved.heightCm).toBe(178);
    expect(resolved.weightKg).toBe(76);
    expect(resolved.bmi).toBe(24);
    expect(resolved.ageCalculation).not.toBeNull();
    expect(resolved.dependentProducts.length).toBeGreaterThan(0);

    const state = createRuntimeState(1);
    const httpRes = await dispatchApiRoute(state, 'POST', '/underwriting/register', new URLSearchParams(), {
      partyId: 'PTY-0002',
      productId: 'PROD-LIFE-TERM',
      sumAssured: '300,000.00',
      paymentFrequency: 'annual',
      termYears: 15,
      beneficiaryName: 'Khalid Khalifa',
      beneficiaryRelationship: 'Spouse',
      sex: 'female',
      smoker: false,
      heightCm: 165,
      weightKg: 60,
      occupationClass: 1,
      annualIncome: '390,000.00',
    });
    expect(httpRes.status).toBe(200);
    expect((httpRes.body as { applicationId: string }).applicationId).toMatch(/^UW-/);
  });
});
