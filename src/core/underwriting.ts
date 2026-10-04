/**
 * Underwriting.
 *
 * The engine scores a risk the way a real underwriting manual does — age, build, occupation,
 * pursuits, medical history, family history, then the financial test — but it separates the three
 * things that are always conflated in software: the *rules* (data), the *decision* (what the risk
 * merits) and the *authority* (who is allowed to say it).
 *
 * Two rules matter more than the rest:
 *  - an AI agent may accept or rate a risk inside its own limit, and may *never* decline one;
 *    a decline, a postponement or anything above the limit becomes a referral to a named human;
 *  - a risk that exceeds the automatic binding limit is flagged for the reinsurer before the
 *    policy is issued, because discovering that after issue is how a treaty gets breached.
 */
import { Money, add, applyBps, compare, formatAmount, money, scaleOf, sub, zero } from './money.js';

export type ProductLine = 'life' | 'medical' | 'critical-illness' | 'motor' | 'travel' | 'group';
export type DecisionOutcome = 'standard' | 'rated' | 'excluded' | 'postponed' | 'declined' | 'referred';
export type OccupationClass = 1 | 2 | 3 | 4 | 5;

export interface RiskProfile {
  readonly partyId: string;
  readonly age: number;
  readonly sex: 'male' | 'female';
  readonly smoker: boolean;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly occupationClass: OccupationClass;
  readonly pursuits: string[];
  readonly conditions: string[];
  readonly familyHistory: string[];
  readonly residenceCountry: string;
  readonly annualIncome: Money;
}

export interface EvidenceBand {
  readonly fromAge: number;
  readonly fromSumAssuredMinor: bigint;
  readonly requirements: string[];
}

export interface ProductRules {
  readonly productId: string;
  readonly line: ProductLine;
  readonly minAge: number;
  readonly maxAge: number;
  readonly referralMarginYears: number;      // age beyond max that may still be referred, not declined
  readonly maxBmi: number;
  readonly acceptedCountries: string[];
  readonly standardOccupations: OccupationClass[];
  readonly baseRatePerThousandMinor: bigint; // gross annual premium per 1,000 sum assured, standard life
  readonly incomeMultiple: number;           // maximum sum assured as a multiple of income
  readonly automaticBindingLimitMinor: bigint;  // per life, before the reinsurer must see it
  readonly facultativeThresholdMinor: bigint;   // per policy
  readonly evidenceBands: EvidenceBand[];
  readonly aiStraightThroughMinor: bigint;   // what an AI agent may accept without a human
}

export interface ConditionRule {
  readonly code: string;
  readonly label: string;
  readonly extraMortalityBps: number;
  readonly evidence?: string[];
  readonly exclusion?: string;
  readonly referToHuman?: boolean;
}

/** A compact, explicit manual. Real manuals are longer; the shape is what matters. */
export const CONDITION_RULES: ConditionRule[] = [
  { code: 'diabetes-type-2', label: 'Type 2 diabetes', extraMortalityBps: 75, evidence: ['HbA1c result within 6 months'] },
  { code: 'diabetes-type-1', label: 'Type 1 diabetes', extraMortalityBps: 150, evidence: ['endocrinologist report'], referToHuman: true },
  { code: 'hypertension-controlled', label: 'Controlled hypertension', extraMortalityBps: 25, evidence: ['recent blood pressure readings'] },
  { code: 'hypertension-uncontrolled', label: 'Uncontrolled hypertension', extraMortalityBps: 100, evidence: ['24-hour ambulatory reading'], referToHuman: true },
  { code: 'cardiac-history', label: 'Cardiac history', extraMortalityBps: 200, evidence: ['cardiologist report', 'stress ECG'], referToHuman: true },
  { code: 'cancer-remission-5y', label: 'Cancer in remission over five years', extraMortalityBps: 100, evidence: ['oncologist report'], referToHuman: true },
  { code: 'asthma-mild', label: 'Mild asthma', extraMortalityBps: 15 },
  { code: 'high-cholesterol', label: 'Raised cholesterol', extraMortalityBps: 30, evidence: ['lipid profile'] },
  { code: 'depression-treated', label: 'Treated depression', extraMortalityBps: 40, evidence: ['treating physician report'] },
  { code: 'ckd-stage-3', label: 'Chronic kidney disease, stage 3', extraMortalityBps: 175, evidence: ['nephrologist report'], referToHuman: true },
];

