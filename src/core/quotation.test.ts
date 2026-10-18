/**
 * The quotation as a controlled document.
 *
 * A quotation is what the customer relies on, so the tests here are about the gates rather than the
 * formatting: it must not exist while a mandatory gate is open, it must show the loadings itemised
 * with the same basis points the underwriting file carries, re-issuing must supersede rather than
 * edit, and the emailed attachment must be identifiable by fingerprint.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount, parseAmount } from './money.js';
import { priceFromDecimal } from './units.js';
import { ProductRules } from './underwriting.js';
import { loadingBreakdown } from './loadings.js';
import { allocateInvestment, validateBeneficiaries, FundOption } from './allocation.js';
import { DEFAULT_VALIDITY_DAYS, QuotationBook, QuotationFacts, maskEmail } from './quotation.js';
import { verifyPdf } from './pdf.js';

const AED = 'AED';

const MANUAL: ProductRules = {
  productId: 'PROD-UL-GLOBAL', line: 'life', minAge: 18, maxAge: 65, referralMarginYears: 5, maxBmi: 32,
  acceptedCountries: ['AE'], standardOccupations: [1, 2], baseRatePerThousandMinor: 4_800n, incomeMultiple: 25,
  automaticBindingLimitMinor: 1_000_000_00n, facultativeThresholdMinor: 2_000_000_00n,
  evidenceBands: [{ fromAge: 40, fromSumAssuredMinor: 500_000_00n, requirements: ['blood profile', 'urine analysis'] }],
  aiStraightThroughMinor: 500_000_00n,
};

const FUNDS: FundOption[] = [
  { fundId: 'FGLOBAL', name: 'Global Growth Fund', currency: AED, shariahScreened: false, riskGrade: 'growth', navPerUnit: '10.627173', price: priceFromDecimal('0.10627173', AED), navDate: '2026-10-05', fmcBpsAnnual: 150 },
  { fundId: 'FBAL', name: 'Balanced Income Fund', currency: AED, shariahScreened: false, riskGrade: 'balanced', navPerUnit: '10.510493', price: priceFromDecimal('0.10510493', AED), navDate: '2026-10-05', fmcBpsAnnual: 110 },
];

/** Assemble the facts the way the journey desk does: the engines produce the numbers, not the test. */
function facts(over: Partial<QuotationFacts> = {}): QuotationFacts {
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
    illustration: { wording: 'This illustration is not a forecast and does not constitute financial advice. Values may fall as well as rise.', scenariosShown: 3, coolingOffDays: 30 },
    comparisonPresented: true,
    consentId: 'CNS-0001',
    issuedAt: '2026-10-05T12:00:00+04:00',
    issuedBy: 'quotation-desk',
  };
  return { ...base, ...over };
}

