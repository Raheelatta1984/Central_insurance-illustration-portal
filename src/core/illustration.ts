/**
 * The benefit illustration: what this policy is worth in year 10, 20, 30 and at the end of the term.
 *
 * A quotation that shows only tomorrow's premium is the complaint the industry is famous for. The
 * customer signs a twenty-year promise, so the document has to carry the whole promise: what they
 * pay, when they stop paying, what the cover is worth each year, and what they would get back if
 * they walked away. This module computes exactly that, and says exactly how it computed it.
 *
 * Three rules hold the module honest:
 *
 *  1. **Money is never a float and never compounds through one.** Growth is applied year by year in
 *     integer minor units with an explicit rounding mode (`applyBps`), so the same inputs produce
 *     the same row on every machine and in every currency — including the three-decimal ones.
 *  2. **The assumed rates are filed, not invented.** Three scenario rates (pessimistic, mid,
 *     optimistic) are read from a cascade: sub-channel → omni-channel → product → regulatory pack →
 *     the built-in floor. A level that is empty inherits from its parent, so "we only price this
 *     differently on the bank counter" is one row, not a copy of the whole table.
 *  3. **The years are the customer's years.** The term is the benefit term they selected and the
 *     payment term is the one they selected; where the two differ the illustration keeps running
 *     after the last premium, because that is the part of the promise that is easy to hide.
 *
 * The projection itself is deliberately simple and stated on the document: contributions are paid at
 * the start of the policy year, twelve months of cost of insurance and administration are deducted
 * at the same point, and the balance grows for the year at the assumed rate. It is a projection, not
 * a valuation, and the document says so in the pack's own wording.
 */
import { Money, add, applyBps, compare, formatAmount, max, money, multiply, sub, zero } from './money.js';

export class IllustrationError extends Error {}

/* ------------------------------------------------------------------ the rates */

/** One assumed annual growth rate per scenario, in basis points (800 = 8.00% a year). */
export interface IllustrationRates {
  readonly lowBps: number;
  readonly midBps: number;
  readonly highBps: number;
}

/** A filed row may set one, two or three of them; a figure left out is inherited from its parent. */
export interface PartialRates {
  readonly lowBps?: number;
  readonly midBps?: number;
  readonly highBps?: number;
}

export const RATE_FIELDS = ['lowBps', 'midBps', 'highBps'] as const;
export type RateField = (typeof RATE_FIELDS)[number];

/** The floor the cascade falls back to when nothing at all is filed: 4% / 8% / 12%. */
export const BUILT_IN_RATES: IllustrationRates = Object.freeze({ lowBps: 400, midBps: 800, highBps: 1200 });

export const MIN_RATE_BPS = 0;
export const MAX_RATE_BPS = 3_000;      // 30% a year: beyond this a projection is advertising

export const SCENARIO_LABELS: Record<RateField, string> = {
  lowBps: 'Pessimistic',
  midBps: 'Mid',
  highBps: 'Optimistic',
};

export function isPartialRates(value: unknown): value is PartialRates {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return RATE_FIELDS.some((f) => v[f] !== undefined);
}

/** Validate one rate. Throws with the sentence a setter needs, because "invalid" is not actionable. */
export function assertRate(field: RateField, bps: number): void {
  if (!Number.isFinite(bps)) throw new IllustrationError(`${SCENARIO_LABELS[field]} rate is not a number`);
  if (bps < MIN_RATE_BPS || bps > MAX_RATE_BPS) {
    throw new IllustrationError(`${SCENARIO_LABELS[field]} rate must sit between ${MIN_RATE_BPS / 100}% and ${MAX_RATE_BPS / 100}% a year, not ${bps / 100}%`);
  }
}

/** Three rates in order: a document that shows the optimistic figure below the pessimistic one lies. */
export function rateProblems(rates: IllustrationRates): string[] {
  const problems: string[] = [];
  if (rates.lowBps > rates.midBps) problems.push(`the pessimistic rate (${rateLabel(rates.lowBps)}) is above the mid rate (${rateLabel(rates.midBps)})`);
  if (rates.midBps > rates.highBps) problems.push(`the mid rate (${rateLabel(rates.midBps)}) is above the optimistic rate (${rateLabel(rates.highBps)})`);
  return problems;
}

