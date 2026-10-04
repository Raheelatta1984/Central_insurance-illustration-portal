/**
 * Takaful engine.
 *
 * Structural, not cosmetic: participants' risk fund, participants' investment fund and the
 * operator fund are separate pools; contributions route by contract; a deficit in the risk
 * fund is met by an interest-free qard that must be repaid before surplus is shared; and a
 * surplus distribution cannot happen without actuarial recommendation, Shariah Committee
 * approval and board endorsement — with jurisdiction rules applied on top (the UAE restricts
 * surplus distribution to savers; Malaysia's framework requires full valuation first).
 */
import { Ledger, posting } from './ledger.js';
import { Chart } from './chart.js';
import { Money, add, applyBps, compare, money, sub, zero, formatAmount } from './money.js';

export type TakafulModel = 'wakalah' | 'mudarabah' | 'waqf' | 'cooperative' | 'hybrid';

export interface TakafulProductConfig {
  readonly productId: string;
  readonly model: TakafulModel;
  readonly wakalahFeeBps: number;              // operator fee on contribution
  readonly mudarabahProfitShareBps: number;    // operator share of investment profit (0 for pure wakalah)
  readonly tabarruBps: number;                 // share of the post-fee contribution going to the risk fund
  readonly surplusParticipantShareBps: number; // of a declared surplus, participants' share
  readonly allowsSurplusToSavers: boolean;     // jurisdictions such as the UAE restrict this
  readonly jurisdiction: string;
}

export interface QardLoan {
  readonly id: string;
  readonly amount: Money;
  readonly issuedAt: string;
  readonly reason: string;
  repaid: Money;
  status: 'outstanding' | 'repaid';
}

export interface SurplusProposal {
  readonly id: string;
  readonly riskFundId: string;
  readonly determinedAt: string;
  readonly assets: Money;
  readonly liabilities: Money;
  readonly grossSurplus: Money;
  readonly qardOutstanding: Money;
  readonly distributable: Money;
  readonly participantShare: Money;
  readonly operatorShare: Money;
  readonly retained: Money;
  readonly approvals: { actuary: boolean; shariah: boolean; board: boolean };
  readonly blockers: string[];
  readonly ready: boolean;
  readonly notes: string[];
  distributed: boolean;
}

export class TakafulError extends Error {}

let seq = 0;
const nextId = (p: string) => `TKF-${p}-${String(++seq).padStart(6, '0')}`;

export const RISK_FUND = 'PRF';
export const INVESTMENT_FUND = 'PIF';
export const OPERATOR_FUND = 'OPF';

export class TakafulEngine {
  private readonly qards: QardLoan[] = [];
  private readonly proposals: SurplusProposal[] = [];

  constructor(
    private readonly ledger: Ledger,
    private readonly chart: Chart,
    private readonly entityId: string,
    private readonly currency: string,
  ) {}

  /** Contribution routing: operator fee, tabarru into the risk fund, balance into the investment fund. */
  contribute(input: { policyId: string; contribution: Money; at: string; config: TakafulProductConfig }): {
    wakalahFee: Money; tabarru: Money; investment: Money; journalIds: string[];
  } {
    const c = input.config;
    const fee = applyBps(input.contribution, c.wakalahFeeBps);
    const afterFee = sub(input.contribution, fee);
    const tabarru = applyBps(afterFee, c.tabarruBps);
    const investment = sub(afterFee, tabarru);
    const at = input.at;
    const ids: string[] = [];
    ids.push(this.post(input.policyId, at, 'Contribution received', [
      { accountId: this.chart.cash(), side: 'debit', amount: input.contribution, memo: 'contribution received' },
      { accountId: this.chart.fundClearing(), side: 'credit', amount: input.contribution, memo: 'to clearing' },
    ]));
    ids.push(this.post(input.policyId, at, 'Tabarru to risk fund', [
      { accountId: this.chart.fundClearing(), side: 'debit', amount: tabarru, memo: 'tabarru' },
      { accountId: this.fundAccount(RISK_FUND), side: 'credit', amount: tabarru, memo: 'participants risk fund' },
    ]));
    ids.push(this.post(input.policyId, at, 'Investment allocation to PIF', [
      { accountId: this.chart.fundClearing(), side: 'debit', amount: investment, memo: 'investment allocation' },
      { accountId: this.fundAccount(INVESTMENT_FUND), side: 'credit', amount: investment, memo: 'participants investment fund' },
    ]));
    ids.push(this.post(input.policyId, at, 'Wakalah fee to operator', [
      { accountId: this.chart.fundClearing(), side: 'debit', amount: fee, memo: 'wakalah fee' },
      { accountId: this.fundAccount(OPERATOR_FUND), side: 'credit', amount: fee, memo: 'operator fund' },
    ]));
    return { wakalahFee: fee, tabarru, investment, journalIds: ids };
  }

