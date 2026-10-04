/**
 * Claims.
 *
 * The rules encoded here are the ones that get insurers fined when they are missing:
 *  - a claim can only be paid while cover was actually in force on the loss date;
 *  - money leaves the books only through an authority — and an AI agent's authority is
 *    deliberately lower than any human's, with its reasoning recorded next to the human's;
 *  - reserves are a first-class accounting movement, so an outstanding claim is visible as a
 *    liability rather than a note in someone's inbox;
 *  - recoveries (salvage, subrogation, reinsurance) reduce the net cost of the claim and are
 *    posted as income, never netted off silently against the payment.
 *
 * For a takaful claim the payment leaves the participants' risk fund, not the operator's cash,
 * so the engine delegates the settlement to a pool settler (the takaful engine) and posts no
 * money of its own — there is exactly one movement of cash for every claim.
 */
import { Ledger, posting } from './ledger.js';
import { captureInput, RegisterAction, ReplayContext, ReplayableRegister } from './actionlog.js';
import { Money, add, applyBps, compare, formatAmount, gte, isNegative, money, sub, zero } from './money.js';

export type ClaimStatus = 'registered' | 'under-review' | 'approved' | 'settled' | 'declined' | 'withdrawn';
export type ClaimCause = 'death' | 'disability' | 'critical-illness' | 'medical' | 'motor' | 'property' | 'travel' | 'other';
export type RecoveryType = 'salvage' | 'subrogation' | 'reinsurance' | 'third-party';
export type TriageDecision = 'accept' | 'refer' | 'decline';

export interface Authority {
  readonly role: string;
  readonly limitMinor: bigint;
  readonly isAi: boolean;
}

/** Nothing an AI agent may authorise goes above the straight-through limit without a human. */
export const DEFAULT_AUTHORITY: Authority[] = [
  { role: 'claims-officer', limitMinor: 5_000_00n, isAi: false },
  { role: 'claims-manager', limitMinor: 50_000_00n, isAi: false },
  { role: 'head-of-claims', limitMinor: 250_000_00n, isAi: false },
  { role: 'chief-claims-officer', limitMinor: 5_000_000_00n, isAi: false },
  { role: 'ai-straight-through', limitMinor: 1_000_00n, isAi: true },
];

/** Expected severity as a share of sum assured, used only to *suggest* a reserve. */
export const SEVERITY_BPS: Record<ClaimCause, number> = {
  death: 10_000, disability: 6_000, 'critical-illness': 5_000, medical: 2_500,
  motor: 1_500, property: 1_000, travel: 800, other: 500,
};

export interface ClaimDecision {
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly rationale: string;
  readonly amount?: Money;
  readonly isAi: boolean;
}

export interface Recovery {
  readonly id: string;
  readonly type: RecoveryType;
  readonly amount: Money;
  readonly at: string;
  readonly journalId: string;
}

export interface Claim {
  readonly id: string;
  readonly policyId: string;
  readonly entityId: string;
  readonly cause: ClaimCause;
  readonly lossDate: string;
  readonly reportedAt: string;
  readonly description: string;
  readonly fundId?: string;
  status: ClaimStatus;
  reserve: Money;
  paid: Money;
  readonly recoveries: Recovery[];
  readonly decisions: ClaimDecision[];
  declinedReason?: string;
}

export interface TriageInput {
  readonly coverInForce: boolean;
  readonly exclusionsApplied: readonly string[];
  readonly daysLate: number;
  readonly fraudSignals: number;
}

export interface TriageResult {
  readonly decision: TriageDecision;
  readonly reasons: string[];
  readonly reserveSuggestion?: Money;
}

export interface PoolSettler {
  /** `poolId` names the pool the money came from; `fromPool` is how much of it came from there. */
  (claim: Claim, amount: Money, at: string): { journalIds: string[]; poolId: string; fromPool: Money; qardIssued?: Money };
}

export interface ClaimsOptions {
  /** Which register this is, in the snapshot's vocabulary: `claims` or `takaful-claims`. */
  readonly engineName?: string;
  readonly authority?: Authority[];
  readonly notificationGraceDays?: number;
  readonly slaDays?: number;
  readonly fraudSignalLimit?: number;
  readonly poolSettler?: PoolSettler;
}

export class ClaimsError extends Error {}

