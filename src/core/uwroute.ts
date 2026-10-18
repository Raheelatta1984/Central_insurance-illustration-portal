/**
 * Who underwrites the case, and how long the customer waits for the answer.
 *
 * Straight-through processing is the goal, not the default: a case may only be issued without a
 * human when the rules produced no loading, no referral and no outstanding medical evidence, and the
 * sum assured is inside the AI straight-through limit for the product. Everything else is routed to
 * a named desk, and the routing itself is recorded — because "the system decided" is not an answer a
 * regulator or a complainant accepts.
 *
 * Three escalations matter and are modelled explicitly:
 *  - a decline or a postponement always goes to a senior underwriter (the engine may never decline);
 *  - a case that reaches the facultative threshold is offered to the reinsurer's underwriter before
 *    issue, not after;
 *  - when the in-house queue cannot meet the promised decision time, capacity is hired in from the
 *    freelance panel for that case, with the cost and the authority limit written down.
 */
import { Money, formatAmount, money } from './money.js';
import { DecisionOutcome, OccupationClass } from './underwriting.js';

export class RoutingError extends Error {}

export type UnderwritingRoute =
  | 'straight-through'        // no human, issued by the rules inside the AI limit
  | 'auto-rules'              // no human, auto-bound below the binding limit, sampled for QA
  | 'manual-inhouse'          // an in-house underwriter reads it
  | 'senior-review'           // a senior underwriter signs it
  | 'senior-referral'         // a decline/postponement or an over-limit case: only a human may say it
  | 'freelance-assist'        // capacity hired in from the freelance panel
  | 'reinsurance-assist';     // the reinsurer's underwriter is asked before issue

export interface RoutingLimits {
  readonly currency: string;
  readonly aiStraightThroughMinor: bigint;
  readonly automaticBindingLimitMinor: bigint;
  readonly facultativeThresholdMinor: bigint;
  readonly seniorUnderwriterLimitMinor: bigint;
  readonly ratedReferralBps: number;          // loading at or above which a senior must sign
}

export const DEFAULT_ROUTING_LIMITS: Omit<RoutingLimits, 'aiStraightThroughMinor' | 'automaticBindingLimitMinor' | 'facultativeThresholdMinor' | 'currency'> = {
  seniorUnderwriterLimitMinor: 2_000_000_00n,  // 2,000,000.00
  ratedReferralBps: 150,
};

export interface UnderwritingQueue {
  readonly inHouseOpenCases: number;
  readonly inHouseCapacityPerDay: number;
  readonly oldestCaseHours: number;
  readonly promisedDecisionHours: number;
  readonly workingHoursPerDay: number;
}

export interface FreelanceUnderwriter {
  readonly id: string;
  readonly name: string;
  readonly specialty: 'life' | 'medical' | 'financial' | 'takaful' | 'general';
  readonly maxOccupationClass: OccupationClass;
  readonly limitMinor: bigint;
  readonly turnaroundHours: number;
  readonly dayRateMinor: bigint;
  readonly languages: readonly string[];
  readonly shariahQualified: boolean;
  readonly available: boolean;
}

/** The panel the desk hires from. Rates and authority are contractual data, not guesses at runtime. */
export const FREELANCE_PANEL: readonly FreelanceUnderwriter[] = [
  { id: 'FU-01', name: 'Dr. Hana Yusof', specialty: 'medical', maxOccupationClass: 3, limitMinor: 1_500_000_00n, turnaroundHours: 8, dayRateMinor: 180_000n, languages: ['en', 'ms'], shariahQualified: true, available: true },
  { id: 'FU-02', name: 'Peter Njoroge', specialty: 'life', maxOccupationClass: 4, limitMinor: 3_000_000_00n, turnaroundHours: 12, dayRateMinor: 220_000n, languages: ['en'], shariahQualified: false, available: true },
  { id: 'FU-03', name: 'Layla Haddad', specialty: 'financial', maxOccupationClass: 5, limitMinor: 10_000_000_00n, turnaroundHours: 24, dayRateMinor: 340_000n, languages: ['en', 'ar'], shariahQualified: false, available: true },
  { id: 'FU-04', name: 'Ahmad Firdaus', specialty: 'takaful', maxOccupationClass: 3, limitMinor: 2_000_000_00n, turnaroundHours: 16, dayRateMinor: 260_000n, languages: ['en', 'ar', 'ms'], shariahQualified: true, available: true },
  { id: 'FU-05', name: 'Sofia Marchetti', specialty: 'general', maxOccupationClass: 2, limitMinor: 750_000_00n, turnaroundHours: 6, dayRateMinor: 150_000n, languages: ['en', 'fr'], shariahQualified: false, available: false },
];

