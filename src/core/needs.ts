/**
 * Needs analysis and product recommendation.
 *
 * The regulator's rule is blunt: in the UAE and in Malaysia no life, medical, unit-linked or
 * travel cover may be sold before a documented needs analysis exists, and the document has to be
 * retrievable years later with the pack version that required it. So the questionnaire is data
 * per country pack, the evaluation is deterministic, and every number it produces carries the
 * assumption that produced it — because an assumption nobody can find is an assumption nobody can
 * challenge.
 *
 * Nothing here is actuarial advice. The replacement-years and affordability tables below are
 * tenant-editable configuration; they are written down so a reviewer can see exactly what the
 * illustration rested on.
 */
import { Money, add, applyBps, compare, formatAmount, money, multiply, sub, zero } from './money.js';
import { PACKS, PreSaleResult, RegulatoryPack, comparisonMatrix, preSaleCheck } from './regulatory.js';

export type QuestionKind = 'choice' | 'amount' | 'number' | 'boolean';

export interface NeedQuestion {
  readonly id: string;
  readonly label: string;
  readonly kind: QuestionKind;
  readonly mandatory: boolean;
  readonly options?: readonly string[];
  readonly currency?: string;
  readonly why: string;          // the regulatory or underwriting reason this question is asked
}

export interface NeedsQuestionnaire {
  readonly country: string;
  readonly pack: string;
  readonly version: string;
  readonly questions: readonly NeedQuestion[];
  readonly attestation: string;  // the declaration the customer agrees to before the analysis counts
}

/** One question, one answer. Values stay strings/numbers so a form post needs no codec. */
export interface NeedsAnswer { readonly questionId: string; readonly value: string | number | boolean }

/* ------------------------------------------------------------------ assumptions (data, not prose) */

/**
 * How many years of income a dependant structure is assumed to need replacing. Capped by the
 * years actually left to retirement, because a recommendation to cover income after retirement
 * is a different product.
 */
export const REPLACEMENT_YEARS_BY_DEPENDANTS: ReadonlyArray<{ dependants: number; years: number }> = [
  { dependants: 0, years: 3 },
  { dependants: 1, years: 6 },
  { dependants: 2, years: 9 },
  { dependants: 3, years: 12 },
];
export const MAX_REPLACEMENT_YEARS = 15;

/** Debt and education goals are added on top of income replacement, in full. */
export const AFFORDABILITY_CAP_BPS = 1500;   // 15% of gross income is the most a premium should take
export const DEFAULT_RETIREMENT_AGE = 60;

export class NeedsError extends Error {}

export function packFor(country: string): RegulatoryPack {
  const pack = PACKS[country?.trim().toUpperCase()];
  if (!pack) throw new NeedsError(`no regulatory pack for country "${country}" — add one before selling there`);
  return pack;
}

/* ------------------------------------------------------------------ the questionnaires themselves */

const CORE_QUESTIONS: readonly NeedQuestion[] = [
  { id: 'residence-country', label: 'Country of residence', kind: 'choice', mandatory: true, options: ['AE', 'MY', 'SA', 'OTHER'], why: 'Determines which regulatory pack governs the sale and whether an exception approval is needed.' },
  { id: 'dependants', label: 'How many people depend on your income?', kind: 'number', mandatory: true, why: 'Drives how many years of income the cover has to replace.' },
  { id: 'annual-income', label: 'Gross annual income', kind: 'amount', mandatory: true, currency: 'AED', why: 'Sets the affordability ceiling and the financial-underwriting cap on sum assured.' },
  { id: 'existing-cover', label: 'Sum assured already in force elsewhere', kind: 'amount', mandatory: true, currency: 'AED', why: 'Existing cover is deducted from the need — recommending it again is mis-selling.' },
  { id: 'outstanding-debt', label: 'Outstanding mortgage or other debt to cover', kind: 'amount', mandatory: true, currency: 'AED', why: 'Debt cover is a separate component of the protection need.' },
  { id: 'premium-budget', label: 'What can you afford to pay each year?', kind: 'amount', mandatory: true, currency: 'AED', why: 'A recommendation the customer cannot pay is not a recommendation.' },
  { id: 'objective', label: 'Main objective for this cover', kind: 'choice', mandatory: true, options: ['family-protection', 'income-replacement', 'debt-cover', 'education-funding', 'retirement-savings', 'health-cover', 'business-continuity'], why: 'The objective, not the product, is what the recommendation has to answer.' },
  { id: 'risk-appetite', label: 'Investment risk appetite', kind: 'choice', mandatory: true, options: ['cautious', 'balanced', 'growth'], why: 'Decides whether an investment-linked product may be recommended at all.' },
  { id: 'shariah-preferred', label: 'Shariah-compliant arrangement preferred', kind: 'boolean', mandatory: true, why: 'A takaful window may only be recommended to a customer who has asked for it or been offered it explicitly.' },
  { id: 'age', label: 'Your age', kind: 'number', mandatory: true, why: 'Entry-age limits, and the term the cover can actually run to.' },
  { id: 'smoker', label: 'Do you smoke?', kind: 'boolean', mandatory: true, why: 'Feeds the medical questionnaire and the loading that follows it.' },
  { id: 'medical-conditions', label: 'Any diagnosed medical conditions?', kind: 'boolean', mandatory: true, why: 'A "yes" opens the medical requirements stage; it must never be skipped to speed up a sale.' },
  { id: 'occupation-class', label: 'Occupation class', kind: 'choice', mandatory: true, options: ['1', '2', '3', '4', '5'], why: 'Occupational loading is applied before the quotation is generated.' },
];

