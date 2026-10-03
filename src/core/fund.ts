/**
 * Fund management and NAV.
 *
 * A fund is a ring-fenced pool with its own dealing calendar, valuation point and unit price.
 * The engine computes NAV per unit from assets, liabilities and units in issue, keeps the
 * rounding residual in a named account (never quietly lost), publishes valuations, and can
 * revise them (a revision never erases the original — it produces a compensating adjustment).
 */
import { Money, add, compare, money, sub, zero, applyBps } from './money.js';
import { Price, PRICE_SCALE, UNITS_SCALE, priceFromDecimal, unitsToDecimal, valueOfUnits } from './units.js';

export interface BusinessCalendar {
  /** ISO dates that are not business days in addition to weekends. */
  readonly holidays: readonly string[];
  readonly weekend: readonly number[]; // 0 = Sunday
}

export const DEFAULT_CALENDAR: BusinessCalendar = { holidays: [], weekend: [0, 6] };

export interface DealingRule {
  /** Local time of the dealing cut-off, "HH:MM". */
  readonly cutoff: string;
  /** Offset in minutes from UTC for the market's local time (e.g. Dubai +240). */
  readonly utcOffsetMinutes: number;
  /** What happens to instructions received after the cut-off. */
  readonly afterCutoff: 'next-business-day';
}

export interface DealingPoint {
  readonly valuationDate: string;   // ISO date whose price applies
  readonly instructionAt: string;
  readonly sameDay: boolean;
  readonly rule: DealingRule;
  readonly explanation: string;
}

export interface FundDef {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly pricingBasis: 'single' | 'bid-offer';
  readonly dealingRule: DealingRule;
  readonly calendar: BusinessCalendar;
  /** Annual fund management charge in basis points — accrued as a fund liability before pricing. */
  readonly fmcBpsAnnual: number;
  readonly benchmark?: string;
  readonly shariahScreened: boolean;
  readonly composition: ReadonlyArray<{ instrumentId: string; weightBps: number }>;
}

export interface Valuation {
  readonly fundId: string;
  readonly valuationDate: string;
  readonly grossAssets: Money;
  readonly liabilities: Money;
  readonly netAssetValue: Money;
  readonly unitsInIssue: bigint;
  readonly pricePerUnit: Price;
  readonly residual: Money;          // NAV that could not be expressed by the rounded price
  readonly source: string;
  readonly publishedAt: string;
  readonly revisionOf?: string;
}

export class FundError extends Error {}

export function isBusinessDay(day: string, cal: BusinessCalendar): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new FundError(`bad date ${day}`);
  return !cal.weekend.includes(d.getUTCDay()) && !cal.holidays.includes(day);
}

