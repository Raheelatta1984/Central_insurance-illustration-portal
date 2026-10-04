import { beforeEach, describe, expect, it } from 'vitest';
import { ClaimsEngine, ClaimsError, DEFAULT_AUTHORITY, SEVERITY_BPS, TriageInput } from './claims.js';
import { Ledger } from './ledger.js';
import { Chart, buildChart } from './chart.js';
import { TakafulEngine } from './takaful.js';
import { money, formatAmount } from './money.js';

let ledger: Ledger;
let chart: Chart;
let claims: ClaimsEngine;

const cleanTriage: TriageInput = { coverInForce: true, exclusionsApplied: [], daysLate: 3, fraudSignals: 0 };

beforeEach(() => {
  ledger = new Ledger('AED');
  chart = buildChart(ledger, 'ALK-CONV', 'AED', ['FGLOBAL']);
  claims = new ClaimsEngine(ledger, chart, 'ALK-CONV', 'AED');
});

describe('claims intake and triage', () => {
  it('registers a claim with an audit trail and triages clean cases to accept', () => {
    const claim = claims.register({
      policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23',
      description: 'Death benefit notification received from the nominated beneficiary',
    });
    expect(claim.id).toBe('CLM-000001');
    expect(claim.status).toBe('registered');

    const triage = claims.triage(claim.id, cleanTriage);
    expect(triage.decision).toBe('accept');
    expect(claims.claim(claim.id).status).toBe('under-review');
    expect(claims.claim(claim.id).decisions.map((d) => d.action)).toEqual(['registered', 'triage:accept']);
  });

  it('declines a claim where cover was not in force, and records why', () => {
    const claim = claims.register({ policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-01', reportedAt: '2026-09-02', description: 'Accident' });
    const triage = claims.triage(claim.id, { ...cleanTriage, coverInForce: false });
    expect(triage.decision).toBe('decline');
    expect(claims.claim(claim.id).status).toBe('declined');
    expect(claims.claim(claim.id).declinedReason).toMatch(/not in force/);
  });

  it('declines on an exclusion and refers late or suspicious notifications', () => {
    const excluded = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-01', reportedAt: '2026-09-02', description: 'Treatment' });
    expect(claims.triage(excluded.id, { ...cleanTriage, exclusionsApplied: ['pre-existing condition within 12 months'] }).decision).toBe('decline');

    const late = claims.register({ policyId: 'UL-000123', cause: 'critical-illness', lossDate: '2026-01-01', reportedAt: '2026-09-01', description: 'Diagnosis' });
    expect(claims.triage(late.id, { ...cleanTriage, daysLate: 240 }).decision).toBe('refer');

    const suspicious = claims.register({ policyId: 'UL-000123', cause: 'property', lossDate: '2026-08-01', reportedAt: '2026-08-05', description: 'Loss' });
    expect(claims.triage(suspicious.id, { ...cleanTriage, fraudSignals: 3 }).decision).toBe('refer');
  });
});

describe('reserves', () => {
  it('books a reserve movement as expense against a liability, never a silent note', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Death' });
    claims.triage(claim.id, cleanTriage);
    claims.setReserve(claim.id, { amount: money(500_00n, 'AED'), at: '2026-09-24', by: 'reserving-actuary' });

    expect(claims.claim(claim.id).reserve.minor).toBe(500_00n);
    expect(ledger.balance(chart.claimReserve()).minor).toBe(500_00n);
    expect(ledger.balance(chart.claimExpense()).minor).toBe(500_00n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('suggests a reserve from the severity table without deciding anything', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Death' });
    expect(claims.suggestReserve(claim, money(100_000_00n, 'AED')).minor).toBe(100_000_00n);
    const motor = claims.register({ policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-20', reportedAt: '2026-09-21', description: 'Accident' });
    expect(claims.suggestReserve(motor, money(100_000_00n, 'AED')).minor).toBe(span(SEVERITY_BPS.motor, 100_000_00n));
  });

  it('refuses a silent reserve reduction', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-01', reportedAt: '2026-09-02', description: 'Treatment' });
    claims.triage(claim.id, cleanTriage);
    claims.setReserve(claim.id, { amount: money(500_00n, 'AED'), at: '2026-09-03', by: 'officer' });
    expect(() => claims.setReserve(claim.id, { amount: money(200_00n, 'AED'), at: '2026-09-04', by: 'officer' })).toThrow(/never silently/);
  });
});

describe('authority', () => {
  it('holds an AI agent below the straight-through limit and requires a human above it', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Death' });
    claims.triage(claim.id, cleanTriage);

    expect(() => claims.approve(claim.id, { amount: money(900_00n, 'AED'), at: '2026-09-25', by: 'agent/claims-triage', role: 'ai-straight-through' })).not.toThrow();
    expect(claims.claim(claim.id).decisions.at(-1)?.isAi).toBe(true);
    expect(claims.claim(claim.id).decisions.at(-1)?.rationale).toMatch(/within the ai-straight-through limit/);
  });

  it('refuses an AI approval above its limit and a human below the required role', () => {
    const small = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Treatment' });
    claims.triage(small.id, cleanTriage);
    expect(() => claims.approve(small.id, { amount: money(1_100_00n, 'AED'), at: '2026-09-25', by: 'agent/x', role: 'ai-straight-through' }))
      .toThrow(/needs a human authority/);

    const big = claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Death' });
    claims.triage(big.id, cleanTriage);
    expect(() => claims.approve(big.id, { amount: money(60_000_00n, 'AED'), at: '2026-09-25', by: 'officer', role: 'claims-officer' }))
      .toThrow(/may authorise at most/);
    expect(() => claims.approve(big.id, { amount: money(60_000_00n, 'AED'), at: '2026-09-25', by: 'manager', role: 'claims-manager' }))
      .toThrow(/may authorise at most/);
    expect(() => claims.approve(big.id, { amount: money(60_000_00n, 'AED'), at: '2026-09-25', by: 'head', role: 'head-of-claims' })).not.toThrow();
  });

  it('refuses a declaration that pretends an AI authority is human', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Treatment' });
    claims.triage(claim.id, cleanTriage);
    expect(() => claims.approve(claim.id, { amount: money(100_00n, 'AED'), at: '2026-09-25', by: 'agent/x', role: 'ai-straight-through', isAi: false }))
      .toThrow(/does not match/);
    expect(DEFAULT_AUTHORITY.find((a) => a.role === 'ai-straight-through')?.limitMinor).toBe(1_000_00n);
  });
});

describe('settlement', () => {
  it('releases the reserve, pays cash and keeps the books balanced when settling above reserve', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-23', description: 'Death' });
    claims.triage(claim.id, cleanTriage);
    claims.setReserve(claim.id, { amount: money(500_00n, 'AED'), at: '2026-09-24', by: 'actuary' });
    claims.approve(claim.id, { amount: money(700_00n, 'AED'), at: '2026-09-25', by: 'manager', role: 'claims-manager' });
    claims.settle(claim.id, { amount: money(700_00n, 'AED'), at: '2026-09-26', by: 'finance' });

    const settled = claims.claim(claim.id);
    expect(settled.status).toBe('settled');
    expect(settled.paid.minor).toBe(700_00n);
    expect(settled.reserve.minor).toBe(0n);
    expect(ledger.balance(chart.cash()).minor).toBe(-700_00n);
    expect(ledger.balance(chart.claimReserve()).minor).toBe(0n);
    expect(ledger.balance(chart.claimExpense()).minor).toBe(700_00n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
    expect(claims.position().paidCash.minor).toBe(700_00n);
    expect(claims.position().expenseIncurred.minor).toBe(700_00n);
    expect(claims.position().netCost.minor).toBe(700_00n);
  });

  it('credits an excess reserve back instead of leaving it in expense', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'motor', lossDate: '2026-09-20', reportedAt: '2026-09-21', description: 'Accident' });
    claims.triage(claim.id, cleanTriage);
    claims.setReserve(claim.id, { amount: money(1_000_00n, 'AED'), at: '2026-09-22', by: 'officer' });
    claims.approve(claim.id, { amount: money(400_00n, 'AED'), at: '2026-09-23', by: 'officer', role: 'claims-officer' });
    claims.settle(claim.id, { amount: money(400_00n, 'AED'), at: '2026-09-24', by: 'finance' });
    expect(ledger.balance(chart.claimExpense()).minor).toBe(400_00n);
    expect(ledger.balance(chart.claimReserve()).minor).toBe(0n);
  });

  it('refuses to settle anything that is not approved, declined or already settled', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-20', reportedAt: '2026-09-21', description: 'Treatment' });
    expect(() => claims.settle(claim.id, { amount: money(100_00n, 'AED'), at: '2026-09-22', by: 'finance' })).toThrow(/must be approved/);
    claims.triage(claim.id, cleanTriage);
    claims.approve(claim.id, { amount: money(100_00n, 'AED'), at: '2026-09-22', by: 'officer', role: 'claims-officer' });
    claims.settle(claim.id, { amount: money(100_00n, 'AED'), at: '2026-09-22', by: 'finance' });
    expect(() => claims.settle(claim.id, { amount: money(100_00n, 'AED'), at: '2026-09-23', by: 'finance' })).toThrow(/already settled/);
  });
});

