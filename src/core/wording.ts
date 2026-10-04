/**
 * Wording and disclaimers, generated rather than pasted.
 *
 * Every document a UAE carrier sends in connection with its reinsurance carries words that a
 * regulator has decided must appear: that the cover was placed with a licensed company, that the
 * figures come from the register and the books, that a takaful window's participant money is kept
 * apart from the operator's, that an illustration is not a forecast. This module holds those
 * paragraphs **as data with their instruments**, composes the document around them, and refuses to
 * produce one that is missing a disclaimer its template requires.
 *
 * Three rules make it more than a template engine:
 *
 *  - A **label** may be renamed per scope — the takaful window says *contribution* where the
 *    conventional book says *premium* — from the same label registry the screens read. A rename
 *    changes what a field is called and never what a mandated paragraph says.
 *  - A mandated paragraph is **bilingual in one record**, English and Arabic together, so a document
 *    cannot be produced in one language with the other silently dropped.
 *  - Every document states **which pack version produced it**, so a wording change is a new document,
 *    not a quiet edit. Identical content returns the same document; a change supersedes it with a
 *    reason and keeps the earlier version.
 */
import { Locale } from './labels.js';

export class WordingError extends Error {}

export const REASON_MINIMUM = 24;

/** A paragraph a regulator requires, held with the instrument that requires it. */
export interface WordingDisclaimer {
  readonly id: string;
  readonly kind: 'instrument' | 'basis' | 'limitation' | 'segregation' | 'illustration';
  readonly text: string;
  readonly textAr: string;
  readonly instrument?: string;
  readonly appliesTo: readonly WordingDocumentType[];
}

export type WordingDocumentType = 'bordereau-cover' | 'return-cover' | 'treaty-note' | 'customer-reinsurance-note';

export interface WordingField {
  readonly key: string;                    // a label key the scope may rename
  readonly required: boolean;
  readonly value: string;                  // already formatted by the caller, e.g. a Money in base currency
}

export interface WordingTemplate {
  readonly type: WordingDocumentType;
  /**
   * A template may declare a different label set and a different set of mandated paragraphs per scope:
   * the treaty note of a takaful window states a contribution and the fund segregation paragraph, while
   * the conventional book's states a premium and neither. The declared labels stay on the template, so
   * a scope can still rename them.
   */
  readonly labelsByScope?: Readonly<Record<string, readonly string[]>>;
  readonly disclaimersByScope?: Readonly<Record<string, readonly string[]>>;
  readonly title: string;
  readonly titleAr: string;
  readonly purpose: string;
  readonly purposeAr: string;
  readonly labels: readonly string[];      // the label keys this document uses, and may rename
  readonly disclaimers: readonly string[]; // disclaimer ids that must be present
  readonly closes: string;
  readonly closesAr: string;
}

export interface WordingCatalogue {
  readonly templates: readonly WordingTemplate[];
  readonly disclaimers: readonly WordingDisclaimer[];
}

export interface WordingBlock {
  readonly id: string;
  readonly kind: 'heading' | 'purpose' | 'body' | 'disclaimer' | 'closing';
  readonly en: string;
  readonly ar: string;
  readonly instrument?: string;
  readonly disclaimerId?: string;
}

export interface WordingDocument {
  readonly id: string;
  readonly version: number;
  readonly type: WordingDocumentType;
  readonly scope: string;                 // 'conventional' | 'takaful' | a tenant id
  readonly locale: Locale;
  readonly title: string;
  readonly titleAr: string;
  readonly blocks: readonly WordingBlock[];
  readonly fields: readonly { key: string; label: string; labelAr: string; value: string }[];
  readonly disclaimers: readonly { id: string; instrument?: string }[];
  readonly packVersion: string;
  readonly fingerprint: string;
  readonly generatedAt: string;
  readonly by: string;
  readonly tiesTo: readonly string[];
  readonly limitation: string;
  /** The facts the letter was generated from, kept so the store can regenerate and compare it. */
  readonly facts: WordingFacts;
  readonly supersedes?: string;
  readonly changesSummary?: string;
}

