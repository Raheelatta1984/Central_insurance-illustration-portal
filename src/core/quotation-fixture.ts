/**
 * The quotation fixture: one set of facts the quotation tests agree on.
 *
 * It is built here rather than inside a test file because two suites need it — the document gates
 * (src/core/quotation.test.ts) and the delivery path (src/core/quotation-delivery.test.ts) — and a
 * copy of a hundred lines of facts would drift the first time somebody changed a loading. Every
 * figure the fixture carries is produced by a real engine: the loadings module prices the premium,
 * the allocation module splits it, the illustration module projects it.
 */
import { money, parseAmount } from './money.js';
import { priceFromDecimal } from './units.js';
import { ProductRules } from './underwriting.js';
import { loadingBreakdown } from './loadings.js';
import { allocateInvestment, validateBeneficiaries, FundOption } from './allocation.js';
import { QuotationFacts } from './quotation.js';
import { BUILT_IN_RATES, buildIllustration } from './illustration.js';
import { DEFAULT_CHARGES } from './unitlinked.js';

export const AED = 'AED';

export const MANUAL: ProductRules = {
  productId: 'PROD-UL-GLOBAL', line: 'life', minAge: 18, maxAge: 65, referralMarginYears: 5, maxBmi: 32,
  acceptedCountries: ['AE'], standardOccupations: [1, 2], baseRatePerThousandMinor: 4_800n, incomeMultiple: 25,
  automaticBindingLimitMinor: 1_000_000_00n, facultativeThresholdMinor: 2_000_000_00n,
  evidenceBands: [{ fromAge: 40, fromSumAssuredMinor: 500_000_00n, requirements: ['blood profile', 'urine analysis'] }],
  aiStraightThroughMinor: 500_000_00n,
};

export const FUNDS: FundOption[] = [
  { fundId: 'FGLOBAL', name: 'Global Growth Fund', currency: AED, shariahScreened: false, riskGrade: 'growth', navPerUnit: '10.627173', price: priceFromDecimal('0.10627173', AED), navDate: '2026-10-05', fmcBpsAnnual: 150 },
  { fundId: 'FBAL', name: 'Balanced Income Fund', currency: AED, shariahScreened: false, riskGrade: 'balanced', navPerUnit: '10.510493', price: priceFromDecimal('0.10510493', AED), navDate: '2026-10-05', fmcBpsAnnual: 110 },
];

/** Assemble the facts the way the journey desk does: the engines produce the numbers, not the test. */
export function quotationFactsFixture(over: Partial<QuotationFacts> = {}): QuotationFacts {
  const standardPremium = parseAmount('48,960', AED);
  const breakdown = loadingBreakdown({
    standardPremium, rules: MANUAL, age: 41, smoker: false, bmi: 25.9, occupationClass: 3,
    conditions: [], pursuits: [], familyHistory: [],
    riders: [{ code: 'critical-illness' }, { code: 'waiver-of-premium' }],
  });
  const plan = allocateInvestment({
    investable: breakdown.totalPayable, funds: FUNDS, appetite: 'growth',
    weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }],
  });
  const beneficiaries = validateBeneficiaries({
    proceeds: money(1_020_000_00n, AED), asOf: '2026-10-05',
    beneficiaries: [
      { name: 'Salem Al Mansoori', relationship: 'brother', sharePct: 60 },
      { name: 'Hessa Al Mansoori', relationship: 'daughter', sharePct: 40, dateOfBirth: '2015-04-02', guardian: 'Salem Al Mansoori' },
    ],
  });
  const illustration = buildIllustration({
    currency: AED,
    sumAssured: money(1_020_000_00n, AED),
    premiumPerFrequency: plan.investable,
    paymentFrequency: 'annual',
    premiumPayingTermYears: 20,
    benefitTermYears: 20,
    entryAge: 41,
    rates: BUILT_IN_RATES,
    charges: {
      allocationChargeBps: DEFAULT_CHARGES.allocationChargeBps,
      coiPerMilleMonthly: DEFAULT_CHARGES.coiPerMilleMonthly,
      adminFeeMonthlyMinor: DEFAULT_CHARGES.adminFeeMonthlyMinor,
      surrenderChargeBpsByYear: [...DEFAULT_CHARGES.surrenderChargeBpsByYear],
    },
    investmentLinked: true,
    generatedAt: '2026-10-05T12:00:00+04:00',
  });
  const base: QuotationFacts = {
    tenant: { name: 'Al Khaleej Insurance (PSC)' },
    customer: {
      partyId: 'PTY-0001', name: 'Ahmed Al Mansoori', nameAr: 'أحمد المنصوري',
      idType: 'emirates-id', idNumber: '784-1985-1234567-1', email: 'ahmed.mansoori@example.ae',
      phone: '+971 50 123 4567', address: 'Villa 12, Al Barsha 2', city: 'Dubai', country: 'AE',
    },
    product: { productId: 'PROD-UL-GLOBAL', name: 'Global Unit-Linked Plan', category: 'unit-linked', entityId: 'ALK-CONV', currency: AED, shariahCompliant: false },
    sumAssured: money(1_020_000_00n, AED),
    termYears: 20,
    paymentFrequency: 'annual',
    premiumPerFrequency: plan.investable,
    standardPremium,
    loadingLines: breakdown.components.filter((c) => c.source !== 'rider').map((c) => ({ label: c.label, amount: c.amount, bps: c.extraMortalityBps, basis: c.reason })),
    loadedPremium: breakdown.loadedPremium,
    riderLines: breakdown.riders!.lines.map((l) => ({ label: l.name, amount: l.amount, bps: l.appliedBps, basis: l.note })),
    totalPayable: breakdown.totalPayable,
    exclusions: breakdown.exclusions,
    fundLines: plan.lines.map((l) => ({ fundId: l.fundId, name: l.name, weightBps: l.weightBps, amount: l.amount, navPerUnit: l.navPerUnit, navDate: l.navDate, units: l.units })),
    beneficiaryLines: [...beneficiaries.primaries, ...beneficiaries.contingents].map((b) => ({ name: b.name, relationship: b.relationship, shareBps: b.shareBps, kind: b.kind })),
    medicalRequirements: [
      { label: 'blood profile', status: 'reviewed', source: 'evidence-band' },
      { label: 'urine analysis', status: 'reviewed', source: 'evidence-band' },
    ],
    outstandingMedical: [],
    underwriting: { outcome: 'rated', decidedBy: 'senior-underwriter', decidedByAi: false, extraMortalityBps: breakdown.components.filter((c) => c.source !== 'rider').reduce((s, c) => s + c.extraMortalityBps, 0), referrals: ['senior-underwriter'] },
    needs: { needId: 'NA-JNY-000001', pack: 'AE 2026.1', completed: true, percent: 100 },
    illustration: { wording: 'This illustration is not a forecast and does not constitute financial advice. Values may fall as well as rise.', scenariosShown: 3, coolingOffDays: 30, table: illustration },
    comparisonPresented: true,
    consentId: 'CNS-0001',
    issuedAt: '2026-10-05T12:00:00+04:00',
    issuedBy: 'quotation-desk',
  };
  return { ...base, ...over };
}

/** The bytes behind a base64 PDF, without reaching for a Buffer. */
export function decodeBase64(base64: string): number[] {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
  }
  return out;
}