  private fundAccount(fund: string): string {
    // Reuses the participant-liability style accounts defined by the chart for the three pools.
    return `${this.chart.entityId}:${fund}:PARTICIPANTS`;
  }

  /** Idempotent: calling it twice, or after the chart already defined the pools, is a no-op. */
  ensurePoolAccounts(funds: string[]): void {
    for (const f of funds) {
      const investments = `${this.entityId}:${f}:INVESTMENTS`;
      if (!this.ledger.hasAccount(investments)) {
        this.ledger.defineAccount({ id: investments, name: `Pool investments — ${f}`, type: 'asset', entityId: this.entityId, fundId: f, currency: this.currency });
      }
      const participants = `${this.entityId}:${f}:PARTICIPANTS`;
      if (!this.ledger.hasAccount(participants)) {
        this.ledger.defineAccount({ id: participants, name: `Pool balance — ${f}`, type: 'liability', entityId: this.entityId, fundId: f, currency: this.currency });
      }
    }
  }

  balance(fund: string): Money {
    return this.ledger.balance(`${this.entityId}:${fund}:PARTICIPANTS`);
  }

  /** Pay a claim from the risk fund; if the fund is short, the operator lends interest-free (qard). */
  payClaim(input: { claimId: string; amount: Money; at: string }): { fromFund: Money; qard?: QardLoan; journalIds: string[] } {
    const available = this.balance(RISK_FUND);
    const shortfall = compare(available, input.amount) < 0 ? sub(input.amount, available) : zero(this.currency);
    const fromFund = sub(input.amount, shortfall);
    const ids: string[] = [];
    if (fromFund.minor > 0n) {
      ids.push(this.post(input.claimId, input.at, 'Claim paid from risk fund', [
        { accountId: this.fundAccount(RISK_FUND), side: 'debit', amount: fromFund, memo: 'claim paid' },
        { accountId: this.chart.cash(), side: 'credit', amount: fromFund, memo: 'claim payment' },
      ]));
    }
    let qard: QardLoan | undefined;
    if (shortfall.minor > 0n) {
      qard = { id: nextId('QARD'), amount: shortfall, issuedAt: input.at, reason: `Deficit in risk fund for claim ${input.claimId}`, repaid: zero(this.currency), status: 'outstanding' };
      this.qards.push(qard);
      ids.push(this.post(input.claimId, input.at, 'Qard hasan to cover risk fund deficit', [
        { accountId: this.chart.qard(), side: 'debit', amount: shortfall, memo: 'interest-free loan to participants fund' },
        { accountId: this.fundAccount(RISK_FUND), side: 'credit', amount: shortfall, memo: 'qard credited to risk fund' },
      ]));
      ids.push(this.post(input.claimId, input.at, 'Claim paid using qard', [
        { accountId: this.fundAccount(RISK_FUND), side: 'debit', amount: shortfall, memo: 'claim paid from qard' },
        { accountId: this.chart.cash(), side: 'credit', amount: shortfall, memo: 'claim payment' },
      ]));
    }
    return { fromFund, ...(qard ? { qard } : {}), journalIds: ids };
  }

  /**
   * Spend from the participants' risk fund on behalf of the claims engine, so a takaful claim
   * touches cash exactly once and never also posts a conventional claim expense. The claims
   * engine keeps the workflow; the pool keeps the money.
   */
  settlePoolClaim(claim: { id: string; fundId?: string }, amount: Money, at: string): { journalIds: string[]; poolId: string; fromPool: Money; qardIssued?: Money } {
    if (claim.fundId && claim.fundId !== RISK_FUND) {
      throw new TakafulError(`a claim on pool ${claim.fundId} cannot be paid from the risk fund; only ${RISK_FUND} carries risk`);
    }
    const result = this.payClaim({ claimId: claim.id, amount, at });
    return {
      journalIds: result.journalIds,
      poolId: RISK_FUND,
      fromPool: result.fromFund,
      ...(result.qard ? { qardIssued: result.qard.amount } : {}),
    };
  }

  qardOutstanding(): Money {
    return this.qards.filter((q) => q.status === 'outstanding')
      .reduce((acc, q) => add(acc, sub(q.amount, q.repaid)), zero(this.currency));
  }

  listQards(): readonly QardLoan[] { return this.qards; }

  /** Repay qard from future surplus before any distribution to participants or operator. */
  repayQard(input: { qardId: string; amount: Money; at: string }): QardLoan {
    const q = this.qards.find((x) => x.id === input.qardId);
    if (!q) throw new TakafulError(`unknown qard ${input.qardId}`);
    const outstanding = sub(q.amount, q.repaid);
    const amount = compare(input.amount, outstanding) > 0 ? outstanding : input.amount;
    this.post(input.qardId, input.at, 'Qard repayment', [
      { accountId: this.fundAccount(RISK_FUND), side: 'debit', amount, memo: 'qard repayment' },
      { accountId: this.chart.qard(), side: 'credit', amount, memo: 'qard repaid' },
    ]);
    q.repaid = add(q.repaid, amount);
    q.status = compare(q.repaid, q.amount) >= 0 ? 'repaid' : 'outstanding';
    return q;
  }