/** The paragraphs. English and Arabic in one record: a document cannot drop one of them by accident. */
export const AE_WORDING: WordingCatalogue = {
  templates: [
    {
      type: 'bordereau-cover',
      title: 'Cover note to the reinsurer, with the treaty bordereau',
      titleAr: 'خطاب إحاطة إلى معيد التأمين، مع كشف الاتفاقية',
      purpose: 'Sends the period’s cession bordereau, names the accounts it was drawn from and the terms on which the balance is due.',
      purposeAr: 'يُرسل كشف التنازلات عن الفترة، ويحدد الحسابات التي استُخرج منها والشروط التي يستحق بموجبها الرصيد.',
      labels: ['policy.premium', 'policy.sumAssured', 'fund.value'],
      disclaimers: ['W-BASIS-01', 'W-LICENCE-01', 'W-SETTLE-01'],
      closes: 'Queries on this bordereau should be raised with the reinsurance desk within the settlement terms stated above.',
      closesAr: 'تُقدَّم الاستفسارات بشأن هذا الكشف إلى مكتب إعادة التأمين خلال مهلة التسوية المذكورة أعلاه.',
    },
    {
      type: 'return-cover',
      title: 'Cover letter to the supervisor, with the regulatory return',
      titleAr: 'خطاب إحاطة إلى الجهة الرقابية، مع الإقرار الرقابي',
      purpose: 'Files the period’s return, names its schedules and controls, and states every difference accepted and by whom.',
      purposeAr: 'يودع إقرار الفترة، ويحدد جداوله وضوابطه، ويبيّن كل فرق تم قبوله ومن قبله.',
      labels: ['policy.premium', 'policy.contribution'],
      disclaimers: ['W-BASIS-01', 'W-LIMIT-01', 'W-LICENCE-02'],
      closes: 'The return is filed on the basis stated above; a corrected return supersedes this one and says what changed.',
      closesAr: 'يُقدَّم الإقرار على الأساس المبين أعلاه؛ ويحل أي إقرار مصحح محل هذا الإقرار مع بيان ما تغيّر.',
    },
    {
      type: 'treaty-note',
      title: 'Treaty file note',
      titleAr: 'مذكرة ملف الاتفاقية',
      purpose: 'Records the basis of the treaty, the approved plan it sits under, the security held and the rule book’s decision on the placement.',
      purposeAr: 'يُدوّن أساس الاتفاقية، والخطة المعتمدة التي تندرج تحتها، والضمانات المحتفظ بها، وقرار كتاب القواعد بشأن الإسناد.',
      labels: ['policy.premium', 'policy.contribution', 'takaful.riskFund', 'takaful.operator'],
      labelsByScope: {
        conventional: ['policy.premium'],
        takaful: ['policy.contribution', 'takaful.riskFund', 'takaful.operator'],
      },
      disclaimers: ['W-BASIS-01', 'W-LICENCE-01', 'W-SEG-01'],
      disclaimersByScope: {
        conventional: ['W-BASIS-01', 'W-LICENCE-01'],
        takaful: ['W-BASIS-01', 'W-LICENCE-01', 'W-SEG-01'],
      },
      closes: 'This note is filed with the treaty and supersedes any earlier note for the same treaty.',
      closesAr: 'تُحفظ هذه المذكرة مع الاتفاقية وتحل محل أي مذكرة سابقة لنفس الاتفاقية.',
    },
    {
      type: 'customer-reinsurance-note',
      title: 'Note to the policyholder on reinsurance',
      titleAr: 'ملاحظة إلى حامل الوثيقة بشأن إعادة التأمين',
      purpose: 'Tells the customer that the risk is reinsured, what that does and does not give them, and how their data moves.',
      purposeAr: 'يُخبر العميل بأن الخطر معاد تأمينه، وما يمنحه ذلك وما لا يمنحه، وكيف تُنقل بياناته.',
      labels: ['policy.holder', 'policy.premium'],
      disclaimers: ['W-CUST-01', 'W-LICENCE-02', 'W-LIMIT-02'],
      closes: 'Your policy remains with us; the cover, the payments and the complaints route do not change.',
      closesAr: 'تبقى وثيقتك لدينا؛ ولا تتغير التغطية ولا المدفوعات ولا قناة تقديم الشكاوى.',
    },
  ],
  disclaimers: [
    {
      id: 'W-BASIS-01', kind: 'basis',
      text: 'Every figure in this document is derived from the cession register and the books of the entity named above; each control that supports it names the ledger account it ties to.',
      textAr: 'كل رقم في هذا المستند مستخرج من سجل التنازلات ودفاتر الجهة المذكورة أعلاه؛ وكل ضابط يدعمه يحدد حساب الدفاتر الذي يطابقه.',
      appliesTo: ['bordereau-cover', 'return-cover', 'treaty-note'],
    },
    {
      id: 'W-LICENCE-01', kind: 'instrument',
      instrument: 'Federal Decree-Law No. 48 of 2023, Article (42)',
      text: 'Reinsurance under this document has been placed only with a company licensed to carry the class of business ceded, as Article (42) requires.',
      textAr: 'لم تُسند إعادة التأمين الواردة في هذا المستند إلا إلى شركة مرخصة لمزاولة نوع التأمين المتنازل عنه، وفقاً لما تقتضيه المادة (42).',
      appliesTo: ['bordereau-cover', 'treaty-note'],
    },
    {
      id: 'W-LICENCE-02', kind: 'instrument',
      instrument: 'Federal Decree-Law No. 48 of 2023, Articles (42) and (64)',
      text: 'The risk is carried by a company licensed in the United Arab Emirates and reinsured inside or outside the State; where a counterparty is licensed in a financial free zone it may write reinsurance outside the zone and no other insurance activity.',
      textAr: 'يحمل الخطر شركة مرخصة في دولة الإمارات العربية المتحدة ويُعاد تأمينه داخل الدولة أو خارجها؛ وإذا كان الطرف المرخص له في منطقة مالية حرة فلا يجوز له مزاولة أي نشاط تأميني خارج المنطقة باستثناء إعادة التأمين.',
      appliesTo: ['return-cover', 'customer-reinsurance-note'],
    },
    {
      id: 'W-SETTLE-01', kind: 'basis',
      text: 'Balances are payable within the settlement terms of the treaty named above; recoveries carry the security stated in the security register, and any part of that security that is not cash is disclosed as off balance sheet.',
      textAr: 'تُسدد الأرصدة خلال مهلة التسوية المنصوص عليها في الاتفاقية المذكورة أعلاه؛ وتُحمّل المبالغ المستردة بالضمانات المبينة في سجل الضمانات، ويُفصح عن أي جزء من تلك الضمانات غير نقدي خارج الميزانية.',
      appliesTo: ['bordereau-cover'],
    },
    {
      id: 'W-LIMIT-01', kind: 'limitation',
      text: 'The return states paid and reserved facts and where its arithmetic stops: no IBNR, no discounting and no unexpired premium on annual business.',
      textAr: 'يبيّن الإقرار الوقائع المدفوعة والمحتسبة ونقطة توقف حساباته: لا احتياطي للخسائر المتكبدة ولم تُبلغ، ولا خصم، ولا أقساط غير مكتسبة على الأعمال السنوية.',
      appliesTo: ['return-cover'],
    },
    {
      id: 'W-LIMIT-02', kind: 'limitation',
      text: 'How we settle a claim with you does not depend on how or whether we reinsure it, and a reinsurer is not answerable to you directly.',
      textAr: 'لا تتوقف طريقة تسوية مطالبتك معنا على كيفية إعادة تأمين الخطر أو على إعادة تأمينه من عدمه، ولا يُسأل معيد التأمين أمامك مباشرة.',
      appliesTo: ['customer-reinsurance-note'],
    },
    {
      id: 'W-SEG-01', kind: 'segregation',
      instrument: 'Federal Decree-Law No. 48 of 2023 and the CBUAE takaful regulations',
      text: 'Participant risk money is held in the participant risk fund and may only be protected by a retakaful arrangement; the operator’s share is the wakalah fee or its share of surplus, never participant money.',
      textAr: 'تُحفظ أموال مخاطر المشاركين في صندوق مخاطر المشاركين ولا يجوز حمايتها إلا من خلال ترتيب إعادة تكافل؛ وحصة المشغل هي أجر الوكالة أو نصيبه من الفائض، وليست أموال المشاركين.',
      appliesTo: ['treaty-note'],
    },
    {
      id: 'W-CUST-01', kind: 'illustration',
      instrument: 'CBUAE consumer protection requirements',
      text: 'This note explains a reinsurance arrangement; it is not advice, an offer of cover, or a promise that a claim will be paid.',
      textAr: 'توضح هذه الملاحظة ترتيب إعادة تأمين؛ وهي ليست نصيحة أو عرضاً للتغطية أو وعداً بسداد المطالبة.',
      appliesTo: ['customer-reinsurance-note'],
    },
  ],
};

