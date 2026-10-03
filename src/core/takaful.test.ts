import { describe, expect, it } from 'vitest';
import { Ledger } from './ledger.js';
import { buildChart } from './chart.js';
import { money } from './money.js';
import { TakafulEngine, TakafulError, TakafulProductConfig } from './takaful.js';

const CUR = 'AED';
const config: TakafulProductConfig = {
  productId: 'TKF-1', model: 'wakalah', wakalahFeeBps: 2000, mudarabahProfitShareBps: 0,
  tabarruBps: 3000, surplusParticipantShareBps: 7000, allowsSurplusToSavers: false, jurisdiction: 'AE',
};

function setup() {
  const ledger = new Ledger(CUR);
  const chart = buildChart(ledger, 'E2', CUR, ['PRF', 'PIF', 'OPF']);
  const engine = new TakafulEngine(ledger, chart, 'E2', CUR);
  return { ledger, chart, engine };
}

describe('takaful — funds, qard and surplus gates', () => {
  it('routes a contribution: operator fee, tabarru to the risk fund, balance to investment', () => {
    const { ledger, engine } = setup();
    const result = engine.contribute({ policyId: 'T1', contribution: money(300_000n, CUR), at: '2026-10-01T09:00:00+04:00', config });
    expect(result.wakalahFee.minor).toBe(60_000n);   // 20%
    expect(result.tabarru.minor).toBe(72_000n);      // 30% of the 240,000 balance
    expect(result.investment.minor).toBe(168_000n);  // remainder
    expect(engine.balance('PRF').minor).toBe(72_000n);
    expect(engine.balance('PIF').minor).toBe(168_000n);
    expect(engine.balance('OPF').minor).toBe(60_000n);
    expect(ledger.proof('E2').balanced).toBe(true);
  });

  it('pays a claim from the risk fund when the fund is sufficient', () => {
    const { engine } = setup();
    engine.contribute({ policyId: 'T1', contribution: money(300_000n, CUR), at: '2026-10-01T09:00:00+04:00', config });
    const paid = engine.payClaim({ claimId: 'C1', amount: money(50_000n, CUR), at: '2026-10-02T09:00:00+04:00' });
    expect(paid.qard).toBeUndefined();
    expect(paid.fromFund.minor).toBe(50_000n);
    expect(engine.balance('PRF').minor).toBe(22_000n);
    expect(engine.qardOutstanding().minor).toBe(0n);
  });

  it('issues interest-free qard when the risk fund cannot meet a claim', () => {
    const { ledger, engine } = setup();
    engine.contribute({ policyId: 'T1', contribution: money(300_000n, CUR), at: '2026-10-01T09:00:00+04:00', config });
    const paid = engine.payClaim({ claimId: 'C2', amount: money(100_000n, CUR), at: '2026-10-02T09:00:00+04:00' });
    expect(paid.fromFund.minor).toBe(72_000n);
    expect(paid.qard?.amount.minor).toBe(28_000n);
    expect(engine.qardOutstanding().minor).toBe(28_000n);
    expect(ledger.balance('E2:QARD').minor).toBe(28_000n);
    expect(ledger.proof('E2').balanced).toBe(true);
  });

  it('refuses to declare a surplus without actuary, Shariah and board approval', () => {
    const { engine } = setup();
    const proposal = engine.surplusRun({
      riskFundId: 'PRF', determinedAt: '2026-12-31', assets: money(305_000n, CUR), liabilities: money(180_000n, CUR),
      config, isFullValuation: true, auditedResultsAvailable: true,
    });
    expect(proposal.ready).toBe(false);
    expect(proposal.blockers).toHaveLength(3);
    expect(proposal.blockers.join(' ')).toMatch(/Actuarial recommendation/);
    expect(proposal.blockers.join(' ')).toMatch(/Shariah Committee/);
    expect(proposal.blockers.join(' ')).toMatch(/Board endorsement/);
    expect(proposal.distributable.minor).toBe(0n);
  });

  it('blocks distribution while the valuation is incomplete, results unaudited, or a qard is outstanding', () => {
    const { engine } = setup();
    engine.contribute({ policyId: 'T1', contribution: money(300_000n, CUR), at: '2026-10-01T09:00:00+04:00', config });
    engine.payClaim({ claimId: 'C3', amount: money(100_000n, CUR), at: '2026-10-02T09:00:00+04:00' });
    const approvals = {
      actuarialRecommendation: { recommended: true, by: 'actuary', at: '2026-12-31' },
      shariahApproval: { approved: true, by: 'shariah', at: '2026-12-31' },
      boardApproval: { endorsed: true, by: 'board', at: '2026-12-31' },
    };
    const blockedByQard = engine.surplusRun({
      riskFundId: 'PRF', determinedAt: '2026-12-31', assets: money(305_000n, CUR), liabilities: money(180_000n, CUR),
      config, isFullValuation: true, auditedResultsAvailable: true, ...approvals,
    });
    expect(blockedByQard.ready).toBe(false);
    expect(blockedByQard.blockers.join(' ')).toMatch(/Qard hasan/);
    expect(() => engine.distribute(blockedByQard.id, '2026-12-31')).toThrow(TakafulError);

    for (const q of engine.listQards()) engine.repayQard({ qardId: q.id, amount: money(1_000_000n, CUR), at: '2026-12-30T09:00:00+04:00' });
    const notAudited = engine.surplusRun({
      riskFundId: 'PRF', determinedAt: '2026-12-31', assets: money(305_000n, CUR), liabilities: money(180_000n, CUR),
      config, isFullValuation: true, auditedResultsAvailable: false, ...approvals,
    });
    expect(notAudited.blockers.join(' ')).toMatch(/Audited results/);

    const ready = engine.surplusRun({
      riskFundId: 'PRF', determinedAt: '2026-12-31', assets: money(305_000n, CUR), liabilities: money(180_000n, CUR),
      config, isFullValuation: true, auditedResultsAvailable: true, ...approvals,
    });
    expect(ready.ready).toBe(true);
    expect(ready.grossSurplus.minor).toBe(125_000n);
    expect(ready.participantShare.minor).toBe(87_500n);   // 70%
    expect(ready.operatorShare.minor).toBe(37_500n);
    expect(ready.notes.join(' ')).toMatch(/surplus may not be distributed to savers/i);
  });

  it('distributes a ready surplus to participants and the operator, once', () => {
    const { ledger, engine } = setup();
    const ready = engine.surplusRun({
      riskFundId: 'PRF', determinedAt: '2026-12-31', assets: money(305_000n, CUR), liabilities: money(180_000n, CUR),
      config, isFullValuation: true, auditedResultsAvailable: true,
      actuarialRecommendation: { recommended: true, by: 'actuary', at: '2026-12-31' },
      shariahApproval: { approved: true, by: 'shariah', at: '2026-12-31' },
      boardApproval: { endorsed: true, by: 'board', at: '2026-12-31' },
    });
    const paid = engine.distribute(ready.id, '2026-12-31T12:00:00+04:00');
    expect(paid.distributed).toBe(true);
    expect(engine.balance('PIF').minor).toBe(87_500n);
    expect(engine.balance('OPF').minor).toBe(37_500n);
    expect(ledger.proof('E2').balanced).toBe(true);
    expect(() => engine.distribute(ready.id, '2026-12-31T12:05:00+04:00')).toThrow(/already distributed/);
  });
});