const AE_ATTESTATION = 'I confirm the answers above are complete and true, and that this needs analysis was carried out before any product was recommended to me.';
const MY_ATTESTATION = 'I confirm the answers above are complete and accurate, and that my needs were assessed before any product was recommended.';

export const AE_NEEDS_QUESTIONNAIRE: NeedsQuestionnaire = {
  country: 'AE', pack: PACKS['AE']!.name, version: '2026.1', questions: CORE_QUESTIONS, attestation: AE_ATTESTATION,
};

export const MY_NEEDS_QUESTIONNAIRE: NeedsQuestionnaire = {
  country: 'MY', pack: PACKS['MY']!.name, version: '2026.1', questions: CORE_QUESTIONS, attestation: MY_ATTESTATION,
};

export const QUESTIONNAIRES: Record<string, NeedsQuestionnaire> = {
  AE: AE_NEEDS_QUESTIONNAIRE, MY: MY_NEEDS_QUESTIONNAIRE,
};

export function questionnaireFor(country: string): NeedsQuestionnaire {
  const q = QUESTIONNAIRES[country?.trim().toUpperCase()];
  if (!q) throw new NeedsError(`no needs questionnaire for country "${country}"`);
  return q;
}

/* ------------------------------------------------------------------ evaluation */

export interface NeedsEvaluation {
  readonly needId: string;
  readonly country: string;
  readonly pack: string;
  readonly questionnaireVersion: string;
  readonly completed: boolean;
  readonly percent: number;                 // 0..100 — the gate the journey uses to auto-advance
  readonly missing: readonly string[];      // question labels still outstanding
  readonly answers: ReadonlyArray<{ questionId: string; label: string; value: string }>;
  readonly riskAppetite: 'cautious' | 'balanced' | 'growth' | null;
  readonly objective: string | null;
  readonly shariahPreferred: boolean;
  readonly smoker: boolean;
  readonly medicalConditions: boolean;
  readonly age: number | null;
  readonly occupationClass: number | null;
  readonly residenceCountry: string;
  readonly annualIncome: Money | null;
  readonly premiumBudget: Money | null;
  /** The protection gap, built up in components so a reviewer can see the arithmetic. */
  readonly need: {
    readonly incomeReplacement: Money | null;
    readonly debtCover: Money | null;
    readonly lessExistingCover: Money | null;
    readonly suggestedSumAssured: Money | null;
    readonly affordabilityCeiling: Money | null;
    readonly replacementYears: number | null;
    readonly basis: readonly string[];
  };
  readonly regulatory: PreSaleResult | null;
  readonly blockers: readonly string[];
  readonly attestation: { readonly text: string; readonly agreed: boolean };
}

const number = (v: string | number | boolean | undefined): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const clean = v.trim().replace(/,/g, '');
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
};

export function replacementYearsFor(dependants: number, age: number | null): number {
  const byDependants = [...REPLACEMENT_YEARS_BY_DEPENDANTS].reverse().find((r) => dependants >= r.dependants)?.years ?? 3;
  const toRetirement = age === null ? MAX_REPLACEMENT_YEARS : Math.max(0, DEFAULT_RETIREMENT_AGE - age);
  return Math.min(byDependants, toRetirement, MAX_REPLACEMENT_YEARS);
}

/**
 * Evaluate the questionnaire. The evaluation never throws on missing answers — it reports them,
 * because the point of the stage is to show the customer what is still outstanding, not to fail.
 */