describe('issuing a quotation', () => {
  it('issues when every gate is satisfied, and the document opens', () => {
    const book = new QuotationBook('Al Khaleej Insurance (PSC)');
    const issued = book.issue(facts());
    expect(issued.refused).toBe(false);
    expect(issued.record.status).toBe('issued');
    expect(issued.record.pdf.opens).toBe(true);
    expect(issued.record.pdf.pages).toBeGreaterThan(0);
    expect(issued.record.pdf.bytes).toBeGreaterThan(1000);
    expect(issued.record.blockers).toEqual([]);
    expect(issued.record.validityDays).toBe(DEFAULT_VALIDITY_DAYS);
    expect(issued.record.expiresAt.slice(0, 10)).toBe('2026-10-26');
    expect(verifyPdf(new Uint8Array(issued.record.pdf.base64.length > 0 ? decode(issued.record.pdf.base64) : [])).ok).toBe(true);
  });

  it('carries the itemised loadings, the free-look period and the mandated wording into the document', () => {
    // The customer has to be able to read how the premium was built without asking anyone.
    const issued = new QuotationBook('Al Khaleej Insurance (PSC)').issue(facts());
    const text = issued.record.pdf.text;
    expect(text).toContain('Standard premium (rate table, standard lives): 48,960.00 AED');
    expect(text).toMatch(/Occupational loading: 293\.76 AED \(60 bps\)/);
    expect(text).toContain('Rider — Critical illness cover');
    expect(text).toContain('Free-look period: 30 day(s)');
    expect(text).toContain('This illustration is not a forecast');
    expect(text).toContain('Primary — Salem Al Mansoori (brother): 60.00%');
    expect(text).toContain('Global Growth Fund (FGLOBAL): 60.00%');
    expect(text).toMatch(/not an offer of cover/);
  });

  it('totals the money the same way the engines do', () => {
    const record = new QuotationBook('Al Khaleej').issue(facts()).record;
    expect(record.standardPremium).toBe('48,960.00 AED');
    expect(record.loadingTotal).toBe('293.76 AED');
    expect(record.loadedPremium).toBe('49,253.76 AED');
    expect(record.riderTotal).toBe('261.04 AED');      // 45 bps + 8 bps of the loaded premium
    expect(record.totalPayable).toBe('49,514.80 AED');
    expect(record.sumAssured).toBe('1,020,000.00 AED');
  });

  it('refuses while the needs analysis is incomplete', () => {
    const issued = new QuotationBook('Al Khaleej').issue(facts({ needs: { needId: 'NA-2', pack: 'AE 2026.1', completed: false, percent: 46 } }));
    expect(issued.refused).toBe(true);
    expect(issued.reason).toMatch(/needs analysis/i);
    expect(issued.record.status).toBe('refused');
    expect(issued.record.pdf.bytes).toBe(0);
  });

  it('refuses when the itemised loadings do not agree with the underwriting file', () => {
    const issued = new QuotationBook('Al Khaleej').issue(facts({ underwriting: { outcome: 'rated', decidedBy: 'senior-underwriter', decidedByAi: false, extraMortalityBps: 120, referrals: [] } }));
    expect(issued.refused).toBe(true);
    expect(issued.reason).toMatch(/Itemised loading is 60 bps but the underwriting file carries 120 bps/);
  });

  it('refuses on fund weights that do not total 100%, and on beneficiaries that do not either', () => {
    const f = facts();
    const badFunds = new QuotationBook('Al Khaleej').issue({ ...f, fundLines: f.fundLines.slice(0, 1) });
    expect(badFunds.refused).toBe(true);
    expect(badFunds.reason).toMatch(/total 6000 bps/);

    const badBeneficiaries = new QuotationBook('Al Khaleej').issue({ ...f, beneficiaryLines: f.beneficiaryLines.slice(0, 1) });
    expect(badBeneficiaries.refused).toBe(true);
    expect(badBeneficiaries.reason).toMatch(/Primary shares total 6000 bps/);
  });

  it('refuses while medical evidence is outstanding, and while the case is still referred', () => {
    const outstanding = new QuotationBook('Al Khaleej').issue(facts({ outstandingMedical: ['blood profile'] }));
    expect(outstanding.refused).toBe(true);
    expect(outstanding.reason).toMatch(/Outstanding: blood profile/);

    const referred = new QuotationBook('Al Khaleej').issue(facts({ underwriting: { outcome: 'referred', decidedBy: '', decidedByAi: false, extraMortalityBps: 60, referrals: ['senior-underwriter'] } }));
    expect(referred.refused).toBe(true);
    expect(referred.reason).toMatch(/still referred/);
  });

  it('warns — but still issues — when no comparison was presented', () => {
    const issued = new QuotationBook('Al Khaleej').issue(facts({ comparisonPresented: false }));
    expect(issued.refused).toBe(false);
    expect(issued.record.warnings.join(' ')).toMatch(/No comparison was presented/);
  });

  it('supersedes the previous version instead of editing what the customer already has', () => {
    // The document a customer received must stay exactly as it was sent, even after a correction.
    const book = new QuotationBook('Al Khaleej');
    const first = book.issue(facts());
    const second = book.issue(facts({ sumAssured: money(1_120_000_00n, AED) }), { quotationId: first.record.quotationId });
    expect(second.record.version).toBe(2);
    expect(second.record.pdf.fileName).toBe(`${first.record.quotationId}-v2.pdf`);
    expect(book.list().filter((r) => r.status === 'superseded').length).toBeGreaterThan(0);
    expect(second.record.pdf.fingerprint).not.toBe(first.record.pdf.fingerprint);
  });
});