  /**
   * Determine a surplus. The proposal is always produced — the gates decide whether it may be paid.
   * This is deliberately impossible to bypass: ready === false means distribution is blocked.
   */
  surplusRun(input: {
    riskFundId: string; determinedAt: string; assets: Money; liabilities: Money;
    actuarialRecommendation?: { recommended: boolean; by: string; at: string };
    shariahApproval?: { approved: boolean; by: string; at: string };
    boardApproval?: { endorsed: boolean; by: string; at: string };
    config: TakafulProductConfig;
    isFullValuation: boolean;
    auditedResultsAvailable: boolean;
  }): SurplusProposal {
    const grossSurplus = sub(input.assets, input.liabilities);
    const qard = this.qardOutstanding();
    const blockers: string[] = [];
    const notes: string[] = [];
    const approvals = {
      actuary: Boolean(input.actuarialRecommendation?.recommended),
      shariah: Boolean(input.shariahApproval?.approved),
      board: Boolean(input.boardApproval?.endorsed),
    };
    if (!approvals.actuary) blockers.push('Actuarial recommendation missing (the actuary must recommend the surplus)');
    if (!approvals.shariah) blockers.push('Shariah Committee approval missing');
    if (!approvals.board) blockers.push('Board endorsement missing');
    if (!input.isFullValuation) blockers.push('Surplus may only be determined on a full valuation');
    if (!input.auditedResultsAvailable) blockers.push('Audited results are not yet available for the period');
    if (compare(grossSurplus, zero(this.currency)) <= 0) blockers.push('There is no surplus to distribute');
    if (compare(qard, zero(this.currency)) > 0) blockers.push(`Qard hasan of ${formatAmount(qard)} is outstanding and must be repaid first`);
    if (!input.config.allowsSurplusToSavers && input.config.jurisdiction === 'AE' && input.config.model !== 'cooperative') {
      notes.push('Jurisdiction rule (AE): surplus may not be distributed to savers under this model — retained in the risk fund.');
    }
    const payable = blockers.length === 0;
    const distributable = payable ? grossSurplus : zero(this.currency);
    const participantShare = applyBps(distributable, input.config.surplusParticipantShareBps);
    const operatorShare = sub(distributable, participantShare);
    const retained = payable ? zero(this.currency) : grossSurplus;
    const proposal: SurplusProposal = {
      id: nextId('SRP'), riskFundId: input.riskFundId, determinedAt: input.determinedAt,
      assets: input.assets, liabilities: input.liabilities, grossSurplus, qardOutstanding: qard,
      distributable, participantShare, operatorShare, retained, approvals, blockers, ready: payable, notes,
      distributed: false,
    };
    this.proposals.push(proposal);
    return proposal;
  }

  proposalsList(): readonly SurplusProposal[] { return this.proposals; }

  /** Pay a ready proposal. Any blocker stops it here too — belt and braces. */
  distribute(proposalId: string, at: string): SurplusProposal {
    const p = this.proposals.find((x) => x.id === proposalId);
    if (!p) throw new TakafulError(`unknown surplus proposal ${proposalId}`);
    if (!p.ready) throw new TakafulError(`surplus proposal ${proposalId} is blocked: ${p.blockers.join('; ')}`);
    if (p.distributed) throw new TakafulError('already distributed');
    this.post(proposalId, at, 'Surplus distribution to participants', [
      { accountId: this.fundAccount(RISK_FUND), side: 'debit', amount: p.participantShare, memo: 'participants share of surplus' },
      { accountId: this.fundAccount(INVESTMENT_FUND), side: 'credit', amount: p.participantShare, memo: 'credited to participant accounts' },
    ]);
    if (p.operatorShare.minor > 0n) {
      this.post(proposalId, at, 'Performance fee to operator', [
        { accountId: this.fundAccount(RISK_FUND), side: 'debit', amount: p.operatorShare, memo: 'operator share' },
        { accountId: this.fundAccount(OPERATOR_FUND), side: 'credit', amount: p.operatorShare, memo: 'operator fund' },
      ]);
    }
    p.distributed = true;
    return p;
  }

  private post(sourceRef: string, at: string, description: string, lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: Money; memo?: string }>): string {
    const entry = this.ledger.post({
      id: nextId('J'), entityId: this.entityId, at, source: 'takaful', sourceRef, description,
      postings: lines.map((l) => posting(l.accountId, l.side, l.amount, this.ledger.toBase(l.amount, this.entityId, at), l.memo)),
    });
    return entry.id;
  }
}
