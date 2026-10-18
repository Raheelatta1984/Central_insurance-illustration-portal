/**
 * Medical requirements, occupational and medical loadings, and riders.
 *
 * The underwriting engine already decides a case (`underwriting.ts`): this module makes the same
 * arithmetic *legible*. It answers three questions a quotation has to be able to answer before it
 * is sent to a customer:
 *
 *  1. what medical evidence does this risk actually require, and what is still outstanding;
 *  2. what is the loading made of — occupation, conditions, build, pursuits, family history — with
 *     a basis-point and money figure on each component, reconciled back to the engine's own total;
 *  3. what each rider costs, including the riders added *without* loading, which are the ones an
 *     auditor asks about first because somebody had to authorise giving them away.
 *
 * A waiver is never silent: dropping a loading or a medical requirement records who dropped it,
 * when, and why.
 */
import { Money, add, applyBps, formatAmount, money, zero } from './money.js';
import {
  CONDITION_RULES, FAMILY_HISTORY_RULES, OCCUPATION_DEBITS, PURSUIT_RULES,
  OccupationClass, ProductRules, UnderwritingDecision,
} from './underwriting.js';

export class LoadingError extends Error {}

/* ------------------------------------------------------------------ occupations */

export const OCCUPATION_LABELS: Record<OccupationClass, string> = {
  1: 'Class 1 — professional, clerical or supervisory (office based)',
  2: 'Class 2 — light manual, field sales or site supervision',
  3: 'Class 3 — skilled trades, driving, machine operation',
  4: 'Class 4 — heavy manual work, work at height, armed or security duties',
  5: 'Class 5 — underground, offshore, aviation crew or explosives handling',
};

export interface OccupationalLoading {
  readonly occupationClass: OccupationClass;
  readonly label: string;
  readonly insideStandardRange: boolean;
  readonly extraMortalityBps: number;
  readonly amount: Money;
  readonly reason: string;
}

/** The occupational debit, with the reason it applies (or does not) written out. */
export function occupationalLoading(
  occupationClass: OccupationClass,
  standardOccupations: readonly OccupationClass[],
  standardPremium: Money,
): OccupationalLoading {
  const inside = standardOccupations.includes(occupationClass);
  const bps = inside ? 0 : OCCUPATION_DEBITS[occupationClass];
  return {
    occupationClass,
    label: OCCUPATION_LABELS[occupationClass],
    insideStandardRange: inside,
    extraMortalityBps: bps,
    amount: applyBps(standardPremium, bps),
    reason: inside
      ? `${OCCUPATION_LABELS[occupationClass]} is inside the standard range for this product (${standardOccupations.join(', ')}): no occupational debit.`
      : `${OCCUPATION_LABELS[occupationClass]} is outside the standard range for this product (${standardOccupations.join(', ')}): a debit of ${bps} basis points applies and the case must be read by a human underwriter.`,
  };
}

/* ------------------------------------------------------------------ medical requirements */

export type RequirementStatus = 'required' | 'ordered' | 'received' | 'reviewed' | 'waived';

export interface MedicalRequirement {
  readonly code: string;
  readonly label: string;
  readonly source: 'evidence-band' | 'condition' | 'pursuit' | 'occupation' | 'financial' | 'rider';
  readonly reason: string;
  readonly status: RequirementStatus;
  readonly receivedAt?: string;
  readonly reviewedBy?: string;
  readonly waiver?: { readonly by: string; readonly at: string; readonly reason: string };
}

export interface MedicalRequirementSet {
  readonly requirements: readonly MedicalRequirement[];
  readonly outstanding: readonly MedicalRequirement[];
  readonly complete: boolean;
  readonly percent: number;
  readonly blockers: readonly string[];
}

const SETTLED: ReadonlySet<RequirementStatus> = new Set(['reviewed', 'waived']);

export interface RequirementResult {
  readonly code: string;                 // the requirement label, as issued
  readonly status: 'ordered' | 'received' | 'reviewed' | 'waived';
  readonly at?: string;
  readonly by?: string;
  readonly waiverReason?: string;
}

