/**
 * Decision theatre.
 *
 * What the market does not give a policyholder: the outcome of a decision, in their money,
 * before they make it. Every preview here is computed with the same pricing rules and charges
 * as the live engine, and every forward-looking number is labelled an illustration — never advice.
 */
import { Money, add, applyBps, compare, money, multiply, sub, zero, formatAmount } from './money.js';
import { Price, unitsForAmount, unitsToRealise, unitsToDecimal, valueOfUnits } from './units.js';
import { DealingPoint, NavEngine, resolveDealingPoint } from './fund.js';
import { ChargeSchedule, UnitLinkedEngine } from './unitlinked.js';

export interface ScenarioSet {
  readonly adverseBps: number;
  readonly centralBps: number;
  readonly favourableBps: number;
  readonly annualChargeDragBps: number;
}

export const DEFAULT_SCENARIOS: ScenarioSet = { adverseBps: 0, centralBps: 600, favourableBps: 1000, annualChargeDragBps: 150 };

export interface ProjectionRow {
  readonly year: number;
  readonly adverse: Money;
  readonly central: Money;
  readonly favourable: Money;
  readonly contributionsToDate: Money;
}

export interface Illustration {
  readonly isIllustration: true;
  readonly currency: string;
  readonly startValue: Money;
  readonly monthlyContribution: Money;
  readonly scenarios: ScenarioSet;
  readonly rows: ProjectionRow[];
  readonly disclaimer: string;
}

export class DecisionError extends Error {}

export function project(input: {
  startValue: Money;
  monthlyContribution?: Money;
  years: number;
  scenarios?: ScenarioSet;
  disclaimer: string;
}): Illustration {
  const s = input.scenarios ?? DEFAULT_SCENARIOS;
  const monthly = input.monthlyContribution ?? zero(input.startValue.currency);
  const rows: ProjectionRow[] = [];
  let adverse = input.startValue.minor;
  let central = input.startValue.minor;
  let favourable = input.startValue.minor;
  let contributed = input.startValue.minor;
  const netAnnual = (bps: number) => (BigInt(bps - s.annualChargeDragBps) * 100n) / 10000n; // per 100 units, per annum
  for (let year = 1; year <= input.years; year++) {
    for (let month = 0; month < 12; month++) {
      adverse += monthly.minor; central += monthly.minor; favourable += monthly.minor;
      contributed += monthly.minor;
      adverse = adverse + (adverse * netAnnual(s.adverseBps)) / 10000n;
      central = central + (central * netAnnual(s.centralBps)) / 10000n;
      favourable = favourable + (favourable * netAnnual(s.favourableBps)) / 10000n;
    }
    rows.push({
      year,
      adverse: money(adverse, input.startValue.currency),
      central: money(central, input.startValue.currency),
      favourable: money(favourable, input.startValue.currency),
      contributionsToDate: money(contributed, input.startValue.currency),
    });
  }
  return { isIllustration: true, currency: input.startValue.currency, startValue: input.startValue, monthlyContribution: monthly, scenarios: s, rows, disclaimer: input.disclaimer };
}

export interface SwitchPreview {
  readonly instructionType: 'switch';
  readonly from: { fundId: string; fundName: string; units: string; price: string; value: Money; valuationDate: string; explanation: string };
  readonly to: { fundId: string; fundName: string; price: string; valuationDate: string; unitsExpected: string; explanation: string };
  readonly fee: Money;
  readonly netInvested: Money;
  readonly illustration: Illustration;
  readonly blocked: string[];
}

export interface WithdrawalPreview {
  readonly instructionType: 'withdrawal';
  readonly fundId: string;
  readonly requested: Money;
  readonly unitsCancelled: string;
  readonly fee: Money;
  readonly gross: Money;
  readonly cashToCustomer: Money;
  readonly price: string;
  readonly valuationDate: string;
  readonly explanation: string;
  readonly remainingUnits: string;
  readonly remainingValue: Money;
  readonly lockInActive: boolean;
  readonly illustration: Illustration;
  readonly blocked: string[];
}

export class DecisionTheatre {
  constructor(
    private readonly nav: NavEngine,
    private readonly engine: UnitLinkedEngine,
    private readonly charges: ChargeSchedule,
  ) {}

  /** Where the money sits: units -> fund -> underlying instruments, with market prices. */
  penetration(policyId: string, valuationDate: string) {
    const value = this.engine.valueOf(policyId, valuationDate);
    return value.byFund.map((f) => ({
      ...f,
      lookThrough: this.nav.lookThrough(f.fundId, f.units, f.priceAsOf || valuationDate),
    }));
  }

  /**
   * The price an instruction will actually get. An instruction taken after the dealing cut-off rolls
   * to the next business day, whose valuation is not struck until that evening — a preview must still
   * answer, so it prices on the latest published valuation and says so in plain words. A fund with no
   * published valuation at all is a real failure and still throws.
   */
  private priceForPreview(fundId: string, valuationDate: string, blocked: string[]): Price {
    try {
      return this.nav.priceAt(fundId, valuationDate);
    } catch (err) {
      const published = this.nav.valuationHistory(fundId).filter((v) => v.valuationDate <= valuationDate).at(-1);
      if (!published) throw err;
      blocked.push(`${fundId}: the ${valuationDate} valuation is not published yet — priced on the ${published.valuationDate} valuation, the latest published`);
      return published.pricePerUnit;
    }
  }

