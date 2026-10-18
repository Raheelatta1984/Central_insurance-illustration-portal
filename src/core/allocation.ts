/**
 * Allocation: the customer's money into funds, and the proceeds to beneficiaries.
 *
 * Both sides of a unit-linked sale are allocations, and both have the same failure mode — a set of
 * percentages that look plausible and do not add up. So the rule in this module is arithmetic, not
 * opinion: weights are basis points, they must total exactly 10,000, the money is split by largest
 * remainder so nothing is lost or invented, and a plan that does not balance reports itself as
 * incomplete rather than being quietly normalised.
 *
 * Post-issue the same module measures drift against the target weights the customer signed, because
 * "we invested it as agreed" is only true until the markets move.
 */
import { Money, add, allocate, compare, formatAmount, money, sub, zero } from './money.js';
import { Price, priceFromDecimal, unitsForAmount, unitsToDecimal } from './units.js';

export class AllocationError extends Error {}

export const TOTAL_WEIGHT_BPS = 10_000;
export const DEFAULT_DRIFT_TOLERANCE_BPS = 500;   // 5 percentage points away from target triggers a review
export const DEFAULT_REVIEW_MONTHS = 12;

export type RiskGrade = 'cautious' | 'balanced' | 'growth';

export interface FundOption {
  readonly fundId: string;
  readonly name: string;
  readonly currency: string;
  readonly shariahScreened: boolean;
  readonly riskGrade: RiskGrade;
  /** The published NAV per unit, in the console's display convention (minor units per unit). */
  readonly navPerUnit: number | string;
  /** The exact published price, when the caller has it: unit maths uses this, never the display string. */
  readonly price?: Price;
  readonly navDate: string;
  readonly fmcBpsAnnual: number;
  readonly minWeightBps?: number;
  readonly maxWeightBps?: number;
}

export interface AllocationLine {
  readonly fundId: string;
  readonly name: string;
  readonly weightBps: number;
  readonly weightPct: number;
  readonly amount: Money;
  readonly amountLabel: string;
  readonly units: string;
  readonly navPerUnit: string;
  readonly navDate: string;
  readonly shariahScreened: boolean;
  readonly riskGrade: RiskGrade;
  readonly fundManagementChargeBps: number;
}

export interface AllocationPlan {
  readonly currency: string;
  readonly investable: Money;
  readonly investableLabel: string;
  readonly lines: readonly AllocationLine[];
  readonly totalWeightBps: number;
  readonly allocatedTotal: Money;
  readonly balances: boolean;
  readonly weightedRiskScore: number;          // 0 = cautious, 2 = growth
  readonly weightedChargeBps: number;
  readonly appetite: RiskGrade | null;
  readonly appetiteAgrees: boolean | null;
  readonly shariahRequired: boolean;
  readonly shariahAgrees: boolean;
  readonly complete: boolean;
  readonly percent: number;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly acknowledgementsRequired: readonly string[];
}

const RISK_SCORE: Record<RiskGrade, number> = { cautious: 0, balanced: 1, growth: 2 };

function toBps(input: { weightBps?: number; weightPct?: number }): number {
  if (input.weightBps !== undefined) return Math.round(Number(input.weightBps));
  if (input.weightPct !== undefined) return Math.round(Number(input.weightPct) * 100);
  throw new AllocationError('each allocation line needs a weight in basis points or a percentage');
}

/**
 * Build the investment allocation. Weights are taken as given — the module never re-scales them to
 * make a plan "work", because a plan the customer did not choose is not the plan they were sold.
 */