export const PURSUIT_RULES: Array<{ code: string; extraMortalityBps: number; exclusion?: string }> = [
  { code: 'aviation-private', extraMortalityBps: 0, exclusion: 'Death while piloting a private aircraft' },
  { code: 'scuba-diving', extraMortalityBps: 50 },
  { code: 'motor-racing', extraMortalityBps: 0, exclusion: 'Death while competing in motorsport' },
  { code: 'mountaineering-above-6000m', extraMortalityBps: 75 },
];

export const OCCUPATION_DEBITS: Record<OccupationClass, number> = { 1: 0, 2: 20, 3: 60, 4: 150, 5: 300 };

export const FAMILY_HISTORY_RULES: Array<{ code: string; extraMortalityBps: number }> = [
  { code: 'early-cardiac-death', extraMortalityBps: 50 },
  { code: 'early-cancer-death', extraMortalityBps: 40 },
  { code: 'early-stroke-death', extraMortalityBps: 35 },
];

export interface Reason {
  readonly code: string;
  readonly detail: string;
  readonly source: 'eligibility' | 'build' | 'occupation' | 'pursuits' | 'medical' | 'family' | 'financial' | 'reinsurance' | 'authority';
  /** True when this point is what put the case in a human's queue — waivers are recorded against these. */
  readonly referral?: boolean;
}

export interface UnderwritingDecision {
  readonly applicationId: string;
  readonly productId: string;
  readonly partyId: string;
  readonly at: string;
  readonly outcome: DecisionOutcome;
  readonly sumAssured: Money;
  readonly standardPremium: Money;
  readonly extraMortalityBps: number;
  readonly loadedPremium: Money;
  readonly exclusions: string[];
  readonly evidence: string[];
  readonly reasons: Reason[];
  readonly referrals: string[];
  readonly reinsurance: { mode: 'automatic' | 'facultative'; threshold: Money; note: string };
  readonly proposedBy: string;
  readonly proposedByAi: boolean;
  readonly decidedBy: string;
  readonly decidedByAi: boolean;
}

export interface Application {
  readonly id: string;
  readonly partyId: string;
  readonly productId: string;
  readonly sumAssured: Money;
  readonly at: string;
  readonly profile: RiskProfile;
  decision?: UnderwritingDecision;
}

export interface AggregateExposure {
  readonly partyId: string;
  readonly policies: number;
  readonly totalSumAssured: Money;
  readonly automaticBindingLimit: Money;
  readonly withinAutomaticLimit: boolean;
  readonly facultativeRequired: boolean;
}

export class UnderwritingError extends Error {}

export class UnderwritingEngine {
  private readonly applications = new Map<string, Application>();
  private readonly accepted = new Map<string, UnderwritingDecision[]>();
  private seq = 0;

  constructor(
    private readonly rules: Map<string, ProductRules>,
    private readonly currency: string,
    private readonly humanRoles: { decline: string; refer: string } = { decline: 'chief-underwriter', refer: 'senior-underwriter' },
  ) {}

  rulesFor(productId: string): ProductRules {
    const r = this.rules.get(productId);
    if (!r) throw new UnderwritingError(`no underwriting rules for product ${productId}`);
    return r;
  }

  register(input: { partyId: string; productId: string; sumAssured: Money; at: string; profile: RiskProfile }): Application {
    const application: Application = { id: `UW-${String(++this.seq).padStart(6, '0')}`, ...input };
    this.applications.set(application.id, application);
    return application;
  }