export interface RoutingInput {
  readonly sumAssured: Money;
  readonly outcome: DecisionOutcome;
  readonly extraMortalityBps: number;
  readonly referrals: readonly string[];
  readonly outstandingMedical: number;
  readonly occupationClass: OccupationClass;
  readonly limits: RoutingLimits;
  readonly queue: UnderwritingQueue;
  readonly shariahProduct?: boolean;
  readonly language?: string;
  readonly caseReference: string;
  readonly at: string;
}

export interface RoutingDecision {
  readonly caseReference: string;
  readonly route: UnderwritingRoute;
  readonly automatic: boolean;
  readonly assignedTo: string;
  readonly headline: string;
  readonly reasons: readonly string[];
  readonly escalations: readonly string[];
  readonly expectedDecisionHours: number;
  readonly promisedDecisionHours: number;
  readonly withinPromise: boolean;
  readonly reinsuranceAssist: boolean;
  readonly freelance: FreelanceEngagementOffer | null;
  readonly costEstimate: Money;
  readonly costEstimateLabel: string;
  readonly decidedBy: string;
  readonly decidedByAi: boolean;
}

export interface FreelanceEngagementOffer {
  readonly underwriterId: string;
  readonly name: string;
  readonly specialty: string;
  readonly turnaroundHours: number;
  readonly daysEngaged: number;
  readonly cost: Money;
  readonly costLabel: string;
  readonly limit: Money;
  readonly authorityNote: string;
  readonly reason: string;
}

export interface FreelanceEngagement extends FreelanceEngagementOffer {
  readonly engagementId: string;
  readonly caseReference: string;
  readonly engagedAt: string;
  readonly engagedBy: string;
  readonly expectedDecisionAt: string;
  readonly status: 'engaged' | 'reported' | 'released' | 'declined-by-panel';
  readonly report?: { readonly at: string; readonly recommendation: DecisionOutcome; readonly notes: string; readonly byFreelance: true };
}

export interface ReinsuranceAssistRequest {
  readonly requestId: string;
  readonly caseReference: string;
  readonly treatyId: string | null;
  readonly sumAssured: Money;
  readonly sumAssuredLabel: string;
  readonly cessionBps: number;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly questions: readonly string[];
  readonly expectedTurnaroundHours: number;
  readonly status: 'requested' | 'answered' | 'declined-to-quote';
  readonly answer?: { readonly at: string; readonly byReinsurer: string; readonly decision: 'accept' | 'accept-with-conditions' | 'decline'; readonly conditions: readonly string[] };
}

const HOURS_PER_DAY = 8;

/** How long the in-house desk needs before this case is read, in working hours. */
export function queueWaitHours(queue: UnderwritingQueue): number {
  const perDay = Math.max(1, queue.inHouseCapacityPerDay);
  const days = Math.ceil(queue.inHouseOpenCases / perDay);
  const hoursPerDay = Math.max(1, queue.workingHoursPerDay);
  return days * hoursPerDay + queue.oldestCaseHours;
}

export function addHours(at: string, hours: number): string {
  const base = new Date(at);
  if (Number.isNaN(base.getTime())) return at;
  return new Date(base.getTime() + hours * 3_600_000).toISOString();
}

/**
 * Decide the route. Every branch records the sentence that explains it, and the escalation path is
 * part of the answer rather than a later surprise.
 */
