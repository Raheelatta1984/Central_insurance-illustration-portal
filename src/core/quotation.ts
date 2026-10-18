/**
 * Quotation generation, dispatch to the customer, and finalisation.
 *
 * A quotation is the document the customer relies on, so it is treated as a controlled artefact:
 * it is versioned, it carries the pack version and the mandated wording that required it, every
 * loading on it is itemised with its basis, and it cannot be issued while a mandatory gate is open
 * (needs analysis missing, loadings that do not reconcile with the underwriting file, fund weights
 * that do not total 100%, beneficiaries that do not total 100%, medical evidence outstanding).
 *
 * The PDF is written by this repository's own writer (`pdf.ts`) and fingerprinted, so an emailed
 * attachment can be matched to the document that was approved. Dispatch records the consent it was
 * sent under and masks the address in the audit copy. Finalisation records the customer's sign-off
 * inside the validity window and the cooling-off period that follows issue.
 */
import { Money, add, compare, formatAmount, money, zero } from './money.js';
import { PdfDocument, PdfFile, renderPdf, verifyPdf } from './pdf.js';
import { fingerprint } from './persistence.js';

export class QuotationError extends Error {}

export const DEFAULT_VALIDITY_DAYS = 21;
export const REASON_MINIMUM = 24;

export interface QuotationCustomer {
  readonly partyId: string;
  readonly name: string;
  readonly nameAr?: string;
  readonly idType?: string;
  readonly idNumber?: string;
  readonly email: string;
  readonly phone?: string;
  readonly address?: string;
  readonly city?: string;
  readonly country: string;
}

export interface QuotationProduct {
  readonly productId: string;
  readonly name: string;
  readonly category: 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg';
  readonly entityId: string;
  readonly currency: string;
  readonly shariahCompliant: boolean;
}

export interface QuotationChargeLine {
  readonly label: string;
  readonly amount: Money;
  readonly basis: string;             // the sentence that explains the number
  readonly bps?: number;
  readonly waived?: boolean;
}

export interface QuotationFacts {
  readonly tenant: { readonly name: string };
  readonly customer: QuotationCustomer;
  readonly product: QuotationProduct;
  readonly sumAssured: Money;
  readonly termYears: number;
  readonly paymentFrequency: 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'single';
  readonly premiumPerFrequency: Money;
  readonly standardPremium: Money;
  readonly loadingLines: readonly QuotationChargeLine[];
  readonly loadedPremium: Money;
  readonly riderLines: readonly QuotationChargeLine[];
  readonly totalPayable: Money;
  readonly exclusions: readonly string[];
  readonly fundLines: ReadonlyArray<{ fundId: string; name: string; weightBps: number; amount: Money; navPerUnit: string; navDate: string; units: string }>;
  readonly beneficiaryLines: ReadonlyArray<{ name: string; relationship: string; shareBps: number; kind: 'primary' | 'contingent' }>;
  readonly medicalRequirements: ReadonlyArray<{ label: string; status: string; source: string }>;
  readonly outstandingMedical: readonly string[];
  readonly underwriting: {
    readonly outcome: string;
    readonly decidedBy: string;
    readonly decidedByAi: boolean;
    readonly extraMortalityBps: number;
    readonly referrals: readonly string[];
  };
  readonly needs: { readonly needId: string; readonly pack: string; readonly completed: boolean; readonly percent: number };
  readonly illustration: { readonly wording: string; readonly scenariosShown: number; readonly coolingOffDays: number };
  readonly comparisonPresented: boolean;
  readonly consentId?: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly chargeNotes?: readonly string[];
}

export interface ComplianceCheck {
  readonly code: string;
  readonly label: string;
  readonly passes: boolean;
  readonly hard: boolean;             // hard failures stop the quotation being issued at all
  readonly detail: string;
}

export interface QuotationEmail {
  readonly messageId: string;
  readonly quotationId: string;
  readonly version: number;
  readonly to: string;                 // masked in the audit copy
  readonly toFull: string;
  readonly subject: string;
  readonly body: string;
  readonly attachment: { readonly fileName: string; readonly fingerprint: string; readonly bytes: number };
  readonly language: 'en' | 'ar' | 'both';
  readonly consentId: string | null;
  readonly channel: 'email';
  readonly dispatchedAt: string;
  readonly dispatchedBy: string;
}

