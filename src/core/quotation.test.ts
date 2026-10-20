import { describe, expect, it } from 'vitest';
import { money } from './money.js';
import { DEFAULT_VALIDITY_DAYS, QuotationBook, maskEmail } from './quotation.js';
import { verifyPdf } from './pdf.js';
import { AED, decodeBase64, quotationFactsFixture as facts } from './quotation-fixture.js';

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
    expect(verifyPdf(new Uint8Array(issued.record.pdf.base64.length > 0 ? decodeBase64(issued.record.pdf.base64) : [])).ok).toBe(true);
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
    expect(signed.buyToken).toHaveLength(32);
    expect(signed.signatureReference).toHaveLength(64);
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