export function rateLabel(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/* ------------------------------------------------------------------ where the rates are filed */

export type IllustrationLevel = 'product' | 'channel' | 'sub-channel';

export interface IllustrationScope {
  readonly productId: string;
  readonly channelCode?: string | null;
  readonly subChannelCode?: string | null;
}

export interface IllustrationAssumption extends IllustrationScope {
  readonly productId: string;
  readonly channelCode: string | null;
  readonly subChannelCode: string | null;
  readonly level: IllustrationLevel;
  readonly rates: PartialRates;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ResolvedRates {
  readonly rates: IllustrationRates;
  /** Which layer each figure came from — printed on the document, because an assumption must be owned. */
  readonly sources: Record<RateField, string>;
  /** The narrowest layer that set anything; `pack` or `built-in` when nothing was filed. */
  readonly level: IllustrationLevel | 'pack' | 'built-in';
  readonly problems: string[];
}

export interface AssumptionTrailEntry {
  readonly at: string;
  readonly by: string;
  readonly action: 'set' | 'cleared';
  readonly productId: string;
  readonly channelCode: string | null;
  readonly subChannelCode: string | null;
  readonly detail: string;
}

/** Codes are case-insensitive on the way in and stored upper-cased; an empty scope part is `*`. */
function clamp(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function orNull(value: string): string | null { return value === '' ? null : value; }

function scopeKey(productId: string | null | undefined, channelCode?: string | null, subChannelCode?: string | null): string {
  return [clamp(productId), clamp(channelCode) || '*', clamp(subChannelCode) || '*'].join('|');
}

function levelOf(channelCode: string | null, subChannelCode: string | null): IllustrationLevel {
  return subChannelCode ? 'sub-channel' : channelCode ? 'channel' : 'product';
}

/**
 * The filed rate table, keyed by how narrow the row is.
 *
 * Resolution walks narrowest to widest and merges field by field, so a sub-channel that overrides
 * only the optimistic rate keeps the product's pessimistic and mid figures. That is the whole point
 * of the cascade: an override is a difference from the parent, never a copy of it.
 */
export class IllustrationAssumptionTable {
  private readonly rows = new Map<string, IllustrationAssumption>();
  private readonly trail: AssumptionTrailEntry[] = [];

  /**
   * File a row. `lowBps`/`midBps`/`highBps` may each be left out, which means "inherit this one";
   * leaving all three out removes the row, because an empty row is not an override of anything.
   */
  set(input: IllustrationScope & PartialRates & { note?: string; at?: string; by?: string }): IllustrationAssumption | null {
    const productId = clamp(input.productId);
    if (!productId) throw new IllustrationError('an illustration rate row has to name the product it prices');
    const channelCode = orNull(clamp(input.channelCode));
    const subChannelCode = orNull(clamp(input.subChannelCode));
    if (subChannelCode && !channelCode) {
      throw new IllustrationError(`sub-channel ${subChannelCode} needs the omni-channel it sits under`);
    }
    const rates: PartialRates = {};
    const next: Record<string, number> = {};
    for (const field of RATE_FIELDS) {
      const value = input[field];
      if (value === undefined || value === null || (typeof value === 'string' && String(value).trim() === '')) continue;
      const bps = Number(value);
      assertRate(field, bps);
      next[field] = bps;
    }
    if (Object.keys(next).length === 0) {
      this.clear({ productId, channelCode, subChannelCode, at: input.at, by: input.by });
      return null;
    }
    const at = input.at?.trim() || new Date().toISOString();
    const by = input.by?.trim() || 'master-settings';
    const row: IllustrationAssumption = {
      productId, channelCode, subChannelCode, level: levelOf(channelCode, subChannelCode),
      rates: next as PartialRates, note: (input.note ?? '').trim(), updatedAt: at, updatedBy: by,
    };
    this.rows.set(scopeKey(productId, channelCode, subChannelCode), row);
    this.record('set', row, at, by, `filed ${RATE_FIELDS.filter((f) => next[f] !== undefined).map((f) => `${SCENARIO_LABELS[f]} ${rateLabel(next[f]!)}`).join(', ')}`);
    return row;
  }

  /** Remove a row so the scope falls back to its parent again. */
  clear(input: IllustrationScope & { at?: string; by?: string }): boolean {
    const productId = clamp(input.productId);
    const channelCode = orNull(clamp(input.channelCode));
    const subChannelCode = orNull(clamp(input.subChannelCode));
    const key = scopeKey(productId, channelCode, subChannelCode);
    const existing = this.rows.get(key);
    if (!existing) return false;
    this.rows.delete(key);
    this.record('cleared', existing, input.at?.trim() || new Date().toISOString(), input.by?.trim() || 'master-settings',
      'removed; this scope now inherits from its parent');
    return true;
  }

  list(): IllustrationAssumption[] {
    return [...this.rows.values()].sort((a, b) => scopeKey(a.productId, a.channelCode, a.subChannelCode)
      .localeCompare(scopeKey(b.productId, b.channelCode, b.subChannelCode)));
  }

  get(productId: string, channelCode?: string | null, subChannelCode?: string | null): IllustrationAssumption | null {
    return this.rows.get(scopeKey(productId, channelCode, subChannelCode)) ?? null;
  }

  /**
   * The rates for a scope: narrowest layer wins, field by field, and the pack is the last filed
   * word before the built-in floor. Every figure says where it came from.
   */
  /**
   * The rates in force for a scope, and where each figure came from.
   *
   * Five layers, narrowest first: the sub-channel row, the omni-channel row, the product row, the
   * pack the caller supplies, and the built-in floor beneath it. A figure is taken from the first
   * layer that states it, so filing one number on a counter does not quietly file three.
   */
  resolve(scope: IllustrationScope, packRates?: IllustrationRates): ResolvedRates {
    const productId = clamp(scope.productId);
    const channelCode = orNull(clamp(scope.channelCode));
    const subChannelCode = orNull(clamp(scope.subChannelCode));
    const layers: Array<{ level: IllustrationAssumption['level'] | 'pack' | 'built-in'; row: PartialRates | IllustrationRates; where: string }> = [];
    const sub = subChannelCode ? this.get(productId, channelCode, subChannelCode) : null;
    if (sub) layers.push({ level: 'sub-channel', row: sub.rates, where: `sub-channel ${subChannelCode}` });
    const channel = channelCode ? this.get(productId, channelCode, null) : null;
    if (channel) layers.push({ level: 'channel', row: channel.rates, where: `omni-channel ${channelCode}` });
    const product = this.get(productId, null, null);
    if (product) layers.push({ level: 'product', row: product.rates, where: 'the product master' });
    if (packRates) layers.push({ level: 'pack', row: packRates, where: 'the regulatory pack' });
    layers.push({ level: 'built-in', row: BUILT_IN_RATES, where: 'the built-in floor' });

    const out: Record<string, number> = {};
    const sources: Record<string, string> = {};
    for (const field of RATE_FIELDS) {
      const layer = layers.find((l) => (l.row as Record<string, number | undefined>)[field] !== undefined);
      const value = layer ? (layer.row as Record<string, number | undefined>)[field]! : BUILT_IN_RATES[field];
      out[field] = value;
      sources[field] = layer?.where ?? 'the built-in floor';
    }
    const rates = out as unknown as IllustrationRates;
    const filed = layers.find((l) => l.level === 'sub-channel' || l.level === 'channel' || l.level === 'product');
    return {
      rates,
      sources: sources as Record<RateField, string>,
      // With no pack supplied the figures came from the built-in floor, and the label must say so:
      // a quotation that names its source has to name the right one.
      level: filed?.level ?? (packRates ? 'pack' : 'built-in'),
      problems: rateProblems(rates),
    };
  }

  audit(limit = 12): AssumptionTrailEntry[] { return this.trail.slice(-limit).reverse(); }

  snapshot(): {
    rates: Array<IllustrationAssumption & { lowPct: string; midPct: string; highPct: string }>;
    audit: AssumptionTrailEntry[];
  } {
    return {
      rates: this.list().map((r) => ({
        ...r,
        lowPct: r.rates.lowBps === undefined ? 'inherited' : rateLabel(r.rates.lowBps),
        midPct: r.rates.midBps === undefined ? 'inherited' : rateLabel(r.rates.midBps),
        highPct: r.rates.highBps === undefined ? 'inherited' : rateLabel(r.rates.highBps),
      })),
      audit: this.audit(),
    };
  }

  private record(action: 'set' | 'cleared', row: IllustrationAssumption, at: string, by: string, detail: string): void {
    this.trail.push({
      at, by, action, productId: row.productId, channelCode: row.channelCode, subChannelCode: row.subChannelCode,
      detail: `${row.level} row for ${row.productId}${row.channelCode ? ` on ${row.channelCode}` : ''}${row.subChannelCode ? ` / ${row.subChannelCode}` : ''}: ${detail}`,
    });
    if (this.trail.length > 200) this.trail.splice(0, this.trail.length - 200);
  }
}

/* ------------------------------------------------------------------ the projection */

export type PaymentFrequency = 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'single';

export const PAYMENTS_PER_YEAR: Record<PaymentFrequency, number> = {
  monthly: 12, quarterly: 4, 'semi-annual': 2, annual: 1, single: 1,
};

export const FREQUENCY_LABEL: Record<PaymentFrequency, string> = {
  monthly: 'every month', quarterly: 'every quarter', 'semi-annual': 'every six months',
  annual: 'every year', single: 'in one single payment',
};

export interface IllustrationCharges {
  /** Taken from each contribution before it is invested, in basis points. */
  readonly allocationChargeBps: number;
  /** Cost of insurance, in per mille of the sum assured, every month. */
  readonly coiPerMilleMonthly: number;
  /** Policy administration fee, in minor units, every month. */
  readonly adminFeeMonthlyMinor: number;
  /** Surrender charge by policy year; the last figure repeats, and a year past the schedule is nil. */
  readonly surrenderChargeBpsByYear: readonly number[];
}

export interface IllustrationInput {
  readonly currency: string;
  readonly sumAssured: Money;
  readonly premiumPerFrequency: Money;
  readonly paymentFrequency: PaymentFrequency;
  /** How many years the customer pays for. Blank means "for the whole benefit term". */
  readonly premiumPayingTermYears: number;
  /** How many years the benefit runs for — the term the customer selected. */
  readonly benefitTermYears: number;
  readonly entryAge: number;
  readonly rates: IllustrationRates;
  readonly charges: IllustrationCharges;
  /** Investment-linked (unit-linked / family takaful) policies carry a fund value; term cover does not. */
  readonly investmentLinked: boolean;
  /** The age the illustration is carried to when the benefit runs past it (default 100). */
  readonly toAge?: number;
  readonly milestoneStepYears?: number;
  readonly generatedAt?: string;
  readonly rateSources?: Record<RateField, string>;
}

export interface IllustrationYearRow {
  readonly year: number;
  readonly age: number;
  readonly payingPremium: boolean;
  readonly premiumThisYear: Money;
  readonly cumulativePremium: Money;
  readonly allocatedThisYear: Money;
  readonly chargesThisYear: Money;
  /** Nil on a policy with no investment component. */
  readonly fundValue: { readonly low: Money; readonly mid: Money; readonly high: Money };
  readonly surrenderValue: { readonly low: Money; readonly mid: Money; readonly high: Money };
  readonly deathBenefit: { readonly low: Money; readonly mid: Money; readonly high: Money };
}

export interface IllustrationMilestone {
  readonly year: number;
  readonly age: number;
  readonly label: string;
  readonly row: IllustrationYearRow;
}

export interface IllustrationScenario {
  readonly field: RateField;
  readonly label: string;
  readonly rateBps: number;
  readonly source: string;
}

export interface BenefitIllustration {
  readonly currency: string;
  readonly generatedAt: string;
  readonly investmentLinked: boolean;
  readonly benefitTermYears: number;
  readonly premiumPayingTermYears: number;
  readonly paymentFrequency: PaymentFrequency;
  readonly paymentTermsLabel: string;
  readonly entryAge: number;
  readonly rows: readonly IllustrationYearRow[];
  readonly milestones: readonly IllustrationMilestone[];
  readonly scenarios: readonly IllustrationScenario[];
  readonly totals: {
    readonly premiumPayable: Money;
    readonly allocatedToFund: Money;
    readonly charges: Money;
  };
  readonly assumptions: readonly string[];
}

function surrenderChargeBps(charges: IllustrationCharges, policyYear: number): number {
  const schedule = charges.surrenderChargeBpsByYear;
  if (schedule.length === 0) return 0;
  const index = Math.min(Math.max(policyYear - 1, 0), schedule.length - 1);
  if (policyYear - 1 >= schedule.length) return 0;
  return schedule[index] ?? 0;
}

/** Customer-facing projection cadence: annual through ten, five-yearly thereafter, always ending at the selected horizon (at most 50). */
export function milestoneYears(input: {
  benefitTermYears: number; entryAge: number; toAge?: number; step?: number;
}): number[] {
  const end = Math.min(50, Math.max(0, Math.floor(input.benefitTermYears)));
  if (!end) return [];
  const years = new Set<number>();
  for (let year = 1; year <= Math.min(10, end); year++) years.add(year);
  for (let year = 15; year <= end; year += 5) years.add(year);
  years.add(end);
  return [...years].sort((a, b) => a - b);
}

/**
 * Project the policy year by year.
 *
 * One pass, three scenarios in parallel, exact integer money throughout:
 *
 *   value = (opening + contribution − allocation charge − twelve months of cost of insurance
 *            − twelve months of administration) × (1 + assumed rate)
 *
 * Contributions stop at the end of the premium paying term and the projection keeps running, so the
 * customer can see the years they pay for against the years they are covered for. The fund value is
 * floored at zero rather than allowed to go negative: a projection that says the customer owes the
 * insurer money is nonsense, and the assumption that keeps it honest (the policy stays in force) is
 * printed with the table.
 */
export function buildIllustration(input: IllustrationInput): BenefitIllustration {
  const currency = input.currency;
  if (input.benefitTermYears < 1) throw new IllustrationError('the benefit term has to be at least one year');
  if (input.premiumPayingTermYears < 0) throw new IllustrationError('the premium paying term cannot be negative');
  const problems = rateProblems(input.rates);
  if (problems.length > 0) throw new IllustrationError(`the illustration rates do not hold together: ${problems.join('; ')}`);

  const perYear = PAYMENTS_PER_YEAR[input.paymentFrequency] ?? 1;
  const payingTerm = input.premiumPayingTermYears > 0 ? Math.min(input.premiumPayingTermYears, input.benefitTermYears) : input.benefitTermYears;
  const single = input.paymentFrequency === 'single';
  const annualPremium = single
    ? input.premiumPerFrequency
    : multiply(input.premiumPerFrequency, perYear);

  // Cost of insurance: 1 per mille of the sum assured a month = 10 bps a month = 120 bps a year.
  const coiAnnual = applyBps(input.sumAssured, input.charges.coiPerMilleMonthly * 120);
  const adminAnnual = money(BigInt(input.charges.adminFeeMonthlyMinor) * 12n, currency);
  const annualCharges = add(coiAnnual, adminAnnual);

  const rows: IllustrationYearRow[] = [];
  const fund: Record<RateField, Money> = {
    lowBps: zero(currency), midBps: zero(currency), highBps: zero(currency),
  };
  let cumulativePremium = zero(currency);
  let totalAllocated = zero(currency);
  let totalCharges = zero(currency);

  for (let year = 1; year <= input.benefitTermYears; year += 1) {
    const paying = single ? year === 1 : year <= payingTerm;
    const premiumThisYear = paying ? annualPremium : zero(currency);
    const allocationCharge = paying ? applyBps(premiumThisYear, input.charges.allocationChargeBps) : zero(currency);
    const allocatedThisYear = sub(premiumThisYear, allocationCharge);
    const chargesThisYear = add(annualCharges, allocationCharge);

    cumulativePremium = add(cumulativePremium, premiumThisYear);
    totalAllocated = add(totalAllocated, allocatedThisYear);
    totalCharges = add(totalCharges, chargesThisYear);

    const values: Record<string, Money> = {};
    for (const field of RATE_FIELDS) {
      if (!input.investmentLinked) { values[field] = zero(currency); continue; }
      const opening = add(fund[field], allocatedThisYear);
      const afterCharges = sub(opening, annualCharges);
      const floored = afterCharges.minor < 0n ? zero(currency) : afterCharges;
      const grown = add(floored, applyBps(floored, input.rates[field]));
      fund[field] = grown;
      values[field] = grown;
    }
    const fundValue = values as unknown as Record<RateField, Money>;

    const surrenderBps = surrenderChargeBps(input.charges, year);
    const surrender: Record<string, Money> = {};
    const death: Record<string, Money> = {};
    for (const field of RATE_FIELDS) {
      const value = fundValue[field];
      const surrenderValue = input.investmentLinked ? sub(value, applyBps(value, surrenderBps)) : zero(currency);
      surrender[field] = surrenderValue.minor < 0n ? zero(currency) : surrenderValue;
      death[field] = input.investmentLinked ? max(input.sumAssured, value) : input.sumAssured;
    }

    rows.push({
      year, age: input.entryAge + year, payingPremium: paying,
      premiumThisYear, cumulativePremium, allocatedThisYear, chargesThisYear,
      fundValue: { low: fundValue.lowBps, mid: fundValue.midBps, high: fundValue.highBps },
      surrenderValue: { low: surrender.lowBps!, mid: surrender.midBps!, high: surrender.highBps! },
      deathBenefit: { low: death.lowBps!, mid: death.midBps!, high: death.highBps! },
    });
  }

  const years = milestoneYears({
    benefitTermYears: input.benefitTermYears, entryAge: input.entryAge,
    toAge: input.toAge, step: input.milestoneStepYears,
  });
  const toAge = input.toAge ?? 100;
  const milestones: IllustrationMilestone[] = years.map((year) => {
    const row = rows[year - 1]!;
    const age = input.entryAge + year;
    const label = year === input.benefitTermYears
      ? `End of the ${input.benefitTermYears}-year benefit term`
      : age >= toAge ? `At age ${age}` : `After ${year} year(s)`;
    return { year, age, label, row };
  });

  const scenarios: IllustrationScenario[] = RATE_FIELDS.map((field) => ({
    field, label: SCENARIO_LABELS[field], rateBps: input.rates[field],
    source: input.rateSources?.[field] ?? 'the filed rate table',
  }));

  const paymentTermsLabel = single
    ? `One single premium of ${formatAmount(input.premiumPerFrequency)}, paid once, for ${input.benefitTermYears} year(s) of cover.`
    : `${formatAmount(input.premiumPerFrequency)} ${FREQUENCY_LABEL[input.paymentFrequency]} for ${payingTerm} year(s), with cover running for ${input.benefitTermYears} year(s).`;

  const assumptions = [
    paymentTermsLabel,
    `Assumed growth, before charges: ${scenarios.map((s) => `${s.label.toLowerCase()} ${rateLabel(s.rateBps)}`).join(', ')}.`,
    input.investmentLinked
      ? `Allocation charge ${rateLabel(input.charges.allocationChargeBps)} of each contribution; cost of insurance (${input.charges.coiPerMilleMonthly} per mille of the sum assured a month) and the ${formatAmount(money(BigInt(input.charges.adminFeeMonthlyMinor), currency))} monthly administration fee are deducted, taken here at the start of each policy year.`
      : 'This policy has no investment component: the benefit shown is the guaranteed sum assured.',
    'Each year assumes the policy stays in force, every contribution is paid when due, and no withdrawal or switch is made.',
    'Projected values are not guaranteed. The value of units can fall as well as rise and past performance does not predict future returns.',
  ];

  return {
    currency,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    investmentLinked: input.investmentLinked,
    benefitTermYears: input.benefitTermYears,
    premiumPayingTermYears: payingTerm,
    paymentFrequency: input.paymentFrequency,
    paymentTermsLabel,
    entryAge: input.entryAge,
    rows,
    milestones,
    scenarios,
    totals: { premiumPayable: cumulativePremium, allocatedToFund: totalAllocated, charges: totalCharges },
    assumptions,
  };
}

/**
 * The illustration as rows of strings, ready for the PDF table and for the console grid. Money is
 * formatted once, here, so the document and the screen can never show different figures.
 */
export function illustrationRows(illustration: BenefitIllustration): {
  header: string[];
  rows: string[][];
  milestoneHeader: string[];
  milestoneRows: string[][];
} {
  const money_ = (m: Money): string => (m.minor === 0n && !illustration.investmentLinked ? '—' : formatAmount(m));
  const header = illustration.investmentLinked
    ? ['Year', 'Age', 'Premium', 'Cum. paid', 'Fund low', 'Fund mid', 'Fund high', 'Surrender', 'Death benefit']
    : ['Year', 'Age', 'Premium', 'Cum. paid', 'Benefit', 'Charges'];
  const rows = illustration.rows.map((r) => (illustration.investmentLinked
    ? [
      String(r.year), String(r.age), money_(r.premiumThisYear), money_(r.cumulativePremium),
      money_(r.fundValue.low), money_(r.fundValue.mid), money_(r.fundValue.high),
      money_(r.surrenderValue.mid), money_(r.deathBenefit.mid),
    ]
    : [
      String(r.year), String(r.age), money_(r.premiumThisYear), money_(r.cumulativePremium),
      money_(r.deathBenefit.mid), money_(r.chargesThisYear),
    ]));

  const milestoneHeader = illustration.investmentLinked
    ? ['Milestone', 'Year', 'Age', 'Premiums paid', 'Fund low', 'Fund mid', 'Fund high', 'On death']
    : ['Milestone', 'Year', 'Age', 'Premiums paid', 'Benefit'];
  const milestoneRows = illustration.milestones.map((m) => (illustration.investmentLinked
    ? [
      m.label, String(m.year), String(m.age), money_(m.row.cumulativePremium),
      money_(m.row.fundValue.low), money_(m.row.fundValue.mid), money_(m.row.fundValue.high),
      money_(m.row.deathBenefit.mid),
    ]
    : [m.label, String(m.year), String(m.age), money_(m.row.cumulativePremium), money_(m.row.deathBenefit.mid)]));

  return { header, rows, milestoneHeader, milestoneRows };
}

/** The figures without the currency, for a table whose note already says which currency it is in. */
function compact(m: Money): string {
  return formatAmount(m).replace(/\s[A-Z]{3}$/, '');
}

export interface IllustrationTableColumn { readonly header: string; readonly width: number; readonly align: 'left' | 'right' }

export interface IllustrationTable {
  readonly columns: readonly IllustrationTableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly note: string;
}

/** Column widths come from the widest figure in them, so a short term is not padded out to a long one. */
function toTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>, align: readonly ('left' | 'right')[], note: string): IllustrationTable {
  const columns = header.map((title, i) => ({
    header: title,
    align: align[i] ?? 'left',
    width: Math.min(30, Math.max(title.length, ...rows.map((r) => (r[i] ?? '').length))),
  })) as IllustrationTableColumn[];
  return { columns, rows, note };
}

/**
 * The two tables the document prints: the milestones the customer will actually look at, and the
 * year-by-year schedule behind them. Both use the same figures, formatted once.
 */
export function illustrationTables(illustration: BenefitIllustration): {
  milestones: IllustrationTable;
  yearly: IllustrationTable;
  currencyNote: string;
} {
  const currencyNote = `All figures are in ${illustration.currency}. ${illustration.assumptions.join(' ')}`;
  if (!illustration.investmentLinked) {
    const head = ['Milestone', 'Year', 'Age', 'Premiums paid', 'On death'];
    const align = ['left', 'right', 'right', 'right', 'right'] as const;
    return {
      currencyNote,
      milestones: toTable(head, illustration.milestones.map((m) => [
        m.label, String(m.year), String(m.age), compact(m.row.cumulativePremium), compact(m.row.deathBenefit.mid),
      ]), align, currencyNote),
      yearly: toTable(['Year', 'Age', 'Premium', 'Cum. paid', 'On death'],
        illustration.rows.map((r) => [String(r.year), String(r.age), compact(r.premiumThisYear), compact(r.cumulativePremium), compact(r.deathBenefit.mid)]),
        ['right', 'right', 'right', 'right', 'right'], currencyNote),
    };
  }
  return {
    currencyNote,
    milestones: toTable(
      ['Milestone', 'Year', 'Age', 'Premiums paid', 'Fund low', 'Fund mid', 'Fund high', 'On death'],
      illustration.milestones.map((m) => [
        m.label, String(m.year), String(m.age), compact(m.row.cumulativePremium),
        compact(m.row.fundValue.low), compact(m.row.fundValue.mid), compact(m.row.fundValue.high),
        compact(m.row.deathBenefit.mid),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      currencyNote,
    ),
    yearly: toTable(
      ['Year', 'Age', 'Premium', 'Cum. paid', 'Fund low', 'Fund mid', 'Fund high', 'Surrender', 'On death'],
      illustration.rows.map((r) => [
        String(r.year), String(r.age),
        r.payingPremium ? compact(r.premiumThisYear) : '—', compact(r.cumulativePremium),
        compact(r.fundValue.low), compact(r.fundValue.mid), compact(r.fundValue.high),
        compact(r.surrenderValue.mid), compact(r.deathBenefit.mid),
      ]),
      ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      currencyNote,
    ),
  };
}

/**
 * The illustration as the console and the API carry it: money already formatted, so no screen ever
 * re-formats a number the engine has decided, and no bigint crosses a JSON boundary as a number.
 */
export interface IllustrationView {
  readonly currency: string;
  readonly headline: string;
  readonly paymentTermsLabel: string;
  readonly assumptions: readonly string[];
  readonly scenarios: ReadonlyArray<{ readonly label: string; readonly rate: string; readonly source: string }>;
  readonly milestoneHeader: readonly string[];
  readonly milestones: ReadonlyArray<{ readonly label: string; readonly year: number; readonly age: number; readonly values: readonly string[] }>;
  readonly yearlyHeader: readonly string[];
  readonly yearly: ReadonlyArray<readonly string[]>;
  readonly investmentLinked: boolean;
}

export function illustrationView(illustration: BenefitIllustration): IllustrationView {
  const { header, rows, milestoneHeader, milestoneRows } = illustrationRows(illustration);
  return {
    currency: illustration.currency,
    headline: illustrationHeadline(illustration),
    paymentTermsLabel: illustration.paymentTermsLabel,
    assumptions: illustration.assumptions,
    scenarios: illustration.scenarios.map((s) => ({ label: s.label, rate: rateLabel(s.rateBps), source: s.source })),
    milestoneHeader,
    // The row is [label, year, age, ...figures]: the figures start after the three lead columns, so
    // a table that renders the label, the year and the age itself does not print them twice.
    milestones: illustration.milestones.map((m, i) => ({
      label: m.label, year: m.year, age: m.age, values: milestoneRows[i]!.slice(3),
    })),
    yearlyHeader: header,
    yearly: rows,
    investmentLinked: illustration.investmentLinked,
  };
}

/** The one-line figure a card or an email body quotes: the mid scenario at the end of the term. */
export function illustrationHeadline(illustration: BenefitIllustration): string {
  const last = illustration.milestones.at(-1);
  if (!last) return 'no projection';
  if (!illustration.investmentLinked) {
    return `${formatAmount(last.row.deathBenefit.mid)} of cover at ${last.label.toLowerCase()} for ${formatAmount(last.row.cumulativePremium)} of premiums paid.`;
  }
  return `${formatAmount(last.row.fundValue.mid)} projected at the mid rate, ${formatAmount(last.row.fundValue.low)} to ${formatAmount(last.row.fundValue.high)} across the three scenarios, at ${last.label.toLowerCase()}.`;
}

/** True when the illustration covers the term the customer is buying — a projection that stops early hides the cost. */
export function illustrationCoversTerm(illustration: BenefitIllustration): boolean {
  return illustration.rows.length === illustration.benefitTermYears
    && compare(illustration.rows.at(-1)?.cumulativePremium ?? zero(illustration.currency), illustration.totals.premiumPayable) === 0;
}