  application(id: string): Application {
    const a = this.applications.get(id);
    if (!a) throw new UnderwritingError(`unknown application ${id}`);
    return a;
  }

  list(): Application[] { return [...this.applications.values()]; }

  bmi(profile: RiskProfile): number {
    const metres = profile.heightCm / 100;
    if (metres <= 0) throw new UnderwritingError('height must be positive');
    return Math.round((profile.weightKg / (metres * metres)) * 10) / 10;
  }

  /** Emphysema-free, auditable build-up of the extra mortality loading. */
  assess(applicationId: string): UnderwritingDecision {
    const app = this.application(applicationId);
    const rules = this.rulesFor(app.productId);
    const profile = app.profile;
    const reasons: Reason[] = [];
    const exclusions: string[] = [];
    const evidence: string[] = [];
    const referrals: string[] = [];
    let extra = 0;
    let hardStop: DecisionOutcome | null = null;

    /* eligibility */
    if (profile.residenceCountry !== '' && !rules.acceptedCountries.includes(profile.residenceCountry)) {
      hardStop = 'declined';
      reasons.push({ code: 'residence-not-accepted', detail: `${profile.residenceCountry} is outside the accepted territory for ${rules.productId}`, source: 'eligibility' });
    }
    if (profile.age < rules.minAge || profile.age > rules.maxAge + rules.referralMarginYears) {
      hardStop = 'declined';
      reasons.push({ code: 'age-outside-limits', detail: `Age ${profile.age} is outside the issued range ${rules.minAge}–${rules.maxAge} for ${rules.productId}`, source: 'eligibility' });
    } else if (profile.age > rules.maxAge) {
      referrals.push(this.humanRoles.refer);
      reasons.push({ code: 'age-referral', referral: true, detail: `Age ${profile.age} is above the standard issue age of ${rules.maxAge}; a senior underwriter must sign`, source: 'eligibility' });
    }

    /* build */
    const bmi = this.bmi(profile);
    if (bmi > rules.maxBmi) {
      referrals.push(this.humanRoles.refer);
      reasons.push({ code: 'build-referral', referral: true, detail: `BMI ${bmi} is above the standard maximum of ${rules.maxBmi}`, source: 'build' });
      extra += 50;
    } else if (bmi > rules.maxBmi - 5) {
      extra += 25;
      reasons.push({ code: 'build-debit', detail: `BMI ${bmi} attracts a build debit of 25 basis points`, source: 'build' });
    }
    if (profile.smoker) {
      extra += 100;
      reasons.push({ code: 'smoker', detail: 'Current smoker: 100 basis points of extra mortality', source: 'build' });
    }

    /* occupation: the base rate already prices the standard classes for the product */
    const standardOccupation = rules.standardOccupations.includes(profile.occupationClass);
    const occupationDebit = standardOccupation ? 0 : OCCUPATION_DEBITS[profile.occupationClass];
    if (standardOccupation) {
      reasons.push({ code: `occupation-class-${profile.occupationClass}`, detail: `Occupation class ${profile.occupationClass} is inside the standard range for ${rules.productId}: no debit`, source: 'occupation' });
    } else {
      extra += occupationDebit;
      referrals.push(this.humanRoles.refer);
      reasons.push({
        code: 'occupation-referral', referral: true, source: 'occupation',
        detail: `Occupation class ${profile.occupationClass} is outside the standard range (${rules.standardOccupations.join(', ')}) and carries a debit of ${occupationDebit} basis points`,
      });
    }

    /* pursuits */
    for (const pursuit of profile.pursuits) {
      const rule = PURSUIT_RULES.find((p) => p.code === pursuit);
      if (!rule) {
        reasons.push({ code: `pursuit-unknown-${pursuit}`, referral: true, detail: `Pursuit "${pursuit}" is not in the manual; treating it as no loading and referring for review`, source: 'pursuits' });
        referrals.push(this.humanRoles.refer);
        continue;
      }
      extra += rule.extraMortalityBps;
      if (rule.exclusion) exclusions.push(rule.exclusion);
      reasons.push({
        code: `pursuit-${rule.code}`,
        detail: `${pursuit}: ${rule.extraMortalityBps} basis points${rule.exclusion ? `, with the exclusion "${rule.exclusion}"` : ''}`,
        source: 'pursuits',
      });
    }

    /* medical */
    for (const condition of profile.conditions) {
      const rule = CONDITION_RULES.find((c) => c.code === condition);
      if (!rule) {
        hardStop = hardStop ?? 'referred';
        referrals.push(this.humanRoles.refer);
        reasons.push({ code: `condition-unknown-${condition}`, referral: true, detail: `Condition "${condition}" is not in the manual; it must be read by a human underwriter`, source: 'medical' });
        continue;
      }
      extra += rule.extraMortalityBps;
      if (rule.evidence) evidence.push(...rule.evidence);
      if (rule.exclusion) exclusions.push(rule.exclusion);
      if (rule.referToHuman && !hardStop) referrals.push(this.humanRoles.refer);
      reasons.push({
        code: `condition-${rule.code}`, source: 'medical',
        ...(rule.referToHuman ? { referral: true } : {}),
        detail: `${rule.label}: ${rule.extraMortalityBps} basis points${rule.evidence ? `; evidence required (${rule.evidence.join(', ')})` : ''}`,
      });
    }

    /* family history */
    for (const item of profile.familyHistory) {
      const rule = FAMILY_HISTORY_RULES.find((f) => f.code === item);
      if (!rule) continue;
      extra += rule.extraMortalityBps;
      reasons.push({ code: `family-${rule.code}`, detail: `${item}: ${rule.extraMortalityBps} basis points`, source: 'family' });
    }

    /* financial underwriting */
    const cap = applyBps(profile.annualIncome, rules.incomeMultiple * 10_000); // "three times income" is 30,000 bps
    if (compare(app.sumAssured, cap) > 0) {
      referrals.push('financial-underwriter');
      reasons.push({
        code: 'financial-underwriting', referral: true,
        source: 'financial',
        detail: `Sum assured ${formatAmount(app.sumAssured)} is ${(Number(app.sumAssured.minor) / Number(cap.minor || 1n)).toFixed(1)}× income, above the ${rules.incomeMultiple}× cap of ${formatAmount(cap)}`,
      });
    }

    /* evidence bands */
    for (const band of rules.evidenceBands) {
      if (profile.age >= band.fromAge && app.sumAssured.minor >= band.fromSumAssuredMinor) {
        evidence.push(...band.requirements);
      }
    }

    /* reinsurance */
    const exposure = this.aggregateExposure(app.partyId, rules);
    const facultative = app.sumAssured.minor >= rules.facultativeThresholdMinor || exposure.facultativeRequired;
    if (facultative) {
      referrals.push('reinsurance-desk');
      reasons.push({
        code: 'reinsurance-facultative', referral: true,
        source: 'reinsurance',
        detail: `Sum assured ${formatAmount(app.sumAssured)} reaches the facultative threshold of ${formatAmount(money(rules.facultativeThresholdMinor, this.currency))}${exposure.facultativeRequired ? ` and the aggregate for this life is ${formatAmount(exposure.totalSumAssured)} against an automatic binding limit of ${formatAmount(exposure.automaticBindingLimit)}` : ''}; the reinsurer must be asked before issue`,
      });
    }

    // The manual quotes a rate in minor units per 1,000 units of sum assured, so the divisor
    // carries the currency scale: 3,000 (i.e. 30.00) per 1,000 of a 250,000.00 sum assured is
    // 7,500.00 a year, not 750,000.00.
    const divisor = 1000n * 10n ** BigInt(scaleOf(this.currency));
    const standardPremium = money((app.sumAssured.minor * rules.baseRatePerThousandMinor) / divisor, this.currency);
    const loadedPremium = add(standardPremium, applyBps(standardPremium, extra));

    let outcome: DecisionOutcome;
    if (hardStop) outcome = hardStop;
    else if (referrals.length > 0) outcome = 'referred';
    else if (extra > 0 && exclusions.length > 0) outcome = 'excluded';
    else if (extra > 0) outcome = 'rated';
    else outcome = 'standard';

    return {
      applicationId: app.id, productId: app.productId, partyId: app.partyId, at: app.at,
      outcome, sumAssured: app.sumAssured, standardPremium, extraMortalityBps: extra, loadedPremium,
      exclusions: [...new Set(exclusions)], evidence: [...new Set(evidence)], reasons,
      referrals: [...new Set(referrals)],
      reinsurance: {
        mode: facultative ? 'facultative' : 'automatic',
        threshold: money(rules.facultativeThresholdMinor, this.currency),
        note: facultative ? 'Reinsurer referral required before issue' : 'Inside the automatic binding limit',
      },
      proposedBy: 'underwriting-rules', proposedByAi: false,
      decidedBy: '', decidedByAi: false,
    };
  }