export function routeUnderwriting(input: RoutingInput): RoutingDecision {
  const limits = input.limits;
  const reasons: string[] = [];
  const escalations: string[] = [];
  const sa = input.sumAssured;

  const overAiLimit = sa.minor >= limits.aiStraightThroughMinor;
  const overBindingLimit = sa.minor >= limits.automaticBindingLimitMinor;
  const facultative = sa.minor >= limits.facultativeThresholdMinor || input.referrals.includes('reinsurance-desk');
  const overSeniorLimit = sa.minor >= limits.seniorUnderwriterLimitMinor;
  const heavyRating = input.extraMortalityBps >= limits.ratedReferralBps;
  const medicalOpen = input.outstandingMedical > 0;
  const referralPoints = input.referrals.filter((r) => r !== 'reinsurance-desk');

  let route: UnderwritingRoute;
  let automatic = false;

  if (input.outcome === 'declined' || input.outcome === 'postponed') {
    route = 'senior-referral';
    reasons.push(`The rules produced "${input.outcome}", and no automated path may decline or postpone a risk: a senior underwriter must take the decision and record the reason.`);
    escalations.push('chief-underwriter');
  } else if (facultative) {
    route = 'reinsurance-assist';
    reasons.push(`Sum assured ${formatAmount(sa)} reaches the facultative threshold of ${formatAmount(money(limits.facultativeThresholdMinor, limits.currency))}${input.referrals.includes('reinsurance-desk') ? ' and the reinsurance desk has been flagged by the rules' : ''}: the reinsurer's underwriter is asked before issue.`);
    escalations.push('senior-underwriter', 'chief-underwriter');
  } else if (medicalOpen) {
    route = 'manual-inhouse';
    reasons.push(`${input.outstandingMedical} medical requirement(s) are still outstanding; the case cannot be issued automatically until the evidence is received and reviewed.`);
    escalations.push('senior-underwriter');
  } else if (referralPoints.length > 0 || input.outcome === 'referred') {
    route = heavyRating || overSeniorLimit ? 'senior-review' : 'manual-inhouse';
    const authority = heavyRating
      ? `The loading of ${input.extraMortalityBps} bps is at or above the ${limits.ratedReferralBps} bps senior-review threshold, so a senior underwriter signs.`
      : overSeniorLimit
        ? `A sum assured of ${formatAmount(sa)} is at or above the senior underwriter limit of ${formatAmount(money(limits.seniorUnderwriterLimitMinor, limits.currency))}.`
        : 'An in-house underwriter reads it and records what was relied on.';
    reasons.push(`Referral point(s) on file: ${referralPoints.join(', ') || input.outcome}. ${authority}`);
    escalations.push('senior-underwriter', 'chief-underwriter');
  } else if (heavyRating || overSeniorLimit || input.occupationClass >= 4) {
    route = 'senior-review';
    reasons.push(heavyRating
      ? `Loading of ${input.extraMortalityBps} bps is at or above the ${limits.ratedReferralBps} bps senior-review threshold.`
      : overSeniorLimit
        ? `Sum assured ${formatAmount(sa)} is at or above the senior underwriter limit of ${formatAmount(money(limits.seniorUnderwriterLimitMinor, limits.currency))}.`
        : `Occupation class ${input.occupationClass} needs a senior underwriter's signature.`);
    escalations.push('chief-underwriter');
  } else if (!overAiLimit && referralPoints.length === 0 && input.extraMortalityBps === 0) {
    route = 'straight-through';
    automatic = true;
    reasons.push(`Standard risk, no loading, no referral and a sum assured of ${formatAmount(sa)} inside the ${formatAmount(money(limits.aiStraightThroughMinor, limits.currency))} straight-through limit: issued without a human decision.`);
    escalations.push('manual-inhouse (10% quality sample)');
  } else if (!overAiLimit && referralPoints.length === 0) {
    route = 'auto-rules';
    automatic = true;
    reasons.push(`Rules accepted the case with ${input.extraMortalityBps} bps of loading inside the ${formatAmount(money(limits.aiStraightThroughMinor, limits.currency))} straight-through limit: auto-bound and sampled for quality review.`);
    escalations.push('senior-underwriter (on sample failure)');
  } else if (!overBindingLimit) {
    route = 'manual-inhouse';
    reasons.push(`A sum assured of ${formatAmount(sa)} is above the ${formatAmount(money(limits.aiStraightThroughMinor, limits.currency))} straight-through limit, so no automatic path may bind it; an in-house underwriter does, inside the automatic binding limit of ${formatAmount(money(limits.automaticBindingLimitMinor, limits.currency))}.`);
    escalations.push('senior-underwriter');
  } else {
    route = 'senior-review';
    reasons.push(`Sum assured ${formatAmount(sa)} exceeds the automatic binding limit of ${formatAmount(money(limits.automaticBindingLimitMinor, limits.currency))}: a senior underwriter must bind it.`);
    escalations.push('chief-underwriter', 'reinsurance-desk');
  }

  const promised = input.queue.promisedDecisionHours;
  let expected = automatic ? 0 : queueWaitHours(input.queue);
  if (route === 'reinsurance-assist') expected = Math.max(expected, 24);

  let freelance: FreelanceEngagementOffer | null = null;
  if (!automatic && expected > promised) {
    const offer = offerFreelanceAssist({ ...input, neededWithinHours: promised });
    if (offer) {
      freelance = offer;
      if (route === 'reinsurance-assist') {
        // Capacity can be hired in to read the file, but the reinsurer's answer still governs the
        // issue date, so the promise is not met by the panel turnaround alone.
        reasons.push(`${offer.reason} The reinsurer's answer still governs when this may be issued.`);
      } else {
        route = 'freelance-assist';
        expected = Math.min(expected, offer.turnaroundHours);
        reasons.push(offer.reason);
      }
      escalations.push('senior-underwriter (reviews the freelance recommendation before issue)');
    } else {
      reasons.push(`The in-house queue needs about ${expected} hour(s) against a promise of ${promised}; no panel underwriter is available with the authority this case needs, so it escalates instead of waiting silently.`);
      escalations.push('chief-underwriter');
    }
  }

  const assignedTo = route === 'straight-through' ? 'rules-engine (no human)'
    : route === 'auto-rules' ? 'rules-engine (auto-bound)'
    : route === 'freelance-assist' && freelance ? `${freelance.name} (${freelance.underwriterId}) with senior-underwriter review`
    : route === 'reinsurance-assist' ? 'reinsurance underwriter, with senior-underwriter sign-off'
    : route === 'senior-review' || route === 'senior-referral' ? 'senior-underwriter'
    : 'in-house underwriter';

  return {
    caseReference: input.caseReference,
    route,
    automatic,
    assignedTo,
    headline: headlineFor(route, automatic, expected),
    reasons,
    escalations: [...new Set(escalations)],
    expectedDecisionHours: expected,
    promisedDecisionHours: promised,
    withinPromise: expected <= promised,
    reinsuranceAssist: route === 'reinsurance-assist' || input.referrals.includes('reinsurance-desk'),
    freelance,
    costEstimate: freelance ? freelance.cost : zeroMoney(limits.currency),
    costEstimateLabel: freelance ? freelance.costLabel : 'no external cost',
    decidedBy: assignedTo,
    decidedByAi: automatic,
  };
}