describe('sending and accepting a quotation', () => {
  it('masks the address in the audit copy and keeps the consent it was sent under', () => {
    expect(maskEmail('ahmed.mansoori@example.ae')).toBe('a************i@example.ae');
    const book = new QuotationBook('Al Khaleej');
    const issued = book.issue(facts());
    const email = book.dispatch({ quotationId: issued.record.quotationId, at: '2026-10-05T12:30:00+04:00', by: 'quotation-desk' });
    expect(email.to).toBe('a************i@example.ae');
    expect(email.toFull).toBe('ahmed.mansoori@example.ae');
    expect(email.consentId).toBe('CNS-0001');
    expect(email.attachment.fingerprint).toBe(issued.record.pdf.fingerprint);
    expect(email.subject).toMatch(/Quotation QTN-/);
    expect(email.body).toMatch(/free-look period of 30 day/);
    expect(book.get(issued.record.quotationId).status).toBe('dispatched');
  });

  it('refuses to send a refused quotation, an undeliverable address, or a superseded version', () => {
    const book = new QuotationBook('Al Khaleej');
    const refused = book.issue(facts({ needs: { needId: 'NA-3', pack: 'AE 2026.1', completed: false, percent: 20 } }));
    expect(() => book.dispatch({ quotationId: refused.record.quotationId })).toThrow(/was refused/);

    const issued = book.issue(facts());
    expect(() => book.dispatch({ quotationId: issued.record.quotationId, to: 'not-an-email' })).toThrow(/not a deliverable email address/);

    book.issue(facts(), { quotationId: issued.record.quotationId });
    expect(() => book.dispatch({ quotationId: issued.record.quotationId, version: 1 })).toThrow(/superseded/);
    expect(() => book.finalise({ quotationId: issued.record.quotationId, version: 1, signedBy: 'Ahmed Al Mansoori' })).toThrow(/must accept the current version/);
  });

  it('takes the customer’s signature inside the validity window and issues the buy-online token', () => {
    const book = new QuotationBook('Al Khaleej');
    const issued = book.issue(facts());
    book.dispatch({ quotationId: issued.record.quotationId });
    const signed = book.finalise({ quotationId: issued.record.quotationId, signedBy: 'Ahmed Al Mansoori', at: '2026-10-06T10:00:00+04:00' });
    expect(signed.insideValidity).toBe(true);
    expect(signed.daysRemaining).toBe(20);
    expect(signed.coolingOffEndsOn).toBe('2026-11-05');
    expect(signed.readyToBuyOnline).toBe(true);
    expect(signed.buyToken).toHaveLength(16);
    expect(signed.signatureReference).toHaveLength(16);
    expect(book.get(issued.record.quotationId).status).toBe('finalised');
  });

  it('will not accept an expired quotation, and marks it expired', () => {
    // A quotation that has lapsed cannot be paid against: the terms may have moved.
    const book = new QuotationBook('Al Khaleej');
    const issued = book.issue(facts());
    book.dispatch({ quotationId: issued.record.quotationId });
    expect(() => book.finalise({ quotationId: issued.record.quotationId, signedBy: 'Ahmed Al Mansoori', at: '2026-12-01T10:00:00+04:00' })).toThrow(/expired on 2026-10-26/);
    expect(book.get(issued.record.quotationId).status).toBe('expired');
  });

  it('reports where a customer stands on the quotation section without changing anything', () => {
    const book = new QuotationBook('Al Khaleej');
    expect(book.statusFor('PTY-0001').status).toBe('not-started');
    const issued = book.issue(facts());
    book.dispatch({ quotationId: issued.record.quotationId });
    const status = book.statusFor('PTY-0001');
    expect(status.quotationId).toBe(issued.record.quotationId);
    expect(status.issued).toBe(true);
    expect(status.dispatched).toBe(true);
    expect(status.finalised).toBe(false);
    expect(book.amountDue(issued.record.quotationId).minor).toBe(4_951_480n);
  });
});

function decode(base64: string): number[] {
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