/** The first business day strictly AFTER the given date. */
export function nextBusinessDay(day: string, cal: BusinessCalendar): string {
  let d = new Date(`${day}T00:00:00Z`);
  for (let i = 0; i < 400; i++) {
    d = new Date(d.getTime() + 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    if (isBusinessDay(iso, cal)) return iso;
  }
  throw new FundError('no business day found');
}

export function addBusinessDays(day: string, n: number, cal: BusinessCalendar): string {
  let iso = day;
  for (let i = 0; i < n; i++) iso = nextBusinessDay(iso, cal);
  return iso;
}

/**
 * Resolve an instruction timestamp to a valuation date.
 * This is the rule regulators test first, so it is deliberately explicit and explained.
 */
export function resolveDealingPoint(rule: DealingRule, instructionAt: string, cal: BusinessCalendar): DealingPoint {
  const at = new Date(instructionAt);
  if (Number.isNaN(at.getTime())) throw new FundError(`bad timestamp ${instructionAt}`);
  const localMs = at.getTime() + rule.utcOffsetMinutes * 60_000;
  const local = new Date(localMs);
  const localDay = local.toISOString().slice(0, 10);
  const [hh, mm] = rule.cutoff.split(':').map((n) => Number(n));
  const cutoffMinutes = hh! * 60 + mm!;
  const localMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const beforeCutoff = localMinutes < cutoffMinutes;
  const day = isBusinessDay(localDay, cal) ? localDay : nextBusinessDay(localDay, cal);
  if (beforeCutoff && isBusinessDay(localDay, cal)) {
    return {
      valuationDate: day, instructionAt, sameDay: true, rule,
      explanation: `Received ${local.toISOString().slice(11, 16)} local, before the ${rule.cutoff} cut-off, on a business day: same-day closing price.`,
    };
  }
  const rolled = isBusinessDay(localDay, cal) ? nextBusinessDay(localDay, cal) : day;
  return {
    valuationDate: rolled, instructionAt, sameDay: false, rule,
    explanation: beforeCutoff
      ? `Non-business day (${localDay}): next dealing day ${rolled}.`
      : `Received ${local.toISOString().slice(11, 16)} local, at or after the ${rule.cutoff} cut-off: next dealing day ${rolled}.`,
  };
}

export interface Instrument { readonly id: string; readonly name: string; readonly assetClass: string; readonly isin?: string; readonly shariahScreened: boolean; }

export interface MarketPrice { readonly instrumentId: string; readonly asOf: string; readonly price: number; readonly currency: string }

export class NavEngine {
  private readonly funds = new Map<string, FundDef>();
  private readonly valuations = new Map<string, Valuation[]>();   // fundId -> ordered history
  private readonly instruments = new Map<string, Instrument>();
  private readonly marketPrices: MarketPrice[] = [];

  defineFund(f: FundDef): FundDef {
    if (this.funds.has(f.id)) throw new FundError(`fund ${f.id} already defined`);
    this.funds.set(f.id, f);
    this.valuations.set(f.id, []);
    return f;
  }

  defineInstrument(i: Instrument): Instrument { this.instruments.set(i.id, i); return i; }
  instrument(id: string): Instrument { const i = this.instruments.get(id); if (!i) throw new FundError(`unknown instrument ${id}`); return i; }
  recordMarketPrice(p: MarketPrice): void { this.marketPrices.push(p); }
  priceOf(instrumentId: string, asOf: string): MarketPrice {
    const found = [...this.marketPrices].filter((p) => p.instrumentId === instrumentId && p.asOf <= asOf).pop();
    if (!found) throw new FundError(`no market price for ${instrumentId} as of ${asOf}`);
    return found;
  }

  fund(id: string): FundDef { const f = this.funds.get(id); if (!f) throw new FundError(`unknown fund ${id}`); return f; }
  listFunds(): FundDef[] { return [...this.funds.values()]; }

  /** Publish a valuation: price = (assets - liabilities) / units, residual kept explicitly. */
  publishValuation(input: Omit<Valuation, 'pricePerUnit' | 'residual' | 'netAssetValue' | 'publishedAt'> & { publishedAt?: string }): Valuation {
    const fund = this.fund(input.fundId);
    if (!isBusinessDay(input.valuationDate, fund.calendar)) throw new FundError(`valuation date ${input.valuationDate} is not a dealing day for ${fund.id}`);
    if (input.grossAssets.currency !== fund.currency || input.liabilities.currency !== fund.currency) {
      throw new FundError('valuation currency must match fund currency');
    }
    if (input.unitsInIssue <= 0n) throw new FundError('cannot price a fund with no units in issue');
    const nav = sub(input.grossAssets, input.liabilities);
    const micro = (nav.minor * PRICE_SCALE * UNITS_SCALE) / input.unitsInIssue; // floor: never round a price up against policyholders
    const price: Price = { micro, currency: fund.currency };
    const represented = valueOfUnits(input.unitsInIssue, price);
    const residual = sub(nav, represented);
    const valuation: Valuation = {
      ...input,
      netAssetValue: nav,
      pricePerUnit: price,
      residual,
      publishedAt: input.publishedAt ?? new Date().toISOString(),
    };
    this.valuations.get(fund.id)!.push(valuation);
    return valuation;
  }

  latestValuation(fundId: string): Valuation | undefined { return this.valuations.get(fundId)?.at(-1); }
  valuationHistory(fundId: string): readonly Valuation[] { return this.valuations.get(fundId) ?? []; }

  priceAt(fundId: string, valuationDate: string): Price {
    const v = this.valuationHistory(fundId).find((x) => x.valuationDate === valuationDate && !x.revisionOf);
    const revised = this.valuationHistory(fundId).filter((x) => x.valuationDate === valuationDate).at(-1);
    const use = revised ?? v;
    if (!use) throw new FundError(`no published valuation for ${fundId} on ${valuationDate}`);
    return use.pricePerUnit;
  }

  valuationOn(fundId: string, valuationDate: string): Valuation {
    const list = this.valuationHistory(fundId).filter((x) => x.valuationDate === valuationDate);
    const last = list.at(-1);
    if (!last) throw new FundError(`no valuation for ${fundId} on ${valuationDate}`);
    return last;
  }

  /** How stale is the price we would use on a given date? Zero means same day. */
  stalenessDays(fundId: string, asOf: string): number {
    const hist = this.valuationHistory(fundId).filter((v) => v.valuationDate <= asOf);
    const last = hist.at(-1);
    if (!last) return Number.POSITIVE_INFINITY;
    const a = new Date(`${last.valuationDate}T00:00:00Z`).getTime();
    const b = new Date(`${asOf}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86_400_000);
  }

  /** Accrue the fund management charge as a fund liability for a period (days). */
  accrueFmc(fundId: string, grossAssets: Money, days: number): Money {
    const fund = this.fund(fundId);
    const daily = applyBps(grossAssets, fund.fmcBpsAnnual / 365, 'half-up');
    return money(daily.minor * BigInt(days), fund.currency);
  }

  /**
   * Penetration: where does a policyholder's money actually sit?
   * units -> fund -> instruments (weights) -> market price and value.
   */
  lookThrough(fundId: string, units: bigint, valuationDate: string): Array<{
    instrument: Instrument; weightBps: number; value: Money; marketPrice: number; marketAsOf: string;
  }> {
    const fund = this.fund(fundId);
    const price = this.priceAt(fundId, valuationDate);
    const total = valueOfUnits(units, price);
    return fund.composition.map((c) => {
      const instrument = this.instrument(c.instrumentId);
      const best = [...this.marketPrices].filter((p) => p.instrumentId === c.instrumentId && p.asOf <= valuationDate).pop();
      return {
        instrument,
        weightBps: c.weightBps,
        value: money((total.minor * BigInt(c.weightBps)) / 10000n, fund.currency),
        marketPrice: best?.price ?? 0,
        marketAsOf: best?.asOf ?? valuationDate,
      };
    });
  }

  /** Total weight sanity check used by the fund setup screen. */
  compositionWarnings(fundId: string): string[] {
    const fund = this.fund(fundId);
    const total = fund.composition.reduce((s, c) => s + c.weightBps, 0);
    const out: string[] = [];
    if (total !== 10000) out.push(`composition weights sum to ${total} bps, expected 10000`);
    if (fund.shariahScreened) {
      for (const c of fund.composition) {
        if (!this.instrument(c.instrumentId).shariahScreened) out.push(`${c.instrumentId} is not Shariah-screened but the fund is`);
      }
    }
    return out;
  }

  /** Simple point-to-point return between two published valuations. */
  performance(fundId: string, fromDate: string, toDate: string): number | undefined {
    const from = this.valuationHistory(fundId).find((v) => v.valuationDate === fromDate);
    const to = this.valuationHistory(fundId).filter((v) => v.valuationDate === toDate).at(-1);
    if (!from || !to) return undefined;
    const a = Number(from.pricePerUnit.micro);
    const b = Number(to.pricePerUnit.micro);
    if (a === 0) return undefined;
    return (b - a) / a;
  }

  /** Unit reconciliation for a fund on a date: NAV = units x price + residual. */
  reconcile(fundId: string, valuationDate: string): { ok: boolean; detail: string; nav: Money; represented: Money; residual: Money; units: string } {
    const v = this.valuationOn(fundId, valuationDate);
    const represented = valueOfUnits(v.unitsInIssue, v.pricePerUnit);
    const ok = compare(add(represented, v.residual), v.netAssetValue) === 0;
    return {
      ok,
      detail: ok
        ? `NAV ${v.netAssetValue.minor} = units ${unitsToDecimal(v.unitsInIssue)} x price + residual ${v.residual.minor}`
        : 'NAV does not reconcile to units x price + residual',
      nav: v.netAssetValue, represented, residual: v.residual, units: unitsToDecimal(v.unitsInIssue),
    };
  }
}

export function singlePriceFund(fundId: string, name: string, currency: string, opts: Partial<FundDef> = {}): FundDef {
  return {
    id: fundId, name, currency, pricingBasis: 'single',
    dealingRule: { cutoff: '15:00', utcOffsetMinutes: 240, afterCutoff: 'next-business-day' },
    calendar: DEFAULT_CALENDAR, fmcBpsAnnual: 150, shariahScreened: false, composition: [],
    ...opts,
  };
}

export { priceFromDecimal, valueOfUnits };