export function evaluateNeeds(input: {
  needId: string;
  country?: string;
  answers: readonly NeedsAnswer[];
  attestationAgreed?: boolean;
  productLine?: 'life' | 'medical' | 'unit-linked' | 'travel' | 'motor' | 'group';
}): NeedsEvaluation {
  const byId = new Map<string, string | number | boolean>();
  for (const a of input.answers) byId.set(a.questionId, a.value);
  const residence = String(byId.get('residence-country') ?? input.country ?? 'AE').toUpperCase();
  const country = PACKS[residence] ? residence : (input.country ?? 'AE').toUpperCase();
  const questionnaire = QUESTIONNAIRES[country] ?? AE_NEEDS_QUESTIONNAIRE;
  const pack = packFor(country);

  const missing = questionnaire.questions
    .filter((q) => q.mandatory)
    .filter((q) => {
      const v = byId.get(q.id);
      if (v === undefined || v === null) return true;
      if (typeof v === 'string') return v.trim() === '';
      return false;
    })
    .map((q) => q.label);

  const answered = questionnaire.questions.map((q) => {
    const raw = byId.get(q.id);
    const value = raw === undefined ? '' : typeof raw === 'boolean' ? (raw ? 'yes' : 'no') : String(raw);
    return { questionId: q.id, label: q.label, value };
  });

  const total = questionnaire.questions.filter((q) => q.mandatory).length;
  const percent = total === 0 ? 0 : Math.round(((total - missing.length) / total) * 100);

  const incomeValue = number(byId.get('annual-income'));
  const currency = 'AED';
  const annualIncome = incomeValue === null ? null : money(BigInt(Math.max(0, Math.round(incomeValue * 100))), currency);
  const budgetValue = number(byId.get('premium-budget'));
  const premiumBudget = budgetValue === null ? null : money(BigInt(Math.max(0, Math.round(budgetValue * 100))), currency);
  const debtValue = number(byId.get('outstanding-debt'));
  const debtCover = debtValue === null ? null : money(BigInt(Math.max(0, Math.round(debtValue * 100))), currency);
  const existingValue = number(byId.get('existing-cover'));
  const lessExistingCover = existingValue === null ? null : money(BigInt(Math.max(0, Math.round(existingValue * 100))), currency);

  const age = number(byId.get('age'));
  const dependants = number(byId.get('dependants'));
  const years = annualIncome && dependants !== null ? replacementYearsFor(dependants, age) : null;
  const incomeReplacement = annualIncome && years !== null ? multiply(annualIncome, years) : null;

  const basis: string[] = [];
  if (years !== null) basis.push(`Income replacement: ${years} year(s), from ${dependants ?? 0} dependant(s)${age !== null ? ` and ${Math.max(0, DEFAULT_RETIREMENT_AGE - age)} year(s) to the assumed retirement age of ${DEFAULT_RETIREMENT_AGE}` : ''}.`);
  if (debtCover) basis.push(`Debt cover added in full: ${formatAmount(debtCover)}.`);
  if (lessExistingCover) basis.push(`Existing cover in force elsewhere deducted: ${formatAmount(lessExistingCover)}.`);

  let suggestedSumAssured: Money | null = null;
  if (incomeReplacement && debtCover && lessExistingCover) {
    const gross = add(incomeReplacement, debtCover);
    suggestedSumAssured = compare(gross, lessExistingCover) > 0 ? sub(gross, lessExistingCover) : zero(currency);
    basis.push('Suggested sum assured = income replacement + debt cover − existing cover, floored at zero.');
  }

  const affordabilityCeiling = annualIncome ? applyBps(annualIncome, AFFORDABILITY_CAP_BPS) : null;
  if (affordabilityCeiling) basis.push(`Affordability ceiling: ${AFFORDABILITY_CAP_BPS / 100}% of gross income = ${formatAmount(affordabilityCeiling)} a year.`);

  const riskAppetite = (['cautious', 'balanced', 'growth'].includes(String(byId.get('risk-appetite') ?? ''))
    ? String(byId.get('risk-appetite'))
    : null) as NeedsEvaluation['riskAppetite'];
  const objective = byId.get('objective') === undefined ? null : String(byId.get('objective'));
  const occupationClass = number(byId.get('occupation-class'));

  const line = input.productLine ?? (objective === 'health-cover' ? 'medical' : riskAppetite ? 'unit-linked' : 'life');
  const hasNeedAnalysis = missing.length === 0 && (input.attestationAgreed ?? false);
  const regulatory = preSaleCheck(pack, {
    productLine: line,
    hasNeedAnalysis,
    hasNeedId: hasNeedAnalysis,
    surveyCompleted: objective !== null,
    comparisonPresented: false,      // the comparison is presented at the recommendation stage, not here
    customerIsResident: residence === country,
    consentCaptured: true,           // consent is captured at the customer stage, which precedes this one
  });

  const blockers: string[] = [];
  if (missing.length > 0) blockers.push(`${missing.length} mandatory question(s) are still unanswered: ${missing.join('; ')}`);
  if (!(input.attestationAgreed ?? false)) blockers.push('The customer has not agreed to the needs-analysis attestation');
  if (premiumBudget && affordabilityCeiling && compare(premiumBudget, affordabilityCeiling) > 0) {
    blockers.push(`The stated budget of ${formatAmount(premiumBudget)} is above the affordability ceiling of ${formatAmount(affordabilityCeiling)} — the budget must be reviewed with the customer, not simply accepted`);
  }

  return {
    needId: input.needId,
    country,
    pack: `${pack.country} ${pack.version}`,
    questionnaireVersion: questionnaire.version,
    completed: missing.length === 0 && (input.attestationAgreed ?? false) && blockers.filter((b) => b.startsWith('The stated budget')).length === 0,
    percent,
    missing,
    answers: answered,
    riskAppetite,
    objective,
    shariahPreferred: byId.get('shariah-preferred') === true || String(byId.get('shariah-preferred') ?? '') === 'yes',
    smoker: byId.get('smoker') === true || String(byId.get('smoker') ?? '') === 'yes',
    medicalConditions: byId.get('medical-conditions') === true || String(byId.get('medical-conditions') ?? '') === 'yes',
    age,
    occupationClass,
    residenceCountry: residence,
    annualIncome,
    premiumBudget,
    need: {
      incomeReplacement, debtCover, lessExistingCover, suggestedSumAssured, affordabilityCeiling,
      replacementYears: years, basis,
    },
    regulatory,
    blockers,
    attestation: { text: questionnaire.attestation, agreed: input.attestationAgreed ?? false },
  };
}