function headlineFor(route: UnderwritingRoute, automatic: boolean, hours: number): string {
  if (automatic) return 'Straight-through: no human decision needed, cover can be issued now.';
  const when = hours <= 0 ? 'now' : `in about ${hours} working hour(s)`;
  switch (route) {
    case 'manual-inhouse': return `Manual underwriting by the in-house desk, ${when}.`;
    case 'senior-review': return `Senior underwriter review, ${when}.`;
    case 'senior-referral': return `Referred to a senior underwriter — only a human may decline or postpone, ${when}.`;
    case 'freelance-assist': return `Freelance underwriter engaged to meet the promised decision time, ${when}.`;
    case 'reinsurance-assist': return `Reinsurer's underwriter asked before issue, ${when}.`;
    default: return `Routed ${route}, ${when}.`;
  }
}

function zeroMoney(currency: string): Money { return money(0n, currency); }

/** Pick the panel underwriter who can actually decide this case, cheapest first, and price the engagement. */
export function offerFreelanceAssist(input: {
  sumAssured: Money;
  occupationClass: OccupationClass;
  shariahProduct?: boolean;
  language?: string;
  neededWithinHours: number;
  at?: string;
}): FreelanceEngagementOffer | null {
  const candidates = FREELANCE_PANEL
    .filter((f) => f.available)
    .filter((f) => f.limitMinor >= input.sumAssured.minor)
    .filter((f) => f.maxOccupationClass >= input.occupationClass)
    .filter((f) => (input.shariahProduct ? f.shariahQualified : true))
    .filter((f) => (input.language && input.language !== 'en' ? f.languages.includes(input.language) : true))
    .filter((f) => f.turnaroundHours <= Math.max(1, input.neededWithinHours) + 24)
    .sort((a, b) => (a.turnaroundHours === b.turnaroundHours ? Number(a.dayRateMinor - b.dayRateMinor) : a.turnaroundHours - b.turnaroundHours));

  const chosen = candidates[0];
  if (!chosen) return null;
  const days = Math.max(1, Math.ceil(chosen.turnaroundHours / HOURS_PER_DAY));
  const cost = money(chosen.dayRateMinor * BigInt(days), input.sumAssured.currency);
  return {
    underwriterId: chosen.id, name: chosen.name, specialty: chosen.specialty,
    turnaroundHours: chosen.turnaroundHours, daysEngaged: days,
    cost, costLabel: formatAmount(cost),
    limit: money(chosen.limitMinor, input.sumAssured.currency),
    authorityNote: `Panel authority up to ${formatAmount(money(chosen.limitMinor, input.sumAssured.currency))} and occupation class ${chosen.maxOccupationClass}; anything above returns to the senior underwriter.`,
    reason: `The in-house queue cannot answer inside the promised ${input.neededWithinHours} hour(s), so ${chosen.name} (${chosen.specialty}, ${chosen.turnaroundHours}h turnaround) is engaged for ${days} day(s) at ${formatAmount(cost)}.`,
  };
}