/**
 * What this risk has to prove before it can be accepted. Requirements come from four places — the
 * product's age/sum-assured evidence bands, the conditions declared, the pursuits declared, and the
 * riders added — and each one keeps the sentence that explains why it is on the list.
 */
export function medicalRequirements(input: {
  age: number;
  sumAssured: Money;
  rules: ProductRules;
  conditions?: readonly string[];
  pursuits?: readonly string[];
  occupationClass?: OccupationClass;
  riders?: readonly string[];
  results?: readonly RequirementResult[];
}): MedicalRequirementSet {
  const results = new Map<string, RequirementResult>();
  for (const r of input.results ?? []) results.set(r.code, r);
  const found: MedicalRequirement[] = [];
  const push = (label: string, source: MedicalRequirement['source'], reason: string) => {
    if (found.some((f) => f.label === label)) return;
    const res = results.get(label);
    const status: RequirementStatus = res?.status ?? 'required';
    if (status === 'waived' && !(res?.by && res?.waiverReason)) {
      throw new LoadingError(`requirement "${label}" cannot be waived without a named person and a reason`);
    }
    found.push({
      code: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label, source, reason, status,
      ...(res?.at ? { receivedAt: res.at } : {}),
      ...(res?.by ? { reviewedBy: res.by } : {}),
      ...(status === 'waived' && res ? { waiver: { by: res.by ?? 'unnamed', at: res.at ?? '', reason: res.waiverReason ?? '' } } : {}),
    });
  };

  for (const band of input.rules.evidenceBands) {
    if (input.age >= band.fromAge && input.sumAssured.minor >= band.fromSumAssuredMinor) {
      for (const req of band.requirements) {
        push(req, 'evidence-band', `Age ${input.age} with a sum assured of ${formatAmount(input.sumAssured)} falls in the product's evidence band from age ${band.fromAge} / ${formatAmount(money(band.fromSumAssuredMinor, input.sumAssured.currency))}.`);
      }
    }
  }
  for (const code of input.conditions ?? []) {
    const rule = CONDITION_RULES.find((c) => c.code === code);
    if (!rule) {
      push(`Underwriter review of undeclared-in-manual condition "${code}"`, 'condition', `"${code}" is not in the medical manual, so a human underwriter must read it and record what was relied on.`);
      continue;
    }
    for (const req of rule.evidence ?? []) {
      push(req, 'condition', `${rule.label} carries ${rule.extraMortalityBps} basis points of extra mortality and must be evidenced.`);
    }
  }
  for (const code of input.pursuits ?? []) {
    const rule = PURSUIT_RULES.find((p) => p.code === code);
    if (rule?.exclusion) {
      push(`Signed acknowledgement of the exclusion "${rule.exclusion}"`, 'pursuit', `Pursuit "${code}" is accepted only with this exclusion, and the customer has to acknowledge it in writing.`);
    }
  }
  if (input.occupationClass !== undefined && !input.rules.standardOccupations.includes(input.occupationClass)) {
    push('Occupation and duties declaration', 'occupation', `${OCCUPATION_LABELS[input.occupationClass]} is outside the standard range, so the actual duties must be declared before the debit is applied.`);
  }
  for (const code of input.riders ?? []) {
    const rider = RIDER_CATALOGUE.find((r) => r.code === code);
    for (const req of rider?.requiresEvidence ?? []) {
      push(req, 'rider', `Rider "${rider?.name ?? code}" cannot be attached without it.`);
    }
  }

  const outstanding = found.filter((f) => !SETTLED.has(f.status));
  const total = found.length;
  const percent = total === 0 ? 100 : Math.round(((total - outstanding.length) / total) * 100);
  const blockers = outstanding.map((o) => `${o.label} — ${o.status === 'ordered' ? 'ordered, not yet received' : o.status === 'received' ? 'received, not yet reviewed' : 'not yet ordered'}`);

  return { requirements: found, outstanding, complete: outstanding.length === 0, percent, blockers };
}