/* ------------------------------------------------------------------ recommendation */

export interface ProductCandidate {
  readonly productId: string;
  readonly name: string;
  readonly line: 'life' | 'medical' | 'motor' | 'travel' | 'group';
  readonly category: 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg';
  readonly entityId: string;
  readonly currency: string;
  readonly minAge: number;
  readonly maxAge: number;
  readonly baseRatePerThousandMinor: bigint;
  readonly defaultFunds: readonly string[];
  /** What the product is for, in the same vocabulary the questionnaire uses. */
  readonly objectives: readonly string[];
  readonly investmentLinked: boolean;
  readonly shariahCompliant: boolean;
  readonly minimumRiskAppetite: 'cautious' | 'balanced' | 'growth';
}

export interface Recommendation {
  readonly productId: string;
  readonly name: string;
  readonly category: ProductCandidate['category'];
  readonly entityId: string;
  readonly fits: boolean;
  readonly score: number;                       // 0..1
  readonly scorePct: number;
  readonly reasons: readonly string[];
  readonly disqualifiers: readonly string[];
  readonly indicativeAnnualPremium: Money | null;
  readonly indicativePremiumLabel: string;
  readonly suggestedSumAssured: Money | null;
  readonly suggestedSumAssuredLabel: string;
  readonly withinBudget: boolean | null;
}

const APPETITE_RANK: Record<string, number> = { cautious: 0, balanced: 1, growth: 2 };

/**
 * Rank the catalogue against the evaluated need. The score is explainable on purpose: every point
 * is a reason string, and anything that rules a product out is a disqualifier rather than a silent
 * zero — a customer-facing list that hides why it said no is how mis-selling findings start.
 */