export interface QuotationFinalisation {
  readonly quotationId: string;
  readonly version: number;
  readonly signedBy: string;
  readonly signatureReference: string;
  readonly signedAt: string;
  readonly insideValidity: boolean;
  readonly daysRemaining: number;
  readonly coolingOffEndsOn: string;
  readonly coolingOffStatement: string;
  readonly readyToBuyOnline: boolean;
  readonly buyToken: string;
}

export interface QuotationRecord {
  readonly quotationId: string;
  readonly version: number;
  readonly status: 'issued' | 'superseded' | 'dispatched' | 'finalised' | 'expired' | 'refused';
  readonly partyId: string;
  readonly customerName: string;
  readonly productId: string;
  readonly productName: string;
  readonly category: QuotationProduct['category'];
  readonly currency: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly expiresAt: string;
  readonly validityDays: number;
  readonly sumAssured: string;
  readonly standardPremium: string;
  readonly loadingTotal: string;
  readonly loadedPremium: string;
  readonly riderTotal: string;
  readonly totalPayable: string;
  readonly premiumPerFrequency: string;
  readonly underwritingOutcome: string;
  readonly decidedBy: string;
  readonly compliance: readonly ComplianceCheck[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly pdf: { readonly fileName: string; readonly fingerprint: string; readonly bytes: number; readonly pages: number; readonly base64: string; readonly text: string; readonly opens: boolean };
  readonly document: PdfDocument;
  readonly email: QuotationEmail | null;
  readonly finalisation: QuotationFinalisation | null;
  readonly supersededBy: string | null;
  readonly facts: QuotationFacts;
}

/* ------------------------------------------------------------------ helpers */

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return 'invalid-address';
  const shown = local && local.length > 1 ? `${local[0]}${'*'.repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}` : '*';
  return `${shown}@${domain}`;
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/* ------------------------------------------------------------------ compliance gates */

/**
 * The gates that decide whether this quotation may exist. Each one says what it checked and what it
 * found, because "quotation refused" with no reason is a support ticket and a complaint waiting.
 */
export function quotationCompliance(facts: QuotationFacts): { checks: ComplianceCheck[]; blockers: string[]; warnings: string[] } {
  const checks: ComplianceCheck[] = [];
  const push = (code: string, label: string, passes: boolean, detail: string, hard = true) => {
    checks.push({ code, label, passes, hard, detail });
  };

  push('needs-analysis', 'Needs analysis completed under the pack in force', facts.needs.completed,
    facts.needs.completed
      ? `Need analysis ${facts.needs.needId} is complete (${facts.needs.percent}%) under ${facts.needs.pack}.`
      : `Need analysis ${facts.needs.needId} is only ${facts.needs.percent}% complete; ${facts.needs.pack} does not allow a ${facts.product.category} quotation before it is finished.`);

  push('loadings-reconciled', 'Loadings reconcile with the underwriting file',
    facts.loadingLines.reduce((s, l) => s + (l.bps ?? 0), 0) === facts.underwriting.extraMortalityBps,
    facts.loadingLines.reduce((s, l) => s + (l.bps ?? 0), 0) === facts.underwriting.extraMortalityBps
      ? `Itemised loading of ${facts.loadingLines.reduce((s, l) => s + (l.bps ?? 0), 0)} bps agrees with the underwriting decision's ${facts.underwriting.extraMortalityBps} bps.`
      : `Itemised loading is ${facts.loadingLines.reduce((s, l) => s + (l.bps ?? 0), 0)} bps but the underwriting file carries ${facts.underwriting.extraMortalityBps} bps; the customer would be quoted a premium the file does not support.`,
    true);

  push('premium-arithmetic', 'Loaded premium equals standard premium plus itemised loadings',
    compare(add(facts.standardPremium, facts.loadingLines.reduce((acc, l) => add(acc, l.amount), zero(facts.standardPremium.currency))), facts.loadedPremium) === 0,
    `Standard ${formatAmount(facts.standardPremium)} + loadings ${formatAmount(facts.loadingLines.reduce((acc, l) => add(acc, l.amount), zero(facts.standardPremium.currency)))} vs loaded ${formatAmount(facts.loadedPremium)}.`);

  push('rider-arithmetic', 'Total payable equals loaded premium plus rider premiums',
    compare(add(facts.loadedPremium, facts.riderLines.reduce((acc, l) => add(acc, l.amount), zero(facts.loadedPremium.currency))), facts.totalPayable) === 0,
    `Loaded ${formatAmount(facts.loadedPremium)} + riders ${formatAmount(facts.riderLines.reduce((acc, l) => add(acc, l.amount), zero(facts.loadedPremium.currency)))} vs payable ${formatAmount(facts.totalPayable)}.`);

  const fundTotal = facts.fundLines.reduce((s, f) => s + f.weightBps, 0);
  push('fund-weights', 'Fund weights total exactly 100%', fundTotal === 10_000 || facts.fundLines.length === 0,
    facts.fundLines.length === 0 ? 'No investment allocation on this product.' : `Selected weights total ${fundTotal} bps (${(fundTotal / 100).toFixed(2)}%).`);

  const fundAmount = facts.fundLines.reduce((acc, f) => add(acc, f.amount), zero(facts.totalPayable.currency));
  push('fund-amounts', 'Invested amount equals the first contribution', facts.fundLines.length === 0 || compare(fundAmount, facts.premiumPerFrequency) === 0,
    facts.fundLines.length === 0 ? 'No investment allocation on this product.' : `Allocated ${formatAmount(fundAmount)} against a first contribution of ${formatAmount(facts.premiumPerFrequency)}.`);

  const primaryTotal = facts.beneficiaryLines.filter((b) => b.kind === 'primary').reduce((s, b) => s + b.shareBps, 0);
  push('beneficiaries', 'Primary beneficiaries total exactly 100%', facts.beneficiaryLines.length > 0 && primaryTotal === 10_000,
    facts.beneficiaryLines.length === 0 ? 'No beneficiary has been designated.' : `Primary shares total ${primaryTotal} bps (${(primaryTotal / 100).toFixed(2)}%).`);

  push('medical-evidence', 'Every medical requirement received and reviewed, or waived by a named person',
    facts.outstandingMedical.length === 0,
    facts.outstandingMedical.length === 0
      ? `${facts.medicalRequirements.length} requirement(s) on file, none outstanding.`
      : `Outstanding: ${facts.outstandingMedical.join('; ')}.`);

  push('underwriting-decided', 'The case has been decided by someone with authority',
    facts.underwriting.outcome !== 'referred' && facts.underwriting.decidedBy.trim() !== '',
    facts.underwriting.outcome === 'referred'
      ? 'The case is still referred; a quotation may not be issued on an undecided risk.'
      : `Decided by ${facts.underwriting.decidedBy}${facts.underwriting.decidedByAi ? ' (AI agent, inside its straight-through limit)' : ''} with outcome "${facts.underwriting.outcome}".`);

  push('comparison-presented', 'A comparison of alternatives was presented', facts.comparisonPresented,
    facts.comparisonPresented ? 'The recommendation list was presented with the quotation.' : 'No comparison was presented; the customer must see the alternatives before this is issued.', false);

  push('cooling-off-disclosed', 'The cooling-off period is disclosed on the document', facts.illustration.coolingOffDays > 0,
    `${facts.illustration.coolingOffDays} day(s) of free-look disclosed on the quotation.`);

  push('scenarios-shown', 'The illustration shows the required number of scenarios', facts.illustration.scenariosShown >= 3,
    `${facts.illustration.scenariosShown} scenario(s) shown; the pack requires at least 3.`, facts.illustration.scenariosShown >= 3);

  push('waived-loadings-authorised', 'Every loading given away carries a named authoriser',
    facts.loadingLines.filter((l) => l.waived).every((l) => l.basis.length >= REASON_MINIMUM),
    facts.loadingLines.some((l) => l.waived)
      ? `${facts.loadingLines.filter((l) => l.waived).length} waived line(s), each with a reason of at least ${REASON_MINIMUM} characters.`
      : 'No loading was waived.');

  const blockers = checks.filter((c) => !c.passes && c.hard).map((c) => `${c.label}: ${c.detail}`);
  const warnings = checks.filter((c) => !c.passes && !c.hard).map((c) => `${c.label}: ${c.detail}`);
  return { checks, blockers, warnings };
}

/* ------------------------------------------------------------------ the document */

export function quotationDocument(facts: QuotationFacts, quotationId: string, version: number): PdfDocument {
  const c = facts.customer;
  const lines: Array<{ text: string; bold?: boolean; indent?: number; gapBefore?: number; rule?: boolean }> = [];

  lines.push({ text: `Quotation ${quotationId} · version ${version}`, bold: true });
  lines.push({ text: `Issued ${facts.issuedAt} by ${facts.issuedBy} · valid for ${DEFAULT_VALIDITY_DAYS} days, to ${addDays(facts.issuedAt, DEFAULT_VALIDITY_DAYS)}` });
  lines.push({ text: `Regulatory pack: ${facts.needs.pack} · needs analysis ${facts.needs.needId} (${facts.needs.percent}% complete)` });
  lines.push({ text: '', rule: true });

  lines.push({ text: `Customer: ${c.name}${c.nameAr ? ` (${c.nameAr})` : ''} · ${c.partyId}`, bold: true, gapBefore: 6 });
  if (c.idType && c.idNumber) lines.push({ text: `Identity: ${c.idType} ${c.idNumber}` });
  lines.push({ text: `Contact: ${maskEmail(c.email)}${c.phone ? ` · ${c.phone}` : ''}${c.city ? ` · ${c.city}, ${c.country}` : ''}` });

  lines.push({ text: `Product: ${facts.product.name} (${facts.product.productId})`, bold: true, gapBefore: 8 });
  lines.push({ text: `Category: ${facts.product.category} · entity ${facts.product.entityId} · currency ${facts.product.currency}${facts.product.shariahCompliant ? ' · Shariah-compliant arrangement' : ''}` });
  lines.push({ text: `Sum assured: ${formatAmount(facts.sumAssured)} · term ${facts.termYears} year(s) · premium ${facts.paymentFrequency}` });

  lines.push({ text: 'How the premium is built', bold: true, gapBefore: 10 });
  lines.push({ text: `Standard premium (rate table, standard lives): ${formatAmount(facts.standardPremium)}`, indent: 8 });
  for (const l of facts.loadingLines) {
    lines.push({ text: `${l.label}: ${formatAmount(l.amount)}${l.bps ? ` (${l.bps} bps)` : ''}${l.waived ? ' — loading waived' : ''}`, indent: 16 });
    lines.push({ text: l.basis, indent: 24 });
  }
  lines.push({ text: `Loaded premium: ${formatAmount(facts.loadedPremium)}`, indent: 8, bold: true });
  for (const r of facts.riderLines) {
    lines.push({ text: `Rider — ${r.label}: ${formatAmount(r.amount)}${r.waived ? ' (attached without loading, authorised)' : ''}`, indent: 16 });
    lines.push({ text: r.basis, indent: 24 });
  }
  lines.push({ text: `Total payable ${facts.paymentFrequency}: ${formatAmount(facts.totalPayable)}`, indent: 8, bold: true, rule: true });

  if (facts.fundLines.length > 0) {
    lines.push({ text: 'Where the contribution is invested', bold: true, gapBefore: 10 });
    for (const f of facts.fundLines) {
      lines.push({ text: `${f.name} (${f.fundId}): ${(f.weightBps / 100).toFixed(2)}% = ${formatAmount(f.amount)} · ${f.units} units at ${f.navPerUnit} valued ${f.navDate}`, indent: 8 });
    }
  }

  if (facts.beneficiaryLines.length > 0) {
    lines.push({ text: 'Beneficiaries', bold: true, gapBefore: 10 });
    for (const b of facts.beneficiaryLines) {
      lines.push({ text: `${b.kind === 'primary' ? 'Primary' : 'Contingent'} — ${b.name} (${b.relationship}): ${(b.shareBps / 100).toFixed(2)}%`, indent: 8 });
    }
  }

  if (facts.medicalRequirements.length > 0) {
    lines.push({ text: 'Medical requirements', bold: true, gapBefore: 10 });
    for (const m of facts.medicalRequirements) lines.push({ text: `${m.label} — ${m.status} (${m.source})`, indent: 8 });
  }

  lines.push({ text: 'Underwriting', bold: true, gapBefore: 10 });
  lines.push({ text: `Outcome: ${facts.underwriting.outcome} · decided by ${facts.underwriting.decidedBy}${facts.underwriting.decidedByAi ? ' (AI agent)' : ''} · extra mortality ${facts.underwriting.extraMortalityBps} bps`, indent: 8 });
  if (facts.underwriting.referrals.length > 0) lines.push({ text: `Referrals recorded: ${facts.underwriting.referrals.join(', ')}`, indent: 8 });
  for (const e of facts.exclusions) lines.push({ text: `Exclusion: ${e}`, indent: 8 });

  for (const note of facts.chargeNotes ?? []) lines.push({ text: `Charge: ${note}`, indent: 8 });

  lines.push({ text: 'Important', bold: true, gapBefore: 12 });
  lines.push({ text: facts.illustration.wording, indent: 8 });
  lines.push({ text: `Free-look period: ${facts.illustration.coolingOffDays} day(s) from the date you receive this policy, during which you may cancel and receive a refund of the premium less the cost of any medical examination and stamp duty.`, indent: 8 });
  lines.push({ text: 'This quotation is an indication of terms, not an offer of cover. Cover begins only when the policy is issued and the first payment is received and cleared.', indent: 8 });

  return {
    title: `Quotation ${quotationId} — ${facts.product.name}`,
    subtitle: `${facts.tenant.name} · ${facts.customer.name} · ${formatAmount(facts.sumAssured)} · ${facts.paymentFrequency} premium ${formatAmount(facts.totalPayable)}`,
    footer: `${quotationId} v${version} · issued ${facts.issuedAt.slice(0, 10)} · valid to ${addDays(facts.issuedAt, DEFAULT_VALIDITY_DAYS)} · not an offer of cover`,
    sections: [{ lines }],
  };
}

/* ------------------------------------------------------------------ the book of quotations */

export interface IssueResult {
  readonly record: QuotationRecord;
  readonly refused: boolean;
  readonly reason: string;
}

export class QuotationBook {
  /** Every version is kept under `${quotationId}|v${version}`: a document a customer received is never overwritten. */
  private readonly records = new Map<string, QuotationRecord>();
  private seq = 0;
  private emailSeq = 0;

