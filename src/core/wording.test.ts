/**
 * Wording and disclaimers: the promises a generated document has to keep.
 *
 * A regulator's paragraphs are not decoration, so these tests hold the generator to four things: a
 * document cannot be produced without the wording its template requires; every block exists in
 * English and Arabic in the same record; a rename changes a field's name and never a mandated
 * paragraph; and a document states which pack version produced it, reproduces on demand, and is
 * superseded rather than edited when a figure moves.
 */
import { describe, expect, it } from 'vitest';
import { AE_WORDING, WordingBook, WordingCatalogue, WordingError, WordingFacts } from './wording.js';
import { LabelRegistry, Locale } from './labels.js';

const facts = (overrides: Partial<WordingFacts> = {}): WordingFacts => ({
  scope: 'conventional',
  locale: 'en',
  packVersion: 'AE 2026.1',
  at: '2026-10-05T17:00:00+04:00',
  by: 'finance/reporting',
  entityName: 'Al Khaleej Insurance — conventional entity',
  counterparty: 'Emirates Re',
  period: '2026-01-01 to 2026-10-05',
  fields: [
    { key: 'policy.premium', required: true, value: '3,819.63 AED' },
    { key: 'policy.sumAssured', required: true, value: '250,000.00 AED' },
    { key: 'fund.value', required: false, value: '10,627.173 AED' },
  ],
  tiesTo: ['GET /api/extracts', 'ALK-CONV:REINS:CEDED-PREMIUM'],
  ...overrides,
});