export function recommendProducts(input: {
  evaluation: NeedsEvaluation;
  candidates: readonly ProductCandidate[];
  sumAssured?: Money;
}): Recommendation[] {
  const ev = input.evaluation;
  const sumAssured = input.sumAssured ?? ev.need.suggestedSumAssured;
  const out: Recommendation[] = [];

  for (const c of input.candidates) {
    const reasons: string[] = [];
    const disqualifiers: string[] = [];
    let score = 0;

    if (ev.age !== null && (ev.age < c.minAge || ev.age > c.maxAge)) {
      disqualifiers.push(`Age ${ev.age} is outside the entry range ${c.minAge}–${c.maxAge}`);
    }
    if (ev.objective && c.objectives.includes(ev.objective)) {
      score += 0.4;
      reasons.push(`Answers the stated objective "${ev.objective}"`);
    } else if (ev.objective) {
      disqualifiers.push(`Does not answer the stated objective "${ev.objective}"`);
    }
    if (ev.riskAppetite) {
      const want = APPETITE_RANK[ev.riskAppetite] ?? 0;
      const has = APPETITE_RANK[c.minimumRiskAppetite] ?? 0;
      if (c.investmentLinked && want < has) {
        disqualifiers.push(`Investment-linked and needs a "${c.minimumRiskAppetite}" appetite; the customer stated "${ev.riskAppetite}"`);
      } else if (c.investmentLinked) {
        // Tailored beats merely acceptable: a fund mix graded exactly at the customer's appetite is
        // worth more than one they would tolerate, and the difference has to show in the ranking.
        const exact = want === has;
        score += exact ? 0.2 : 0.1;
        reasons.push(exact
          ? `Investment-linked and graded exactly at the customer's "${ev.riskAppetite}" appetite`
          : `Investment-linked and acceptable for a "${ev.riskAppetite}" appetite, though graded "${c.minimumRiskAppetite}"`);
      } else {
        score += 0.1;
        reasons.push('Protection without investment risk, suitable for any appetite');
      }
    }
    if (ev.shariahPreferred && c.shariahCompliant) {
      score += 0.2;
      reasons.push('Shariah-compliant, as the customer asked');
    } else if (ev.shariahPreferred && !c.shariahCompliant) {
      disqualifiers.push('Not Shariah-compliant, and the customer asked for a takaful arrangement');
    }

    let premium: Money | null = null;
    if (sumAssured) {
      const rate = money(c.baseRatePerThousandMinor, c.currency);
      premium = money((sumAssured.minor * rate.minor) / (1000n * 100n), c.currency);
      if (ev.premiumBudget) {
        if (compare(premium, ev.premiumBudget) <= 0) {
          score += 0.2;
          reasons.push(`Indicative premium ${formatAmount(premium)} is inside the stated budget of ${formatAmount(ev.premiumBudget)}`);
        } else {
          disqualifiers.push(`Indicative premium ${formatAmount(premium)} exceeds the stated budget of ${formatAmount(ev.premiumBudget)}`);
        }
      }
    }
    if (ev.need.affordabilityCeiling && premium && compare(premium, ev.need.affordabilityCeiling) > 0) {
      disqualifiers.push(`Indicative premium is above the affordability ceiling of ${formatAmount(ev.need.affordabilityCeiling)}`);
    }

    const normalised = Math.max(0, Math.min(1, Math.round(score * 10000) / 10000));
    out.push({
      productId: c.productId, name: c.name, category: c.category, entityId: c.entityId,
      fits: disqualifiers.length === 0 && normalised >= 0.5,
      score: normalised, scorePct: Math.round(normalised * 100),
      reasons, disqualifiers,
      indicativeAnnualPremium: premium,
      indicativePremiumLabel: premium ? formatAmount(premium) : '—',
      suggestedSumAssured: sumAssured ?? null,
      suggestedSumAssuredLabel: sumAssured ? formatAmount(sumAssured) : '—',
      withinBudget: premium && ev.premiumBudget ? compare(premium, ev.premiumBudget) <= 0 : null,
    });
  }

  return out.sort((a, b) => (b.fits === a.fits ? b.score - a.score : b.fits ? 1 : -1));
}

/**
 * The comparison the regulator wants presented alongside a recommendation: the recommended cover
 * against the market offers already on file, on the same axes, with the ranking explained.
 */
export function recommendationComparison(offers: ReadonlyArray<{ insurer: string; product: string; premium: number; excess: number; benefits: string[]; serviceRating: number; complaintsPer10k: number }>) {
  return comparisonMatrix(offers.map((o) => ({ ...o })));
}

export function describeEvaluation(ev: NeedsEvaluation): string {
  const parts: string[] = [
    `Need analysis ${ev.needId} under ${ev.pack}: ${ev.percent}% complete${ev.completed ? '' : ` — outstanding: ${ev.missing.join('; ') || 'attestation'}`}.`,
  ];
  if (ev.need.suggestedSumAssured) parts.push(`Suggested sum assured ${formatAmount(ev.need.suggestedSumAssured)}.`);
  if (ev.premiumBudget) parts.push(`Budget ${formatAmount(ev.premiumBudget)} a year.`);
  if (ev.regulatory && !ev.regulatory.allowed) parts.push(`Pre-sale gate: ${ev.regulatory.blockers.join('; ')}`);
  return parts.join(' ');
}

export { formatAmount, zero };