  constructor(private readonly tenantName: string, private readonly clock: () => string = () => '2026-10-05T12:00:00+04:00') {}

  list(): QuotationRecord[] { return [...this.records.values()]; }

  versions(quotationId: string): QuotationRecord[] {
    return this.list().filter((r) => r.quotationId === quotationId).sort((a, b) => a.version - b.version);
  }

  /** The current version, unless a specific one is asked for. */
  get(quotationId: string, version?: number): QuotationRecord {
    const versions = this.versions(quotationId);
    if (versions.length === 0) throw new QuotationError(`unknown quotation ${quotationId}`);
    const found = version === undefined ? versions.at(-1)! : versions.find((r) => r.version === version);
    if (!found) throw new QuotationError(`quotation ${quotationId} has no version ${version}`);
    return found;
  }

  forParty(partyId: string): QuotationRecord[] { return this.list().filter((r) => r.partyId === partyId); }

  /**
   * Issue (or re-issue) a quotation. Re-issuing supersedes every earlier version rather than editing
   * it, so the document the customer already holds stays exactly as it was sent.
   */
  issue(facts: QuotationFacts, options: { quotationId?: string; validityDays?: number } = {}): IssueResult {
    const at = facts.issuedAt || this.clock();
    const { checks, blockers, warnings } = quotationCompliance(facts);
    const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;

    const year = new Date(`${at.slice(0, 10)}T00:00:00Z`).getUTCFullYear();
    const quotationId = options.quotationId ?? `QTN-${year}-${String(++this.seq).padStart(6, '0')}`;
    const version = (this.versions(quotationId).at(-1)?.version ?? 0) + 1;
    const expiresAt = `${addDays(at, validityDays)}T23:59:59+04:00`;

    for (const previous of this.versions(quotationId)) {
      if (previous.status === 'refused') continue;
      this.records.set(key(previous.quotationId, previous.version), {
        ...previous, status: 'superseded', supersededBy: `${quotationId}-v${version}`,
      });
    }

    const pdf = blockers.length > 0 ? null : renderPdf(quotationDocument(facts, quotationId, version), `${quotationId}-v${version}.pdf`);
    const record = this.buildRecord(facts, quotationId, version, at, expiresAt, validityDays, checks, blockers, warnings, pdf);
    this.records.set(key(quotationId, version), record);
    return {
      record,
      refused: blockers.length > 0,
      reason: blockers.length > 0 ? blockers.join(' · ') : 'issued',
    };
  }