/* ------------------------------------------------------------------ riders */

export interface RiderDef {
  readonly code: string;
  readonly name: string;
  /** Extra mortality in basis points on the base premium. Zero means the rider is priced inside the base rate. */
  readonly loadingBps: number;
  readonly shariahEligible: boolean;
  readonly requiresEvidence: readonly string[];
  readonly objectives: readonly string[];
  readonly minAge?: number;
  readonly maxAge?: number;
  readonly note: string;
}

export const RIDER_CATALOGUE: readonly RiderDef[] = [
  { code: 'critical-illness', name: 'Critical illness cover', loadingBps: 45, shariahEligible: true, requiresEvidence: ['Critical illness questionnaire'], objectives: ['family-protection', 'income-replacement', 'health-cover'], note: 'Pays a lump sum on first diagnosis of a listed condition; loading follows the base mortality.' },
  { code: 'accidental-death', name: 'Accidental death benefit', loadingBps: 12, shariahEligible: true, requiresEvidence: [], objectives: ['family-protection', 'debt-cover'], note: 'Additional sum assured where death is accidental.' },
  { code: 'waiver-of-premium', name: 'Waiver of premium on disability', loadingBps: 8, shariahEligible: true, requiresEvidence: ['Occupation and duties declaration'], objectives: ['income-replacement', 'family-protection'], note: 'Premiums waived after the deferred period if the life assured is totally disabled.' },
  { code: 'income-protection', name: 'Income protection', loadingBps: 25, shariahEligible: false, requiresEvidence: ['Occupation and duties declaration', 'Proof of income for the last 12 months'], objectives: ['income-replacement'], note: 'Monthly benefit replacing a proportion of earned income; occupation class drives the rate.' },
  { code: 'inpatient-topup', name: 'Inpatient medical top-up', loadingBps: 0, shariahEligible: true, requiresEvidence: ['Medical questionnaire'], objectives: ['health-cover'], note: 'Priced inside the medical rate table, so it carries no extra mortality loading.' },
  { code: 'payor-benefit', name: 'Payor benefit (juvenile plans)', loadingBps: 6, shariahEligible: true, requiresEvidence: [], objectives: ['education-funding', 'family-protection'], minAge: 0, maxAge: 17, note: 'Waives the premium on the juvenile plan if the paying adult dies or is disabled.' },
  { code: 'education-savings', name: 'Education savings rider', loadingBps: 0, shariahEligible: true, requiresEvidence: [], objectives: ['education-funding', 'retirement-savings'], note: 'Directs part of the contribution to an education fund; no mortality loading.' },
  { code: 'final-expense', name: 'Final expense benefit', loadingBps: 15, shariahEligible: true, requiresEvidence: [], objectives: ['family-protection'], note: 'A fixed benefit for funeral and immediate costs, payable on production of the death certificate.' },
];

export interface RiderWaiver { readonly by: string; readonly at: string; readonly reason: string }

export interface RiderSelection {
  readonly code: string;
  /** Set when the rider is attached without its loading — always with a named authoriser. */
  readonly loadingWaived?: RiderWaiver;
}

export interface RiderLine {
  readonly code: string;
  readonly name: string;
  readonly loadingBps: number;
  readonly appliedBps: number;
  readonly amount: Money;
  readonly waived: boolean;
  readonly waiver?: RiderWaiver;
  readonly shariahEligible: boolean;
  readonly requiresEvidence: readonly string[];
  readonly note: string;
}

export interface RiderPricing {
  readonly lines: readonly RiderLine[];
  readonly totalExtraBps: number;
  readonly totalRiderPremium: Money;
  readonly waivedLoadingBps: number;
  readonly waivedLoadingValue: Money;
  readonly blockers: readonly string[];
  readonly evidenceRequired: readonly string[];
}