export interface WordingFacts {
  readonly scope: string;
  readonly locale: Locale;
  readonly packVersion: string;
  readonly at: string;
  readonly by: string;
  readonly fields: readonly WordingField[];
  readonly tiesTo: readonly string[];
  readonly entityName: string;
  readonly counterparty?: string;
  readonly period?: string;
}

function fingerprintOf(input: unknown): string {
  // Deterministic, order-stable hashing of the document's substance: the same facts give the same
  // document, and a moved figure gives a different one.
  const text = JSON.stringify(input, Object.keys(input as object).sort());
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

export class WordingBook {
  private readonly log: WordingDocument[] = [];
  private seq = 0;

  constructor(private readonly options: {
    readonly catalogue?: WordingCatalogue;
    readonly resolve?: (key: string, locale: Locale, scope: string) => string;
    readonly reasonMinimum?: number;
  } = {}) {}

  catalogue(): WordingCatalogue { return this.options.catalogue ?? AE_WORDING; }

  template(type: WordingDocumentType): WordingTemplate {
    const found = this.catalogue().templates.find((t) => t.type === type);
    if (!found) throw new WordingError(`no template for a ${type}`);
    return found;
  }

  disclaimer(id: string): WordingDisclaimer {
    const found = this.catalogue().disclaimers.find((d) => d.id === id);
    if (!found) throw new WordingError(`no disclaimer ${id}`);
    return found;
  }

  /**
   * Compose the document. A disclaimer the template requires but the catalogue does not hold is an
   * error, not a silent omission — a document that quietly drops its mandated wording is worse than
   * no document at all.
   */
  generate(input: { type: WordingDocumentType; facts: WordingFacts; disclaimers?: readonly string[] }): WordingDocument {
    const template = this.template(input.type);
    const scopeLabels = template.labelsByScope?.[input.facts.scope] ?? template.labels;
    const wanted = input.disclaimers ?? template.disclaimersByScope?.[input.facts.scope] ?? template.disclaimers;
    // First, what the caller asked for: an unknown paragraph, or one that belongs to another document.
    for (const id of wanted) {
      const d = this.disclaimer(id);
      if (!d.appliesTo.includes(input.type)) throw new WordingError(`${id} does not belong on a ${input.type}`);
    }
    // Then, what the template requires: a mandated paragraph absent from the request is an error.
    const required = template.disclaimersByScope?.[input.facts.scope] ?? template.disclaimers;
    const missing = required.filter((id) => !wanted.includes(id));
    if (missing.length > 0) {
      throw new WordingError(`a ${input.type} cannot be produced without ${missing.join(', ')}: the wording is mandated, not optional`);
    }
    const blocks: WordingBlock[] = [
      { id: 'heading', kind: 'heading', en: template.title, ar: template.titleAr },
      { id: 'purpose', kind: 'purpose', en: template.purpose, ar: template.purposeAr },
      {
        id: 'context', kind: 'body',
        en: `${input.facts.entityName}${input.facts.counterparty ? `, in respect of ${input.facts.counterparty}` : ''}${input.facts.period ? `, for the period ${input.facts.period}` : ''}.`,
        ar: `${input.facts.entityName}${input.facts.counterparty ? `، بخصوص ${input.facts.counterparty}` : ''}${input.facts.period ? `، عن الفترة ${input.facts.period}` : ''}.`,
      },
    ];
    for (const id of wanted) {
      const d = this.disclaimer(id);
      blocks.push({
        id: d.id, kind: d.kind === 'limitation' ? 'disclaimer' : 'disclaimer',
        en: d.text, ar: d.textAr, ...(d.instrument ? { instrument: d.instrument } : {}), disclaimerId: d.id,
      });
    }
    blocks.push({ id: 'closing', kind: 'closing', en: template.closes, ar: template.closesAr });

    // A conventional document states no contribution and a takaful one no premium; those fields are
    // simply absent rather than empty. Anything else a template declares must be supplied.
    const OPTIONAL_WHEN_ABSENT = ['policy.premium', 'policy.contribution', 'fund.value'];
    const fields = scopeLabels.map((key) => {
      const field = input.facts.fields.find((f) => f.key === key);
      const en = this.label(key, 'en', input.facts.scope);
      const ar = this.label(key, 'ar', input.facts.scope);
      if (!field) {
        if (OPTIONAL_WHEN_ABSENT.includes(key)) return null;
        throw new WordingError(`a ${input.type} needs a value for ${key}`);
      }
      return { key, label: en, labelAr: ar, value: field.value };
    }).filter((f): f is { key: string; label: string; labelAr: string; value: string } => f !== null);

    const substance = {
      type: input.type, scope: input.facts.scope, locale: input.facts.locale, packVersion: input.facts.packVersion,
      blocks: blocks.map((b) => [b.id, b.en, b.ar]),
      fields: fields.map((f) => [f.key, f.label, f.labelAr, f.value]),
      tiesTo: input.facts.tiesTo,
      disclaimers: wanted.map((id) => this.disclaimer(id)).map((d) => [d.id, d.text, d.textAr]),
    };
    const existing = this.log.filter((d) => d.type === input.type && d.scope === input.facts.scope);
    const fingerprint = fingerprintOf(substance);
    const same = [...existing].reverse().find((d) => d.fingerprint === fingerprint);
    if (same) return same;

    const previous = existing.at(-1);
    let changesSummary: string | undefined;
    if (previous) {
      const changes = this.diff(previous, { blocks, fields });
      if (input.disclaimers === undefined && changes.length === 0) return previous;
      changesSummary = changes.join('; ');
      if (changesSummary.length < (this.options.reasonMinimum ?? REASON_MINIMUM)) {
        throw new WordingError(`a superseding ${input.type} needs a changes summary of at least ${this.options.reasonMinimum ?? REASON_MINIMUM} characters; got “${changesSummary}”`);
      }
    }

    const document: WordingDocument = Object.freeze({
      id: `W-${input.type.toUpperCase().slice(0, 4)}-${String(++this.seq).padStart(5, '0')}`,
      version: previous ? previous.version + 1 : 1,
      type: input.type, scope: input.facts.scope, locale: input.facts.locale,
      title: template.title, titleAr: template.titleAr,
      blocks: Object.freeze(blocks.map((b) => Object.freeze({ ...b }))),
      fields: Object.freeze(fields.map((f) => Object.freeze({ ...f }))),
      disclaimers: Object.freeze(wanted.map((id) => { const d = this.disclaimer(id); return Object.freeze({ id: d.id, ...(d.instrument ? { instrument: d.instrument } : {}) }); })),
      packVersion: input.facts.packVersion,
      fingerprint,
      generatedAt: input.facts.at, by: input.facts.by,
      tiesTo: Object.freeze([...input.facts.tiesTo]),
      facts: Object.freeze({ ...input.facts, fields: Object.freeze(input.facts.fields.map((f) => Object.freeze({ ...f }))), tiesTo: Object.freeze([...input.facts.tiesTo]) }) as WordingFacts,
      limitation: `Generated from ${this.catalogue().templates.length} templates and ${this.catalogue().disclaimers.length} mandated paragraphs held as data under pack `
        + `${input.facts.packVersion}; the Arabic is the translation of record and travels with the English in the same document, and a rename may change a `
        + 'label but never a mandated paragraph.',
      ...(previous && changesSummary ? { supersedes: previous.id, changesSummary } : {}),
    });
    this.log.push(document);
    return document;
  }

  /** Verify that a document still reproduces from its own substance. */
  verify(id: string): { id: string; fingerprint: string; recomputed: string; intact: boolean; detail: string } {
    const doc = this.document(id);
    const substance = {
      type: doc.type, scope: doc.scope, locale: doc.locale, packVersion: doc.packVersion,
      blocks: doc.blocks.map((b) => [b.id, b.en, b.ar]),
      fields: doc.fields.map((f) => [f.key, f.label, f.labelAr, f.value]),
      tiesTo: [...doc.tiesTo],
      disclaimers: doc.disclaimers.map((d) => {
        const source = this.catalogue().disclaimers.find((x) => x.id === d.id)!;
        return [source.id, source.text, source.textAr];
      }),
    };
    const recomputed = fingerprintOf(substance);
    const intact = recomputed === doc.fingerprint;
    return {
      id: doc.id, fingerprint: doc.fingerprint, recomputed, intact,
      detail: intact
        ? `${doc.id} reproduces: the labels, the fields and the mandated paragraphs are exactly the ones it was generated with`
        : `${doc.id} no longer reproduces: a label, a field or a mandated paragraph has moved since it was generated`,
    };
  }

  documents(): readonly WordingDocument[] { return this.log; }

  document(id: string): WordingDocument {
    const found = this.log.find((d) => d.id === id);
    if (!found) throw new WordingError(`no document ${id}`);
    return found;
  }

  history(type: WordingDocumentType, scope: string): readonly WordingDocument[] {
    return this.log.filter((d) => d.type === type && d.scope === scope);
  }

  private label(key: string, locale: Locale, scope: string): string {
    if (this.options.resolve) return this.options.resolve(key, locale, scope);
    return key;
  }

  private diff(previous: WordingDocument, next: { blocks: WordingBlock[]; fields: { key: string; label: string; labelAr: string; value: string }[] }): string[] {
    const changes: string[] = [];
    const blockById = new Map(previous.blocks.map((b) => [b.id, b]));
    for (const b of next.blocks) {
      const before = blockById.get(b.id);
      if (before && before.en !== b.en) changes.push(`${b.id} (en) changed`);
      if (before && before.ar !== b.ar) changes.push(`${b.id} (ar) changed`);
      if (!before) changes.push(`${b.id} added`);
    }
    for (const b of previous.blocks) if (!next.blocks.some((x) => x.id === b.id)) changes.push(`${b.id} removed`);
    const fieldByKey = new Map(previous.fields.map((f) => [f.key, f]));
    for (const f of next.fields) {
      const before = fieldByKey.get(f.key);
      if (before && before.value !== f.value) changes.push(`${f.key}: ${before.value} → ${f.value}`);
      if (before && before.label !== f.label) changes.push(`${f.key} renamed to “${f.label}”`);
      if (!before) changes.push(`${f.key} added`);
    }
    return changes;
  }
}