describe('a generated document', () => {
  it('carries every mandated paragraph its template requires, in English and Arabic, with its instrument', () => {
    const book = new WordingBook();
    const doc = book.generate({ type: 'bordereau-cover', facts: facts() });
    expect(doc.version).toBe(1);
    expect(doc.disclaimers.map((d) => d.id)).toEqual(['W-BASIS-01', 'W-LICENCE-01', 'W-SETTLE-01']);
    for (const block of doc.blocks) {
      expect(block.en.length).toBeGreaterThan(10);
      expect(block.ar.length).toBeGreaterThan(10);
      expect(block.en).not.toBe(block.ar);
    }
    const licence = doc.blocks.find((b) => b.id === 'W-LICENCE-01')!;
    expect(licence.instrument).toContain('Article (42)');
    expect(licence.ar).toContain('المادة');
    expect(doc.packVersion).toBe('AE 2026.1');
    expect(doc.tiesTo).toContain('ALK-CONV:REINS:CEDED-PREMIUM');
    expect(doc.limitation).toContain('translation of record');
  });

  it('refuses to produce a document when a mandated paragraph is dropped', () => {
    const book = new WordingBook();
    expect(() => book.generate({ type: 'return-cover', facts: facts(), disclaimers: ['W-BASIS-01'] }))
      .toThrow(/cannot be produced without W-LIMIT-01, W-LICENCE-02/);
    const thin: WordingCatalogue = { templates: AE_WORDING.templates, disclaimers: AE_WORDING.disclaimers.filter((d) => d.id !== 'W-BASIS-01') };
    const book2 = new WordingBook({ catalogue: thin });
    expect(() => book2.generate({ type: 'bordereau-cover', facts: facts() })).toThrow(/no disclaimer W-BASIS-01/);
  });

  it('refuses a paragraph that does not belong on the document, and an unknown template', () => {
    const book = new WordingBook();
    expect(() => book.generate({ type: 'customer-reinsurance-note', facts: facts(), disclaimers: ['W-SEG-01'] }))
      .toThrow(/W-SEG-01 does not belong on a customer-reinsurance-note/);
    expect(() => book.generate({ type: 'a-letter' as never, facts: facts() })).toThrow(/no template/);
    expect(() => book.disclaimer('W-NOPE')).toThrow(/no disclaimer/);
  });

  it('reads the labels the scope declares, and refuses a template the caller has not filled', () => {
    const book = new WordingBook();
    const doc = book.generate({ type: 'treaty-note', facts: facts({ scope: 'takaful', fields: [
      { key: 'policy.contribution', required: true, value: '1,800.00 AED' },
      { key: 'takaful.riskFund', required: true, value: 'Participant risk fund' },
      { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
    ] }) });
    expect(doc.fields.map((f) => f.key)).toEqual(['policy.contribution', 'takaful.riskFund', 'takaful.operator']);
    // the conventional book's treaty note declares only its own premium field, and the assets behind the
    // bordereau belong to that template — neither is asked for where it does not belong
    const conv = book.generate({ type: 'treaty-note', facts: facts({ scope: 'conventional' }) });
    expect(conv.fields.map((f) => f.key)).toEqual(['policy.premium']);
    expect(conv.fields.map((f) => f.key)).not.toContain('fund.value');
    // a takaful window that has not filled its fund field is told so rather than given a blank
    expect(() => book.generate({ type: 'treaty-note', facts: facts({ scope: 'takaful', fields: [{ key: 'policy.contribution', required: true, value: '1,800.00 AED' }] }) }))
      .toThrow(/needs a value for takaful.riskFund/);
  });
});

describe('renaming, and the line it may not cross', () => {
  const registry = new LabelRegistry();
  registry.renameMany('alkhaleej-takaful', [
    { key: 'policy.premium', locale: 'en', text: 'Contribution' },
    { key: 'policy.premium', locale: 'ar', text: 'المساهمة' },
    { key: 'policy.contribution', locale: 'en', text: 'Participant contribution' },
    { key: 'takaful.riskFund', locale: 'en', text: 'Participant risk fund (segregated)' },
  ], 'product/manager', '2026-09-30T09:00:00+04:00');

  const resolve = (key: string, locale: Locale, scope: string) =>
    registry.t(key, locale, undefined, scope === 'takaful' ? 'alkhaleej-takaful' : 'default');

  it('renames a field label for the takaful window while the mandated paragraph stays word for word', () => {
    const book = new WordingBook({ resolve });
    const conventional = book.generate({ type: 'treaty-note', facts: facts({ scope: 'conventional', fields: [
      { key: 'policy.premium', required: true, value: '3,819.63 AED' },
    ] }) });
    const takaful = book.generate({ type: 'treaty-note', facts: facts({ scope: 'takaful', fields: [
      { key: 'policy.contribution', required: true, value: '1,800.00 AED' },
      { key: 'takaful.riskFund', required: true, value: 'segregated from the operator' },
      { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
    ] }) });
    const convPremium = conventional.fields.find((f) => f.key === 'policy.premium')!;
    const takafulContribution = takaful.fields.find((f) => f.key === 'policy.contribution')!;
    expect(convPremium.label).toBe('Premium');
    expect(takafulContribution.label).toBe('Participant contribution');
    expect(takafulContribution.labelAr).toBe('المساهمة');
    expect(takaful.fields.find((f) => f.key === 'takaful.riskFund')!.label).toContain('segregated');
    // the segregation paragraph is identical in both documents: a rename never reaches it
    const segregation = AE_WORDING.disclaimers.find((d) => d.id === 'W-SEG-01')!;
    expect(takaful.blocks.find((b) => b.id === 'W-SEG-01')!.en).toBe(segregation.text);
    expect(takaful.blocks.find((b) => b.id === 'W-SEG-01')!.ar).toBe(segregation.textAr);
  });
});

describe('immutability, supersession and verification', () => {
  it('returns the same document for identical content and a new version when a figure moves', () => {
    const book = new WordingBook();
    const first = book.generate({ type: 'bordereau-cover', facts: facts() });
    const again = book.generate({ type: 'bordereau-cover', facts: facts() });
    expect(again.id).toBe(first.id);
    expect(book.history('bordereau-cover', 'conventional').length).toBe(1);

    const moved = book.generate({
      type: 'bordereau-cover',
      facts: facts({ at: '2026-10-05T18:00:00+04:00', fields: [{ key: 'policy.premium', required: true, value: '3,819.63 AED' }, { key: 'policy.sumAssured', required: true, value: '250,000.00 AED' }, { key: 'fund.value', required: false, value: '10,700.000 AED' }] }),
    });
    expect(moved.version).toBe(2);
    expect(moved.supersedes).toBe(first.id);
    expect(moved.changesSummary).toContain('fund.value');
    expect(book.history('bordereau-cover', 'conventional').length).toBe(2);
  });

  it('refuses a supersession with a changes summary too short to be a reason', () => {
    const book = new WordingBook();
    book.generate({ type: 'bordereau-cover', facts: facts() });
    const moved = facts({ at: '2026-10-05T18:00:00+04:00', fields: [{ key: 'policy.premium', required: true, value: '4,000.00 AED' }, { key: 'policy.sumAssured', required: true, value: '250,000.00 AED' }, { key: 'fund.value', required: false, value: '10,627.173 AED' }] });
    const short = new WordingBook({ reasonMinimum: 400 });
    short.generate({ type: 'bordereau-cover', facts: facts() });
    expect(() => short.generate({ type: 'bordereau-cover', facts: moved })).toThrow(/changes summary of at least 400 characters/);
    expect(() => book.generate({ type: 'bordereau-cover', facts: moved })).not.toThrow();
  });

  it('verifies a document against its own substance, and says so when a paragraph has moved underneath it', () => {
    const book = new WordingBook();
    const doc = book.generate({ type: 'return-cover', facts: facts() });
    const intact = book.verify(doc.id);
    expect(intact.intact).toBe(true);
    expect(intact.detail).toContain('reproduces');

    // The pack is amended after the document was issued: the same disclaimer id now says something
    // else, so the issued document no longer reproduces from the catalogue behind it. This is the
    // case the check exists for — a wording review that moves a mandated paragraph under a filed
    // document — and it must not pass silently.
    const live = {
      templates: AE_WORDING.templates,
      disclaimers: [...AE_WORDING.disclaimers],
    };
    const book2 = new WordingBook({ catalogue: live as WordingCatalogue });
    const issued = book2.generate({ type: 'return-cover', facts: facts() });
    expect(book2.verify(issued.id).intact).toBe(true);
    live.disclaimers[0] = { ...live.disclaimers[0]!, text: `${live.disclaimers[0]!.text} Amended after the 2026 review.` };
    const after = book2.verify(issued.id);
    expect(after.intact).toBe(false);
    expect(after.detail).toContain('no longer reproduces');
  });

  it('gives a conventional treaty note no segregation paragraph and no contribution field, and the window both', () => {
    const book = new WordingBook();
    const conv = book.generate({ type: 'treaty-note', facts: facts({ scope: 'conventional' }) });
    expect(conv.disclaimers.map((d) => d.id)).toEqual(['W-BASIS-01', 'W-LICENCE-01']);
    expect(conv.fields.map((f) => f.key)).toEqual(['policy.premium']);
    expect(conv.blocks.some((b) => b.id === 'W-SEG-01')).toBe(false);
    const tkf = book.generate({ type: 'treaty-note', facts: facts({ scope: 'takaful', fields: [
      { key: 'policy.contribution', required: true, value: '1,800.00 AED' },
      { key: 'takaful.riskFund', required: true, value: 'segregated from the operator' },
      { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
    ] }) });
    expect(tkf.disclaimers.map((d) => d.id)).toEqual(['W-BASIS-01', 'W-LICENCE-01', 'W-SEG-01']);
    expect(tkf.blocks.find((b) => b.id === 'W-SEG-01')!.en).toContain('Participant risk money');
    // and the template still declares the window's labels, so its scope may rename them
    const template = book.template('treaty-note');
    expect(template.labels).toContain('takaful.riskFund');
  });

  it('freezes a document once generated', () => {
    const book = new WordingBook();
    const doc = book.generate({ type: 'treaty-note', facts: facts({ fields: [
      { key: 'policy.premium', required: true, value: '3,819.63 AED' },
      { key: 'takaful.riskFund', required: true, value: 'segregated from the operator' },
      { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
    ] }) });
    expect(Object.isFrozen(doc)).toBe(true);
    expect(() => { (doc as { title: string }).title = 'something else'; }).toThrow();
    expect(book.document(doc.id).title).toBe(doc.title);
    expect(() => book.document('W-NOPE-00001')).toThrow(/no document/);
  });
});

describe('the catalogue itself', () => {
  it('gives every template a purpose, a closing and at least one mandated paragraph, and every paragraph both languages', () => {
    expect(AE_WORDING.templates.length).toBe(4);
    for (const t of AE_WORDING.templates) {
      expect(t.disclaimers.length).toBeGreaterThan(0);
      expect(t.purpose.length).toBeGreaterThan(30);
      expect(t.closes.length).toBeGreaterThan(20);
      expect(/[\u0600-\u06FF]/.test(t.titleAr)).toBe(true);
      for (const id of t.disclaimers) {
        const d = AE_WORDING.disclaimers.find((x) => x.id === id);
        expect(d, `${id} exists`).toBeDefined();
        expect(d!.appliesTo).toContain(t.type);
        expect(/[\u0600-\u06FF]/.test(d!.textAr)).toBe(true);
      }
    }
    for (const d of AE_WORDING.disclaimers) {
      expect(d.appliesTo.length).toBeGreaterThan(0);
      expect(d.text.length).toBeGreaterThan(60);
    }
  });
});