  /**
   * Turn an assessment into a decision under an authority. An AI may accept, rate or exclude
   * inside its straight-through limit; it may not decline, postpone or exceed the limit — those
   * become referrals to the named human roles, and the referral is recorded as a reason.
   */
  decide(applicationId: string, input: {
    at: string; by: string; isAi?: boolean; acceptReferralReasonCodes?: string[]; override?: DecisionOutcome;
  }): UnderwritingDecision {
    const app = this.application(applicationId);
    const rules = this.rulesFor(app.productId);
    const assessment = this.assess(applicationId);
    const isAi = input.isAi ?? false;
    const reasons = [...assessment.reasons];
    const referralPoints = reasons.filter((r) => r.referral);
    let outcome = assessment.outcome;

    if (isAi) {
      /* An agent may accept, rate or exclude inside its limit. It may never decline, postpone,
         refer past itself, or accept above its straight-through limit. */
      const substantive: DecisionOutcome = assessment.extraMortalityBps > 0
        ? (assessment.exclusions.length > 0 ? 'excluded' : 'rated')
        : 'standard';
      const hard = outcome === 'declined' || outcome === 'postponed' || outcome === 'referred';
      const overLimit = app.sumAssured.minor >= rules.aiStraightThroughMinor;
      if (hard || overLimit) {
        outcome = 'referred';
        const owner = assessment.referrals.length > 0 ? assessment.referrals.join(', ') : this.humanRoles.decline;
        reasons.push({
          code: 'ai-authority', source: 'authority',
          detail: `An AI agent proposed ${assessment.outcome}${overLimit ? ` on a sum assured of ${formatAmount(app.sumAssured)}, at or above its straight-through limit of ${formatAmount(money(rules.aiStraightThroughMinor, this.currency))}` : ''}; referred to ${owner} — no cover is issued on an AI decision of this kind`,
        });
      } else {
        outcome = substantive;
      }
    } else {
      /* A human decides. Referral points they did not explicitly accept are recorded as waived,
         with their name against it — the file has to show what was set aside and by whom. */
      const accepted = input.acceptReferralReasonCodes ?? [];
      const outstanding = referralPoints.filter((r) => !accepted.includes(r.code));
      if (outstanding.length > 0) {
        reasons.push({
          code: 'referral-waived', source: 'authority',
          detail: `${input.by} decided the case with ${outstanding.length} referral point(s) waived: ${outstanding.map((r) => r.code).join(', ')}`,
        });
      }
      if (input.override) {
        outcome = input.override;
        reasons.push({ code: 'underwriter-override', source: 'authority', detail: `${input.by} overrode the rules outcome (${assessment.outcome}) to ${input.override}` });
      } else if (outcome === 'referred') {
        outcome = assessment.extraMortalityBps > 0
          ? (assessment.exclusions.length > 0 ? 'excluded' : 'rated')
          : 'standard';
      }
    }

    const decision: UnderwritingDecision = {
      ...assessment, outcome, reasons,
      proposedBy: assessment.proposedBy, proposedByAi: false,
      decidedBy: input.by, decidedByAi: isAi,
    };
    app.decision = decision;
    if (outcome === 'standard' || outcome === 'rated' || outcome === 'excluded') {
      const existing = this.accepted.get(app.partyId) ?? [];
      this.accepted.set(app.partyId, [...existing, decision]);
    }
    return decision;
  }

