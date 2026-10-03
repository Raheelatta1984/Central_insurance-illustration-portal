/**
 * Smart onboarding.
 *
 * The pipeline: chip read where the document has one, government lookup where licensed,
 * OCR with multi-engine consensus as the fallback, per-field translation, and a review queue
 * for anything the machines are not sure about. Nothing is auto-accepted below the threshold.
 */
export type DocumentKind = 'emirates-id' | 'national-id' | 'iqama' | 'passport' | 'driving-licence';

export interface ExtractedField {
  readonly field: string;
  readonly value: string;
  readonly confidence: number;
  readonly source: 'chip' | 'government-lookup' | 'ocr-consensus' | 'ocr-single' | 'manual';
  readonly engines?: number;
}

export interface ExtractionResult {
  readonly documentKind: DocumentKind;
  readonly method: 'chip' | 'government-lookup' | 'ocr';
  readonly fields: readonly ExtractedField[];
  readonly reviewQueue: readonly ExtractedField[];
  readonly autoAccepted: boolean;
  readonly notes: string[];
}

export class OnboardingError extends Error {}

/** ICAO 9303-style chip read: highest integrity, so highest confidence. */
export function readChip(kind: DocumentKind, payload: Record<string, string>): ExtractionResult {
  const fields: ExtractedField[] = Object.entries(payload).map(([field, value]) => ({ field, value, confidence: 0.999, source: 'chip' as const }));
  return { documentKind: kind, method: 'chip', fields, reviewQueue: [], autoAccepted: true, notes: ['Read from the document chip (ICAO 9303) — no OCR involved.'] };
}

export function governmentLookup(kind: DocumentKind, payload: Record<string, string>): ExtractionResult {
  const fields: ExtractedField[] = Object.entries(payload).map(([field, value]) => ({ field, value, confidence: 0.98, source: 'government-lookup' as const }));
  return { documentKind: kind, method: 'government-lookup', fields, reviewQueue: [], autoAccepted: true, notes: ['Retrieved from the government source under the customer’s consent.'] };
}

/** Multi-engine OCR: per-field consensus; disagreement lands in the review queue. */
export function ocrDocument(kind: DocumentKind, readings: Record<string, string[]>, threshold = 0.85): ExtractionResult {
  const fields: ExtractedField[] = [];
  const reviewQueue: ExtractedField[] = [];
  for (const [field, values] of Object.entries(readings)) {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [bestValue, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const confidence = bestCount / values.length;
    const fieldResult: ExtractedField = {
      field, value: bestValue, confidence: Math.round(confidence * 1000) / 1000,
      source: values.length > 1 ? 'ocr-consensus' : 'ocr-single', engines: values.length,
    };
    fields.push(fieldResult);
    if (fieldResult.confidence < threshold) reviewQueue.push(fieldResult);
  }
  return {
    documentKind: kind, method: 'ocr', fields, reviewQueue,
    autoAccepted: reviewQueue.length === 0,
    notes: reviewQueue.length === 0
      ? ['All fields reached consensus across the OCR engines.']
      : [`${reviewQueue.length} field(s) need a human eye before this record is accepted.`],
  };
}

export interface BilingualField { readonly field: string; readonly en: string; readonly ar?: string; readonly translatedFrom?: string }

const TRANSLITERATION: Record<string, string> = {
  'أحمد': 'Ahmed', 'محمد': 'Mohammed', 'علي': 'Ali', 'فاطمة': 'Fatima', 'خالد': 'Khalid', 'سارة': 'Sara',
  'دبي': 'Dubai', 'أبوظبي': 'Abu Dhabi', 'الشارقة': 'Sharjah', 'الإمارات': 'United Arab Emirates',
};

/** Translate document fields for display without ever overwriting the official value. */
export function translateFields(fields: readonly ExtractedField[], targetLocale: 'en' | 'ar'): BilingualField[] {
  return fields.map((f) => {
    if (targetLocale === 'en') {
      const translated = TRANSLITERATION[f.value] ?? (/[\u0600-\u06ff]/.test(f.value) ? undefined : f.value);
      return { field: f.field, en: translated ?? f.value, ar: /[\u0600-\u06ff]/.test(f.value) ? f.value : undefined, ...(translated && translated !== f.value ? { translatedFrom: f.value } : {}) };
    }
    return { field: f.field, en: f.value, ar: /[\u0600-\u06ff]/.test(f.value) ? f.value : undefined };
  });
}

export interface OnboardingSession {
  readonly sessionId: string
  readonly documents: ExtractionResult[];
  readonly fields: BilingualField[];
  readonly needAnalysisTriggered: boolean;
  readonly readyForProductSuggestion: boolean;
  readonly blockers: string[];
}

export function onboard(input: {
  sessionId: string; documents: ExtractionResult[]; targetLocale: 'en' | 'ar'; needAnalysisCompleted: boolean; consentCaptured: boolean;
}): OnboardingSession {
  const allFields = input.documents.flatMap((d) => d.fields);
  const blockers: string[] = [];
  if (!input.consentCaptured) blockers.push('Consent must be captured before any product suggestion');
  if (!input.needAnalysisCompleted) blockers.push('The need analysis must be completed before any product suggestion');
  const pending = input.documents.flatMap((d) => d.reviewQueue);
  if (pending.length > 0) blockers.push(`${pending.length} extracted field(s) are waiting in the review queue`);
  return {
    sessionId: input.sessionId,
    documents: input.documents,
    fields: translateFields(allFields, input.targetLocale),
    needAnalysisTriggered: input.needAnalysisCompleted,
    readyForProductSuggestion: blockers.length === 0,
    blockers,
  };
}
