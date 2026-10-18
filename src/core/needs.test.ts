/**
 * Needs analysis and recommendation.
 *
 * The reason these tests are strict about the boring parts: a needs analysis is the document a
 * regulator asks for when a customer says they were sold something they did not need. If the
 * questionnaire can be "complete" with holes in it, or a product can be recommended that the answers
 * rule out, the document proves nothing.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount } from './money.js';
import {
  AE_NEEDS_QUESTIONNAIRE, AFFORDABILITY_CAP_BPS, evaluateNeeds, questionnaireFor,
  recommendProducts, replacementYearsFor, ProductCandidate,
} from './needs.js';

const fullAnswers = [
  { questionId: 'residence-country', value: 'AE' },
  { questionId: 'dependants', value: 2 },
  { questionId: 'annual-income', value: 480000 },
  { questionId: 'existing-cover', value: 3900000 },
  { questionId: 'outstanding-debt', value: 600000 },
  { questionId: 'premium-budget', value: 60000 },
  { questionId: 'objective', value: 'family-protection' },
  { questionId: 'risk-appetite', value: 'growth' },
  { questionId: 'shariah-preferred', value: false },
  { questionId: 'age', value: 41 },
  { questionId: 'smoker', value: false },
  { questionId: 'medical-conditions', value: false },
  { questionId: 'occupation-class', value: '2' },
];

const CATALOGUE: ProductCandidate[] = [
  {
    productId: 'PROD-UL-GLOBAL', name: 'Global Unit-Linked Plan', line: 'life', category: 'unit-linked',
    entityId: 'ALK-CONV', currency: 'AED', minAge: 18, maxAge: 65, baseRatePerThousandMinor: 4_800n,
    defaultFunds: ['FGLOBAL', 'FBAL'], objectives: ['family-protection', 'retirement-savings'],
    investmentLinked: true, shariahCompliant: false, minimumRiskAppetite: 'growth',
  },
  {
    productId: 'PROD-TKF-FAMILY', name: 'Family Takaful Plan', line: 'life', category: 'takaful',
    entityId: 'ALK-TKF', currency: 'AED', minAge: 18, maxAge: 65, baseRatePerThousandMinor: 3_600n,
    defaultFunds: ['TKF-EQ'], objectives: ['family-protection', 'retirement-savings'],
    investmentLinked: true, shariahCompliant: true, minimumRiskAppetite: 'balanced',
  },
  {
    productId: 'PROD-MEDICAL-GRP', name: 'Group Medical Cover', line: 'medical', category: 'conventional',
    entityId: 'ALK-CONV', currency: 'AED', minAge: 18, maxAge: 65, baseRatePerThousandMinor: 3_000n,
    defaultFunds: [], objectives: ['health-cover'], investmentLinked: false, shariahCompliant: false,
    minimumRiskAppetite: 'cautious',
  },
];

describe('the needs questionnaire', () => {
  it('is per country, and a country with no pack cannot be sold into', () => {
    // Selling into a market whose rules are not loaded would silently skip that market's gates.
    expect(AE_NEEDS_QUESTIONNAIRE.country).toBe('AE');
    expect(questionnaireFor('MY').country).toBe('MY');
    expect(() => questionnaireFor('ZZ')).toThrow(/no needs questionnaire/);
  });

  it('says why each question is asked', () => {
    // A questionnaire with unexplained questions gets answered badly, and the file cannot show the
    // adviser asked for a reason.
    for (const q of AE_NEEDS_QUESTIONNAIRE.questions) expect(q.why.length, q.id).toBeGreaterThan(20);
  });

  it('is incomplete until every mandatory question is answered and the customer attests', () => {
    const partial = evaluateNeeds({ needId: 'NA-1', country: 'AE', answers: fullAnswers.slice(0, 6), attestationAgreed: true });
    expect(partial.completed).toBe(false);
    expect(partial.percent).toBeLessThan(100);
    expect(partial.missing).toContain('Main objective for this cover');

    const unattested = evaluateNeeds({ needId: 'NA-2', country: 'AE', answers: fullAnswers, attestationAgreed: false });
    expect(unattested.completed).toBe(false);
    expect(unattested.percent).toBe(100);                     // answered, but not signed
    expect(unattested.blockers.join(' ')).toMatch(/attestation/);

    const done = evaluateNeeds({ needId: 'NA-3', country: 'AE', answers: fullAnswers, attestationAgreed: true });
    expect(done.completed).toBe(true);
    expect(done.percent).toBe(100);
    expect(done.missing).toEqual([]);
  });

  it('builds the protection gap in components and states each assumption', () => {
    const done = evaluateNeeds({ needId: 'NA-4', country: 'AE', answers: fullAnswers, attestationAgreed: true });
    // 9 years of 480,000 (two dependants, 19 years to the assumed retirement age) + 600,000 of debt
    // − 3,900,000 already in force = 1,020,000.
    expect(replacementYearsFor(2, 41)).toBe(9);
    expect(formatAmount(done.need.incomeReplacement!)).toBe('4,320,000.00 AED');
    expect(formatAmount(done.need.suggestedSumAssured!)).toBe('1,020,000.00 AED');
    expect(done.need.basis.join(' ')).toMatch(/Income replacement: 9 year/);
    expect(done.need.basis.join(' ')).toMatch(/deducted/);
  });

  it('caps replacement years at retirement and at the configured maximum', () => {
    expect(replacementYearsFor(4, 58)).toBe(2);       // only two years to the assumed retirement age
    expect(replacementYearsFor(0, 30)).toBe(3);
    expect(replacementYearsFor(3, 20)).toBeLessThanOrEqual(15);
  });

  it('sets the affordability ceiling from income, and refuses a budget above it', () => {
    const done = evaluateNeeds({ needId: 'NA-5', country: 'AE', answers: fullAnswers, attestationAgreed: true });
    expect(formatAmount(done.need.affordabilityCeiling!)).toBe(formatAmount(money(480000n * BigInt(AFFORDABILITY_CAP_BPS) * 100n / 10_000n, 'AED')));

    const greedy = evaluateNeeds({
      needId: 'NA-6', country: 'AE', attestationAgreed: true,
      answers: fullAnswers.map((a) => (a.questionId === 'premium-budget' ? { ...a, value: 120000 } : a)),
    });
    // A budget above the ceiling is not accepted quietly: it has to be reviewed with the customer.
    expect(greedy.completed).toBe(false);
    expect(greedy.blockers.join(' ')).toMatch(/above the affordability ceiling/);
  });

  it('applies the country pack’s pre-sale gate to the analysis', () => {
    const done = evaluateNeeds({ needId: 'NA-7', country: 'AE', answers: fullAnswers, attestationAgreed: true });
    expect(done.regulatory?.allowed).toBe(true);
    expect(done.regulatory?.pack).toMatch(/^AE /);

    const holes = evaluateNeeds({ needId: 'NA-8', country: 'AE', answers: [], attestationAgreed: false });
    expect(holes.regulatory?.allowed).toBe(false);
    expect(holes.regulatory?.blockers.join(' ')).toMatch(/need analysis is mandatory/);
  });
});

describe('the recommendation list', () => {
  const evaluation = evaluateNeeds({ needId: 'NA-9', country: 'AE', answers: fullAnswers, attestationAgreed: true });

  it('ranks the product that answers the stated objective first, with the reasons shown', () => {
    const ranked = recommendProducts({ evaluation, candidates: CATALOGUE });
    expect(ranked[0]!.productId).toBe('PROD-UL-GLOBAL');
    expect(ranked[0]!.fits).toBe(true);
    expect(ranked[0]!.reasons.join(' ')).toMatch(/Answers the stated objective "family-protection"/);
    expect(ranked[0]!.reasons.join(' ')).toMatch(/inside the stated budget/);
  });

  it('rules a product out loudly rather than scoring it quietly to zero', () => {
    // A list that hides why it said no is how a suitability finding starts.
    const medical = recommendProducts({ evaluation, candidates: CATALOGUE }).find((r) => r.productId === 'PROD-MEDICAL-GRP')!;
    expect(medical.fits).toBe(false);
    expect(medical.disqualifiers.join(' ')).toMatch(/Does not answer the stated objective/);
  });

  it('never recommends an investment-linked product above the customer’s appetite', () => {
    const cautious = evaluateNeeds({
      needId: 'NA-10', country: 'AE', attestationAgreed: true,
      answers: fullAnswers.map((a) => (a.questionId === 'risk-appetite' ? { ...a, value: 'cautious' } : a)),
    });
    const ranked = recommendProducts({ evaluation: cautious, candidates: CATALOGUE });
    const ul = ranked.find((r) => r.productId === 'PROD-UL-GLOBAL')!;
    expect(ul.fits).toBe(false);
    expect(ul.disqualifiers.join(' ')).toMatch(/needs a "growth" appetite/);
  });

  it('recommends the takaful window when the customer asked for a Shariah arrangement', () => {
    const shariah = evaluateNeeds({
      needId: 'NA-11', country: 'AE', attestationAgreed: true,
      answers: fullAnswers.map((a) => (a.questionId === 'shariah-preferred' ? { ...a, value: true } : a)),
    });
    const ranked = recommendProducts({ evaluation: shariah, candidates: CATALOGUE });
    expect(ranked[0]!.productId).toBe('PROD-TKF-FAMILY');
    expect(ranked.find((r) => r.productId === 'PROD-UL-GLOBAL')!.disqualifiers.join(' ')).toMatch(/Not Shariah-compliant/);
  });

  it('prices each recommendation indicatively and disqualifies what the budget cannot carry', () => {
    const ranked = recommendProducts({ evaluation, candidates: CATALOGUE });
    const ul = ranked.find((r) => r.productId === 'PROD-UL-GLOBAL')!;
    // 1,020,000 × 4,800 minor per 1,000 = 48,960.00 a year, inside the 60,000 budget.
    expect(ul.indicativePremiumLabel).toBe('48,960.00 AED');
    expect(ul.withinBudget).toBe(true);

    const expensive = recommendProducts({ evaluation, candidates: CATALOGUE, sumAssured: money(4_420_000_00n, 'AED') });
    expect(expensive.find((r) => r.productId === 'PROD-UL-GLOBAL')!.withinBudget).toBe(false);
    expect(expensive.find((r) => r.productId === 'PROD-UL-GLOBAL')!.disqualifiers.join(' ')).toMatch(/exceeds the stated budget/);
  });

  it('rules out a product the customer is too old to enter', () => {
    const older = evaluateNeeds({
      needId: 'NA-12', country: 'AE', attestationAgreed: true,
      answers: fullAnswers.map((a) => (a.questionId === 'age' ? { ...a, value: 71 } : a)),
    });
    const ranked = recommendProducts({ evaluation: older, candidates: CATALOGUE });
    expect(ranked.every((r) => !r.fits)).toBe(true);
    expect(ranked[0]!.disqualifiers.join(' ')).toMatch(/outside the entry range/);
  });
});