describe('recoveries and position', () => {
  it('records salvage and reinsurance as income and reports net cost', () => {
    const claim = claims.register({ policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-20', reportedAt: '2026-09-21', description: 'Accident' });
    claims.triage(claim.id, cleanTriage);
    claims.setReserve(claim.id, { amount: money(1_000_00n, 'AED'), at: '2026-09-22', by: 'officer' });
    claims.approve(claim.id, { amount: money(1_000_00n, 'AED'), at: '2026-09-23', by: 'officer', role: 'claims-officer' });
    claims.settle(claim.id, { amount: money(1_000_00n, 'AED'), at: '2026-09-24', by: 'finance' });
    claims.recover(claim.id, { type: 'salvage', amount: money(250_00n, 'AED'), at: '2026-09-30' });
    claims.recover(claim.id, { type: 'reinsurance', amount: money(400_00n, 'AED'), at: '2026-10-02' });

    expect(claims.netCost(claim.id).minor).toBe(350_00n);
    const position = claims.position();
    expect(position.paidCash.minor).toBe(1_000_00n);
    expect(position.expenseIncurred.minor).toBe(1_000_00n);
    expect(position.recovered.minor).toBe(650_00n);
    expect(position.netCost.minor).toBe(350_00n);
    expect(ledger.balance(chart.cash()).minor).toBe(-350_00n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('lists overdue claims against a service standard', () => {
    const old = claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-05-01', reportedAt: '2026-05-02', description: 'Treatment' });
    claims.triage(old.id, cleanTriage);
    claims.register({ policyId: 'UL-000123', cause: 'medical', lossDate: '2026-09-28', reportedAt: '2026-09-29', description: 'Treatment' });
    const overdue = claims.overdue('2026-10-05');
    expect(overdue.map((c) => c.id)).toEqual([old.id]);
  });

  it('refuses a negative recovery and refuses to decline a claim that has paid money', () => {
    const claim = claims.register({ policyId: 'UL-000123', cause: 'property', lossDate: '2026-09-01', reportedAt: '2026-09-02', description: 'Loss' });
    try { claims.triage(claim.id, cleanTriage); } catch { /* triage is advisory */ }
    expect(() => claims.recover(claim.id, { type: 'salvage', amount: money(-5_00n, 'AED'), at: '2026-09-03' })).toThrow(ClaimsError);
    claims.approve(claim.id, { amount: money(200_00n, 'AED'), at: '2026-09-04', by: 'officer', role: 'claims-officer' });
    claims.settle(claim.id, { amount: money(200_00n, 'AED'), at: '2026-09-05', by: 'finance' });
    expect(() => claims.decline(claim.id, { at: '2026-09-06', by: 'officer', rationale: 'changed my mind' })).toThrow(/cannot be declined/);
  });
});

/** bps of a minor-unit amount, expressed as the engine computes it. */
function span(bps: number, minor: bigint): bigint {
  return (minor * BigInt(bps)) / 10_000n;
}

describe('takaful pool settlement', () => {
  it('pays a takaful claim from the risk fund with exactly one movement of cash, then issues qard when the pool runs dry', () => {
    const poolLedger = new Ledger('AED');
    const poolChart = buildChart(poolLedger, 'ALK-TKF', 'AED', ['PRF', 'PIF', 'OPF']);
    const takaful = new TakafulEngine(poolLedger, poolChart, 'ALK-TKF', 'AED');
    takaful.ensurePoolAccounts(['PRF', 'PIF', 'OPF']);
    const commission = { productId: 'TK-9001', model: 'wakalah' as const, wakalahFeeBps: 2_000, mudarabahProfitShareBps: 0, tabarruBps: 3_000, surplusParticipantShareBps: 6_000, allowsSurplusToSavers: false, jurisdiction: 'AE' };
    takaful.contribute({ policyId: 'TK-9001', contribution: money(10_000_00n, 'AED'), at: '2026-09-01', config: commission });
    expect(takaful.balance('PRF').minor).toBe(2_400_00n);

    const poolClaims = new ClaimsEngine(poolLedger, poolChart, 'ALK-TKF', 'AED', {
      poolSettler: (c, amount, at) => takaful.settlePoolClaim(c, amount, at),
    });
    const claim = poolClaims.register({ policyId: 'TK-9001', cause: 'death', lossDate: '2026-09-10', reportedAt: '2026-09-12', description: 'Death benefit', fundId: 'PRF' });
    poolClaims.triage(claim.id, cleanTriage);
    poolClaims.approve(claim.id, { amount: money(1_500_00n, 'AED'), at: '2026-09-15', by: 'head', role: 'head-of-claims' });
    const cashBefore = poolLedger.balance(poolChart.cash());
    poolClaims.settle(claim.id, { amount: money(1_500_00n, 'AED'), at: '2026-09-16', by: 'finance' });

    expect(takaful.balance('PRF').minor).toBe(900_00n);
    expect(poolLedger.balance(poolChart.cash()).minor).toBe(cashBefore.minor - 1_500_00n);
    expect(poolClaims.claim(claim.id).status).toBe('settled');
    // One cash movement for the claim, no conventional claim expense posted alongside it.
    const claimJournals = poolLedger.allJournals().filter((j) => j.sourceRef === claim.id);
    expect(claimJournals.filter((j) => j.postings.some((p) => p.accountId === poolChart.cash())).length).toBe(1);
    expect(poolLedger.balance(poolChart.claimExpense()).minor).toBe(0n);
    expect(poolLedger.proof('ALK-TKF').balanced).toBe(true);

    // Now exhaust the pool: the settlement borrows from the operator as qard hasan.
    const big = poolClaims.register({ policyId: 'TK-9001', cause: 'death', lossDate: '2026-09-20', reportedAt: '2026-09-21', description: 'Second death benefit', fundId: 'PRF' });
    poolClaims.triage(big.id, cleanTriage);
    poolClaims.approve(big.id, { amount: money(5_000_00n, 'AED'), at: '2026-09-22', by: 'cco', role: 'chief-claims-officer' });
    poolClaims.settle(big.id, { amount: money(5_000_00n, 'AED'), at: '2026-09-23', by: 'finance' });
    expect(takaful.balance('PRF').minor).toBe(0n);
    expect(takaful.qardOutstanding().minor).toBe(4_100_00n);
    expect(poolClaims.claim(big.id).decisions.at(-1)?.rationale).toMatch(/qard hasan/);
    expect(poolLedger.proof('ALK-TKF').balanced).toBe(true);
  });
});