/**
 * Price the selected riders against a base premium. A rider attached without loading is recorded
 * with the value given away, because "free" is an underwriting decision and not a marketing one.
 */
export function priceRiders(input: {
  basePremium: Money;
  selections: readonly RiderSelection[];
  age?: number;
  shariahProduct?: boolean;
}): RiderPricing {
  const lines: RiderLine[] = [];
  const blockers: string[] = [];
  const evidence: string[] = [];
  let waivedBps = 0;

  for (const sel of input.selections) {
    const def = RIDER_CATALOGUE.find((r) => r.code === sel.code);
    if (!def) throw new LoadingError(`unknown rider "${sel.code}" — add it to the rider catalogue before selling it`);
    if (input.shariahProduct && !def.shariahEligible) {
      blockers.push(`${def.name} is not eligible for a Shariah-compliant arrangement`);
    }
    if (input.age !== undefined && def.minAge !== undefined && input.age < def.minAge) {
      blockers.push(`${def.name} requires a life assured aged at least ${def.minAge}`);
    }
    if (input.age !== undefined && def.maxAge !== undefined && input.age > def.maxAge) {
      blockers.push(`${def.name} is only available up to age ${def.maxAge}`);
    }
    if (sel.loadingWaived && (!sel.loadingWaived.by.trim() || !sel.loadingWaived.reason.trim())) {
      throw new LoadingError(`${def.name} cannot be attached without loading unless a named person authorises it with a reason`);
    }
    const waived = Boolean(sel.loadingWaived) && def.loadingBps > 0;
    const appliedBps = waived ? 0 : def.loadingBps;
    if (waived) waivedBps += def.loadingBps;
    evidence.push(...def.requiresEvidence);
    lines.push({
      code: def.code, name: def.name, loadingBps: def.loadingBps, appliedBps,
      amount: applyBps(input.basePremium, appliedBps),
      waived, ...(sel.loadingWaived ? { waiver: sel.loadingWaived } : {}),
      shariahEligible: def.shariahEligible, requiresEvidence: def.requiresEvidence, note: def.note,
    });
  }

  const totalExtraBps = lines.reduce((s, l) => s + l.appliedBps, 0);
  return {
    lines,
    totalExtraBps,
    totalRiderPremium: applyBps(input.basePremium, totalExtraBps),
    waivedLoadingBps: waivedBps,
    waivedLoadingValue: applyBps(input.basePremium, waivedBps),
    blockers,
    evidenceRequired: [...new Set(evidence)],
  };
}

/* ------------------------------------------------------------------ the loading breakdown */

export type LoadingSource = 'occupation' | 'medical' | 'build' | 'smoker' | 'pursuit' | 'family' | 'rider';

export interface LoadingComponent {
  readonly code: string;
  readonly label: string;
  readonly source: LoadingSource;
  readonly extraMortalityBps: number;
  readonly amount: Money;
  readonly reason: string;
  readonly referToHuman: boolean;
  readonly exclusion?: string;
}

export interface LoadingBreakdown {
  readonly currency: string;
  readonly standardPremium: Money;
  readonly components: readonly LoadingComponent[];
  readonly totalExtraBps: number;
  readonly loadedPremium: Money;
  readonly exclusions: readonly string[];
  readonly evidenceRequired: readonly string[];
  readonly riders: RiderPricing | null;
  readonly totalPayable: Money;
  readonly reconciliation: {
    readonly engineExtraBps: number | null;
    readonly riskComponentsBps: number;
    readonly agrees: boolean | null;
    readonly detail: string;
  };
}

/**
 * Itemise the loading. Where an underwriting decision exists, the risk components (everything
 * except riders) are reconciled against the engine's own `extraMortalityBps`: if the two disagree
 * the quotation would show the customer a premium the underwriting file does not support, and that
 * is a stop, not a rounding note.
 */