export function allocateInvestment(input: {
  investable: Money;
  funds: readonly FundOption[];
  weights: ReadonlyArray<{ fundId: string; weightBps?: number; weightPct?: number }>;
  appetite?: RiskGrade;
  shariahRequired?: boolean;
}): AllocationPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const acknowledgements: string[] = [];
  const shariahRequired = input.shariahRequired ?? false;
  const currency = input.investable.currency;

  if (input.weights.length === 0) {
    blockers.push('No funds selected: an investment-linked plan needs at least one fund and its weight');
  }
  const seen = new Set<string>();
  for (const w of input.weights) {
    if (seen.has(w.fundId)) blockers.push(`Fund ${w.fundId} appears more than once in the allocation`);
    seen.add(w.fundId);
    const bps = toBps(w);
    if (bps <= 0) blockers.push(`Fund ${w.fundId} has a weight of ${bps} bps; weights must be positive`);
  }
  const totalWeightBps = input.weights.reduce((s, w) => s + toBps(w), 0);
  if (input.weights.length > 0 && totalWeightBps !== TOTAL_WEIGHT_BPS) {
    blockers.push(`Fund weights total ${totalWeightBps} bps (${(totalWeightBps / 100).toFixed(2)}%); they must total exactly ${TOTAL_WEIGHT_BPS} bps (100%)`);
  }

  const known = new Map(input.funds.map((f) => [f.fundId, f]));
  const lines: AllocationLine[] = [];
  const amounts = totalWeightBps > 0
    ? allocate(input.investable, input.weights.map((w) => Math.max(0, toBps(w))))
    : input.weights.map(() => zero(currency));

  for (let i = 0; i < input.weights.length; i += 1) {
    const w = input.weights[i]!;
    const fund = known.get(w.fundId);
    if (!fund) {
      blockers.push(`Unknown fund ${w.fundId} — it must be defined and have a published valuation before it can be selected`);
      continue;
    }
    const bps = toBps(w);
    if (fund.minWeightBps !== undefined && bps < fund.minWeightBps) {
      blockers.push(`${fund.name} has a minimum weight of ${fund.minWeightBps} bps; ${bps} bps was requested`);
    }
    if (fund.maxWeightBps !== undefined && bps > fund.maxWeightBps) {
      blockers.push(`${fund.name} has a maximum weight of ${fund.maxWeightBps} bps; ${bps} bps was requested`);
    }
    if (shariahRequired && !fund.shariahScreened) {
      blockers.push(`${fund.name} is not Shariah-screened and cannot be held in a takaful arrangement`);
    }
    if (input.appetite && RISK_SCORE[fund.riskGrade] > RISK_SCORE[input.appetite]) {
      warnings.push(`${fund.name} is graded "${fund.riskGrade}" while the customer's stated appetite is "${input.appetite}"`);
      acknowledgements.push(`The customer must acknowledge in writing that ${fund.name} carries more investment risk than the appetite recorded in the needs analysis.`);
    }
    const amount = amounts[i] ?? zero(currency);
    const price = fund.price ?? priceFromDecimal(String(fund.navPerUnit), fund.currency);
    const units = price.micro === 0n ? 0n : unitsForAmount(amount, price);
    lines.push({
      fundId: fund.fundId, name: fund.name, weightBps: bps, weightPct: bps / 100,
      amount, amountLabel: formatAmount(amount),
      units: unitsToDecimal(units), navPerUnit: String(fund.navPerUnit),
      navDate: fund.navDate, shariahScreened: fund.shariahScreened, riskGrade: fund.riskGrade,
      fundManagementChargeBps: fund.fmcBpsAnnual,
    });
  }

  const allocatedTotal = lines.reduce((acc, l) => add(acc, l.amount), zero(currency));
  const balances = compare(allocatedTotal, input.investable) === 0 && totalWeightBps === TOTAL_WEIGHT_BPS && blockers.length === 0;
  const weightedRiskScore = totalWeightBps === 0 ? 0
    : Math.round((lines.reduce((s, l) => s + RISK_SCORE[l.riskGrade] * l.weightBps, 0) / Math.max(1, totalWeightBps)) * 100) / 100;
  const weightedChargeBps = totalWeightBps === 0 ? 0
    : Math.round(lines.reduce((s, l) => s + l.fundManagementChargeBps * l.weightBps, 0) / Math.max(1, totalWeightBps));
  const appetiteAgrees = input.appetite === undefined ? null
    : weightedRiskScore <= RISK_SCORE[input.appetite] + 0.34 && warnings.filter((w) => w.includes('graded')).length === 0;

  const percent = input.weights.length === 0
    ? 0
    : Math.round((Math.min(totalWeightBps, TOTAL_WEIGHT_BPS) / TOTAL_WEIGHT_BPS) * 100);

  return {
    currency,
    investable: input.investable,
    investableLabel: formatAmount(input.investable),
    lines,
    totalWeightBps,
    allocatedTotal,
    balances,
    weightedRiskScore,
    weightedChargeBps,
    appetite: input.appetite ?? null,
    appetiteAgrees,
    shariahRequired,
    shariahAgrees: !shariahRequired || lines.every((l) => l.shariahScreened),
    complete: balances && blockers.length === 0,
    percent: blockers.length === 0 ? percent : Math.min(percent, 99),
    blockers,
    warnings,
    acknowledgementsRequired: [...new Set(acknowledgements)],
  };
}

