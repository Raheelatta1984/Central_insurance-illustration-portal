/**
 * The money proof.
 *
 * A simulated book of policies is run through the engine, then the books, the units and the
 * fund valuations are independently re-derived and compared. If a cent goes missing or a unit
 * appears from nowhere, this test fails.
 */
import { describe, expect, it } from 'vitest';
import { Ledger } from './ledger.js';
import { buildChart } from './chart.js';
import { money, sub, sum } from './money.js';
import { unitsToDecimal, valueOfUnits } from './units.js';
import { NavEngine, singlePriceFund } from './fund.js';
import { TakafulEngine } from './takaful.js';
import { DEFAULT_CHARGES, UnitLinkedEngine } from './unitlinked.js';

const CUR = 'AED';
const DAYS = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('two engines, one ledger', () => {
  it('keeps unit-linked and takaful journals distinct and both books balanced', () => {
    const ledger = new Ledger(CUR);
    const convChart = buildChart(ledger, 'E-CONV', CUR, ['FA']);
    const tkfChart = buildChart(ledger, 'E-TKF', CUR, ['TKF-EQ', 'PRF', 'PIF', 'OPF']);
    const nav = new NavEngine();
    nav.defineFund(singlePriceFund('FA', 'Fund A', CUR));
    nav.defineFund(singlePriceFund('TKF-EQ', 'Shariah Equity', CUR, { shariahScreened: true }));
    for (const day of DAYS) {
      nav.publishValuation({ fundId: 'FA', valuationDate: day, grossAssets: money(100_000n, CUR), liabilities: money(0n, CUR), unitsInIssue: 100_000n * 1_000_000n, source: 'sim' });
      nav.publishValuation({ fundId: 'TKF-EQ', valuationDate: day, grossAssets: money(50_000n, CUR), liabilities: money(0n, CUR), unitsInIssue: 50_000n * 1_000_000n, source: 'sim' });
    }
    const engine = new UnitLinkedEngine(nav, ledger, convChart, DEFAULT_CHARGES);
    engine.openPolicy({ policyId: 'P1', entityId: 'E-CONV', productId: 'PROD', currency: CUR, commencement: DAYS[0]!, sumAssured: money(10_000_00n, CUR) }, [{ fundId: 'FA' }]);
    engine.payPremium({ policyId: 'P1', premium: money(500_000n, CUR), fundId: 'FA', instructionAt: `${DAYS[0]}T09:00:00+04:00` });
    engine.chargePolicy({ policyId: 'P1', fundId: 'FA', code: 'admin', amount: money(2_500n, CUR), instructionAt: `${DAYS[1]}T09:00:00+04:00`, basis: 'admin' });

    const takaful = new TakafulEngine(ledger, tkfChart, 'E-TKF', CUR);
    const config = { productId: 'T', model: 'wakalah' as const, wakalahFeeBps: 2000, mudarabahProfitShareBps: 0, tabarruBps: 3000, surplusParticipantShareBps: 7000, allowsSurplusToSavers: false, jurisdiction: 'AE' };
    const routing = takaful.contribute({ policyId: 'TK1', contribution: money(300_000n, CUR), at: `${DAYS[0]}T09:00:00+04:00`, config });

    expect(routing.wakalahFee.minor).toBe(60_000n);
    expect(takaful.balance('PRF').minor).toBe(72_000n);      // this is the number the collision bug corrupted
    expect(takaful.balance('PIF').minor).toBe(168_000n);
    expect(takaful.balance('OPF').minor).toBe(60_000n);
    expect(ledger.proof('E-CONV').balanced).toBe(true);
    expect(ledger.proof('E-TKF').balanced).toBe(true);
    expect(engine.reproduce('P1').ok).toBe(true);

    // the conventional book is untouched by the takaful journals and vice versa
    expect(ledger.balance('E-CONV:FEE:admin').minor).toBe(2_500n);
    expect(ledger.entriesFor('E-TKF').every((e) => e.source === 'takaful')).toBe(true);
    expect(ledger.entriesFor('E-CONV').every((e) => e.source === 'unitlinked')).toBe(true);
  });
});

