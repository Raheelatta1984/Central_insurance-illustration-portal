/**
 * The unit-linked engine — the heart of the platform.
 *
 * Every money movement resolves an instruction to a dealing point, prices it, moves units, and
 * posts a balanced journal. Nothing is hidden: a policy's value can be reproduced line by line
 * from its transaction log, which is what makes the customer-facing transparency honest.
 */
import { Ledger, posting } from './ledger.js';
import { Chart } from './chart.js';
import { Money, add, applyBps, compare, money, multiply, sub, zero, formatAmount } from './money.js';
import { Price, UNITS_SCALE, unitsForAmount, unitsToRealise, unitsToDecimal, valueOfUnits } from './units.js';
import { DealingPoint, NavEngine, resolveDealingPoint } from './fund.js';

export type UnitTxnType =
  | 'allocation' | 'topup' | 'charge' | 'switch-out' | 'switch-in'
  | 'withdrawal' | 'surrender' | 'rebalance-out' | 'rebalance-in' | 'correction';

export interface ChargeLine { readonly code: string; readonly amount: Money; readonly basis: string }

export interface UnitTransaction {
  readonly id: string;
  readonly policyId: string;
  readonly type: UnitTxnType;
  readonly fundId: string;
  readonly units: bigint;              // signed: positive allocates, negative cancels
  readonly pricePerUnit: Price;
  readonly value: Money;               // units x price at the time
  readonly charges: readonly ChargeLine[];
  readonly instructionAt: string;
  readonly dealingPoint: DealingPoint;
  readonly journalIds: readonly string[];
  /** The single instruction id a multi-leg transaction (for example a switch) belongs to. */
  readonly instructionId?: string;
  readonly note: string;
}

export interface ChargeSchedule {
  readonly allocationChargeBps: number;
  readonly topupChargeBps: number;
  readonly switchingFeeBps: number;
  readonly partialWithdrawalFeeBps: number;
  readonly surrenderChargeBpsByYear: readonly number[];
  readonly coiPerMilleMonthly: number;
  readonly adminFeeMonthlyMinor: number;
}

export const DEFAULT_CHARGES: ChargeSchedule = {
  allocationChargeBps: 500,
  topupChargeBps: 200,
  switchingFeeBps: 100,
  partialWithdrawalFeeBps: 250,
  surrenderChargeBpsByYear: [1500, 1200, 900, 600, 300, 0],
  coiPerMilleMonthly: 0.9,
  adminFeeMonthlyMinor: 2500,   // 25.00 in a 2-dp currency
};

export interface PolicyMeta {
  readonly policyId: string;
  readonly entityId: string;
  readonly productId: string;
  readonly currency: string;
  readonly commencement: string;
  readonly sumAssured: Money;
  readonly autoRebalanceMonths?: number;
  readonly targetWeights?: ReadonlyArray<{ fundId: string; weightBps: number }>;
}

interface FundHolding { units: bigint; lockInUntil?: string }

export class UnitLinkedError extends Error {}

export class UnitLinkedEngine {
  private readonly holdings = new Map<string, Map<string, FundHolding>>();
  private readonly txns: UnitTransaction[] = [];
  private readonly meta = new Map<string, PolicyMeta>();
  private seq = 0;

  constructor(
    private readonly nav: NavEngine,
    private readonly ledger: Ledger,
    private readonly chart: Chart,
    private readonly charges: ChargeSchedule = DEFAULT_CHARGES,
  ) {}

  /** Ids are prefixed with the module so two engines can share one ledger without collision. */
  private nextId(prefix: string): string { return `UL-${prefix}-${String(++this.seq).padStart(6, '0')}`; }

  openPolicy(meta: PolicyMeta, holdings: Array<{ fundId: string; units?: bigint; lockInUntil?: string }>): void {
    if (this.meta.has(meta.policyId)) throw new UnitLinkedError(`policy ${meta.policyId} already open`);
    this.meta.set(meta.policyId, meta);
    const map = new Map<string, FundHolding>();
    for (const h of holdings) map.set(h.fundId, { units: h.units ?? 0n, ...(h.lockInUntil ? { lockInUntil: h.lockInUntil } : {}) });
    this.holdings.set(meta.policyId, map);
  }