/* ------------------------------------------------------------------ beneficiaries */

export interface BeneficiaryInput {
  readonly name: string;
  readonly relationship: string;
  readonly sharePct?: number;
  readonly shareBps?: number;
  readonly kind?: 'primary' | 'contingent';
  readonly dateOfBirth?: string;
  readonly idNumber?: string;
  readonly guardian?: string;
}

export interface BeneficiaryLine extends BeneficiaryInput {
  readonly kind: 'primary' | 'contingent';
  readonly shareBps: number;
  readonly sharePct: number;
  readonly age: number | null;
  readonly shareOfProceeds: Money | null;
}

export interface BeneficiarySet {
  readonly primaries: readonly BeneficiaryLine[];
  readonly contingents: readonly BeneficiaryLine[];
  readonly primaryTotalBps: number;
  readonly contingentTotalBps: number;
  readonly complete: boolean;
  readonly percent: number;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

function ageOn(dateOfBirth: string | undefined, asOf: string): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const ref = new Date(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const before = ref.getUTCMonth() < dob.getUTCMonth()
    || (ref.getUTCMonth() === dob.getUTCMonth() && ref.getUTCDate() < dob.getUTCDate());
  if (before) age -= 1;
  return age;
}

/**
 * Validate the beneficiary designation. Primary shares must total exactly 100%; a minor beneficiary
 * without a guardian is a blocker, because a claim paid to a child with no one authorised to receive
 * it is a claim that cannot be settled.
 */
export function validateBeneficiaries(input: {
  beneficiaries: readonly BeneficiaryInput[];
  proceeds?: Money;
  asOf?: string;
}): BeneficiarySet {
  const asOf = input.asOf ?? '2026-10-05';
  const blockers: string[] = [];
  const warnings: string[] = [];
  const primaries: BeneficiaryLine[] = [];
  const contingents: BeneficiaryLine[] = [];

  for (const b of input.beneficiaries) {
    const kind = b.kind ?? 'primary';
    const shareBps = b.shareBps !== undefined ? Math.round(b.shareBps) : Math.round((b.sharePct ?? 0) * 100);
    const name = b.name.trim();
    if (!name) blockers.push('A beneficiary with no name cannot be recorded');
    if (!b.relationship.trim()) blockers.push(`${name || 'Unnamed beneficiary'}: the relationship to the life assured is mandatory`);
    if (shareBps <= 0) blockers.push(`${name || 'Unnamed beneficiary'}: a share of ${shareBps} bps is not a designation`);
    const age = ageOn(b.dateOfBirth, asOf);
    if (age !== null && age < 18 && !b.guardian?.trim()) {
      blockers.push(`${name} is ${age} year(s) old: a minor beneficiary needs a named guardian or trustee to receive the proceeds`);
    }
    const line: BeneficiaryLine = {
      ...b, name, kind, shareBps, sharePct: shareBps / 100, age,
      shareOfProceeds: input.proceeds && shareBps > 0
        ? money((input.proceeds.minor * BigInt(shareBps)) / BigInt(TOTAL_WEIGHT_BPS), input.proceeds.currency)
        : null,
    };
    (kind === 'primary' ? primaries : contingents).push(line);
  }

  if (primaries.length === 0) blockers.push('At least one primary beneficiary is required');
  const primaryTotalBps = primaries.reduce((s, b) => s + b.shareBps, 0);
  if (primaries.length > 0 && primaryTotalBps !== TOTAL_WEIGHT_BPS) {
    blockers.push(`Primary beneficiary shares total ${primaryTotalBps} bps (${(primaryTotalBps / 100).toFixed(2)}%); they must total exactly ${TOTAL_WEIGHT_BPS} bps (100%)`);
  }
  const contingentTotalBps = contingents.reduce((s, b) => s + b.shareBps, 0);
  if (contingents.length > 0 && contingentTotalBps !== TOTAL_WEIGHT_BPS) {
    warnings.push(`Contingent shares total ${contingentTotalBps} bps; they only take effect if every primary beneficiary predeceases the life assured, and should total ${TOTAL_WEIGHT_BPS} bps`);
  }
  const names = new Map<string, number>();
  for (const b of primaries) names.set(b.name.toLowerCase(), (names.get(b.name.toLowerCase()) ?? 0) + 1);
  for (const [name, count] of names) {
    if (count > 1) warnings.push(`"${name}" appears ${count} times as a primary beneficiary — confirm this is two people and not a duplicate entry`);
  }

  const mandatory = Math.max(1, input.beneficiaries.length);
  const resolved = input.beneficiaries.filter((b) => b.name.trim() && b.relationship.trim() && (b.shareBps ?? (b.sharePct ?? 0) * 100) > 0).length;
  return {
    primaries, contingents, primaryTotalBps, contingentTotalBps,
    complete: blockers.length === 0 && primaries.length > 0 && primaryTotalBps === TOTAL_WEIGHT_BPS,
    percent: blockers.length === 0 && primaryTotalBps === TOTAL_WEIGHT_BPS && primaries.length > 0
      ? 100
      : Math.min(99, Math.round((resolved / mandatory) * 100)),
    blockers, warnings,
  };
}

/* ------------------------------------------------------------------ post-issue drift & progress */

export interface HoldingSnapshot {
  readonly fundId: string;
  readonly fundName: string;
  readonly units: string;
  readonly price: string;
  readonly value: Money;
  readonly priceAsOf: string;
}

export interface DriftLine {
  readonly fundId: string;
  readonly fundName: string;
  readonly targetBps: number;
  readonly actualBps: number;
  readonly driftBps: number;
  readonly value: Money;
  readonly valueLabel: string;
  readonly action: 'hold' | 'trim' | 'top-up';
}

export interface AllocationProgress {
  readonly policyId: string;
  readonly asOf: string;
  readonly commencement: string;
  readonly contributionsToDate: Money;
  readonly currentValue: Money;
  readonly gainLoss: Money;
  readonly gainLossPct: number;
  readonly holdings: readonly DriftLine[];
  readonly unallocated: Money;
  readonly maxDriftBps: number;
  readonly driftToleranceBps: number;
  readonly withinTolerance: boolean;
  readonly rebalanceRecommended: boolean;
  readonly rebalanceReason: string;
  readonly nextReviewDate: string;
  readonly reviewOverdue: boolean;
  readonly monthsInForce: number;
  readonly complete: boolean;
  readonly percent: number;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function addMonths(day: string, months: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), 28)));
  return target.toISOString().slice(0, 10);
}