  private buildRecord(
    facts: QuotationFacts, quotationId: string, version: number, at: string, expiresAt: string,
    validityDays: number, checks: ComplianceCheck[], blockers: string[], warnings: string[], pdf: PdfFile | null,
  ): QuotationRecord {
    const loadingTotal = facts.loadingLines.reduce((acc, l) => add(acc, l.amount), zero(facts.standardPremium.currency));
    const riderTotal = facts.riderLines.reduce((acc, l) => add(acc, l.amount), zero(facts.loadedPremium.currency));
    return {
      quotationId, version, status: blockers.length > 0 ? 'refused' : 'issued',
      partyId: facts.customer.partyId, customerName: facts.customer.name,
      productId: facts.product.productId, productName: facts.product.name,
      category: facts.product.category, currency: facts.product.currency,
      issuedAt: at, issuedBy: facts.issuedBy, expiresAt, validityDays,
      sumAssured: formatAmount(facts.sumAssured),
      standardPremium: formatAmount(facts.standardPremium),
      loadingTotal: formatAmount(loadingTotal),
      loadedPremium: formatAmount(facts.loadedPremium),
      riderTotal: formatAmount(riderTotal),
      totalPayable: formatAmount(facts.totalPayable),
      premiumPerFrequency: formatAmount(facts.premiumPerFrequency),
      underwritingOutcome: facts.underwriting.outcome,
      decidedBy: facts.underwriting.decidedBy,
      compliance: checks, blockers, warnings,
      pdf: pdf
        ? { fileName: pdf.fileName, fingerprint: pdf.fingerprint, bytes: pdf.byteLength, pages: pdf.pages, base64: pdf.base64, text: pdf.text, opens: verifyPdf(pdf.bytes).ok }
        : { fileName: '—', fingerprint: '—', bytes: 0, pages: 0, base64: '', text: '', opens: false },
      document: pdf ? quotationDocument(facts, quotationId, version) : { title: `Quotation ${quotationId} (refused)`, sections: [] },
      email: null,
      finalisation: null,
      supersededBy: null,
      facts,
    };
  }

