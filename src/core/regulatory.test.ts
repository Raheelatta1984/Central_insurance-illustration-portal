import { describe, expect, it } from 'vitest';
import { AE_PACK, comparisonMatrix, MY_PACK, PACKS, preSaleCheck } from './regulatory.js';
import { LabelRegistry } from './labels.js';
import { ocrDocument, onboard, readChip, translateFields, governmentLookup } from './onboarding.js';

describe('regulatory packs', () => {
  it('blocks a motor quote until the survey and comparison matrix are done (UAE)', () => {
    const blocked = preSaleCheck(AE_PACK, { productLine: 'motor', hasNeedAnalysis: true, hasNeedId: true, surveyCompleted: false, comparisonPresented: false, customerIsResident: true, consentCaptured: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockers.join(' ')).toMatch(/survey/);
    expect(blocked.blockers.join(' ')).toMatch(/comparison matrix/);
    const allowed = preSaleCheck(AE_PACK, { productLine: 'motor', hasNeedAnalysis: true, hasNeedId: true, surveyCompleted: true, comparisonPresented: true, customerIsResident: true, consentCaptured: true });
    expect(allowed.allowed).toBe(true);
    expect(allowed.requiredSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses health cover without a need analysis and its identifier', () => {
    const result = preSaleCheck(AE_PACK, { productLine: 'medical', hasNeedAnalysis: false, hasNeedId: false, surveyCompleted: false, comparisonPresented: false, customerIsResident: true, consentCaptured: true });
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/need analysis is mandatory/i);
    expect(result.blockers.join(' ')).toMatch(/need-analysis identifier/);
  });

  it('always requires consent, and flags non-resident medical cover', () => {
    const noConsent = preSaleCheck(AE_PACK, { productLine: 'travel', hasNeedAnalysis: true, hasNeedId: true, surveyCompleted: true, comparisonPresented: true, customerIsResident: true, consentCaptured: false });
    expect(noConsent.blockers.join(' ')).toMatch(/consent/);
    const nonResident = preSaleCheck(AE_PACK, { productLine: 'medical', hasNeedAnalysis: true, hasNeedId: true, surveyCompleted: true, comparisonPresented: true, customerIsResident: false, consentCaptured: true });
    expect(nonResident.blockers.join(' ')).toMatch(/non-residents/);
  });

  it('carries the jurisdiction differences that matter for takaful', () => {
    expect(AE_PACK.takaful.surplusToSaversAllowed).toBe(false);
    expect(MY_PACK.takaful.surplusToSaversAllowed).toBe(true);
    expect(AE_PACK.takaful.fullValuationBeforeSurplus).toBe(true);
    expect(PACKS['MY']!.country).toBe('MY');
  });

  it('ranks the comparison matrix on explained criteria, not just price', () => {
    const rows = comparisonMatrix([
      { insurer: 'Cheap', product: 'TP', premium: 900, excess: 1500, benefits: [], serviceRating: 1, complaintsPer10k: 40 },
      { insurer: 'Solid', product: 'Comp', premium: 2200, excess: 500, benefits: [], serviceRating: 5, complaintsPer10k: 3 },
      { insurer: 'Mid', product: 'Comp', premium: 1800, excess: 750, benefits: [], serviceRating: 3, complaintsPer10k: 10 },
    ]);
    expect(rows[0]!.insurer).not.toBe('Cheap');            // the cheapest offer with terrible service does not win
    expect(rows.map((r) => r.insurer)).toContain('Solid');
    expect(rows[0]!.rationale).toMatch(/Ranked on/);
    expect(rows[0]!.score).toBeGreaterThanOrEqual(rows[1]!.score);
    // weights are explicit: shifting to price-only changes the ranking
    const priceOnly = comparisonMatrix([
      { insurer: 'Cheap', product: 'TP', premium: 900, excess: 1500, benefits: [], serviceRating: 1, complaintsPer10k: 40 },
      { insurer: 'Solid', product: 'Comp', premium: 2200, excess: 500, benefits: [], serviceRating: 5, complaintsPer10k: 3 },
    ], { premium: 1, service: 0, excess: 0 });
    expect(priceOnly[0]!.insurer).toBe('Cheap');
  });
});

describe('labels, renaming and locales', () => {
  it('renames per scope so a takaful window speaks its own vocabulary', () => {
    const labels = new LabelRegistry();
    expect(labels.t('policy.premium', 'en')).toBe('Premium');
    labels.renameMany('alkhaleej:ALK-TKF', LabelRegistry.TAKAFUL_REnames('en'), 'system', '2026-09-01T00:00:00Z');
    expect(labels.t('policy.premium', 'en', undefined, 'alkhaleej:ALK-TKF')).toBe('Contribution');
    expect(labels.t('policy.premium', 'en', undefined, 'alkhaleej')).toBe('Premium');   // conventional scope untouched
    expect(labels.auditTrail()).toHaveLength(5);
    expect(labels.auditTrail()[0]!.to).toBe('Contribution');
    expect(labels.auditTrail()[0]!.from).toBe('Premium');
  });

  it('falls back through locale, then English, then the key itself', () => {
    const labels = new LabelRegistry();
    expect(labels.t('fund.units', 'ar')).toMatch(/وحدات/);
    expect(labels.t('fund.units', 'ms')).toBe('Units');
    expect(labels.t('not.a.key', 'en')).toBe('not.a.key');
  });

  it('reports coverage and exports a locale for documents', () => {
    const labels = new LabelRegistry();
    const coverage = labels.coverage('ar');
    expect(coverage.total).toBeGreaterThan(10);
    expect(coverage.missing.length).toBe(coverage.total - coverage.covered);
    const exported = labels.export('en', 'alkhaleej');
    expect(exported['disclaimer.illustration']).toMatch(/illustration, not advice/);
  });
});

describe('smart onboarding', () => {
  it('accepts a chip read without OCR', () => {
    const result = readChip('emirates-id', { fullName: 'أحمد المنصوري', idNumber: '784-1985-1234567-1' });
    expect(result.method).toBe('chip');
    expect(result.autoAccepted).toBe(true);
    expect(result.reviewQueue).toHaveLength(0);
    expect(result.fields.every((f) => f.confidence > 0.99)).toBe(true);
  });

  it('accepts a government lookup but not blindly (confidence and audit trail)', () => {
    const result = governmentLookup('national-id', { fullName: 'Ahmed Al Mansoori' });
    expect(result.method).toBe('government-lookup');
    expect(result.fields[0]!.confidence).toBe(0.98);
    expect(result.notes.join(' ')).toMatch(/consent/);
  });

  it('sends disagreed OCR fields to a human instead of guessing', () => {
    const result = ocrDocument('driving-licence', {
      licenceNumber: ['DL-AE-99120', 'DL-AE-9912O', 'DL-AE-99120'],
      expiry: ['2027-03-15', '2027-03-15', '2027-04-15'],
    });
    expect(result.method).toBe('ocr');
    const licence = result.fields.find((f) => f.field === 'licenceNumber')!;
    expect(licence.confidence).toBeCloseTo(0.667, 2);
    expect(result.reviewQueue.map((f) => f.field)).toContain('licenceNumber');
    expect(result.autoAccepted).toBe(false);
  });

  it('keeps the official Arabic value beside the English transliteration', () => {
    const fields = translateFields([{ field: 'fullName', value: 'أحمد المنصوري', confidence: 0.99, source: 'chip' }], 'en');
    expect(fields[0]!.ar).toBe('أحمد المنصوري');
    expect(fields[0]!.en).toBe('أحمد المنصوري');   // unknown token is never invented
    const known = translateFields([{ field: 'city', value: 'دبي', confidence: 0.9, source: 'ocr-consensus' }], 'en');
    expect(known[0]!.en).toBe('Dubai');
    expect(known[0]!.translatedFrom).toBe('دبي');
  });

  it('blocks product suggestions until consent, need analysis and the review queue are clear', () => {
    const chip = readChip('emirates-id', { fullName: 'Ahmed Al Mansoori' });
    const blocked = onboard({ sessionId: 'S1', documents: [chip], targetLocale: 'en', needAnalysisCompleted: false, consentCaptured: false });
    expect(blocked.readyForProductSuggestion).toBe(false);
    expect(blocked.blockers.join(' ')).toMatch(/Consent/);
    expect(blocked.blockers.join(' ')).toMatch(/need analysis/);
    const ready = onboard({ sessionId: 'S2', documents: [chip], targetLocale: 'en', needAnalysisCompleted: true, consentCaptured: true });
    expect(ready.readyForProductSuggestion).toBe(true);
  });
});
