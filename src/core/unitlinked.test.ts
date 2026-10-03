import { describe, expect, it, beforeEach } from 'vitest';
import { Ledger } from './ledger.js';
import { buildChart } from './chart.js';
import { applyBps, money, sub } from './money.js';
import { unitsForAmount, unitsToDecimal, unitsToRealise, valueOfUnits } from './units.js';
import { NavEngine, singlePriceFund } from './fund.js';
import { DEFAULT_CHARGES, UnitLinkedEngine, UnitLinkedError } from './unitlinked.js';

const CUR = 'AED';
const DAYS = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];

function setup() {
  const ledger = new Ledger(CUR);
  const chart = buildChart(ledger, 'E1', CUR, ['FA', 'FB']);
  const nav = new NavEngine();
  nav.defineFund(singlePriceFund('FA', 'Fund A', CUR, { composition: [] }));
  nav.defineFund(singlePriceFund('FB', 'Fund B', CUR, { composition: [] }));
  const assets = [1_000_000n, 1_010_000n, 1_020_000n, 1_030_000n];
  DAYS.forEach((day, i) => {
    nav.publishValuation({ fundId: 'FA', valuationDate: day, grossAssets: money(assets[i]!, CUR), liabilities: money(0n, CUR), unitsInIssue: unitsForAmount(money(800_000n, CUR), { micro: (assets[i]! * 1_000_000n * 1_000_000n) / unitsForAmount(money(800_000n, CUR), { micro: 1_000_000n, currency: CUR } as never), currency: CUR } as never) || 1n, source: 'test' });
  });
  // Simpler, deterministic pricing: publish with a fixed unit count and let the price follow assets.
  const nav2 = new NavEngine();
  nav2.defineFund(singlePriceFund('FA', 'Fund A', CUR));
  nav2.defineFund(singlePriceFund('FB', 'Fund B', CUR));
  DAYS.forEach((day, i) => {
    nav2.publishValuation({ fundId: 'FA', valuationDate: day, grossAssets: money(100_000n + BigInt(i) * 1_000n, CUR), liabilities: money(0n, CUR), unitsInIssue: 100_000n * 1_000_000n, source: 'test' });
    nav2.publishValuation({ fundId: 'FB', valuationDate: day, grossAssets: money(200_000n + BigInt(i) * 2_000n, CUR), liabilities: money(0n, CUR), unitsInIssue: 200_000n * 1_000_000n, source: 'test' });
  });
  const engine = new UnitLinkedEngine(nav2, ledger, chart, DEFAULT_CHARGES);
  engine.openPolicy(
    { policyId: 'P1', entityId: 'E1', productId: 'PROD', currency: CUR, commencement: DAYS[0]!, sumAssured: money(250_000_00n, CUR) },
    [{ fundId: 'FA' }, { fundId: 'FB' }],
  );
  const priceA = nav2.priceAt('FA', DAYS[0]!);
  const priceB = nav2.priceAt('FB', DAYS[0]!);
  return { ledger, chart, nav: nav2, engine, priceA, priceB };
}