export function loadingBreakdown(input: {
  standardPremium: Money;
  rules: ProductRules;
  age: number;
  smoker?: boolean;
  bmi?: number;
  occupationClass: OccupationClass;
  conditions?: readonly string[];
  pursuits?: readonly string[];
  familyHistory?: readonly string[];
  riders?: readonly RiderSelection[];
  shariahProduct?: boolean;
  decision?: UnderwritingDecision;
}): LoadingBreakdown {
  const base = input.standardPremium;
  const components: LoadingComponent[] = [];
  const exclusions: string[] = [];
  const evidence: string[] = [];

  const occupation = occupationalLoading(input.occupationClass, input.rules.standardOccupations, base);
  if (occupation.extraMortalityBps > 0) {
    components.push({
      code: `occupation-class-${input.occupationClass}`, label: 'Occupational loading', source: 'occupation',
      extraMortalityBps: occupation.extraMortalityBps, amount: occupation.amount,
      reason: occupation.reason, referToHuman: true,
    });
    evidence.push('Occupation and duties declaration');
  }

  if (input.smoker) {
    components.push({
      code: 'smoker', label: 'Smoker loading', source: 'smoker', extraMortalityBps: 100,
      amount: applyBps(base, 100), reason: 'Current smoker: 100 basis points of extra mortality, matching the underwriting manual.', referToHuman: false,
    });
  }

  if (input.bmi !== undefined) {
    if (input.bmi > input.rules.maxBmi) {
      components.push({
        code: 'build-referral', label: 'Build loading (above maximum BMI)', source: 'build', extraMortalityBps: 50,
        amount: applyBps(base, 50), reason: `BMI ${input.bmi} is above the standard maximum of ${input.rules.maxBmi}: 50 basis points and a human review.`, referToHuman: true,
      });
    } else if (input.bmi > input.rules.maxBmi - 5) {
      components.push({
        code: 'build-debit', label: 'Build debit (near maximum BMI)', source: 'build', extraMortalityBps: 25,
        amount: applyBps(base, 25), reason: `BMI ${input.bmi} is within 5 points of the standard maximum of ${input.rules.maxBmi}: a 25 basis-point build debit applies.`, referToHuman: false,
      });
    }
  }

  for (const code of input.conditions ?? []) {
    const rule = CONDITION_RULES.find((c) => c.code === code);
    if (!rule) {
      components.push({
        code: `condition-unknown-${code}`, label: `Undeclared-in-manual condition "${code}"`, source: 'medical',
        extraMortalityBps: 0, amount: zero(base.currency),
        reason: `"${code}" is not in the medical manual: no loading is assumed and a human underwriter must read the case.`, referToHuman: true,
      });
      continue;
    }
    components.push({
      code: `condition-${rule.code}`, label: rule.label, source: 'medical',
      extraMortalityBps: rule.extraMortalityBps, amount: applyBps(base, rule.extraMortalityBps),
      reason: `${rule.label}: ${rule.extraMortalityBps} basis points of extra mortality${rule.evidence?.length ? `; evidence required (${rule.evidence.join(', ')})` : ''}.`,
      referToHuman: rule.referToHuman === true,
      ...(rule.exclusion ? { exclusion: rule.exclusion } : {}),
    });
    if (rule.exclusion) exclusions.push(rule.exclusion);
    evidence.push(...(rule.evidence ?? []));
  }

  for (const code of input.pursuits ?? []) {
    const rule = PURSUIT_RULES.find((p) => p.code === code);
    if (!rule) {
      components.push({
        code: `pursuit-unknown-${code}`, label: `Pursuit "${code}" not in the manual`, source: 'pursuit',
        extraMortalityBps: 0, amount: zero(base.currency),
        reason: `"${code}" is not in the pursuits table: treated as no loading and referred for review.`, referToHuman: true,
      });
      continue;
    }
    components.push({
      code: `pursuit-${rule.code}`, label: `Pursuit: ${code}`, source: 'pursuit',
      extraMortalityBps: rule.extraMortalityBps, amount: applyBps(base, rule.extraMortalityBps),
      reason: `${code}: ${rule.extraMortalityBps} basis points${rule.exclusion ? `, with the exclusion "${rule.exclusion}"` : ''}.`,
      referToHuman: false, ...(rule.exclusion ? { exclusion: rule.exclusion } : {}),
    });
    if (rule.exclusion) exclusions.push(rule.exclusion);
  }

  for (const code of input.familyHistory ?? []) {
    const rule = FAMILY_HISTORY_RULES.find((f) => f.code === code);
    if (!rule) continue;
    components.push({
      code: `family-${rule.code}`, label: `Family history: ${code}`, source: 'family',
      extraMortalityBps: rule.extraMortalityBps, amount: applyBps(base, rule.extraMortalityBps),
      reason: `${code}: ${rule.extraMortalityBps} basis points of extra mortality from family history.`, referToHuman: false,
    });
  }

  const totalExtraBps = components.reduce((s, c) => s + c.extraMortalityBps, 0);
  const loadedPremium = add(base, applyBps(base, totalExtraBps));

  const riders = input.riders && input.riders.length > 0
    ? priceRiders({ basePremium: loadedPremium, selections: input.riders, ...(input.age !== undefined ? { age: input.age } : {}), shariahProduct: input.shariahProduct ?? false })
    : null;
  if (riders) {
    for (const line of riders.lines) {
      if (line.appliedBps === 0 && !line.waived) continue;
      components.push({
        code: `rider-${line.code}`, label: `Rider: ${line.name}`, source: 'rider',
        extraMortalityBps: line.appliedBps, amount: line.amount,
        reason: line.waived
          ? `Attached without loading on the authority of ${line.waiver?.by ?? 'unnamed'} (${line.waiver?.reason ?? 'no reason recorded'}); the loading given away is ${formatAmount(applyBps(loadedPremium, line.loadingBps))}.`
          : `${line.note} Loading of ${line.appliedBps} basis points on the loaded base premium.`,
        referToHuman: line.waived,
      });
    }
    evidence.push(...riders.evidenceRequired);
  }

  const totalPayable = riders ? add(loadedPremium, riders.totalRiderPremium) : loadedPremium;

  const engineBps = input.decision ? input.decision.extraMortalityBps : null;
  const agrees = engineBps === null ? null : engineBps === totalExtraBps;
  return {
    currency: base.currency,
    standardPremium: base,
    components,
    totalExtraBps,
    loadedPremium,
    exclusions: [...new Set(exclusions)],
    evidenceRequired: [...new Set(evidence)],
    riders,
    totalPayable,
    reconciliation: {
      engineExtraBps: engineBps,
      riskComponentsBps: totalExtraBps,
      agrees,
      detail: engineBps === null
        ? 'No underwriting decision on file yet: the breakdown is computed from the manual and will be reconciled when the case is assessed.'
        : agrees
          ? `The ${totalExtraBps} basis points itemised here agree with the underwriting engine's ${engineBps} basis points for this case.`
          : `MISMATCH: this breakdown itemises ${totalExtraBps} basis points but the underwriting engine computed ${engineBps}. The quotation must not be issued until the two agree.`,
    },
  };
}

export function labelBreakdown(b: LoadingBreakdown): string[] {
  const lines = [
    `Standard premium ${formatAmount(b.standardPremium)}`,
    ...b.components.map((c) => `  + ${c.label}: ${c.extraMortalityBps} bps = ${formatAmount(c.amount)}`),
    `Loaded premium ${formatAmount(b.loadedPremium)}`,
  ];
  if (b.riders) lines.push(`Riders ${formatAmount(b.riders.totalRiderPremium)} (${b.riders.lines.length} attached${b.riders.waivedLoadingBps > 0 ? `, ${b.riders.waivedLoadingBps} bps of loading waived worth ${formatAmount(b.riders.waivedLoadingValue)}` : ''})`);
  lines.push(`Total payable ${formatAmount(b.totalPayable)}`);
  return lines;
}

export { money, formatAmount };