  /** Everything already on risk for a life, which is what the reinsurer asks about first. */
  aggregateExposure(partyId: string, rules?: ProductRules): AggregateExposure {
    const decisions = this.accepted.get(partyId) ?? [];
    const total = decisions.reduce((acc, d) => add(acc, d.sumAssured), zero(this.currency));
    const binding = rules ? money(rules.automaticBindingLimitMinor, this.currency) : zero(this.currency);
    return {
      partyId,
      policies: decisions.length,
      totalSumAssured: total,
      automaticBindingLimit: binding,
      withinAutomaticLimit: rules ? total.minor <= rules.automaticBindingLimitMinor : true,
      facultativeRequired: rules ? decisions.some((d) => d.sumAssured.minor >= rules.facultativeThresholdMinor) : false,
    };
  }

  /** What the reinsurer holds, per life, in the shape a treaty statement needs. */
  cessionSchedule(): Array<{ partyId: string; policies: number; totalSumAssured: Money; mode: 'automatic' | 'facultative' }> {
    return [...this.accepted.entries()].map(([partyId, decisions]) => ({
      partyId,
      policies: decisions.length,
      totalSumAssured: decisions.reduce((acc, d) => add(acc, d.sumAssured), zero(this.currency)),
      mode: decisions.some((d) => d.reinsurance.mode === 'facultative') ? 'facultative' : 'automatic',
    }));
  }