describe('unit-linked engine', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('allocates a premium net of the allocation charge, at the resolved price', () => {
    const premium = money(1_000_000n, CUR);           // 10,000.00
    const txn = ctx.engine.payPremium({ policyId: 'P1', premium, fundId: 'FA', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    const charge = applyBps(premium, DEFAULT_CHARGES.allocationChargeBps);
    expect(charge.minor).toBe(50_000n);               // 500.00
    expect(txn.charges[0]!.amount.minor).toBe(50_000n);
    expect(txn.value.minor).toBe(950_000n);           // value of units bought = net premium
    expect(txn.dealingPoint.valuationDate).toBe(DAYS[0]);
    expect(txn.dealingPoint.sameDay).toBe(true);
    expect(ctx.ledger.balance('E1:FEE:allocation').minor).toBe(50_000n);
    expect(ctx.ledger.balance('E1:FA:PARTICIPANTS').minor).toBe(950_000n);
    expect(ctx.ledger.balance('E1:FA:INVESTMENTS').minor).toBe(950_000n);
    expect(ctx.ledger.proof('E1').balanced).toBe(true);
  });

  it('prices an instruction after the cut-off at the next dealing day', () => {
    const txn = ctx.engine.payPremium({ policyId: 'P1', premium: money(100_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T16:30:00+04:00` });
    expect(txn.dealingPoint.valuationDate).toBe(DAYS[1]);
    expect(txn.dealingPoint.sameDay).toBe(false);
    expect(txn.pricePerUnit.micro).toBe(ctx.nav.priceAt('FA', DAYS[1]!).micro);
  });

  it('takes charges by cancelling units and never lets a holding go negative', () => {
    ctx.engine.payPremium({ policyId: 'P1', premium: money(1_000_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    const before = ctx.engine.unitsOf('P1', 'FA');
    const charged = ctx.engine.chargePolicy({ policyId: 'P1', fundId: 'FA', code: 'admin', amount: money(2_500n, CUR), instructionAt: `${DAYS[1]}T12:00:00+04:00`, basis: 'monthly admin' });
    expect(charged.units < 0n).toBe(true);
    expect(ctx.engine.unitsOf('P1', 'FA')).toBeLessThan(before);
    expect(ctx.ledger.balance('E1:FEE:admin').minor).toBe(2500n);
    expect(ctx.ledger.proof('E1').balanced).toBe(true);
    expect(() => ctx.engine.chargePolicy({ policyId: 'P1', fundId: 'FA', code: 'coi', amount: money(99_999_999n, CUR), instructionAt: `${DAYS[1]}T12:00:00+04:00`, basis: 'too big' })).toThrow(UnitLinkedError);
  });

  it('switches atomically: one instruction id, two legs, fee taken once', () => {
    ctx.engine.payPremium({ policyId: 'P1', premium: money(2_000_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    const beforeA = ctx.engine.unitsOf('P1', 'FA');
    const result = ctx.engine.switchFund({ policyId: 'P1', fromFundId: 'FA', toFundId: 'FB', amount: money(300_000n, CUR), instructionAt: `${DAYS[1]}T11:00:00+04:00` });
    const gross = result.out.value;
    const fee = applyBps(gross, DEFAULT_CHARGES.switchingFeeBps);
    expect(result.out.charges[0]!.amount.minor).toBe(fee.minor);
    expect(result.in.value.minor).toBe(sub(gross, fee).minor);
    expect(result.out.instructionAt).toBe(result.in.instructionAt);
    expect(result.out.journalIds).toEqual(result.in.journalIds);
    expect(result.out.instructionId).toMatch(/^UL-SW-/);
    expect(result.out.note).toContain(result.instructionId);
    expect(ctx.engine.unitsOf('P1', 'FA')).toBeLessThan(beforeA);
    expect(ctx.engine.unitsOf('P1', 'FB')).toBeGreaterThan(0n);
    expect(ctx.ledger.proof('E1').balanced).toBe(true);
    expect(() => ctx.engine.switchFund({ policyId: 'P1', fromFundId: 'FB', toFundId: 'FB', amount: money(100n, CUR), instructionAt: `${DAYS[1]}T11:00:00+04:00` })).toThrow(/must differ/);
  });

  it('withdraws partially with the fee, and refuses to over-withdraw', () => {
    ctx.engine.payPremium({ policyId: 'P1', premium: money(5_000_000n, CUR), fundId: 'FB', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    const cash = money(500_000n, CUR);
    const result = ctx.engine.partialWithdraw({ policyId: 'P1', fundId: 'FB', amount: cash, instructionAt: `${DAYS[2]}T10:00:00+04:00` });
    const fee = applyBps(cash, DEFAULT_CHARGES.partialWithdrawalFeeBps);
    const expectedUnits = unitsToRealise(money(cash.minor + fee.minor, CUR), ctx.nav.priceAt('FB', DAYS[2]!));
    expect(result.txn.units).toBe(-expectedUnits);
    expect(result.txn.charges[0]!.amount.minor).toBe(fee.minor);
    expect(result.remainingUnits).toBeLessThan(ctx.engine.unitsOf('P1', 'FB') + expectedUnits);
    expect(ctx.ledger.proof('E1').balanced).toBe(true);
    expect(() => ctx.engine.partialWithdraw({ policyId: 'P1', fundId: 'FB', amount: money(999_999_999n, CUR), instructionAt: `${DAYS[2]}T10:00:00+04:00` })).toThrow(/only .* held|exceeds/);
  });

  it('surrenders the whole holding with the year-based charge', () => {
    ctx.engine.payPremium({ policyId: 'P1', premium: money(1_000_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    const value = valueOfUnits(ctx.engine.unitsOf('P1', 'FA'), ctx.nav.priceAt('FA', DAYS[3]!));
    const result = ctx.engine.surrender({ policyId: 'P1', fundId: 'FA', instructionAt: `${DAYS[3]}T10:00:00+04:00`, policyYear: 1 });
    expect(result.charge.minor).toBe(applyBps(value, DEFAULT_CHARGES.surrenderChargeBpsByYear[0]!).minor);
    expect(result.paid.minor).toBe(sub(value, result.charge).minor);
    expect(ctx.engine.unitsOf('P1', 'FA')).toBe(0n);
    expect(ctx.ledger.proof('E1').balanced).toBe(true);
  });

  it('reproduces every policy value from the transaction log alone', () => {
    ctx.engine.payPremium({ policyId: 'P1', premium: money(1_000_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T09:30:00+04:00` });
    ctx.engine.payPremium({ policyId: 'P1', premium: money(750_000n, CUR), fundId: 'FB', instructionAt: `${DAYS[1]}T09:30:00+04:00` });
    ctx.engine.chargePolicy({ policyId: 'P1', fundId: 'FA', code: 'coi', amount: money(18_750n, CUR), instructionAt: `${DAYS[2]}T09:00:00+04:00`, basis: 'COI' });
    ctx.engine.switchFund({ policyId: 'P1', fromFundId: 'FA', toFundId: 'FB', amount: money(100_000n, CUR), instructionAt: `${DAYS[2]}T10:00:00+04:00` });
    const repro = ctx.engine.reproduce('P1');
    expect(repro.ok).toBe(true);
    expect(repro.detail.map((d) => d.fundId).sort()).toEqual(['FA', 'FB']);
    const total = ctx.engine.unitsInIssue('FA');
    const held = ctx.engine.unitsHeld('P1').find((h) => h.fundId === 'FA')!.units;
    expect(total).toBe(held);
  });
});