/** The book of external engagements and reinsurance assist requests, so the cost is visible later. */
export class UnderwritingDesk {
  private readonly engagements = new Map<string, FreelanceEngagement>();
  private readonly assists = new Map<string, ReinsuranceAssistRequest>();
  private engageSeq = 0;
  private assistSeq = 0;

  constructor(private readonly limits: RoutingLimits) {}

  routingLimits(): RoutingLimits { return this.limits; }

  engageFreelance(input: {
    caseReference: string; offer: FreelanceEngagementOffer; at: string; by: string;
  }): FreelanceEngagement {
    const engagement: FreelanceEngagement = {
      ...input.offer,
      engagementId: `FUE-${String(++this.engageSeq).padStart(6, '0')}`,
      caseReference: input.caseReference,
      engagedAt: input.at,
      engagedBy: input.by,
      expectedDecisionAt: addHours(input.at, input.offer.turnaroundHours),
      status: 'engaged',
    };
    this.engagements.set(engagement.engagementId, engagement);
    return engagement;
  }

  freelanceReport(input: {
    engagementId: string; at: string; recommendation: DecisionOutcome; notes: string; by?: string;
  }): FreelanceEngagement {
    const engagement = this.engagements.get(input.engagementId);
    if (!engagement) throw new RoutingError(`unknown freelance engagement ${input.engagementId}`);
    if (input.notes.trim().length < 24) throw new RoutingError('a freelance underwriting report needs at least 24 characters of reasoning');
    const updated: FreelanceEngagement = {
      ...engagement, status: 'reported',
      report: { at: input.at, recommendation: input.recommendation, notes: input.notes.trim(), byFreelance: true },
    };
    this.engagements.set(updated.engagementId, updated);
    return updated;
  }

  releaseFreelance(engagementId: string): FreelanceEngagement {
    const engagement = this.engagements.get(engagementId);
    if (!engagement) throw new RoutingError(`unknown freelance engagement ${engagementId}`);
    const updated: FreelanceEngagement = { ...engagement, status: 'released' };
    this.engagements.set(engagementId, updated);
    return updated;
  }

  engagementsList(): FreelanceEngagement[] { return [...this.engagements.values()]; }

  externalCost(): Money {
    return this.engagementsList()
      .filter((e) => e.status !== 'declined-by-panel')
      .reduce((acc, e) => ({ minor: acc.minor + e.cost.minor, currency: acc.currency }), zeroMoney(this.limits.currency));
  }

  requestReinsuranceAssist(input: {
    caseReference: string; sumAssured: Money; treatyId?: string; cessionBps?: number;
    at: string; by: string; questions?: readonly string[]; expectedTurnaroundHours?: number;
  }): ReinsuranceAssistRequest {
    const request: ReinsuranceAssistRequest = {
      requestId: `RIA-${String(++this.assistSeq).padStart(6, '0')}`,
      caseReference: input.caseReference,
      treatyId: input.treatyId ?? null,
      sumAssured: input.sumAssured,
      sumAssuredLabel: formatAmount(input.sumAssured),
      cessionBps: input.cessionBps ?? 0,
      requestedAt: input.at,
      requestedBy: input.by,
      questions: input.questions?.length
        ? [...input.questions]
        : ['Will you accept this risk on the facultative basis, and on what terms?', `Cession sought: ${input.cessionBps ?? 0} bps of ${formatAmount(input.sumAssured)}.`],
      expectedTurnaroundHours: input.expectedTurnaroundHours ?? 24,
      status: 'requested',
    };
    this.assists.set(request.requestId, request);
    return request;
  }

  answerReinsuranceAssist(input: {
    requestId: string; at: string; byReinsurer: string; decision: 'accept' | 'accept-with-conditions' | 'decline'; conditions?: readonly string[];
  }): ReinsuranceAssistRequest {
    const request = this.assists.get(input.requestId);
    if (!request) throw new RoutingError(`unknown reinsurance assist request ${input.requestId}`);
    const updated: ReinsuranceAssistRequest = {
      ...request, status: input.decision === 'decline' ? 'declined-to-quote' : 'answered',
      answer: { at: input.at, byReinsurer: input.byReinsurer, decision: input.decision, conditions: input.conditions ?? [] },
    };
    this.assists.set(request.requestId, updated);
    return updated;
  }

  assistList(): ReinsuranceAssistRequest[] { return [...this.assists.values()]; }

  assistFor(caseReference: string): ReinsuranceAssistRequest | null {
    return this.assistList().find((a) => a.caseReference === caseReference) ?? null;
  }

  engagementFor(caseReference: string): FreelanceEngagement | null {
    return this.engagementsList().find((e) => e.caseReference === caseReference) ?? null;
  }
}