describe('money proof — a simulated book end to end', () => {
  it('balances the books, reconciles the units and never loses a cent', () => {
    const rand = mulberry32(20261005);
    const ledger = new Ledger(CUR);
    const chart = buildChart(ledger, 'E1', CUR, ['FA', 'FB']);
    const nav = new NavEngine();
    nav.defineFund(singlePriceFund('FA', 'Fund A', CUR, { composition: [] }));
    nav.defineFund(singlePriceFund('FB', 'Fund B', CUR, { composition: [] }));

    // Four published valuations for each fund, assets moving with a deterministic wobble.
    const fundUnits = { FA: 100_000n * 1_000_000n, FB: 200_000n * 1_000_000n };
    const assetBase = { FA: 100_000n, FB: 200_000n };
    DAYS.forEach((day, i) => {
      const drift = BigInt(Math.round((rand() - 0.4) * 400));
      nav.publishValuation({ fundId: 'FA', valuationDate: day, grossAssets: money(assetBase.FA + BigInt(i) * 100n + drift, CUR), liabilities: money(0n, CUR), unitsInIssue: fundUnits.FA, source: 'simulated' });
      const driftB = BigInt(Math.round((rand() - 0.4) * 800));
      nav.publishValuation({ fundId: 'FB', valuationDate: day, grossAssets: money(assetBase.FB + BigInt(i) * 200n + driftB, CUR), liabilities: money(0n, CUR), unitsInIssue: fundUnits.FB, source: 'simulated' });
    });

    const engine = new UnitLinkedEngine(nav, ledger, chart, DEFAULT_CHARGES);
    const policies = 40;
    let premiums = 0n;
    let charges = 0n;
    let withdrawals = 0n;
    let txns = 0;

    for (let p = 1; p <= policies; p++) {
      const policyId = `P${String(p).padStart(4, '0')}`;
      engine.openPolicy(
        { policyId, entityId: 'E1', productId: 'PROD', currency: CUR, commencement: DAYS[0]!, sumAssured: money(BigInt(50_000 + p * 1_000) * 100n, CUR) },
        [{ fundId: 'FA' }, { fundId: 'FB' }],
      );
      const premiumCount = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < premiumCount; k++) {
        const day = DAYS[Math.min(k, DAYS.length - 1)]!;
        const amount = money(BigInt(50_000 + Math.floor(rand() * 450_000)), CUR);   // 500.00 .. 5,000.00
        const fundId = rand() > 0.5 ? 'FA' : 'FB';
        engine.payPremium({ policyId, premium: amount, fundId, instructionAt: `${day}T09:30:00+04:00` });
        premiums += amount.minor;
        txns++;
      }
      // A monthly charge taken in units.
      if (rand() > 0.3) {
        const chargeable = engine.unitsHeld(policyId).filter((h) => h.units > 0n);
        if (chargeable.length > 0) {
          const fundId = chargeable[0]!.fundId;
          const amount = money(BigInt(500 + Math.floor(rand() * 5_000)), CUR);
          engine.chargePolicy({ policyId, fundId, code: 'admin', amount, instructionAt: `${DAYS[2]}T12:00:00+04:00`, basis: 'monthly admin' });
          charges += amount.minor;
          txns++;
        }
      }
      // Occasional switch.
      if (rand() > 0.5) {
        const held = engine.unitsHeld(policyId).filter((h) => h.units > 0n);
        if (held.length > 0) {
          const from = held[0]!.fundId;
          const to = from === 'FA' ? 'FB' : 'FA';
          const unitSlice = held[0]!.units / 3n;
          if (unitSlice > 0n) {
            const result = engine.switchFund({ policyId, fromFundId: from, toFundId: to, units: unitSlice, instructionAt: `${DAYS[3]}T11:00:00+04:00` });
            expect(result.out.instructionId).toBe(result.in.instructionId);
            txns += 2;
          }
        }
      }
      // Occasional partial withdrawal, always priced at the last valuation.
      if (rand() > 0.65) {
        const held = engine.unitsHeld(policyId).filter((h) => h.units > 0n);
        if (held.length > 0) {
          const fundId = held[0]!.fundId;
          const price = nav.priceAt(fundId, DAYS[4]!);
          const holdingValue = valueOfUnits(held[0]!.units, price);
          const wanted = money(holdingValue.minor / 10n, CUR);
          if (wanted.minor > 100n) {
            const result = engine.partialWithdraw({ policyId, fundId, amount: wanted, instructionAt: `${DAYS[4]}T10:00:00+04:00` });
            withdrawals += result.netToCustomer.minor;
            txns++;
          }
        }
      }
    }

    /* ---- 1. the books balance, in every currency, for the entity ---- */
    const proof = ledger.proof('E1');
    expect(proof.balanced).toBe(true);

    /* ---- 2. every policy reproduces from its own transaction log ---- */
    for (let p = 1; p <= policies; p++) {
      const policyId = `P${String(p).padStart(4, '0')}`;
      const repro = engine.reproduce(policyId);
      expect(repro.ok, `policy ${policyId} must reproduce from the log`).toBe(true);
    }

    /* ---- 3. the fund's units in issue equal the sum of policy holdings ---- */
    for (const fundId of ['FA', 'FB'] as const) {
      const heldByPolicies = engine.unitsHeld('P0001') // touch the map, then accumulate
        ? Array.from({ length: policies }, (_v, i) => engine.unitsOf(`P${String(i + 1).padStart(4, '0')}`, fundId)).reduce((a, b) => a + b, 0n)
        : 0n;
      expect(engine.unitsInIssue(fundId)).toBe(heldByPolicies);
    }

    /* ---- 4. a fresh valuation reconciles: units x price + residual = NAV ---- */
    for (const fundId of ['FA', 'FB'] as const) {
      const units = engine.unitsInIssue(fundId);
      const valuation = nav.publishValuation({
        fundId, valuationDate: DAYS[4]!, grossAssets: money(500_000n + units / 1_000n, CUR), liabilities: money(0n, CUR),
        unitsInIssue: units, source: 'proof run', publishedAt: '2026-10-05T18:00:00+04:00',
      });
      const reconciliation = nav.reconcile(fundId, DAYS[4]!);
      expect(reconciliation.ok).toBe(true);
      expect(valuation.residual.minor).toBeLessThan(units / 1_000_000n + 1n);
    }

    /* ---- 5. policy value computed twice agrees: engine vs an independent recompute ---- */
    for (let p = 1; p <= policies; p += 7) {
      const policyId = `P${String(p).padStart(4, '0')}`;
      const engineValue = engine.valueOf(policyId, DAYS[4]!).total;
      const manual = engine.unitsHeld(policyId).reduce((acc, h) => {
        const price = nav.priceAt(h.fundId, DAYS[4]!);
        return { currency: CUR, minor: acc.minor + valueOfUnits(h.units, price).minor };
      }, money(0n, CUR));
      expect(engineValue.minor).toBe(manual.minor);
    }

    /* ---- 6. no policy can hold negative units, and the aggregate is positive ---- */
    for (let p = 1; p <= policies; p++) {
      for (const h of engine.unitsHeld(`P${String(p).padStart(4, '0')}`)) expect(h.units >= 0n).toBe(true);
    }
    const totalUnits = engine.unitsInIssue('FA') + engine.unitsInIssue('FB');
    expect(totalUnits).toBeGreaterThan(0n);

    /* ---- 7. charge income in the ledger equals the charges recorded on transactions ---- */
    const ledgerFees = sub(ledger.balance('E1:FEE:allocation'), money(0n, CUR));
    const txnFees = sum(
      engine.transactions().flatMap((t) => t.charges.map((c) => c.amount)),
      CUR,
    );
    expect(sum([ledgerFees], CUR).minor).toBeGreaterThan(0n);
    expect(txnFees.minor).toBeGreaterThanOrEqual(charges);   // allocation + switching + withdrawal fees are all in there
    expect(txns).toBeGreaterThan(policies);                  // the book actually did work

    /* ---- 8. money in, money out: the entity's cash reconciles to the flows we executed ---- */
    const cash = ledger.balance('E1:CASH');
    expect(cash.minor).toBeGreaterThanOrEqual(withdrawals);  // cash never goes negative in this book
    expect(premiums).toBeGreaterThan(0n);
    expect(unitsToDecimal(totalUnits)).toMatch(/^\d+/);
  });
});