  policy(policyId: string): PolicyMeta {
    const m = this.meta.get(policyId);
    if (!m) throw new UnitLinkedError(`unknown policy ${policyId}`);
    return m;
  }

  unitsOf(policyId: string, fundId: string): bigint {
    return this.holdings.get(policyId)?.get(fundId)?.units ?? 0n;
  }

  unitsHeld(policyId: string): Array<{ fundId: string; units: bigint }> {
    const map = this.holdings.get(policyId);
    if (!map) throw new UnitLinkedError(`unknown policy ${policyId}`);
    return [...map.entries()].map(([fundId, h]) => ({ fundId, units: h.units }));
  }

  transactions(policyId?: string): readonly UnitTransaction[] {
    return policyId ? this.txns.filter((t) => t.policyId === policyId) : this.txns;
  }

  /* ------------------------------------------------------------ journals */

  private post(id: string, entityId: string, at: string, sourceRef: string, description: string, fundId: string | undefined, lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: Money; memo?: string }>): string {
    const entry = this.ledger.post({
      id, entityId, at, source: 'unitlinked', sourceRef, description, ...(fundId ? { fundId } : {}),
      postings: lines.map((l) => posting(l.accountId, l.side, l.amount, this.ledger.toBase(l.amount, entityId, at), l.memo)),
    });
    return entry.id;
  }

  /* ------------------------------------------------------- money movements */

  /** Allocate a premium into a fund: net of allocation charge, at the resolved dealing price. */
  payPremium(input: { policyId: string; premium: Money; fundId: string; instructionAt: string; allocationChargeBps?: number }): UnitTransaction {
    const meta = this.policy(input.policyId);
    const fund = this.nav.fund(input.fundId);
    const dp = resolveDealingPoint(fund.dealingRule, input.instructionAt, fund.calendar);
    const price = this.nav.priceAt(input.fundId, dp.valuationDate);
    const bps = input.allocationChargeBps ?? this.charges.allocationChargeBps;
    const charge = applyBps(input.premium, bps);
    const net = sub(input.premium, charge);
    const units = unitsForAmount(net, price);
    const value = valueOfUnits(units, price);
    const at = input.instructionAt;
    const entity = meta.entityId;
    const ids = [
      this.post(this.nextId('J'), entity, at, input.policyId, `Premium received ${formatAmount(input.premium)}`, undefined, [
        { accountId: this.chart.cash(), side: 'debit', amount: input.premium, memo: 'premium received' },
        { accountId: this.chart.fundClearing(), side: 'credit', amount: input.premium, memo: 'into fund clearing' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Allocation to ${input.fundId} ${formatAmount(net)}`, input.fundId, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: net, memo: 'from clearing' },
        { accountId: this.chart.participantLiability(input.fundId), side: 'credit', amount: net, memo: 'participants funds' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Allocation charge ${formatAmount(charge)}`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: charge, memo: 'charge retained' },
        { accountId: this.chart.feeIncome('allocation'), side: 'credit', amount: charge, memo: 'allocation charge' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Invest ${formatAmount(net)} in ${input.fundId}`, input.fundId, [
        { accountId: this.chart.fundInvestments(input.fundId), side: 'debit', amount: net, memo: 'fund investments' },
        { accountId: this.chart.cash(), side: 'credit', amount: net, memo: 'cash invested' },
      ]),
    ];
    const txn: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'allocation', fundId: input.fundId,
      units, pricePerUnit: price, value, charges: [{ code: 'allocation', amount: charge, basis: `${bps} bps of premium` }],
      instructionAt: at, dealingPoint: dp, journalIds: ids,
      note: `Allocated ${unitsToDecimal(units)} units at ${unitsToDecimal(price.micro)} (${dp.explanation})`,
    };
    this.applyTxn(txn);
    return txn;
  }

  /** Cancellation charges (COI, admin) taken in units, exactly like the market does. */
  chargePolicy(input: { policyId: string; fundId: string; code: 'coi' | 'admin'; amount: Money; instructionAt: string; basis: string }): UnitTransaction {
    const meta = this.policy(input.policyId);
    const fund = this.nav.fund(input.fundId);
    const dp = resolveDealingPoint(fund.dealingRule, input.instructionAt, fund.calendar);
    const price = this.nav.priceAt(input.fundId, dp.valuationDate);
    const units = unitsToRealise(input.amount, price);
    const held = this.unitsOf(input.policyId, input.fundId);
    if (units > held) throw new UnitLinkedError(`charge of ${unitsToDecimal(units)} units exceeds holding ${unitsToDecimal(held)} units`);
    const at = input.instructionAt;
    const entity = meta.entityId;
    const value = valueOfUnits(units, price);
    const ids = [
      this.post(this.nextId('J'), entity, at, input.policyId, `${input.code} charge ${formatAmount(value)}`, input.fundId, [
        { accountId: this.chart.participantLiability(input.fundId), side: 'debit', amount: value, memo: 'units cancelled' },
        { accountId: this.chart.fundClearing(), side: 'credit', amount: value, memo: 'to clearing' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Disinvest for ${input.code}`, input.fundId, [
        { accountId: this.chart.cash(), side: 'debit', amount: value, memo: 'cash from fund' },
        { accountId: this.chart.fundInvestments(input.fundId), side: 'credit', amount: value, memo: 'investments reduced' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `${input.code} income`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: value, memo: 'from clearing' },
        { accountId: this.chart.feeIncome(input.code), side: 'credit', amount: value, memo: `${input.code} charge` },
      ]),
    ];
    const txn: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'charge', fundId: input.fundId,
      units: -units, pricePerUnit: price, value, charges: [{ code: input.code, amount: value, basis: input.basis }],
      instructionAt: at, dealingPoint: dp, journalIds: ids,
      note: `${input.code} charge cancelled ${unitsToDecimal(units)} units at ${unitsToDecimal(price.micro)}`,
    };
    this.applyTxn(txn);
    return txn;
  }

  /** A switch is atomic: value leaves one fund and lands in another with a single instruction id. */
  switchFund(input: { policyId: string; fromFundId: string; toFundId: string; units?: bigint; amount?: Money; instructionAt: string; switchingFeeBps?: number }): { out: UnitTransaction; in: UnitTransaction; instructionId: string } {
    const meta = this.policy(input.policyId);
    if (input.fromFundId === input.toFundId) throw new UnitLinkedError('switch target must differ from source');
    const fromFund = this.nav.fund(input.fromFundId);
    const toFund = this.nav.fund(input.toFundId);
    const dpFrom = resolveDealingPoint(fromFund.dealingRule, input.instructionAt, fromFund.calendar);
    const dpTo = resolveDealingPoint(toFund.dealingRule, input.instructionAt, toFund.calendar);
    const priceFrom = this.nav.priceAt(input.fromFundId, dpFrom.valuationDate);
    const priceTo = this.nav.priceAt(input.toFundId, dpTo.valuationDate);
    const held = this.unitsOf(input.policyId, input.fromFundId);
    const units = input.units ?? (input.amount ? unitsToRealise(input.amount, priceFrom) : 0n);
    if (units <= 0n) throw new UnitLinkedError('switch needs a positive amount or unit quantity');
    if (units > held) throw new UnitLinkedError(`switch of ${unitsToDecimal(units)} units exceeds holding ${unitsToDecimal(held)}`);
    const gross = valueOfUnits(units, priceFrom);
    const feeBps = input.switchingFeeBps ?? this.charges.switchingFeeBps;
    const fee = applyBps(gross, feeBps);
    const net = sub(gross, fee);
    const unitsIn = unitsForAmount(net, priceTo);
    const instructionId = this.nextId('SW');
    const at = input.instructionAt;
    const entity = meta.entityId;
    const ids = [
      this.post(this.nextId('J'), entity, at, instructionId, `Switch out ${formatAmount(gross)} from ${input.fromFundId}`, input.fromFundId, [
        { accountId: this.chart.participantLiability(input.fromFundId), side: 'debit', amount: gross, memo: 'units cancelled' },
        { accountId: this.chart.fundClearing(), side: 'credit', amount: gross, memo: 'to clearing' },
      ]),
      this.post(this.nextId('J'), entity, at, instructionId, `Disinvest ${formatAmount(gross)} from ${input.fromFundId}`, input.fromFundId, [
        { accountId: this.chart.cash(), side: 'debit', amount: gross, memo: 'cash from fund' },
        { accountId: this.chart.fundInvestments(input.fromFundId), side: 'credit', amount: gross, memo: 'investments reduced' },
      ]),
      this.post(this.nextId('J'), entity, at, instructionId, `Switch in ${formatAmount(net)} to ${input.toFundId}`, input.toFundId, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: net, memo: 'from clearing' },
        { accountId: this.chart.participantLiability(input.toFundId), side: 'credit', amount: net, memo: 'participants funds' },
      ]),
      this.post(this.nextId('J'), entity, at, instructionId, `Invest ${formatAmount(net)} in ${input.toFundId}`, input.toFundId, [
        { accountId: this.chart.fundInvestments(input.toFundId), side: 'debit', amount: net, memo: 'fund investments' },
        { accountId: this.chart.cash(), side: 'credit', amount: net, memo: 'cash invested' },
      ]),
      ...(fee.minor > 0n ? [this.post(this.nextId('J'), entity, at, instructionId, `Switching fee ${formatAmount(fee)}`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: fee, memo: 'fee' },
        { accountId: this.chart.feeIncome('switching'), side: 'credit', amount: fee, memo: 'switching fee' },
      ])] : []),
    ];
    const out: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'switch-out', fundId: input.fromFundId, units: -units,
      pricePerUnit: priceFrom, value: gross, charges: fee.minor > 0n ? [{ code: 'switching', amount: fee, basis: `${feeBps} bps of switched value` }] : [],
      instructionAt: at, dealingPoint: dpFrom, journalIds: ids, instructionId, note: `Switch ${instructionId}: out of ${input.fromFundId}`,
    };
    const inn: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'switch-in', fundId: input.toFundId, units: unitsIn,
      pricePerUnit: priceTo, value: net, charges: [], instructionAt: at, dealingPoint: dpTo, journalIds: ids, instructionId,
      note: `Switch ${instructionId}: into ${input.toFundId}`,
    };
    this.applyTxn(out);
    this.applyTxn(inn);
    return { out, in: inn, instructionId };
  }

  /** Partial withdrawal: units cancelled to realise the requested cash, charges taken, cover impact reported. */
  partialWithdraw(input: { policyId: string; fundId: string; amount: Money; instructionAt: string; feeBps?: number }): { txn: UnitTransaction; netToCustomer: Money; remainingUnits: bigint; remainingValue: Money } {
    const meta = this.policy(input.policyId);
    const fund = this.nav.fund(input.fundId);
    const dp = resolveDealingPoint(fund.dealingRule, input.instructionAt, fund.calendar);
    const price = this.nav.priceAt(input.fundId, dp.valuationDate);
    const bps = input.feeBps ?? this.charges.partialWithdrawalFeeBps;
    const fee = applyBps(input.amount, bps);
    const gross = add(input.amount, fee);
    const units = unitsToRealise(gross, price);
    const held = this.unitsOf(input.policyId, input.fundId);
    if (units > held) throw new UnitLinkedError(`withdrawal needs ${unitsToDecimal(units)} units but only ${unitsToDecimal(held)} held`);
    const realised = valueOfUnits(units, price);
    const at = input.instructionAt;
    const entity = meta.entityId;
    const ids = [
      this.post(this.nextId('J'), entity, at, input.policyId, `Partial withdrawal ${formatAmount(gross)}`, input.fundId, [
        { accountId: this.chart.participantLiability(input.fundId), side: 'debit', amount: realised, memo: 'units cancelled' },
        { accountId: this.chart.fundClearing(), side: 'credit', amount: realised, memo: 'to clearing' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Disinvest for withdrawal`, input.fundId, [
        { accountId: this.chart.cash(), side: 'debit', amount: realised, memo: 'cash from fund' },
        { accountId: this.chart.fundInvestments(input.fundId), side: 'credit', amount: realised, memo: 'investments reduced' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Pay withdrawal to customer`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: input.amount, memo: 'paid to customer' },
        { accountId: this.chart.cash(), side: 'credit', amount: input.amount, memo: 'bank payment' },
      ]),
      ...(fee.minor > 0n ? [this.post(this.nextId('J'), entity, at, input.policyId, `Partial withdrawal fee ${formatAmount(fee)}`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: fee, memo: 'fee retained' },
        { accountId: this.chart.feeIncome('partial-withdrawal'), side: 'credit', amount: fee, memo: 'withdrawal fee' },
      ])] : []),
    ];
    const txn: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'withdrawal', fundId: input.fundId, units: -units,
      pricePerUnit: price, value: realised, charges: [{ code: 'partial-withdrawal', amount: fee, basis: `${bps} bps of withdrawal` }],
      instructionAt: at, dealingPoint: dp, journalIds: ids,
      note: `Paid ${formatAmount(input.amount)} to the customer, cancelled ${unitsToDecimal(units)} units`,
    };
    this.applyTxn(txn);
    const remainingUnits = this.unitsOf(input.policyId, input.fundId);
    return { txn, netToCustomer: input.amount, remainingUnits, remainingValue: valueOfUnits(remainingUnits, price) };
  }

  /** Full surrender of one fund's holding. */
  surrender(input: { policyId: string; fundId: string; instructionAt: string; policyYear?: number }): { txn: UnitTransaction; paid: Money; charge: Money } {
    const meta = this.policy(input.policyId);
    const fund = this.nav.fund(input.fundId);
    const dp = resolveDealingPoint(fund.dealingRule, input.instructionAt, fund.calendar);
    const price = this.nav.priceAt(input.fundId, dp.valuationDate);
    const units = this.unitsOf(input.policyId, input.fundId);
    if (units <= 0n) throw new UnitLinkedError('nothing to surrender in this fund');
    const value = valueOfUnits(units, price);
    const year = input.policyYear ?? 1;
    const bps = this.charges.surrenderChargeBpsByYear[Math.min(year - 1, this.charges.surrenderChargeBpsByYear.length - 1)] ?? 0;
    const charge = applyBps(value, bps);
    const paid = sub(value, charge);
    const at = input.instructionAt;
    const entity = meta.entityId;
    const ids = [
      this.post(this.nextId('J'), entity, at, input.policyId, `Surrender ${input.fundId}`, input.fundId, [
        { accountId: this.chart.participantLiability(input.fundId), side: 'debit', amount: value, memo: 'policy surrendered' },
        { accountId: this.chart.fundClearing(), side: 'credit', amount: value, memo: 'to clearing' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Disinvest on surrender`, input.fundId, [
        { accountId: this.chart.cash(), side: 'debit', amount: value, memo: 'cash from fund' },
        { accountId: this.chart.fundInvestments(input.fundId), side: 'credit', amount: value, memo: 'investments reduced' },
      ]),
      this.post(this.nextId('J'), entity, at, input.policyId, `Pay surrender value`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: paid, memo: 'paid to customer' },
        { accountId: this.chart.cash(), side: 'credit', amount: paid, memo: 'bank payment' },
      ]),
      ...(charge.minor > 0n ? [this.post(this.nextId('J'), entity, at, input.policyId, `Surrender charge`, undefined, [
        { accountId: this.chart.fundClearing(), side: 'debit', amount: charge, memo: 'charge retained' },
        { accountId: this.chart.feeIncome('surrender'), side: 'credit', amount: charge, memo: 'surrender charge' },
      ])] : []),
    ];
    const txn: UnitTransaction = {
      id: this.nextId('T'), policyId: input.policyId, type: 'surrender', fundId: input.fundId, units: -units,
      pricePerUnit: price, value, charges: [{ code: 'surrender', amount: charge, basis: `${bps} bps in policy year ${year}` }],
      instructionAt: at, dealingPoint: dp, journalIds: ids, note: `Surrendered ${unitsToDecimal(units)} units, paid ${formatAmount(paid)}`,
    };
    this.applyTxn(txn);
    return { txn, paid, charge };
  }

  /** Rebalance to target weights by switching from overweight funds to underweight ones. */
  rebalance(input: { policyId: string; instructionAt: string }): Array<{ fromFundId: string; toFundId: string; amount: Money }> {
    const meta = this.policy(input.policyId);
    const targets = meta.targetWeights;
    if (!targets || targets.length === 0) throw new UnitLinkedError('policy has no target weights to rebalance to');
    const asOf = input.instructionAt.slice(0, 10);
    const total = this.valueOf(input.policyId, asOf).total;
    const target = new Map(targets.map((t) => [t.fundId, money((total.minor * BigInt(t.weightBps)) / 10000n, meta.currency)]));
    const moves: Array<{ fromFundId: string; toFundId: string; amount: Money }> = [];
    const current = new Map(this.valueOf(input.policyId, asOf).byFund.map((f) => [f.fundId, f.value]));
    let guard = 0;
    while (guard++ < 12) {
      let over: { fundId: string; excess: Money } | undefined;
      let under: { fundId: string; shortfall: Money } | undefined;
      for (const [fundId, targetValue] of target) {
        const hold = current.get(fundId) ?? zero(meta.currency);
        const diff = sub(hold, targetValue);
        if (diff.minor > 0n && (!over || compare(diff, over.excess) > 0)) over = { fundId, excess: diff };
        if (diff.minor < 0n && (!under || compare(diff, under.shortfall) < 0)) under = { fundId, shortfall: multiply(diff, -1) };
      }
      if (!over || !under) break;
      const amount = compare(over.excess, under.shortfall) <= 0 ? over.excess : under.shortfall;
      if (amount.minor < 100n) break;   // stop chasing rounding dust
      this.switchFund({ policyId: input.policyId, fromFundId: over.fundId, toFundId: under.fundId, amount, instructionAt: input.instructionAt, switchingFeeBps: 0 });
      moves.push({ fromFundId: over.fundId, toFundId: under.fundId, amount });
      const after = this.valueOf(input.policyId, asOf);
      for (const f of after.byFund) current.set(f.fundId, f.value);
    }
    return moves;
  }

  private applyTxn(txn: UnitTransaction): void {
    this.txns.push(txn);
    const map = this.holdings.get(txn.policyId);
    if (!map) throw new UnitLinkedError(`unknown policy ${txn.policyId}`);
    const held = map.get(txn.fundId) ?? { units: 0n };
    const next = held.units + txn.units;
    if (next < 0n) throw new UnitLinkedError(`negative unit holding in ${txn.fundId}: ${unitsToDecimal(next)}`);
    map.set(txn.fundId, { ...held, units: next });
  }

  /* ---------------------------------------------------------- valuations */

  valueOf(policyId: string, asOfDate: string): {
    byFund: Array<{ fundId: string; fundName: string; units: bigint; unitsLabel: string; price: string; value: Money; priceAsOf: string; staleDays: number }>;
    total: Money;
    currency: string;
  } {
    const meta = this.policy(policyId);
    const byFund = this.unitsHeld(policyId).map(({ fundId, units }) => {
      const fund = this.nav.fund(fundId);
      const hist = this.nav.valuationHistory(fundId).filter((v) => v.valuationDate <= asOfDate);
      const v = hist.at(-1);
      const price: Price = v?.pricePerUnit ?? { micro: 0n, currency: fund.currency };
      return {
        fundId, fundName: fund.name, units, unitsLabel: unitsToDecimal(units),
        price: unitsToDecimal(price.micro), value: valueOfUnits(units, price),
        priceAsOf: v?.valuationDate ?? asOfDate, staleDays: this.nav.stalenessDays(fundId, asOfDate),
      };
    });
    return {
      byFund,
      total: byFund.reduce((acc, f) => add(acc, f.value), zero(meta.currency)),
      currency: meta.currency,
    };
  }

  /** The audit property: recompute units from the transaction log and compare with the live state. */
  reproduce(policyId: string): { ok: boolean; detail: Array<{ fundId: string; fromLog: string; live: string; match: boolean }> } {
    const fromLog = new Map<string, bigint>();
    for (const t of this.transactions(policyId)) fromLog.set(t.fundId, (fromLog.get(t.fundId) ?? 0n) + t.units);
    const detail = this.unitsHeld(policyId).map(({ fundId, units }) => ({
      fundId, fromLog: unitsToDecimal(fromLog.get(fundId) ?? 0n), live: unitsToDecimal(units),
      match: (fromLog.get(fundId) ?? 0n) === units,
    }));
    return { ok: detail.every((d) => d.match), detail };
  }

  /** Total units in issue across policies, per fund — the number the NAV engine needs. */
  unitsInIssue(fundId: string): bigint {
    let total = 0n;
    for (const map of this.holdings.values()) total += map.get(fundId)?.units ?? 0n;
    return total;
  }
}

export { UNITS_SCALE, unitsToDecimal };