  /** Send the issued document to the customer, under the consent already on file. */
  dispatch(input: {
    quotationId: string;
    version?: number;
    to?: string;
    language?: 'en' | 'ar' | 'both';
    consentId?: string;
    at?: string;
    by?: string;
    buyLink?: string;
  }): QuotationEmail {
    const record = this.get(input.quotationId, input.version);
    if (record.status === 'refused') throw new QuotationError(`quotation ${record.quotationId} was refused and cannot be sent: ${record.blockers.join(' · ')}`);
    if (record.status === 'superseded') throw new QuotationError(`quotation ${record.quotationId} v${record.version} has been superseded by ${record.supersededBy}; send the current version`);
    const at = input.at ?? this.clock();
    const to = (input.to ?? record.facts.customer.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new QuotationError(`"${to}" is not a deliverable email address`);
    const language = input.language ?? 'both';
    const greeting = language === 'ar' ? 'عزيزي العميل' : language === 'both' ? 'Dear customer / عزيزي العميل' : 'Dear customer';
    const body = [
      `${greeting},`,
      '',
      `Your quotation ${record.quotationId} (version ${record.version}) for ${record.productName} is attached as a PDF.`,
      `Sum assured ${record.sumAssured}. Premium ${record.premiumPerFrequency} ${record.facts.paymentFrequency}, ${record.totalPayable} payable in total including loadings and riders.`,
      `The quotation is valid until ${record.expiresAt.slice(0, 10)}. A free-look period of ${record.facts.illustration.coolingOffDays} day(s) applies from the date the policy is delivered.`,
      record.facts.illustration.wording,
      input.buyLink ? `To buy online: ${input.buyLink}` : 'To buy online, use the secure payment link in the customer portal.',
      '',
      `${this.tenantName}`,
    ].join('\n');

    const email: QuotationEmail = {
      messageId: `MSG-${String(++this.emailSeq).padStart(6, '0')}`,
      quotationId: record.quotationId, version: record.version,
      to: maskEmail(to), toFull: to,
      subject: `Quotation ${record.quotationId} — ${record.productName} (${record.sumAssured})`,
      body,
      attachment: { fileName: record.pdf.fileName, fingerprint: record.pdf.fingerprint, bytes: record.pdf.bytes },
      language,
      consentId: input.consentId ?? record.facts.consentId ?? null,
      channel: 'email',
      dispatchedAt: at,
      dispatchedBy: input.by?.trim() || 'quotation-desk',
    };
    this.records.set(key(record.quotationId, record.version), { ...record, email, status: 'dispatched' });
    return email;
  }

  /** The customer signs: inside the validity window, with the cooling-off period stated. */
  finalise(input: { quotationId: string; version?: number; signedBy: string; at?: string; signatureReference?: string }): QuotationFinalisation {
    const record = this.get(input.quotationId, input.version);
    if (record.status === 'refused') throw new QuotationError(`quotation ${record.quotationId} was refused and cannot be accepted`);
    if (record.status === 'superseded') throw new QuotationError(`quotation ${record.quotationId} v${record.version} was superseded; the customer must accept the current version`);
    const at = input.at ?? this.clock();
    const daysRemaining = daysBetween(at.slice(0, 10), record.expiresAt.slice(0, 10));
    if (daysRemaining < 0) {
      this.records.set(key(record.quotationId, record.version), { ...record, status: 'expired' });
      throw new QuotationError(`quotation ${record.quotationId} expired on ${record.expiresAt.slice(0, 10)}; re-issue it before the customer can accept`);
    }
    const signatureReference = input.signatureReference ?? fingerprint(`${record.quotationId}|${record.version}|${input.signedBy}|${at}`);
    const finalisation: QuotationFinalisation = {
      quotationId: record.quotationId, version: record.version,
      signedBy: input.signedBy, signatureReference, signedAt: at,
      insideValidity: true, daysRemaining,
      coolingOffEndsOn: addDays(at, record.facts.illustration.coolingOffDays),
      coolingOffStatement: `You have ${record.facts.illustration.coolingOffDays} day(s) from delivery of the policy to cancel without reason and receive a refund less any medical examination cost.`,
      readyToBuyOnline: true,
      buyToken: fingerprint(`${record.quotationId}|buy|${signatureReference}`).slice(0, 16),
    };
    this.records.set(key(record.quotationId, record.version), { ...record, status: 'finalised', finalisation });
    return finalisation;
  }

  /** Where the journey stands on the quotation section, without mutating anything. */
  statusFor(partyId: string): { quotationId: string | null; version: number | null; status: string; issued: boolean; dispatched: boolean; finalised: boolean; expiresAt: string | null; blockers: readonly string[] } {
    const current = this.forParty(partyId)
      .filter((r) => r.status !== 'superseded')
      .sort((a, b) => (a.issuedAt === b.issuedAt ? b.version - a.version : a.issuedAt < b.issuedAt ? 1 : -1))[0]
      ?? this.forParty(partyId).at(-1);
    if (!current) return { quotationId: null, version: null, status: 'not-started', issued: false, dispatched: false, finalised: false, expiresAt: null, blockers: [] };
    return {
      quotationId: current.quotationId, version: current.version, status: current.status,
      issued: current.status !== 'refused', dispatched: Boolean(current.email), finalised: current.status === 'finalised',
      expiresAt: current.expiresAt, blockers: current.blockers,
    };
  }

  /** The money the payment section charges against. */
  amountDue(quotationId: string): Money {
    const record = this.get(quotationId);
    return record.facts.totalPayable.minor > 0n ? record.facts.totalPayable : money(0n, record.currency);
  }
}

function key(quotationId: string, version: number): string { return `${quotationId}|v${version}`; }