/** Whole months elapsed: a month is not complete until its day-of-month has passed. */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(0, b.getUTCDate() < a.getUTCDate() ? months - 1 : months);
}

/**
 * Measure what the money actually did against what the customer signed up to: value, gain or loss,
 * drift per fund, and whether the periodic review is overdue. This is the "investment progress"
 * answer, and it is only honest if the drift is measured against the signed target weights.
 */
export function allocationProgress(input: {
  policyId: string;
  contributionsToDate: Money;
  holdings: readonly HoldingSnapshot[];
  targetWeights: ReadonlyArray<{ fundId: string; weightBps: number }>;
  commencement: string;
  asOf: string;
  driftToleranceBps?: number;
  reviewEveryMonths?: number;
}): AllocationProgress {
  const currency = input.contributionsToDate.currency;
  const tolerance = input.driftToleranceBps ?? DEFAULT_DRIFT_TOLERANCE_BPS;
  const reviewMonths = input.reviewEveryMonths ?? DEFAULT_REVIEW_MONTHS;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const currentValue = input.holdings.reduce((acc, h) => add(acc, h.value), zero(currency));
  const gainLoss = sub(currentValue, input.contributionsToDate);
  const gainLossPct = input.contributionsToDate.minor === 0n
    ? 0
    : Math.round((Number(gainLoss.minor) / Number(input.contributionsToDate.minor)) * 10000) / 100;

  const targetTotal = input.targetWeights.reduce((s, t) => s + t.weightBps, 0);
  if (input.targetWeights.length === 0) blockers.push('No target weights are recorded on the policy, so drift cannot be measured');
  else if (targetTotal !== TOTAL_WEIGHT_BPS) blockers.push(`Target weights on the policy total ${targetTotal} bps; they must total ${TOTAL_WEIGHT_BPS} bps`);

  const targets = new Map(input.targetWeights.map((t) => [t.fundId, t.weightBps]));
  const lines: DriftLine[] = input.holdings.map((h) => {
    const actualBps = currentValue.minor === 0n ? 0 : Math.round(Number((h.value.minor * BigInt(TOTAL_WEIGHT_BPS)) / currentValue.minor));
    const targetBps = targets.get(h.fundId) ?? 0;
    const driftBps = actualBps - targetBps;
    return {
      fundId: h.fundId, fundName: h.fundName, targetBps, actualBps, driftBps,
      value: h.value, valueLabel: formatAmount(h.value),
      action: Math.abs(driftBps) <= tolerance ? 'hold' : driftBps > 0 ? 'trim' : 'top-up',
    };
  });
  for (const [fundId, bps] of targets) {
    if (!input.holdings.some((h) => h.fundId === fundId) && bps > 0) {
      warnings.push(`Fund ${fundId} is a ${bps} bps target but holds no units — the allocation has not been invested as signed`);
    }
  }
  const allocated = lines.reduce((s, l) => add(s, l.value), zero(currency));
  const unallocated = sub(currentValue, allocated);
  const maxDriftBps = lines.reduce((m, l) => Math.max(m, Math.abs(l.driftBps)), 0);
  const withinTolerance = maxDriftBps <= tolerance;
  const rebalanceRecommended = !withinTolerance;

  const nextReviewDate = addMonths(input.commencement, reviewMonths);
  const reviewOverdue = input.asOf.slice(0, 10) > nextReviewDate;
  const monthsInForce = monthsBetween(input.commencement, input.asOf);

  if (stalePrices(input.holdings, input.asOf) > 0) {
    warnings.push(`${stalePrices(input.holdings, input.asOf)} holding(s) are priced before ${input.asOf.slice(0, 10)}; progress is measured at the last published valuation`);
  }

  const complete = blockers.length === 0 && input.holdings.length > 0 && currentValue.minor > 0n;
  const percent = complete ? (withinTolerance ? 100 : 90) : Math.min(99, Math.round((input.holdings.length / Math.max(1, input.targetWeights.length)) * 100));

  return {
    policyId: input.policyId, asOf: input.asOf, commencement: input.commencement,
    contributionsToDate: input.contributionsToDate, currentValue, gainLoss, gainLossPct,
    holdings: lines, unallocated, maxDriftBps, driftToleranceBps: tolerance, withinTolerance,
    rebalanceRecommended,
    rebalanceReason: rebalanceRecommended
      ? `Largest drift is ${maxDriftBps} bps against a tolerance of ${tolerance} bps: ${lines.filter((l) => l.action !== 'hold').map((l) => `${l.fundName} ${l.action}`).join(', ')}`
      : `Every fund is within ${tolerance} bps of its signed target weight`,
    nextReviewDate, reviewOverdue, monthsInForce, complete, percent, blockers, warnings,
  };
}

function stalePrices(holdings: readonly HoldingSnapshot[], asOf: string): number {
  return holdings.filter((h) => h.priceAsOf.slice(0, 10) < asOf.slice(0, 10)).length;
}

export { formatAmount, zero };