  previewSwitch(input: { policyId: string; fromFundId: string; toFundId: string; amount?: Money; units?: bigint; instructionAt: string; disclaimer: string; lockInDate?: string }): SwitchPreview {
    const asOf = input.instructionAt.slice(0, 10);
    const fromFund = this.nav.fund(input.fromFundId);
    const toFund = this.nav.fund(input.toFundId);
    const dpFrom = resolveDealingPoint(fromFund.dealingRule, input.instructionAt, fromFund.calendar);
    const dpTo = resolveDealingPoint(toFund.dealingRule, input.instructionAt, toFund.calendar);
    const blocked: string[] = [];
    const priceFrom = this.priceForPreview(input.fromFundId, dpFrom.valuationDate, blocked);
    const priceTo = this.priceForPreview(input.toFundId, dpTo.valuationDate, blocked);
    const held = this.engine.unitsOf(input.policyId, input.fromFundId);
    const units = input.units ?? (input.amount ? unitsToRealise(input.amount, priceFrom) : 0n);
    const gross = valueOfUnits(units, priceFrom);
    const fee = applyBps(gross, this.charges.switchingFeeBps);
    const net = sub(gross, fee);
    const unitsIn = unitsForAmount(net, priceTo);
    if (units <= 0n) blocked.push('Specify an amount or a number of units to switch');
    if (units > held) blocked.push(`Only ${unitsToDecimal(held)} units are available in ${fromFund.name}`);
    if (input.lockInDate && input.lockInDate > asOf) blocked.push(`This plan is locked in until ${input.lockInDate}; switching before then is not permitted`);
    return {
      instructionType: 'switch',
      from: { fundId: fromFund.id, fundName: fromFund.name, units: unitsToDecimal(units), price: unitsToDecimal(priceFrom.micro), value: gross, valuationDate: dpFrom.valuationDate, explanation: dpFrom.explanation },
      to: { fundId: toFund.id, fundName: toFund.name, price: unitsToDecimal(priceTo.micro), valuationDate: dpTo.valuationDate, unitsExpected: unitsToDecimal(unitsIn), explanation: dpTo.explanation },
      fee, netInvested: net,
      illustration: project({ startValue: net, monthlyContribution: zero(net.currency), years: 10, disclaimer: input.disclaimer }),
      blocked,
    };
  }

  previewWithdrawal(input: { policyId: string; fundId: string; amount: Money; instructionAt: string; disclaimer: string; lockInDate?: string; minRemainingUnits?: bigint }): WithdrawalPreview {
    const asOf = input.instructionAt.slice(0, 10);
    const fund = this.nav.fund(input.fundId);
    const dp = resolveDealingPoint(fund.dealingRule, input.instructionAt, fund.calendar);
    const blocked: string[] = [];
    const price: Price = this.priceForPreview(input.fundId, dp.valuationDate, blocked);
    const fee = applyBps(input.amount, this.charges.partialWithdrawalFeeBps);
    const gross = add(input.amount, fee);
    const units = unitsToRealise(gross, price);
    const held = this.engine.unitsOf(input.policyId, input.fundId);
    const remainingUnits = held - units;
    if (units > held) blocked.push(`The withdrawal needs ${unitsToDecimal(units)} units but only ${unitsToDecimal(held)} are available`);
    if (input.lockInDate && input.lockInDate > asOf) blocked.push(`This plan is locked in until ${input.lockInDate}; partial withdrawal before then is not permitted`);
    if (input.minRemainingUnits !== undefined && remainingUnits < input.minRemainingUnits) {
      blocked.push(`Withdrawal would leave ${unitsToDecimal(remainingUnits)} units, below the plan minimum of ${unitsToDecimal(input.minRemainingUnits)}`);
    }
    return {
      instructionType: 'withdrawal', fundId: input.fundId, requested: input.amount,
      unitsCancelled: unitsToDecimal(units), fee, gross, cashToCustomer: input.amount,
      price: unitsToDecimal(price.micro), valuationDate: dp.valuationDate, explanation: dp.explanation,
      remainingUnits: unitsToDecimal(remainingUnits < 0n ? 0n : remainingUnits),
      remainingValue: valueOfUnits(remainingUnits < 0n ? 0n : remainingUnits, price),
      lockInActive: Boolean(input.lockInDate && input.lockInDate > asOf),
      illustration: project({ startValue: valueOfUnits(remainingUnits < 0n ? 0n : remainingUnits, price), monthlyContribution: zero(input.amount.currency), years: 10, disclaimer: input.disclaimer }),
      blocked,
    };
  }

  /** "Dream" projection: what the suggested portfolio would look like if the same money had gone there. */
  dreamProjection(input: { amount: Money; years: number; monthlyContribution?: Money; disclaimer: string; scenarios?: ScenarioSet }): Illustration {
    return project({ startValue: input.amount, monthlyContribution: input.monthlyContribution ?? zero(input.amount.currency), years: input.years, ...(input.scenarios ? { scenarios: input.scenarios } : {}), disclaimer: input.disclaimer });
  }
}

export { formatAmount, compare, multiply };