  /** Applications a human still has to look at, with the reason each one is waiting. */
  queue(): Array<{ applicationId: string; partyId: string; outcome: DecisionOutcome; waitingOn: string[]; reasonCodes: string[] }> {
    return this.list()
      .filter((a) => !a.decision || a.decision.outcome === 'referred')
      .map((a) => {
        const assessment = a.decision ?? this.assess(a.id);
        return {
          applicationId: a.id, partyId: a.partyId, outcome: assessment.outcome,
          waitingOn: assessment.referrals.length > 0 ? assessment.referrals : [this.humanRoles.refer],
          reasonCodes: assessment.reasons.map((r) => r.code),
        };
      });
  }

  /** Premium the book carries, standard against loaded, from accepted decisions only. */
  bookPremium(): { standard: Money; loaded: Money; extra: Money; policies: number } {
    let standard = zero(this.currency);
    let loaded = zero(this.currency);
    let policies = 0;
    for (const decisions of this.accepted.values()) {
      for (const d of decisions) {
        standard = add(standard, d.standardPremium);
        loaded = add(loaded, d.loadedPremium);
        policies += 1;
      }
    }
    return { standard, loaded, extra: sub(loaded, standard), policies };
  }

  /** The decision on one application — what the reinsurance desk has to cede, and on what terms. */
  decisionFor(applicationId: string): UnderwritingDecision | undefined {
    return this.accepted.get(applicationId)?.at(-1) ?? this.applications.get(applicationId)?.decision;
  }

  /** Reinsurance share of the book at a given cession rate, per policy line. */
  reinsuranceShare(cessionBps: number): Array<{ productId: string; ceded: Money; retained: Money }> {
    const byProduct = new Map<string, Money>();
    for (const decisions of this.accepted.values()) {
      for (const d of decisions) {
        byProduct.set(d.productId, add(byProduct.get(d.productId) ?? zero(this.currency), d.sumAssured));
      }
    }
    return [...byProduct.entries()].map(([productId, total]) => {
      const ceded = applyBps(total, cessionBps);
      return { productId, ceded, retained: sub(total, ceded) };
    });
  }
}