export class ClaimsEngine implements ReplayableRegister {
  private readonly claims = new Map<string, Claim>();
  private readonly actions: RegisterAction[] = [];
  /** Set while an action is being taken again: the journal it posted, and whether to record it. */
  private replayJournalId: string | null = null;
  private replaying = false;
  private readonly authority: Authority[];
  private readonly grace: number;
  private readonly sla: number;
  private readonly fraudLimit: number;
  private readonly settler?: PoolSettler;
  private seq = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly chart: { entityId: string; cash(): string; claimExpense(): string; claimReserve(): string; claimRecovery(): string },
    private readonly entityId: string,
    private readonly currency: string,
    options: ClaimsOptions = {},
  ) {
    this.engineName = options.engineName ?? 'claims';
    this.authority = [...(options.authority ?? DEFAULT_AUTHORITY)];
    this.grace = options.notificationGraceDays ?? 30;
    this.sla = options.slaDays ?? 45;
    this.fraudLimit = options.fraudSignalLimit ?? 2;
    if (options.poolSettler) this.settler = options.poolSettler;
  }

  /* --------------------------------------------------------------- intake */

  readonly engineName: string;

  /** What this claims register did: claims registered, reserves moved, settlements, recoveries. */
  actionLog(): readonly RegisterAction[] { return this.actions; }

  replay(action: RegisterAction, _context?: ReplayContext): void {
    const input = action.input as Record<string, never>;
    this.replayJournalId = action.journalId || null;
    this.replaying = true;
    try {
      this.replayInner(action, input);
    } finally {
      this.replaying = false;
      this.replayJournalId = null;
    }
  }

  private replayInner(action: RegisterAction, input: Record<string, never>): void {
    switch (action.kind) {
      case 'register-claim': this.register(input as never); return;
      case 'set-reserve': this.setReserve(String(input['claimId']), input as never); return;
      case 'approve-claim': this.approve(String(input['claimId']), input as never); return;
      case 'settle-claim': this.settle(String(input['claimId']), input as never); return;
      case 'recover-claim': this.recover(String(input['claimId']), input as never); return;
      case 'decline-claim': this.decline(String(input['claimId']), input as never); return;
      default: throw new ClaimsError(`this claims register has no action called ${action.kind} to take again`);
    }
  }

  private did(kind: string, at: string, journalId: string, input: unknown): void {
    if (this.replaying) return;   // an action being taken again is already in the log
    this.actions.push(Object.freeze({
      engine: this.engineName, kind, at, journalId,
      mark: this.ledger.allJournals().length,
      input: captureInput(input) as Readonly<Record<string, unknown>>,
    }));
  }

  register(input: {
    policyId: string; cause: ClaimCause; lossDate: string; reportedAt: string;
    description: string; fundId?: string;
  }): Claim {
    const id = `CLM-${String(++this.seq).padStart(6, '0')}`;
    const claim: Claim = {
      id, policyId: input.policyId, entityId: this.entityId, cause: input.cause,
      lossDate: input.lossDate, reportedAt: input.reportedAt, description: input.description,
      ...(input.fundId ? { fundId: input.fundId } : {}),
      status: 'registered', reserve: zero(this.currency), paid: zero(this.currency),
      recoveries: [], decisions: [{
        at: input.reportedAt, by: 'intake', action: 'registered',
        rationale: `Notification received and logged against ${input.policyId}`, isAi: false,
      }],
    };
    this.claims.set(id, claim);
    this.did('register-claim', input.reportedAt, '', input);
    return claim;
  }

  claim(id: string): Claim {
    const c = this.claims.get(id);
    if (!c) throw new ClaimsError(`unknown claim ${id}`);
    return c;
  }

  list(filter?: { status?: ClaimStatus; policyId?: string }): Claim[] {
    return [...this.claims.values()]
      .filter((c) => (filter?.status ? c.status === filter.status : true))
      .filter((c) => (filter?.policyId ? c.policyId === filter.policyId : true));
  }

  /* --------------------------------------------------------------- triage */

  triage(claimId: string, input: TriageInput): TriageResult {
    const claim = this.claim(claimId);
    const reasons: string[] = [];
    if (!input.coverInForce) {
      reasons.push('Cover was not in force on the loss date');
      return this.decide(claim, 'decline', reasons, input);
    }
    if (input.exclusionsApplied.length > 0) {
      reasons.push(`Exclusion applies: ${input.exclusionsApplied.join(', ')}`);
      return this.decide(claim, 'decline', reasons, input);
    }
    if (input.daysLate > this.grace) {
      reasons.push(`Notification ${input.daysLate} days after the loss, beyond the ${this.grace}-day grace period`);
      return this.decide(claim, 'refer', reasons, input);
    }
    if (input.fraudSignals >= this.fraudLimit) {
      reasons.push(`${input.fraudSignals} fraud signals reached the referral threshold of ${this.fraudLimit}`);
      return this.decide(claim, 'refer', reasons, input);
    }
    reasons.push('Cover in force, no exclusion applied, notification inside the grace period');
    return this.decide(claim, 'accept', reasons, input);
  }

  private decide(claim: Claim, decision: TriageDecision, reasons: string[], input: TriageInput): TriageResult {
    if (decision === 'decline') {
      claim.status = 'declined';
      claim.declinedReason = reasons.join('; ');
    } else {
      claim.status = 'under-review';
    }
    claim.decisions.push({
      at: claim.reportedAt, by: 'triage', action: `triage:${decision}`,
      rationale: `${reasons.join('; ')} (late by ${input.daysLate} days, ${input.fraudSignals} fraud signals)`, isAi: false,
    });
    const suggestion = decision === 'accept'
      ? { reserveSuggestion: this.suggestReserve(claim) }
      : {};
    return { decision, reasons, ...suggestion };
  }

  /** A suggestion, not a decision: the actuarial severity table applied to the sum assured. */
  suggestReserve(claim: Claim, sumAssured?: Money): Money {
    const bps = SEVERITY_BPS[claim.cause];
    if (!sumAssured) return zero(this.currency);
    return applyBps(sumAssured, bps);
  }

  /* -------------------------------------------------------------- reserves */

  /** Establishment or top-up of the case reserve. The movement is the expense; the balance is a liability. */
  setReserve(claimId: string, input: { amount: Money; at: string; by: string; isAi?: boolean; rationale?: string }): Claim {
    const claim = this.assertOpen(claimId, 'reserve');
    const delta = sub(input.amount, claim.reserve);
    if (isNegative(delta)) throw new ClaimsError('a reserve can be reduced only by settling or by an explicit release, never silently');
    if (compare(delta, zero(this.currency)) === 0) return claim;
    const journalId = this.post(`reserve ${claim.id}`, claim, input.at, `Increase in claim reserve ${claim.id} by ${formatAmount(delta)}`, [
      { accountId: this.chart.claimExpense(), side: 'debit', amount: delta, memo: 'increase in claim reserve' },
      { accountId: this.chart.claimReserve(), side: 'credit', amount: delta, memo: 'claim reserve outstanding' },
    ]);
    claim.reserve = input.amount;
    claim.decisions.push({
      at: input.at, by: input.by, action: 'reserve', amount: delta, isAi: input.isAi ?? false,
      rationale: input.rationale ?? `Reserve set to ${formatAmount(input.amount)}`,
    });
    this.did('set-reserve', input.at, journalId, { claimId: claim.id, ...input });
    return claim;
  }

  /* -------------------------------------------------------------- approval */

  authorityTable(): Array<{ role: string; limit: Money; isAi: boolean }> {
    return this.authority.map((a) => ({ role: a.role, limit: money(a.limitMinor, this.currency), isAi: a.isAi }));
  }

  /** Approval is a permission check, not a payment: the money moves at settlement. */
  approve(claimId: string, input: { amount: Money; at: string; by: string; role: string; isAi?: boolean }): Claim {
    const claim = this.assertOpen(claimId, 'approve');
    const authority = this.authority.find((a) => a.role === input.role);
    if (!authority) throw new ClaimsError(`unknown authority ${input.role}`);
    const isAi = input.isAi ?? authority.isAi;
    if (isAi !== authority.isAi) {
      throw new ClaimsError(`the ${input.role} authority is ${authority.isAi ? 'an AI' : 'a human'} authority; the declaration does not match`);
    }
    const limit = money(authority.limitMinor, this.currency);
    if (gte(input.amount, add(limit, money(1n, this.currency)))) {
      throw new ClaimsError(
        authority.isAi
          ? `an AI agent may authorise at most ${formatAmount(limit)} straight through; ${formatAmount(input.amount)} needs a human authority`
          : `${input.role} may authorise at most ${formatAmount(limit)}; ${formatAmount(input.amount)} needs a higher authority`,
      );
    }
    claim.status = 'approved';
    claim.decisions.push({
      at: input.at, by: input.by, action: 'approve', amount: input.amount, isAi,
      rationale: `Approved within the ${input.role} limit of ${formatAmount(limit)}`,
    });
    return claim;
  }

  /** The last amount an authority approved, so settlement pays what was authorised. */
  approvedAmount(claimId: string): Money | undefined {
    const decisions = this.claim(claimId).decisions.filter((d) => d.action === 'approve' && d.amount);
    return decisions.length > 0 ? decisions[decisions.length - 1]!.amount : undefined;
  }

  /* ------------------------------------------------------------- settlement */

  /**
   * Pay the claim. The reserve is released, the difference between settlement and reserve lands in
   * claim expense, and cash leaves exactly once — through the pool when the claim belongs to one.
   */
  settle(claimId: string, input: { amount: Money; at: string; by: string }): Claim {
    const claim = this.claim(claimId);
    if (claim.status === 'declined') throw new ClaimsError('a declined claim cannot be settled');
    if (claim.status === 'settled') throw new ClaimsError(`claim ${claimId} is already settled`);
    if (claim.status !== 'approved') throw new ClaimsError(`claim ${claimId} must be approved before settlement`);
    if (isNegative(input.amount) || compare(input.amount, zero(this.currency)) === 0) {
      throw new ClaimsError('a settlement amount must be positive');
    }

    const journalIds: string[] = [];
    if (this.settler && claim.fundId) {
      const result = this.settler(claim, input.amount, input.at);
      journalIds.push(...result.journalIds);
      claim.decisions.push({
        at: input.at, by: input.by, action: 'settled-from-pool', amount: input.amount, isAi: false,
        rationale: `Paid ${formatAmount(input.amount)} from the ${result.poolId} pool (${formatAmount(result.fromPool)} of it from the pool balance)${result.qardIssued ? `, with ${formatAmount(result.qardIssued)} qard hasan issued` : ''} — journals ${result.journalIds.length}`,
      });
    } else {
      const difference = sub(input.amount, claim.reserve);
      const lines = [
        { accountId: this.chart.claimReserve(), side: 'debit' as const, amount: claim.reserve, memo: 'release of case reserve' },
        { accountId: this.chart.cash(), side: 'credit' as const, amount: input.amount, memo: 'claim paid' },
      ];
      if (compare(difference, zero(this.currency)) < 0) {
        lines.push({ accountId: this.chart.claimExpense(), side: 'credit' as const, amount: sub(zero(this.currency), difference), memo: 'release of excess reserve' });
      } else if (compare(difference, zero(this.currency)) > 0) {
        lines.push({ accountId: this.chart.claimExpense(), side: 'debit' as const, amount: difference, memo: 'settlement above reserve' });
      }
      journalIds.push(this.post(`settle ${claim.id}`, claim, input.at, `Settlement of claim ${claim.id} for ${formatAmount(input.amount)}`, lines));
      claim.decisions.push({
        at: input.at, by: input.by, action: 'settled', amount: input.amount, isAi: false,
        rationale: `Paid ${formatAmount(input.amount)} against a reserve of ${formatAmount(claim.reserve)}${difference.minor === 0n ? '' : ` (difference ${formatAmount(difference)})`}`,
      });
    }

    claim.paid = add(claim.paid, input.amount);
    claim.reserve = zero(this.currency);
    claim.status = 'settled';
    this.did('settle-claim', input.at, journalIds[journalIds.length - 1] ?? '', { claimId: claim.id, ...input });
    return claim;
  }

  /* ------------------------------------------------------------- recoveries */

  /** Salvage, subrogation or reinsurance money coming back. Never netted off the payment. */
  /**
   * A recovery. Salvage and subrogation arrive in the bank; a reinsurance recovery is owed to us by
   * the reinsurer, so it lands on the reinsurance receivable instead of cash. One code path, one
   * journal, and the money sits where it actually is.
   */
  recover(claimId: string, input: { type: RecoveryType; amount: Money; at: string; by?: string; receivedInto?: string }): Recovery {
    const claim = this.claim(claimId);
    if (isNegative(input.amount) || compare(input.amount, zero(this.currency)) === 0) {
      throw new ClaimsError('a recovery amount must be positive');
    }
    const id = `REC-${claim.id}-${claim.recoveries.length + 1}`;
    const journalId = this.post(`recovery ${id}`, claim, input.at, `${input.type} recovery on ${claim.id} for ${formatAmount(input.amount)}`, [
      { accountId: input.receivedInto ?? this.chart.cash(), side: 'debit', amount: input.amount, memo: input.receivedInto ? `${input.type} recoverable` : `${input.type} received` },
      { accountId: this.chart.claimRecovery(), side: 'credit', amount: input.amount, memo: `${input.type} recovery income` },
    ]);
    const recovery: Recovery = { id, type: input.type, amount: input.amount, at: input.at, journalId };
    claim.recoveries.push(recovery);
    claim.decisions.push({
      at: input.at, by: input.by ?? 'recovery-desk', action: `recovery:${input.type}`, amount: input.amount, isAi: false,
      rationale: `${input.type} recovery recorded on ${journalId}`,
    });
    this.did('recover-claim', input.at, journalId, { claimId: claim.id, ...input });
    return recovery;
  }

  decline(claimId: string, input: { at: string; by: string; rationale: string }): Claim {
    const claim = this.claim(claimId);
    if (claim.paid.minor !== 0n) throw new ClaimsError('a claim that has paid money cannot be declined; use a recovery or a reversal');
    claim.status = 'declined';
    claim.declinedReason = input.rationale;
    claim.decisions.push({ at: input.at, by: input.by, action: 'decline', isAi: false, rationale: input.rationale });
    this.did('decline-claim', input.at, '', { claimId: claim.id, ...input });
    return claim;
  }

  /* ---------------------------------------------------------------- numbers */

  netCost(claimId: string): Money {
    const claim = this.claim(claimId);
    return sub(claim.paid, claim.recoveries.reduce((acc, r) => add(acc, r.amount), zero(this.currency)));
  }

  /**
   * The claims position. Balances come from the ledger itself, not from the in-memory claims, so
   * the numbers cannot drift from the books; `paidCash` and `openClaims` are operational counts.
   *
   * `expenseIncurred` is what has hit profit and loss: settlements plus reserve movements.
   * `reserved` is the liability still standing for open cases. `paidCash` is cash actually paid.
   */
  position(): {
    reserved: Money; expenseIncurred: Money; paidCash: Money; recovered: Money; netCost: Money; openClaims: number;
  } {
    const expense = this.ledger.balance(this.chart.claimExpense());
    const reserve = this.ledger.balance(this.chart.claimReserve());
    const recovery = this.ledger.balance(this.chart.claimRecovery());
    // `Ledger.balance` reports every account on its natural side, so the liability and the
    // income account both come back positive — no sign gymnastics needed here.
    const paidCash = this.list().reduce((acc, c) => add(acc, c.paid), zero(this.currency));
    return {
      reserved: reserve,
      expenseIncurred: expense,
      paidCash,
      recovered: recovery,
      netCost: sub(expense, recovery),
      openClaims: this.list().filter((c) => c.status === 'registered' || c.status === 'under-review' || c.status === 'approved').length,
    };
  }

  /**
   * Claims that have sat open beyond the service standard — the ones a regulator asks about.
   * Approved but unsettled counts as open: money promised to a claimant and not yet paid is
   * exactly the case a service standard is there to catch.
   */
  overdue(asOf: string, days = this.sla): Claim[] {
    const limit = new Date(asOf).getTime() - days * 86_400_000;
    return this.list().filter((c) => (c.status === 'registered' || c.status === 'under-review' || c.status === 'approved')
      && new Date(c.reportedAt).getTime() < limit);
  }

  /* ----------------------------------------------------------------- internals */

  private assertOpen(claimId: string, what: string): Claim {
    const claim = this.claim(claimId);
    if (claim.status === 'settled') throw new ClaimsError(`cannot ${what} a settled claim`);
    if (claim.status === 'declined') throw new ClaimsError(`cannot ${what} a declined claim`);
    return claim;
  }

  private post(sourceRef: string, claim: Claim, at: string, description: string, lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: Money; memo?: string }>): string {
    const entry = this.ledger.post({
      // on a replay the journal comes from the action, not from the counter: the books are being
      // reproduced, and an id minted afresh would collide with a journal the books already hold
      id: this.replayJournalId ?? `CL-${this.entityId}-${String(++this.seq).padStart(6, '0')}`,
      entityId: this.entityId, at, source: 'claims', sourceRef, description,
      ...(claim.fundId ? { fundId: claim.fundId } : {}),
      postings: lines.map((l) => posting(l.accountId, l.side, l.amount, this.ledger.toBase(l.amount, this.entityId, at), l.memo)),
    });
    return entry.id;
  }
}
