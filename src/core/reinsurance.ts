/**
 * Reinsurance and retakaful: the treaty register, automatic and facultative cession, ceded premium
 * and claim recovery posted to the books, and a treaty-utilisation statement a finance committee can
 * read without an actuary in the room.
 *
 * The same engine serves a conventional carrier and a takaful operator. What differs is the label on
 * the money and the rule about where it may go, and those are enforced here, in code:
 *
 *  - A takaful window may only cede to a **retakaful** treaty. Participant risk money never leaves
 *    the participant risk fund for a conventional reinsurer: that would break fund segregation, and
 *    no amount of paperwork afterwards can undo it. The engine refuses, and says why.
 *  - Cession never exceeds what the treaty actually gives: a quota share cedes its percentage, a
 *    surplus treaty cedes above the retention and up to retention × lines, an excess-of-loss treaty
 *    cedes only inside its band. Asking for more throws rather than inventing cover.
 *  - A facultative treaty applies only after the reinsurer has accepted that specific risk in
 *    writing. Until then the risk is retained in full — the register says so.
 *  - A treaty cannot be used outside its validity dates. Retrocession of a cession is simply another
 *    treaty (see `retrocede`), so a reinsurer's own book can be modelled the same way.
 *  - Ceding commission belongs to the operator (conventional) or is the operator's wakalah fee
 *    (takaful); it is never participant money.
 */
import { Ledger, posting } from './ledger.js';
import { captureInput, RegisterAction, ReplayContext, ReplayableRegister } from './actionlog.js';
import {
  Currency, Money, abs, add, applyBps, applyRatio, compare, formatAmount, isNegative, lte, money, sub, zero,
} from './money.js';

export class ReinsuranceError extends Error {}

export type TreatyKind = 'quota-share' | 'surplus' | 'excess-of-loss' | 'facultative';

/** Lines are appended to and settled in place: the register owns the record, callers get a copy. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type Basis = 'conventional' | 'takaful';

export interface Treaty {
  readonly id: string;
  readonly name: string;
  readonly counterparty: string;           // the reinsurer / retakaful operator
  readonly kind: TreatyKind;
  readonly basis: Basis;
  readonly lineOfBusiness: string;         // 'motor', 'life', 'medical', 'all'
  readonly currency: Currency;
  readonly from: string;                   // ISO date, inclusive
  readonly to?: string;                    // ISO date, inclusive; open-ended when absent
  readonly cessionBps?: number;            // quota share / facultative: share offered
  readonly retention?: Money;              // surplus: kept per risk before the treaty responds
  readonly lines?: number;                 // surplus: multiples of the retention the treaty takes
  readonly attachment?: Money;             // excess of loss: where cover starts
  readonly limit?: Money;                  // excess of loss: how far it reaches
  readonly commissionBps: number;          // ceding commission / operator wakalah fee on ceded premium
  readonly annualPremium?: Money;          // what the treaty costs for the period — the base for a reinstatement premium
  readonly reinstatements?: number;        // how many times excess-of-loss cover may be restored
  readonly reinstatementBps?: number;      // reinstatement premium, bps of the annual premium, pro rata to the loss
  readonly freeReinstatements?: number;    // the first N reinstatements cost nothing
  readonly depositAccounted?: boolean;     // risk transfer insufficient: account for it as a deposit, not as insurance
  readonly depositPremium?: Money;         // deposit premium agreed for the period, adjustable on expiry
  readonly rateOnLineBps?: number;         // technical premium = subject premium x rate on line
  readonly settlementDays?: number;        // how long the counterparty has to settle a recovery (default 60)
  readonly securityRequiredBps?: number;   // security to hold against premium still unearned, bps of ceded premium written
}

export interface Cession {
  readonly treatyId: string;
  readonly kind: TreatyKind;
  readonly basis: Basis;
  readonly lineOfBusiness: string;         // the book the risk was written in, carried so a report can group by it
  readonly riskId: string;
  readonly sumInsured: Money;
  readonly ceded: Money;                   // sum insured the reinsurer carries
  readonly retainedAfter: Money;           // what the company keeps, after every treaty applied
  readonly shareBps: number;               // ceded / sum insured, in basis points
  readonly explanation: string;
}

export interface CessionPosting extends Cession {
  readonly policyId: string;
  readonly ref: string;                    // identifies the cession: the policy, or an instalment of it
  readonly treatment: 'risk-transferring' | 'deposit';
  readonly premium: Money;                 // gross premium on the risk
  readonly cededPremium: Money;
  readonly commission: Money;
  readonly netRetainedPremium: Money;
  readonly journalId: string;
  readonly at: string;
}

export interface TreatyUtilisation {
  readonly treatyId: string;
  readonly name: string;
  readonly counterparty: string;
  readonly kind: TreatyKind;
  readonly basis: Basis;
  readonly lineOfBusiness: string;
  readonly reinstatementsUsed: number;
  readonly reinstatementsLeft: number;
  readonly capacity: Money;                // total sum insured the treaty can carry
  readonly cededSumInsured: Money;         // sum insured ceded to date
  readonly headroom: Money;
  readonly usedBps: number;
  readonly risks: number;
  readonly premiumCeded: Money;
  readonly premiumWritten: Money;          // gross premium on the risks that used this treaty
  readonly premiumCededBps: number;
  readonly commissionEarned: Money;
  readonly recoveries: Money;
  readonly valid: boolean;                 // inside its dates on the statement date
  readonly treatment: 'risk-transferring' | 'deposit';
  readonly cover: CoverState;              // limit, consumed, available and the reinstatements left
}

export interface ReinsuranceStatement {
  readonly asOf: string;
  readonly basis: Basis;
  readonly grossPremium: Money;
  readonly cededPremium: Money;
  readonly netRetainedPremium: Money;
  readonly cessionBps: number;             // ceded / gross
  readonly commissionIncome: Money;
  readonly recoveries: Money;
  readonly recoverable: Money;             // still owed to us by reinsurers
  readonly treaties: readonly TreatyUtilisation[];
  readonly reinstatements: readonly Reinstatement[];
  readonly deposits: readonly DepositAccount[];
  readonly notes: readonly string[];
}

const DAY = 86_400_000;
const isoDay = (at: string) => at.slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export interface CoverState {
  readonly treatyId: string;
  readonly limit: Money;
  readonly consumed: Money;                // the reinsurer's share of losses so far
  readonly available: Money;               // cover left before a reinstatement is needed
  readonly reinstatementsUsed: number;
  readonly reinstatementsLeft: number;
  readonly exhausted: boolean;
}

export interface Reinstatement {
  readonly treatyId: string;
  readonly sequence: number;
  readonly restored: Money;
  readonly premium: Money;                 // zero on a free reinstatement
  readonly free: boolean;
  readonly at: string;
  readonly journalId?: string;
  readonly available: Money;               // cover available once this reinstatement is in force
}

export interface DepositAccount {
  readonly treatyId: string;
  readonly depositPaid: Money;             // cumulative deposit premium paid on account
  readonly technicalPremium?: Money;       // the premium the period actually earned (on settlement)
  readonly adjustments: ReadonlyArray<{ at: string; kind: 'additional' | 'return'; amount: Money; journalId: string }>;
  readonly settled: boolean;
  readonly settledAt?: string;             // the day the period was settled: the day the premium was recognised
  readonly treatment: 'risk-transferring' | 'deposit';
  readonly assetRemaining: Money;          // deposit premium still sitting on the balance sheet
}

export type AgeBucket = '0-30' | '31-60' | '61-90' | '90+';

export interface RecoveryAgeing {
  readonly recoveryId: string;
  readonly claimId: string;
  readonly treatyId: string;
  readonly amount: Money;                  // what was claimed
  readonly settled: Money;                 // what the counterparty has paid
  readonly outstanding: Money;
  readonly at: string;
  readonly ageDays: number;
  readonly expectedBy: string;             // at + the treaty's settlement terms
  readonly overdueDays: number;            // 0 when inside terms
  readonly bucket: AgeBucket;
  readonly treatment: 'risk-transferring' | 'deposit';
}

export interface AgeingStatement {
  readonly asOf: string;
  readonly buckets: ReadonlyArray<{ bucket: AgeBucket; count: number; outstanding: Money }>;
  readonly items: readonly RecoveryAgeing[];
  readonly outstanding: Money;
  readonly overdue: Money;
  readonly oldestDays: number;
  readonly worstOverdue: readonly string[];
}

export interface ReconciliationLine {
  readonly kind: string;
  readonly what: string;
  readonly register: Money;                // what the reinsurance records say
  readonly ledger: Money;                  // what the books say
  readonly difference: Money;
  readonly status: 'agrees' | 'difference';
  readonly note?: string;
}

export interface Reconciliation {
  readonly asOf: string;
  readonly lines: readonly ReconciliationLine[];
  readonly agrees: boolean;
  readonly differences: number;
  readonly balanceSheet: { receivable: Money; payable: Money; depositAsset: Money; restrictedCash: Money; securityReceived: Money };
}

export interface DataQualityFinding {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
}

export interface DataQualityReport {
  readonly asOf: string;
  readonly findings: readonly DataQualityFinding[];
  readonly errors: number;
  readonly warnings: number;
  readonly checked: readonly string[];
}

/** Only the bit of the claims engine a reinsurance recovery needs, so the two modules stay apart. */
export interface ClaimsForRecovery {
  recover(claimId: string, input: {
    type: 'reinsurance'; amount: Money; at: string; by?: string; receivedInto?: string;
  }): { id: string; amount: Money };
}

/* ------------------------------------------- capability 8: collateral and cash calls */

export type SecurityKind = 'cash' | 'funds-withheld' | 'letter-of-credit' | 'bank-guarantee';

/**
 * Security a counterparty has put behind its promises.
 *
 * Cash and funds withheld are money we hold and must show on the balance sheet: cash is money posted
 * to us, funds withheld is premium we kept instead of paying. A letter of credit and a bank guarantee
 * are undertakings we can rely on but cannot spend — they are recorded, counted in the cover and
 * disclosed, never posted to the books, because pretending an unspent promise is cash is how insurers
 * end up with a balance sheet that flatters them.
 */
export interface SecurityInstrument {
  readonly id: string;
  readonly counterparty: string;
  readonly treatyId?: string;
  readonly kind: SecurityKind;
  readonly amount: Money;                  // face value when it was taken
  readonly at: string;
  readonly expiresAt?: string;
  readonly reference: string;              // the document number the counterparty will quote back at us
  readonly fundId?: string;                // participant risk money sits in the participant risk fund, security and all
  readonly onBalanceSheet: boolean;
  readonly by: string;
  readonly released: Money;                // returned to the counterparty
  readonly releasedAt?: string;
  readonly releasedBy?: string;
  readonly interest: Money;               // conventional only: interest earned on their cash, owed to them
  readonly journalId?: string;
}

export interface CashCall {
  readonly id: string;
  readonly counterparty: string;
  readonly amount: Money;
  readonly shortfallAtRaise: Money;        // what the shortfall was when the call was made
  readonly reason: string;
  readonly at: string;
  readonly dueBy: string;
  readonly by: string;
  readonly settled: Money;
  readonly status: 'open' | 'part-settled' | 'settled';
  readonly settlements: readonly SecurityAnswer[];
}

type SecurityAnswer = { at: string; amount: Money; kind: SecurityKind; instrumentId: string };
/** The register's own copy of a call: it settles in place, callers get a snapshot. */
type CashCallRecord = Mutable<Omit<CashCall, 'settlements'>> & { settlements: SecurityAnswer[] };

export interface CollateralPosition {
  readonly counterparty: string;
  readonly treaties: readonly string[];
  readonly recoverable: Money;             // what the counterparty still owes us on claims
  readonly premiumRequirement: Money;      // security against premium still unearned
  readonly requirement: Money;
  readonly held: Money;                    // instruments in force at the statement date, at face
  readonly heldOnBalanceSheet: Money;
  readonly heldOffBalanceSheet: Money;
  readonly shortfall: Money;
  readonly surplus: Money;
  readonly coverBps: number;               // held / requirement; 10,000 when nothing is required, by definition covered
  readonly expiringSoon: readonly SecurityInstrument[];
  readonly expired: readonly SecurityInstrument[];
  readonly instruments: readonly SecurityInstrument[];
  readonly calls: readonly CashCall[];
  readonly secured: boolean;
  readonly notes: readonly string[];
}

export interface SecurityFinding {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly what: string;
  readonly counterparty?: string;
}

export interface SecurityStatement {
  readonly asOf: string;
  readonly positions: readonly CollateralPosition[];
  readonly requirement: Money;
  readonly held: Money;
  readonly shortfall: Money;
  readonly unsecured: readonly string[];
  readonly findings: readonly SecurityFinding[];
  readonly notes: readonly string[];
  readonly ledger: {
    restrictedCash: Money;
    receivedAsSecurity: Money;
    interestCredited: Money;
    offBalanceSheet: Money;
  };
}

/** A day count in whole days between two ISO dates; negative when the second day is earlier. */
function daysBetween(from: string, to: string): number {
  const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** The ISO day `days` after an ISO day. Dates are counted in the calendar, never in floating point hours. */
function dayAfter(day: string, days: number): string {
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + days);
  return new Date(at).toISOString().slice(0, 10);
}

/** The 30-day window every treasury desk watches: security that lapses before it can be replaced. */
const SECURITY_EXPIRY_WINDOW_DAYS = 30;

export class TreatyRegister implements ReplayableRegister {
  private readonly treaties = new Map<string, Treaty>();
  private readonly cessions: CessionPosting[] = [];
  private readonly accepted = new Map<string, Set<string>>();   // facultative: treatyId -> risk ids
  private readonly schedule = new Map<string, Cession>();       // policyId -> the cession that applies
  private seq = 0;
  private readonly actions: RegisterAction[] = [];
  /** Set while an action is being taken again: the journal it posted, and whether to record it. */
  private replayJournalId: string | null = null;
  private replaying = false;

  constructor(
    private readonly ledger: Ledger,
    private readonly entityId: string,
    private readonly currency: Currency,
    private readonly engineNameIn?: string,
  ) {
    const id = (n: string) => `${entityId}:${n}`;
    this.ledger.defineAccount({ id: id('REINS:CEDED-PREMIUM'), name: 'Ceded premium / contribution (expense)', type: 'expense', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:PAYABLE'), name: 'Payable to reinsurers / retakaful operators', type: 'liability', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:RECEIVABLE'), name: 'Receivable from reinsurers / retakaful operators', type: 'asset', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:COMMISSION'), name: 'Ceding commission / wakalah fee', type: 'income', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:RECOVERY'), name: 'Catastrophe / event recovery income', type: 'income', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:DEPOSIT-PREMIUM'), name: 'Deposit premium paid on account', type: 'asset', entityId, currency });
    this.ledger.defineAccount({ id: id('COLLATERAL:CASH'), name: 'Cash held as security (restricted)', type: 'asset', entityId, currency });
    this.ledger.defineAccount({ id: id('RECEIVED-AS-SECURITY'), name: 'Security received from reinsurers, returnable', type: 'liability', entityId, currency });
    this.ledger.defineAccount({ id: id('COLLATERAL:INTEREST'), name: 'Interest earned on cash collateral held', type: 'expense', entityId, currency });
  }

  /* ------------------------------------------------------------- what this register did */

  get engineName(): string { return this.engineNameIn ?? 'reinsurance'; }

  /**
   * Every money-moving action this register took, and the journal it posted. The register hands this
   * to the store; the store replays it to prove a restart lands on the same books.
   */
  actionLog(): readonly RegisterAction[] { return this.actions; }

  /**
   * Take an action again from its own recorded inputs. This is the register being asked to
   * reproduce itself, so it goes back through the same public method the desk used — not around it.
   */
  replay(action: RegisterAction, context?: ReplayContext): void {
    const input = action.input as Record<string, never>;
    this.replayJournalId = action.journalId || null;
    this.replaying = true;
    try {
      this.replayInner(action, input, context);
    } finally {
      this.replaying = false;
      this.replayJournalId = null;
    }
  }

  private replayInner(action: RegisterAction, input: Record<string, never>, context?: ReplayContext): void {
    switch (action.kind) {
      case 'cede-premium': this.cedePremium(input as never); return;
      case 'recover-claim': {
        // A claim recovery is taken against a claims register. The action remembers which one by
        // name; the replay hands it the register wearing that name in this world, or says it cannot.
        const named = (action.input['claim'] as { engine?: string } | undefined)?.engine;
        const claim = named ? context?.register(named) : undefined;
        if (named && !claim) {
          throw new ReinsuranceError(`this recovery was taken against the ${named} register and there is no ${named} register here to take it again`);
        }
        this.recoverClaim({ ...(action.input as object), ...(claim ? { claim } : {}) } as never);
        return;
      }
      case 'event-recovery': this.recoverEvent(String(input['treatyId']), input as never); return;
      case 'reinstate': this.reinstate(String(input['treatyId']), input as never); return;
      case 'open-deposit': this.openDeposit(String(input['treatyId']), input as never); return;
      case 'settle-deposit': this.settleDeposit(String(input['treatyId']), input as never); return;
      case 'settle-recovery': this.settleRecovery(input as never); return;
      case 'hold-security': this.holdSecurity(input as never); return;
      case 'call-security': this.callSecurity(input as never); return;
      case 'release-security': this.releaseSecurity(input as never); return;
      case 'credit-collateral-interest': this.creditCollateralInterest(input as never); return;
      case 'accept-facultative': this.acceptFacultative(String(input['treatyId']), String(input['riskId']), input as never); return;
      default: throw new ReinsuranceError(`the register has no action called ${action.kind} to take again`);
    }
  }

  /**
   * The id the next journal takes. On a replay it is the id the action posted the first time — the
   * books are being reproduced, not written afresh, so the counter must not be consulted.
   */
  private nextJournalId(): string {
    return this.replayJournalId ?? `RI-${this.entityId}-${String(++this.seq).padStart(6, '0')}`;
  }

  /** Record an action and the journal it posted. Called by the actions themselves, never by hand. */
  private did(kind: string, at: string, journalId: string, input: unknown): void {
    // an action being taken again is already in the log: recording it again would grow the log on
    // every restore, and the second copy would carry a mark from a world that had already moved on
    if (this.replaying) return;
    this.actions.push(Object.freeze({
      engine: this.engineName,
      kind,
      at,
      journalId,
      mark: this.ledger.allJournals().length,
      input: captureInput(input) as Readonly<Record<string, unknown>>,
    }));
  }

  /* ------------------------------------------------------------------ register */

  /** Put a treaty on the register. A name and a counterparty are not decoration: they are who we sue. */
  register(input: Omit<Treaty, 'currency'> & { currency?: Currency }): Treaty {
    if (!input.id || !input.name || !input.counterparty) {
      throw new ReinsuranceError('a treaty needs an id, a name and a counterparty');
    }
    const currency = input.currency ?? this.currency;
    if (currency !== this.currency) {
      throw new ReinsuranceError(`a ${this.currency} book cannot take a ${currency} treaty; cede through a ${currency} entity and consolidate`);
    }
    if (input.commissionBps < 0 || input.commissionBps > 10_000) {
      throw new ReinsuranceError(`ceding commission of ${input.commissionBps} bps is not a share of the premium`);
    }
    if (input.from < '2020-01-01') throw new ReinsuranceError('a treaty start date that far back is a data error');
    if (input.to && input.to < input.from) throw new ReinsuranceError('a treaty cannot end before it starts');
    switch (input.kind) {
      case 'quota-share':
        if (!input.cessionBps || input.cessionBps <= 0 || input.cessionBps > 10_000) {
          throw new ReinsuranceError('a quota share treaty needs a share between 0 and 10,000 bps');
        }
        break;
      case 'surplus':
        if (!input.retention || input.retention.minor <= 0n || !input.lines || input.lines < 1) {
          throw new ReinsuranceError('a surplus treaty needs a retention and at least one line');
        }
        break;
      case 'excess-of-loss':
        if (!input.attachment || !input.limit || input.limit.minor <= 0n) {
          throw new ReinsuranceError('an excess of loss treaty needs an attachment and a positive limit');
        }
        break;
      case 'facultative':
        if (!input.cessionBps || input.cessionBps <= 0 || input.cessionBps > 10_000) {
          throw new ReinsuranceError('a facultative treaty needs the share offered to the reinsurer');
        }
        break;
    }
    if ((input.reinstatements ?? 0) > 0) {
      if (input.kind !== 'excess-of-loss') {
        throw new ReinsuranceError(`reinstatements are an excess of loss feature; ${input.id} is a ${input.kind} treaty`);
      }
      if (!input.annualPremium || input.annualPremium.minor <= 0n) {
        throw new ReinsuranceError('a treaty with reinstatements needs its annual premium: a reinstatement premium is a share of it');
      }
      if ((input.reinstatementBps ?? 0) < 0 || (input.reinstatementBps ?? 0) > 10_000) {
        throw new ReinsuranceError(`a reinstatement premium of ${input.reinstatementBps} bps is not a share of the annual premium`);
      }
      if ((input.freeReinstatements ?? 0) > (input.reinstatements ?? 0)) {
        throw new ReinsuranceError('there cannot be more free reinstatements than reinstatements');
      }
    }
    if (input.rateOnLineBps !== undefined && (!input.depositPremium || input.depositPremium.minor <= 0n)) {
      throw new ReinsuranceError('a rate on line is an adjustment to a deposit premium; give the deposit premium');
    }
    if (input.securityRequiredBps !== undefined) {
      if (input.securityRequiredBps < 0 || input.securityRequiredBps > 10_000) {
        throw new ReinsuranceError(`security of ${input.securityRequiredBps} bps of ceded premium is not a share of it`);
      }
      if (input.depositAccounted) {
        throw new ReinsuranceError('a deposit accounted treaty is not a risk transfer: there is no reinsurer exposure to secure, only the deposit we already hold');
      }
    }
    if (input.depositAccounted && input.basis === 'takaful' && input.kind === 'quota-share') {
      throw new ReinsuranceError('a retakaful quota share is risk-transferring: deposit accounting does not apply to it');
    }
    if (this.treaties.has(input.id)) throw new ReinsuranceError(`treaty ${input.id} is already on the register`);
    const treaty: Treaty = { ...input, currency };
    this.treaties.set(treaty.id, treaty);
    return treaty;
  }

  treaty(id: string): Treaty {
    const t = this.treaties.get(id);
    if (!t) throw new ReinsuranceError(`unknown treaty ${id}`);
    return t;
  }

  list(filter?: { basis?: Basis; kind?: TreatyKind; lineOfBusiness?: string }): Treaty[] {
    return [...this.treaties.values()]
      .filter((t) => !filter?.basis || t.basis === filter.basis)
      .filter((t) => !filter?.kind || t.kind === filter.kind)
      .filter((t) => !filter?.lineOfBusiness || t.lineOfBusiness === filter.lineOfBusiness || t.lineOfBusiness === 'all')
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The reinsurer accepts a named risk. Without this a facultative treaty carries nothing. */
  acceptFacultative(treatyId: string, riskId: string, input: { at: string; by: string }): Treaty {
    const treaty = this.treaty(treatyId);
    if (treaty.kind !== 'facultative') throw new ReinsuranceError(`${treatyId} is a ${treaty.kind} treaty; only a facultative treaty accepts named risks`);
    if (!this.isValidOn(treaty, isoDay(input.at))) throw new ReinsuranceError(`${treatyId} is not in force on ${isoDay(input.at)}`);
    const set = this.accepted.get(treatyId) ?? new Set<string>();
    set.add(riskId);
    this.accepted.set(treatyId, set);
    this.notes.push(`${input.by} had ${riskId} accepted under ${treatyId} on ${isoDay(input.at)}`);
    // An acceptance posts no journal and moves no money, and it is still an action of the register:
    // a cession under a facultative treaty is refused unless the risk was accepted first, so a
    // restart that cannot put the acceptance back cannot reproduce the cession either.
    this.did('accept-facultative', input.at, '', { treatyId, riskId, ...input });
    return treaty;
  }

  acceptedRisks(treatyId: string): string[] {
    return [...(this.accepted.get(treatyId) ?? new Set<string>())].sort();
  }

  private readonly notes: string[] = [];
  /** Cover each treaty has paid away, so a reinstatement can put it back. */
  private readonly consumed = new Map<string, Money>();
  private readonly reinstatementLog: Reinstatement[] = [];
  private readonly eventRecoveries: Array<{ treatyId: string; eventId: string; amount: Money; at: string; journalId: string }> = [];
  private readonly deposits = new Map<string, {
    treatyId: string; depositPaid: Money; technicalPremium?: Money; settled: boolean; settledAt?: string;
    adjustments: Array<{ at: string; kind: 'additional' | 'return'; amount: Money; journalId: string }>;
  }>();

  isValidOn(treaty: Treaty, day: string): boolean {
    return day >= treaty.from && (!treaty.to || day <= treaty.to);
  }

  /* ------------------------------------------------------------------- cession */

  /**
   * The cession one treaty makes of one risk, before any money moves. Capacity is checked here, so
   * every posting downstream is arithmetic on an authorised cession rather than a hopeful guess.
   */
  authoriseCession(treatyId: string, input: {
    riskId: string; sumInsured: Money; lineOfBusiness: string; at: string; basis: Basis;
  }): Cession {
    const treaty = this.treaty(treatyId);
    const day = isoDay(input.at);
    if (!this.isValidOn(treaty, day)) {
      throw new ReinsuranceError(`${treatyId} is not in force on ${day} (${treaty.from}${treaty.to ? ` to ${treaty.to}` : ' onwards'})`);
    }
    if (treaty.basis === 'takaful' && input.basis !== 'takaful') {
      throw new ReinsuranceError(`${treatyId} is a retakaful treaty and cannot take conventional risk`);
    }
    if (treaty.basis === 'conventional' && input.basis === 'takaful') {
      throw new ReinsuranceError(`${treatyId} is a conventional reinsurance treaty: participant risk money may not be ceded to it. Use a retakaful treaty`);
    }
    if (input.sumInsured.currency !== treaty.currency) throw new ReinsuranceError(`risk in ${input.sumInsured.currency} cannot be ceded to a ${treaty.currency} treaty`);
    if (treaty.lineOfBusiness !== 'all' && treaty.lineOfBusiness !== input.lineOfBusiness) {
      throw new ReinsuranceError(`${treatyId} covers ${treaty.lineOfBusiness}, not ${input.lineOfBusiness}`);
    }
    const sumInsured = input.sumInsured;
    let ceded: Money;
    let explanation: string;
    switch (treaty.kind) {
      case 'quota-share': {
        ceded = applyBps(sumInsured, treaty.cessionBps!);
        explanation = `${treaty.cessionBps! / 100}% of every risk is ceded as it is written`;
        break;
      }
      case 'surplus': {
        const retention = treaty.retention!;
        const capacity = money(retention.minor * BigInt(treaty.lines!), treaty.currency);
        if (lte(sumInsured, retention)) {
          ceded = zero(treaty.currency);
          explanation = `${formatAmount(sumInsured)} sits inside the ${formatAmount(retention)} retention: the treaty does not respond`;
        } else {
          const above = sub(sumInsured, retention);
          ceded = compare(above, capacity) > 0 ? capacity : above;
          explanation = `${formatAmount(retention)} retained, the next ${treaty.lines} line(s) ceded up to ${formatAmount(capacity)}`
            + (compare(above, capacity) > 0 ? `; ${formatAmount(sub(above, capacity))} above the treaty is retained and should be facultative` : '');
        }
        break;
      }
      case 'excess-of-loss': {
        const attachment = treaty.attachment!;
        const limit = treaty.limit!;
        if (lte(sumInsured, attachment)) {
          ceded = zero(treaty.currency);
          explanation = `${formatAmount(sumInsured)} is below the ${formatAmount(attachment)} attachment point`;
        } else {
          const above = sub(sumInsured, attachment);
          ceded = compare(above, limit) > 0 ? limit : above;
          explanation = `cover of ${formatAmount(limit)} excess of ${formatAmount(attachment)}`;
        }
        break;
      }
      case 'facultative': {
        if (!this.accepted.get(treaty.id)?.has(input.riskId)) {
          throw new ReinsuranceError(`${input.riskId} has not been accepted under facultative treaty ${treaty.id}; the risk is retained in full until the reinsurer says yes in writing`);
        }
        ceded = applyBps(sumInsured, treaty.cessionBps!);
        explanation = `${treaty.counterparty} accepted ${input.riskId} for ${treaty.cessionBps! / 100}% on ${day}`;
        break;
      }
    }
    const shareBps = sumInsured.minor === 0n ? 0 : Number((ceded.minor * 10_000n * 100n) / sumInsured.minor) / 100;
    return {
      treatyId: treaty.id, kind: treaty.kind, basis: treaty.basis, lineOfBusiness: input.lineOfBusiness,
      riskId: input.riskId, sumInsured, ceded, retainedAfter: sub(sumInsured, ceded),
      shareBps: Math.round(shareBps), explanation,
    };
  }

  /**
   * Cede the premium on a risk: the cession is authorised, the reinsurer's share of the premium is
   * booked as an expense, the ceding commission as income, and the net retention is what the profit
   * and loss account actually keeps. Idempotent per risk and treaty.
   */
  cedePremium(input: {
    treatyId: string; policyId: string; riskId: string; sumInsured: Money; premium: Money;
    lineOfBusiness: string; at: string; basis: Basis; by?: string; fundId?: string; ref?: string;
  }): CessionPosting {
    // Ceding the same risk twice under the same treaty is how money leaves a company quietly.
    const ref = input.ref ?? input.policyId;
    const already = this.cessions.find((c) => c.treatyId === input.treatyId && c.policyId === input.policyId && c.ref === ref);
    if (already) {
      throw new ReinsuranceError(`${input.policyId} is already ceded under ${input.treatyId} (${already.journalId}); a second cession of the same risk would count it twice. Give an instalment its own reference`);
    }
    const cession = this.authoriseCession(input.treatyId, input);
    if (input.premium.currency !== cession.sumInsured.currency) throw new ReinsuranceError('premium and sum insured must be the same money');
    // Exact ratio, not the rounded basis points: a surplus treaty cedes a slice, not a percentage.
    const cededPremium = applyRatio(input.premium, cession.ceded.minor, cession.sumInsured.minor);
    const commission = applyBps(cededPremium, this.treaty(input.treatyId).commissionBps);
    const netRetainedPremium = add(sub(input.premium, cededPremium), commission);
    const treaty = this.treaty(input.treatyId);
    const treatment: 'risk-transferring' | 'deposit' = treaty.depositAccounted ? 'deposit' : 'risk-transferring';
    const id = this.nextJournalId();
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance',
      sourceRef: `${input.policyId}/${input.treatyId}`,
      // A retakaful cession belongs to the participant risk fund, not to the operator: the journal
      // says so, so a fund-level view can never quietly treat it as shareholder money.
      ...(input.fundId ? { fundId: input.fundId } : {}),
      description: `Cession of ${formatAmount(cededPremium)} premium (${cession.shareBps / 100}% of ${formatAmount(input.premium)}) to ${treaty.counterparty} under ${input.treatyId}`
        + (treatment === 'deposit' ? ' (deposit accounting: a deposit, not an expense)' : ''),
      postings: [
        // A risk-transferring treaty moves premium to expense. A deposit-accounted one does not: the
        // money is an asset the reinsurer holds for us, and it only becomes a cost when the period is
        // settled on the real subject premium.
        ...(treatment === 'deposit'
          ? [posting(this.account('DEPOSIT-PREMIUM'), 'debit', cededPremium, this.ledger.toBase(cededPremium, this.entityId, input.at), `${input.riskId} premium held as a deposit`)]
          : [posting(this.account('CEDED-PREMIUM'), 'debit', cededPremium, this.ledger.toBase(cededPremium, this.entityId, input.at), `${input.riskId} ceded premium`)]),
        posting(this.account('PAYABLE'), 'credit', cededPremium, this.ledger.toBase(cededPremium, this.entityId, input.at), `${treaty.counterparty}`),
        posting(this.account('RECEIVABLE'), 'debit', commission, this.ledger.toBase(commission, this.entityId, input.at), `ceding commission due`),
        posting(this.account('COMMISSION'), 'credit', commission, this.ledger.toBase(commission, this.entityId, input.at), `${treaty.counterparty}`),
      ],
    });
    const postingRecord: CessionPosting = {
      ...cession, policyId: input.policyId, ref, treatment, premium: input.premium, cededPremium, commission,
      netRetainedPremium, journalId: entry.id, at: input.at,
    };
    this.did('cede-premium', input.at, entry.id, input);
    this.cessions.push(postingRecord);
    this.schedule.set(input.policyId, cession);
    return postingRecord;
  }

  /** What share of this risk the reinsurer carries — the number a claim recovery is computed from. */
  shareFor(policyId: string): Cession {
    const cession = this.schedule.get(policyId);
    if (!cession) throw new ReinsuranceError(`no cession is on the schedule for ${policyId}; a recovery cannot be claimed without a cession`);
    return cession;
  }

  cessionSchedule(): readonly CessionPosting[] { return this.cessions; }

  /* ------------------------------------------------------- claim recovery */

  /**
   * The reinsurer's share of a claim we have paid. The recovery is recorded on the claim itself —
   * so the claim's net cost falls in the same place every other recovery lands — but the money is
   * owed by the reinsurer, not in the bank, so it debits the reinsurance receivable.
   */
  recoverClaim(input: {
    policyId: string; claim: ClaimsForRecovery;
    claimId: string; paid: Money; at: string; by?: string; ref?: string;
  }): { amount: Money; shareBps: number; recoveryId: string } {
    const ref = input.ref ?? input.claimId;
    if (this.accountingTreatment(this.shareFor(input.policyId).treatyId) === 'deposit') {
      // Deposit accounting: the reinsurer's share of a claim draws down the money it holds for us.
      // No income is recognised, and the claim itself is not reduced — that is the point of it.
      return this.recoverAgainstDeposit(input);
    }
    const already = this.recoveries.find((r) => r.claimId === input.claimId && r.treatyId === this.shareFor(input.policyId).treatyId && r.ref === ref);
    if (already) {
      throw new ReinsuranceError(`${input.claimId} has already been recovered under ${already.treatyId} (${already.recoveryId}); claim it again only as a named further instalment`);
    }
    const cession = this.shareFor(input.policyId);
    if (cession.shareBps === 0) throw new ReinsuranceError(`nothing was ceded on ${input.policyId}; there is no reinsurance recovery to claim`);
    const amount = applyRatio(input.paid, cession.ceded.minor, cession.sumInsured.minor);
    if (isNegative(amount) || amount.minor === 0n) throw new ReinsuranceError('a recovery amount must be positive');
    const recovery = input.claim.recover(input.claimId, {
      type: 'reinsurance', amount, at: input.at,
      ...(input.by ? { by: input.by } : {}),
      receivedInto: this.account('RECEIVABLE'),
    });
    this.recoveries.push({ claimId: input.claimId, ref, amount, at: input.at, treatyId: cession.treatyId, recoveryId: recovery.id, treatment: 'risk-transferring', source: 'policy', settled: zero(this.currency) });
    this.did('recover-claim', input.at, recovery.id, { ...input, claim: { engine: (input.claim as { engineName?: string }).engineName ?? 'claims' } });
    return { amount, shareBps: cession.shareBps, recoveryId: recovery.id };
  }

  /**
   * The deposit-accounted path: the reinsurer's share is taken out of the deposit it holds, and the
   * balance sheet — not the profit and loss account — carries the movement.
   */
  private recoverAgainstDeposit(input: {
    policyId: string; claim: ClaimsForRecovery; claimId: string; paid: Money; at: string; by?: string; ref?: string;
  }): { amount: Money; shareBps: number; recoveryId: string } {
    const cession = this.shareFor(input.policyId);
    const account = this.deposits.get(cession.treatyId);
    if (!account || this.ledger.balance(this.account('DEPOSIT-PREMIUM')).minor <= 0n) {
      throw new ReinsuranceError(`${cession.treatyId} is deposit accounted and holds no deposit: there is nothing to draw on`);
    }
    const amount = applyRatio(input.paid, cession.ceded.minor, cession.sumInsured.minor);
    if (amount.minor === 0n) throw new ReinsuranceError('a recovery amount must be positive');
    const id = this.nextJournalId();
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${input.claimId}/${cession.treatyId}/deposit`,
      description: `${formatAmount(amount)} of ${input.claimId} drawn from the ${cession.treatyId} deposit (deposit accounting)`,
      postings: [
        posting(this.account('PAYABLE'), 'debit', amount, this.ledger.toBase(amount, this.entityId, input.at), `deposit drawn down for ${input.claimId}`),
        posting(this.account('DEPOSIT-PREMIUM'), 'credit', amount, this.ledger.toBase(amount, this.entityId, input.at), `${cession.treatyId} deposit released`),
      ],
    });
    // A deposit draw is not a receivable: the money was already the reinsurer's, so it is recorded
    // here for the audit trail but never aged and never settled.
    this.recoveries.push({ claimId: input.claimId, ref: input.ref ?? input.claimId, amount, at: input.at, treatyId: cession.treatyId, recoveryId: id, treatment: 'deposit', source: 'deposit', settled: amount });
    this.did('recover-claim', input.at, entry.id, { ...input, claim: { engine: (input.claim as { engineName?: string }).engineName ?? 'claims' } });
    this.notes.push(`${input.by ?? 'recovery-desk'}: ${formatAmount(amount)} drawn from the ${cession.treatyId} deposit for ${input.claimId} (no income recognised)`);
    return { amount, shareBps: cession.shareBps, recoveryId: id };
  }

  private readonly securityInstruments: Array<Mutable<SecurityInstrument>> = [];
  private readonly cashCalls: CashCallRecord[] = [];
  private securitySeq = 0;
  private callSeq = 0;

  private readonly recoveries: Array<{
    claimId: string; ref: string; amount: Money; at: string; treatyId: string; recoveryId: string;
    treatment: 'risk-transferring' | 'deposit'; source: 'policy' | 'event' | 'deposit';
    settled: Money; settledAt?: string;
  }> = [];
  recoveryList(): readonly {
    claimId: string; ref: string; amount: Money; settled: Money; outstanding: Money; at: string;
    treatyId: string; recoveryId: string; treatment: 'risk-transferring' | 'deposit'; source: 'policy' | 'event' | 'deposit';
    settledAt?: string;
  }[] {
    return this.recoveries.map((r) => ({ ...r, outstanding: sub(r.amount, r.settled) }));
  }

  /* ------------------------------------------- catastrophe recovery and reinstatement */

  /**
   * A loss the treaty carries directly — a catastrophe event, or an aggregate stop-loss trigger —
   * rather than one policy's claim. Excess-of-loss cover is consumed by what it pays: the layer
   * responds for the loss above the attachment, up to the limit, and only as far as cover remains.
   */
  recoverEvent(treatyId: string, input: { eventId: string; loss: Money; at: string; by?: string }): {
    amount: Money; cover: CoverState; treatment: 'risk-transferring' | 'deposit';
  } {
    const treaty = this.treaty(treatyId);
    if (treaty.kind !== 'excess-of-loss') {
      throw new ReinsuranceError(`${treatyId} is a ${treaty.kind} treaty: a loss is recovered per policy, not per event`);
    }
    if (!this.isValidOn(treaty, isoDay(input.at))) throw new ReinsuranceError(`${treatyId} is not in force on ${isoDay(input.at)}`);
    if (input.loss.currency !== treaty.currency) throw new ReinsuranceError(`a ${input.loss.currency} loss cannot be recovered from a ${treaty.currency} treaty`);
    const state = this.coverState(treatyId);
    const above = sub(input.loss, treaty.attachment!);
    let amount = compare(above, zero(treaty.currency)) <= 0 ? zero(treaty.currency) : above;
    if (compare(amount, treaty.limit!) > 0) amount = treaty.limit!;
    if (compare(amount, state.available) > 0) {
      throw new ReinsuranceError(
        `${treatyId} has ${formatAmount(state.available)} of cover left and the event needs ${formatAmount(amount)}; reinstate the treaty before claiming, or the excess is retained`,
      );
    }
    if (amount.minor === 0n) {
      throw new ReinsuranceError(`the ${formatAmount(input.loss)} loss is inside the ${formatAmount(treaty.attachment!)} attachment point: the treaty does not respond`);
    }
    const treatment: 'risk-transferring' | 'deposit' = treaty.depositAccounted ? 'deposit' : 'risk-transferring';
    const id = this.nextJournalId();
    // A risk-transferring treaty earns recovery income. A deposit-accounted one does not recognise
    // income at all: the money comes out of the deposit the reinsurer is holding for us.
    const lines = treatment === 'deposit'
      ? [
        posting(this.account('PAYABLE'), 'debit', amount, this.ledger.toBase(amount, this.entityId, input.at), `deposit drawn down: ${input.eventId}`),
        posting(this.account('DEPOSIT-PREMIUM'), 'credit', amount, this.ledger.toBase(amount, this.entityId, input.at), `deposit released to cover ${input.eventId}`),
      ]
      : [
        posting(this.account('RECEIVABLE'), 'debit', amount, this.ledger.toBase(amount, this.entityId, input.at), `${input.eventId} recoverable`),
        posting(this.account('RECOVERY'), 'credit', amount, this.ledger.toBase(amount, this.entityId, input.at), `recovery on ${input.eventId}`),
      ];
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${input.eventId}/${treatyId}`,
      description: `${formatAmount(amount)} recovered from ${treaty.counterparty} under ${treatyId} for ${input.eventId}`
        + (treatment === 'deposit' ? ' (deposit accounting: no income recognised)' : ''),
      postings: lines,
    });
    this.did('event-recovery', input.at, entry.id, { treatyId, ...input });
    this.eventRecoveries.push({ treatyId, eventId: input.eventId, amount, at: input.at, journalId: entry.id });
    this.recoveries.push({
      claimId: input.eventId, ref: input.eventId, amount, at: input.at, treatyId,
      recoveryId: entry.id, treatment, source: 'event', settled: zero(this.currency),
    });
    this.consumed.set(treatyId, add(state.consumed, amount));
    this.notes.push(`${input.by ?? 'reinsurance/desk'}: ${formatAmount(amount)} recovered for ${input.eventId} under ${treatyId} (${entry.id})`);
    return { amount, cover: this.coverState(treatyId), treatment };
  }

  /** What is left of a treaty's cover, and how many reinstatements are still available. */
  coverState(treatyId: string): CoverState {
    const treaty = this.treaty(treatyId);
    const limit = treaty.kind === 'excess-of-loss' ? treaty.limit! : this.consumed.get(treatyId) ?? money(0n, treaty.currency);
    const consumed = this.consumed.get(treatyId) ?? zero(treaty.currency);
    const used = this.reinstatementLog.filter((r) => r.treatyId === treatyId).length;
    const allowed = treaty.reinstatements ?? 0;
    const available = sub(limit, consumed);
    return {
      treatyId, limit, consumed, available,
      reinstatementsUsed: used, reinstatementsLeft: Math.max(0, allowed - used),
      exhausted: available.minor === 0n,
    };
  }

  /**
   * Put cover back after a loss, and pay for it. The reinstatement premium is a share of the annual
   * premium, pro rata to the cover restored — the first one or two are often free, which is a
   * commercial fact and therefore a column, not a footnote.
   */
  reinstate(treatyId: string, input: { at: string; restore?: Money; by?: string }): Reinstatement {
    const treaty = this.treaty(treatyId);
    if (treaty.kind !== 'excess-of-loss') throw new ReinsuranceError(`${treatyId} is a ${treaty.kind} treaty: reinstatements apply to excess of loss`);
    if ((treaty.reinstatements ?? 0) === 0) throw new ReinsuranceError(`${treatyId} has no reinstatements: once its cover is used, it is used`);
    const state = this.coverState(treatyId);
    if (state.reinstatementsLeft === 0) {
      throw new ReinsuranceError(`${treatyId} has used all ${state.reinstatementsUsed} reinstatements; the cover is exhausted and is not reinstated again`);
    }
    const used = state.consumed.minor;
    if (used === 0n) throw new ReinsuranceError(`${treatyId} has paid nothing: there is nothing to reinstate`);
    const wanted = input.restore ?? state.consumed;
    if (compare(wanted, state.consumed) > 0) {
      throw new ReinsuranceError(`a reinstatement cannot restore more than has been used: ${formatAmount(state.consumed)} has been used, ${formatAmount(wanted)} asked for`);
    }
    const sequence = state.reinstatementsUsed + 1;
    const free = sequence <= (treaty.freeReinstatements ?? 0);
    const premium = free
      ? zero(treaty.currency)
      : applyRatio(applyBps(treaty.annualPremium!, treaty.reinstatementBps ?? 0), wanted.minor, treaty.limit!.minor);
    let journalId: string | undefined;
    if (premium.minor > 0n) {
      const id = this.nextJournalId();
      const entry = this.ledger.post({
        id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${treatyId}/reinstatement-${sequence}`,
        description: `Reinstatement ${sequence} of ${formatAmount(wanted)} cover under ${treatyId} for ${formatAmount(premium)}`,
        postings: [
          posting(this.account('CEDED-PREMIUM'), 'debit', premium, this.ledger.toBase(premium, this.entityId, input.at), `reinstatement premium ${sequence}`),
          posting(this.account('PAYABLE'), 'credit', premium, this.ledger.toBase(premium, this.entityId, input.at), treaty.counterparty),
        ],
      });
      journalId = entry.id;
    }
    this.did('reinstate', input.at, journalId ?? '', { treatyId, ...input });
    this.consumed.set(treatyId, sub(state.consumed, wanted));
    const record: Reinstatement = {
      treatyId, sequence, restored: wanted, premium, free, at: input.at, available: this.coverState(treatyId).available,
      ...(journalId ? { journalId } : {}),
    };
    this.reinstatementLog.push(record);
    this.notes.push(
      `${input.by ?? 'reinsurance/desk'}: reinstatement ${sequence} under ${treatyId} restored ${formatAmount(wanted)}`
      + (free ? ' free of charge' : ` for ${formatAmount(premium)}`),
    );
    return record;
  }

  reinstatements(): readonly Reinstatement[] { return this.reinstatementLog; }
  eventRecoveryList(): readonly { treatyId: string; eventId: string; amount: Money; at: string; journalId: string }[] { return this.eventRecoveries; }

  /* ------------------------------------------------------------- deposit premium */

  /**
   * Deposit premium paid on account, against a treaty whose final cost is only known at expiry: a
   * catastrophe cover priced on a rate on line, an aggregate stop loss, a proportional treaty with an
   * adjustable commission. The deposit is an asset until the period is settled — not an expense.
   */
  openDeposit(treatyId: string, input: { amount: Money; at: string; instalment?: number }): DepositAccount {
    const treaty = this.treaty(treatyId);
    if (input.amount.currency !== treaty.currency) throw new ReinsuranceError('a deposit must be in the treaty currency');
    if (input.amount.minor <= 0n) throw new ReinsuranceError('a deposit premium must be positive');
    const account = this.deposits.get(treatyId);
    if (account?.settled) throw new ReinsuranceError(`${treatyId} has been settled for the period: a new deposit belongs to the next one`);
    const current = account ?? { treatyId, depositPaid: zero(treaty.currency), settled: false, adjustments: [] };
    const instalment = input.instalment ?? current.adjustments.length + 1;
    if (current.adjustments.some((a) => a.at === `${input.at}#${instalment}`)) {
      throw new ReinsuranceError(`instalment ${instalment} of the ${treatyId} deposit has already been paid`);
    }
    const id = this.nextJournalId();
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${treatyId}/deposit-${instalment}`,
      description: `Deposit premium instalment ${instalment} of ${formatAmount(input.amount)} under ${treatyId}`,
      postings: [
        posting(this.account('DEPOSIT-PREMIUM'), 'debit', input.amount, this.ledger.toBase(input.amount, this.entityId, input.at), 'deposit premium paid on account'),
        posting(this.cash(), 'credit', input.amount, this.ledger.toBase(input.amount, this.entityId, input.at), treaty.counterparty),
      ],
    });
    const next = {
      treatyId, depositPaid: add(current.depositPaid, input.amount), settled: false,
      adjustments: [...current.adjustments, { at: `${input.at}#${instalment}`, kind: 'additional' as const, amount: input.amount, journalId: entry.id }],
    };
    this.did('open-deposit', input.at, entry.id, { treatyId, amount: input.amount, at: input.at, instalment });
    this.deposits.set(treatyId, { ...next, ...(current.technicalPremium ? { technicalPremium: current.technicalPremium } : {}) });
    this.notes.push(`deposit instalment ${instalment} of ${formatAmount(input.amount)} paid under ${treatyId} (${entry.id})`);
    return this.depositAccount(treatyId);
  }

  /**
   * Settle the period: the technical premium is the subject premium at the agreed rate on line. The
   * deposit is released from the balance sheet, and the difference is paid or refunded — so the
   * profit and loss account carries the real cost, not the guess that was paid on account.
   */
  settleDeposit(treatyId: string, input: { subjectPremium: Money; at: string; rateOnLineBps?: number }): DepositAccount {
    const treaty = this.treaty(treatyId);
    const account = this.deposits.get(treatyId);
    if (!account) throw new ReinsuranceError(`${treatyId} has no deposit premium on account`);
    if (account.settled) throw new ReinsuranceError(`${treatyId} is already settled for this period`);
    const rol = input.rateOnLineBps ?? treaty.rateOnLineBps ?? 0;
    if (rol <= 0 || rol > 10_000) throw new ReinsuranceError(`${rol} bps is not a rate on line`);
    if (input.subjectPremium.currency !== treaty.currency) throw new ReinsuranceError('the subject premium must be in the treaty currency');
    const technical = applyBps(input.subjectPremium, rol);
    const difference = sub(technical, account.depositPaid);
    const id = this.nextJournalId();
    const lines = [
      posting(this.account('CEDED-PREMIUM'), 'debit', technical, this.ledger.toBase(technical, this.entityId, input.at), `technical premium at ${rol / 100}% of ${formatAmount(input.subjectPremium)}`),
      posting(this.account('DEPOSIT-PREMIUM'), 'credit', account.depositPaid, this.ledger.toBase(account.depositPaid, this.entityId, input.at), 'deposit premium released'),
    ];
    if (difference.minor > 0n) {
      lines.push(posting(this.cash(), 'credit', difference, this.ledger.toBase(difference, this.entityId, input.at), 'additional premium paid'));
    } else if (difference.minor < 0n) {
      lines.push(posting(this.cash(), 'debit', abs(difference), this.ledger.toBase(abs(difference), this.entityId, input.at), 'return premium received'));
    }
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${treatyId}/deposit-settlement`,
      description: `Deposit premium settled under ${treatyId}: technical premium ${formatAmount(technical)} against ${formatAmount(account.depositPaid)} paid on account`
        + (difference.minor > 0n ? `, ${formatAmount(difference)} additional` : difference.minor < 0n ? `, ${formatAmount(abs(difference))} returned` : ', exactly as deposited'),
      postings: lines,
    });
    if (difference.minor !== 0n) {
      account.adjustments.push({ at: input.at, kind: difference.minor > 0n ? 'additional' : 'return', amount: abs(difference), journalId: entry.id });
    }
    this.did('settle-deposit', input.at, entry.id, { treatyId, ...input });
    const settled = { ...account, technicalPremium: technical, settled: true, settledAt: input.at };
    this.deposits.set(treatyId, settled);
    this.notes.push(`deposit settled under ${treatyId}: technical ${formatAmount(technical)}, ${difference.minor >= 0n ? 'additional' : 'returned'} ${formatAmount(abs(difference))}`);
    return this.depositAccount(treatyId);
  }

  depositAccount(treatyId: string): DepositAccount {
    this.treaty(treatyId);   // unknown treaties refuse here too
    const account = this.deposits.get(treatyId);
    return {
      treatyId,
      depositPaid: account?.depositPaid ?? zero(this.currency),
      ...(account?.technicalPremium ? { technicalPremium: account.technicalPremium } : {}),
      ...(account?.settledAt ? { settledAt: account.settledAt } : {}),
      adjustments: account?.adjustments ?? [],
      settled: account?.settled ?? false,
      treatment: this.accountingTreatment(treatyId),
      assetRemaining: this.ledger.hasAccount(this.account('DEPOSIT-PREMIUM')) ? this.ledger.balance(this.account('DEPOSIT-PREMIUM')) : zero(this.currency),
    };
  }

  depositAccounts(): readonly DepositAccount[] { return [...this.treaties.keys()].map((id) => this.depositAccount(id)).filter((d) => d.depositPaid.minor > 0n || d.settled); }

  /** Which accounting the treaty gets. Risk transfer is a judgement; here it is a field with a reason. */
  accountingTreatment(treatyId: string): 'risk-transferring' | 'deposit' {
    return this.treaty(treatyId).depositAccounted ? 'deposit' : 'risk-transferring';
  }

  /* ------------------------------------------------- recovery tracking and ageing */

  /**
   * The counterparty pays. A recovery is not money until it is in the bank: settling it moves the
   * receivable to cash, and a part settlement is allowed because reinsurers pay in instalments.
   * Over-settling is refused — a recovery cannot be collected twice.
   */
  settleRecovery(input: { recoveryId: string; at: string; amount?: Money; by?: string }): {
    recoveryId: string; settled: Money; outstanding: Money; journalId?: string;
  } {
    const recovery = this.recoveries.find((r) => r.recoveryId === input.recoveryId);
    if (!recovery) throw new ReinsuranceError(`unknown recovery ${input.recoveryId}`);
    if (recovery.source === 'deposit') {
      throw new ReinsuranceError(`${input.recoveryId} was drawn from a deposit: there is nothing to settle — the deposit was already the reinsurer's money`);
    }
    const outstanding = sub(recovery.amount, recovery.settled);
    if (outstanding.minor <= 0n) throw new ReinsuranceError(`${input.recoveryId} is already settled in full`);
    const amount = input.amount ?? outstanding;
    if (amount.minor <= 0n) throw new ReinsuranceError('a settlement must be positive');
    if (compare(amount, outstanding) > 0) {
      throw new ReinsuranceError(`${input.recoveryId} has ${formatAmount(outstanding)} outstanding; ${formatAmount(amount)} cannot be collected against it`);
    }
    const id = this.nextJournalId();
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: `${recovery.recoveryId}/settlement`,
      description: `${formatAmount(amount)} received from ${this.treaty(recovery.treatyId).counterparty} against recovery ${recovery.recoveryId}`
        + (compare(amount, outstanding) < 0 ? ` (part settlement, ${formatAmount(sub(outstanding, amount))} still outstanding)` : ''),
      postings: [
        posting(this.cash(), 'debit', amount, this.ledger.toBase(amount, this.entityId, input.at), 'recovery received'),
        posting(this.account('RECEIVABLE'), 'credit', amount, this.ledger.toBase(amount, this.entityId, input.at), recovery.recoveryId),
      ],
    });
    recovery.settled = add(recovery.settled, amount);
    recovery.settledAt = input.at;
    this.notes.push(`${input.by ?? 'recovery-desk'}: ${formatAmount(amount)} settled on ${recovery.recoveryId} (${entry.id})`);
    this.did('settle-recovery', input.at, entry.id, { recoveryId: input.recoveryId, at: input.at, ...(input.amount ? { amount: input.amount } : {}), ...(input.by ? { by: input.by } : {}) });
    return { recoveryId: recovery.recoveryId, settled: recovery.settled, outstanding: sub(recovery.amount, recovery.settled), journalId: entry.id };
  }

  /**
   * Ageing: what is still owed to us, how long it has been owed, and whether the counterparty is
   * outside the settlement terms of its own treaty. This is the page a credit committee reads.
   */
  ageing(input: { asOf: string }): AgeingStatement {
    const bucketOf = (days: number): AgeBucket => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
    const items: RecoveryAgeing[] = [];
    for (const r of this.recoveries) {
      if (r.source === 'deposit') continue;      // drawn from the reinsurer's own money: nothing to collect
      const outstanding = sub(r.amount, r.settled);
      if (outstanding.minor <= 0n) continue;
      const treaty = this.treaty(r.treatyId);
      const terms = treaty.settlementDays ?? 60;
      const ageDays = Math.max(0, days(isoDay(r.at), input.asOf));
      const expectedBy = new Date(Date.parse(`${isoDay(r.at)}T00:00:00Z`) + terms * DAY).toISOString().slice(0, 10);
      items.push({
        recoveryId: r.recoveryId, claimId: r.claimId, treatyId: r.treatyId,
        amount: r.amount, settled: r.settled, outstanding,
        at: r.at, ageDays, expectedBy,
        overdueDays: Math.max(0, ageDays - terms),
        bucket: bucketOf(ageDays),
        treatment: r.treatment,
      });
    }
    items.sort((a, b) => b.ageDays - a.ageDays);
    const buckets: Array<{ bucket: AgeBucket; count: number; outstanding: Money }> = (['0-30', '31-60', '61-90', '90+'] as AgeBucket[]).map((bucket) => {
      const inBucket = items.filter((i) => i.bucket === bucket);
      return { bucket, count: inBucket.length, outstanding: inBucket.reduce((t, i) => add(t, i.outstanding), zero(this.currency)) };
    });
    const outstanding = items.reduce((t, i) => add(t, i.outstanding), zero(this.currency));
    const overdue = items.filter((i) => i.overdueDays > 0).reduce((t, i) => add(t, i.outstanding), zero(this.currency));
    const worst = [...items].filter((i) => i.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays);
    return {
      asOf: input.asOf, buckets, items, outstanding, overdue,
      oldestDays: items.length === 0 ? 0 : items[0]!.ageDays,
      worstOverdue: [...new Set(worst.map((i) => `${i.treatyId} (${i.overdueDays}d)`))],
    };
  }

  /* ------------------------------------------- reconciliation and data quality */

  /**
   * The register and the books, side by side, with the difference stated rather than smoothed. Every
   * line names the account it reads, and where an account is shared with another module (claims pays
   * policy recoveries into the same income account as salvage) the note says so.
   */
  reconcile(input: { asOf: string; claimsRecoveries?: ReadonlyArray<{ type: string; amount: Money }> }): Reconciliation {
    const riskTransferring = this.cessions.filter((c) => c.treatment === 'risk-transferring');
    const cededPremium = riskTransferring.reduce((t, c) => add(t, c.cededPremium), zero(this.currency));
    const reinstatementPremium = this.reinstatementLog.reduce((t, r) => add(t, r.premium), zero(this.currency));
    const commission = this.cessions.reduce((t, c) => add(t, c.commission), zero(this.currency));
    const eventRecoveries = this.eventRecoveries.filter((e) => this.accountingTreatment(e.treatyId) === 'risk-transferring')
      .reduce((t, e) => add(t, e.amount), zero(this.currency));
    const policyRecoveries = this.recoveries.filter((r) => r.source === 'policy' && r.treatment === 'risk-transferring')
      .reduce((t, r) => add(t, r.amount), zero(this.currency));
    const settledRecoveries = this.recoveries.reduce((t, r) => add(t, r.settled), zero(this.currency));
    const depositInstalments = [...this.deposits.values()].reduce((t, d) => add(t, d.depositPaid), zero(this.currency));
    const depositReleased = this.reinstatementLog.length === 0 ? zero(this.currency) : zero(this.currency);
    void depositReleased;

    const lines: ReconciliationLine[] = [];
    const line = (kind: string, what: string, register: Money, accountId: string, note?: string): void => {
      const ledger = this.ledger.hasAccount(accountId) ? this.ledger.balance(accountId) : zero(this.currency);
      const difference = sub(register, ledger);
      lines.push({
        kind, what, register, ledger, difference,
        status: difference.minor === 0n ? 'agrees' : 'difference',
        ...(note ? { note } : {}),
      });
    };

    line('ceded-premium', 'Ceded premium and reinstatement premium (expense)', add(cededPremium, reinstatementPremium), this.account('CEDED-PREMIUM'));
    line('commission', 'Commission / wakalah fee (income)', commission, this.account('COMMISSION'));
    line('event-recovery', 'Catastrophe and event recoveries (income)', eventRecoveries, this.account('RECOVERY'));
    if (input.claimsRecoveries) {
      // Policy recoveries land in the claims module's recovery account, which also holds salvage and
      // third-party money. Take that money back out, and the rest must be ours.
      const other = input.claimsRecoveries.filter((r) => r.type !== 'reinsurance').reduce((t, r) => add(t, r.amount), zero(this.currency));
      const register = policyRecoveries;
      const ledger = sub(this.ledger.hasAccount(this.claimsRecoveryAccount()) ? this.ledger.balance(this.claimsRecoveryAccount()) : zero(this.currency), other);
      lines.push({
        kind: 'policy-recovery', what: 'Policy recoveries (income, claims account net of salvage and third parties)',
        register, ledger, difference: sub(register, ledger),
        status: sub(register, ledger).minor === 0n ? 'agrees' : 'difference',
        note: `${formatAmount(other)} of salvage / third-party recovery removed from the account to compare like with like`,
      });
    }
    line('deposit-premium', 'Deposit premium still on account (asset)', sub(depositInstalments, this.recoveryDrawOnDeposit()), this.account('DEPOSIT-PREMIUM'));
    const receivableRegister = sub(add(commission, add(policyRecoveries, eventRecoveries)), settledRecoveries);
    line('receivable', 'Receivable from reinsurers (commission + recoveries − settlements)', receivableRegister, this.account('RECEIVABLE'));
    // Cash security is money we hold and post both ways; funds withheld is premium we kept, so it
    // moves the payable instead and never touches the cash account. Both are owed back, so both sit in
    // the security liability, together with any interest earned on their cash and owed to them.
    const inForce = this.securityInstruments.filter((i) => i.onBalanceSheet && this.inForce(i, input.asOf));
    const cashOnly = inForce.filter((i) => i.kind === 'cash');
    const cashHeld = cashOnly.reduce((t, i) => add(t, sub(i.amount, i.released)), zero(this.currency));
    const interestCredited = cashOnly.reduce((t, i) => add(t, i.interest), zero(this.currency));
    const securityOwed = inForce.reduce((t, i) => add(t, sub(i.amount, i.released)), zero(this.currency));
    line('collateral-cash', 'Cash held as security (asset, restricted)', cashHeld, this.securedCash());
    line('security-liability', 'Security received, returnable to reinsurers (liability)',
      add(securityOwed, interestCredited), this.securityLiability(),
      interestCredited.minor > 0n ? `${formatAmount(interestCredited)} of that is interest earned on their cash and owed back to them` : undefined);

    const differences = lines.filter((l) => l.status === 'difference').length;
    return {
      asOf: input.asOf, lines, agrees: differences === 0, differences,
      balanceSheet: {
        receivable: this.ledger.balance(this.account('RECEIVABLE')),
        payable: this.ledger.balance(this.account('PAYABLE')),
        depositAsset: this.ledger.hasAccount(this.account('DEPOSIT-PREMIUM')) ? this.ledger.balance(this.account('DEPOSIT-PREMIUM')) : zero(this.currency),
        restrictedCash: this.ledger.hasAccount(this.securedCash()) ? this.ledger.balance(this.securedCash()) : zero(this.currency),
        securityReceived: this.ledger.hasAccount(this.securityLiability()) ? this.ledger.balance(this.securityLiability()) : zero(this.currency),
      },
    };
  }

  /** Deposit draws come out of the asset: the reconciliation has to add them back to compare. */
  private recoveryDrawOnDeposit(): Money {
    return this.eventRecoveries.filter((e) => this.accountingTreatment(e.treatyId) === 'deposit')
      .reduce((t, e) => add(t, e.amount), zero(this.currency));
  }

  private claimsRecoveryAccount(): string { return `${this.entityId}:CLAIM-RECOVERY`; }

  /**
   * Data quality: the checks a reinsurance accountant runs before signing. They look for money that
   * should be moving and is not (a paid claim on a ceded risk with no recovery claimed), cover used
   * outside its terms, and treaties that cannot be administered as written.
   */
  dataQuality(input: { asOf: string; paidClaims?: ReadonlyArray<{ claimId: string; policyId: string; paid: Money; cause: string }> }): DataQualityReport {
    const findings: DataQualityFinding[] = [];
    const checked: string[] = [];

    checked.push('every treaty can be administered as written');
    for (const treaty of this.list()) {
      if (treaty.basis === 'takaful' && treaty.depositAccounted && treaty.kind !== 'quota-share') {
        findings.push({ severity: 'info', code: 'REINS-002', subject: treaty.id, detail: 'retakaful with deposit accounting: check the Shariah Committee has approved the accounting treatment, not just the treaty' });
      }
      if (!treaty.to) {
        findings.push({ severity: 'warning', code: 'REINS-003', subject: treaty.id, detail: 'open-ended treaty: there is no expiry to evidence, so the renewal cannot be diarised' });
      }
    }

    checked.push('every cession was inside the treaty it used');
    for (const c of this.cessions) {
      const treaty = this.treaty(c.treatyId);
      if (!this.isValidOn(treaty, isoDay(c.at))) {
        findings.push({ severity: 'error', code: 'REINS-010', subject: c.policyId, detail: `${c.policyId} was ceded under ${c.treatyId} on ${isoDay(c.at)}, outside the treaty dates` });
      }
      if (c.shareBps === 0) {
        findings.push({ severity: 'warning', code: 'REINS-011', subject: c.policyId, detail: `${c.policyId} is on the cession schedule with a 0% share: it will never produce a recovery` });
      }
    }

    checked.push('a paid claim on a ceded risk has had its recovery claimed');
    if (input.paidClaims) {
      for (const claim of input.paidClaims) {
        const cession = this.schedule.get(claim.policyId);
        if (!cession || cession.shareBps === 0) continue;
        const claimed = this.recoveries.some((r) => r.claimId === claim.claimId);
        if (!claimed) {
          findings.push({
            severity: 'error', code: 'REINS-020', subject: claim.claimId,
            detail: `${formatAmount(claim.paid)} was paid on ${claim.policyId}, which is ${cession.shareBps / 100}% ceded: the reinsurer's share of ${formatAmount(applyRatio(claim.paid, cession.ceded.minor, cession.sumInsured.minor))} has not been claimed`,
          });
        }
      }
    }

    checked.push('recoveries are inside their settlement terms');
    for (const item of this.ageing({ asOf: input.asOf }).items) {
      if (item.overdueDays > 0) {
        findings.push({
          severity: item.overdueDays > 90 ? 'error' : 'warning', code: 'REINS-030', subject: item.recoveryId,
          detail: `${formatAmount(item.outstanding)} from ${item.treatyId} is ${item.overdueDays} days past the settlement terms (expected by ${item.expectedBy})`,
        });
      }
    }

    checked.push('deposit premium is settled against the period it belongs to');
    for (const account of this.depositAccounts()) {
      const treaty = this.treaty(account.treatyId);
      if (!account.settled && treaty.to && input.asOf > treaty.to) {
        findings.push({
          severity: 'warning', code: 'REINS-040', subject: account.treatyId,
          detail: `${formatAmount(account.depositPaid)} is still on account after the treaty period ended on ${treaty.to}: it cannot be carried into the next period`,
        });
      }
    }

    checked.push('the security behind every counterparty covers what that counterparty owes');
    for (const finding of this.securityFindings(input.asOf)) {
      findings.push({
        severity: finding.severity, code: finding.code,
        subject: finding.counterparty ?? 'security',
        detail: finding.what,
      });
    }

    checked.push('the register agrees with the books');
    const reconciliation = this.reconcile({ asOf: input.asOf });
    if (!reconciliation.agrees) {
      findings.push({ severity: 'error', code: 'REINS-050', subject: 'ledger', detail: `${reconciliation.differences} reconciliation line(s) do not agree with the books` });
    }

    return {
      asOf: input.asOf, findings,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      checked,
    };
  }

  /* ------------------------------------------------------------- utilisation */

  /**
   * The treaty-utilisation statement: what each treaty has carried, what is left, and whether it is
   * still in force. This is the page a finance committee asks for and a broker cannot fake.
   */
  utilisation(input: { asOf: string; basis: Basis }): ReinsuranceStatement {
    const rows: TreatyUtilisation[] = [];
    for (const treaty of this.list({ basis: input.basis })) {
      const used = this.cessions.filter((c) => c.treatyId === treaty.id);
      const cededSumInsured = used.reduce((t, c) => add(t, c.ceded), zero(this.currency));
      const premiumCeded = used.reduce((t, c) => add(t, c.cededPremium), zero(this.currency));
      const premiumWritten = used.reduce((t, c) => add(t, c.premium), zero(this.currency));
      const commissionEarned = used.reduce((t, c) => add(t, c.commission), zero(this.currency));
      // One register of recoverables: policy claims and catastrophe events are both in it, deposit
      // draws are not income at all, so summing it once is the whole calculation.
      const recoveries = this.recoveries
        .filter((r) => r.treatyId === treaty.id && r.treatment === 'risk-transferring')
        .reduce((t, r) => add(t, r.amount), zero(this.currency));
      const cover = this.coverState(treaty.id);
      const capacity = this.capacityOf(treaty, cededSumInsured);
      rows.push({
        treatyId: treaty.id, name: treaty.name, counterparty: treaty.counterparty, kind: treaty.kind,
        basis: treaty.basis, lineOfBusiness: treaty.lineOfBusiness, capacity,
        cededSumInsured, headroom: sub(capacity, cededSumInsured),
        usedBps: capacity.minor === 0n ? 0 : Number((cededSumInsured.minor * 10_000n) / capacity.minor),
        risks: used.length, premiumCeded, premiumWritten,
        premiumCededBps: premiumWritten.minor === 0n ? 0 : Number((premiumCeded.minor * 10_000n) / premiumWritten.minor),
        commissionEarned, recoveries,
        valid: this.isValidOn(treaty, input.asOf),
        treatment: this.accountingTreatment(treaty.id),
        cover,
        reinstatementsUsed: cover.reinstatementsUsed,
        reinstatementsLeft: cover.reinstatementsLeft,
      });
    }
    const grossPremium = rows.reduce((t, r) => add(t, r.premiumWritten), zero(this.currency));
    const cededPremium = rows.reduce((t, r) => add(t, r.premiumCeded), zero(this.currency));
    const commissionIncome = rows.reduce((t, r) => add(t, r.commissionEarned), zero(this.currency));
    const recoveries = this.recoveries
      .filter((r) => r.treatment === 'risk-transferring' && this.treaty(r.treatyId).basis === input.basis)
      .reduce((t, r) => add(t, r.amount), zero(this.currency));
    // What reinsurers still owe us: commission plus recoveries not yet settled, straight off the books.
    const recoverable = this.ledger.balance(this.account('RECEIVABLE'));
    return {
      asOf: input.asOf, basis: input.basis, grossPremium, cededPremium,
      netRetainedPremium: add(sub(grossPremium, cededPremium), commissionIncome),
      cessionBps: grossPremium.minor === 0n ? 0 : Number((cededPremium.minor * 10_000n) / grossPremium.minor),
      commissionIncome, recoveries, recoverable, treaties: rows,
      reinstatements: this.reinstatementLog.filter((r) => this.treaty(r.treatyId).basis === input.basis),
      deposits: this.depositAccounts().filter((d) => this.treaty(d.treatyId).basis === input.basis),
      notes: this.notes.slice(-8),
    };
  }

  private capacityOf(treaty: Treaty, cededToDate: Money): Money {
    switch (treaty.kind) {
      case 'quota-share': return money(cededToDate.minor, treaty.currency);   // no ceiling: it takes its share of whatever is written
      case 'surplus': return money(treaty.retention!.minor * BigInt(treaty.lines!), treaty.currency);
      case 'excess-of-loss': return treaty.limit!;
      case 'facultative': return money(cededToDate.minor, treaty.currency);
    }
  }

  /** Reinsurers cede too. Retrocession is a treaty on the same register, so the maths is identical. */
  retrocede(input: {
    treatyId: string; policyId: string; riskId: string; sumInsured: Money; premium: Money;
    lineOfBusiness: string; at: string;
  }): CessionPosting {
    const parent = this.treaty(input.treatyId);
    if (!this.treaties.has(`${input.treatyId}-RETRO`)) {
      this.register({
        ...parent, id: `${input.treatyId}-RETRO`, name: `${parent.name} — retrocession`,
        counterparty: `${parent.counterparty} retrocession panel`,
      });
    }
    return this.cedePremium({ ...input, treatyId: `${input.treatyId}-RETRO`, basis: parent.basis });
  }

  /* --------------------------------------------------------------- statements */

  /** A one-line-of-business view: how much of this book's risk is carried by someone else. */
  cessionRate(lineOfBusiness: string): { risks: number; cededBps: number } {
    const used = this.cessions.filter((c) => {
      const lob = this.treaty(c.treatyId).lineOfBusiness;
      return lob === 'all' || lob === lineOfBusiness;
    });
    const sum = used.reduce((t, c) => add(t, c.sumInsured), zero(this.currency));
    const ceded = used.reduce((t, c) => add(t, c.ceded), zero(this.currency));
    return { risks: used.length, cededBps: sum.minor === 0n ? 0 : Number((ceded.minor * 10_000n) / sum.minor) };
  }

  /* ------------------------------------------- capability 8: security, cash calls, release */

  /**
   * What a counterparty owes us and what it must therefore secure: every recovery still outstanding,
   * in full, plus the treaty's own premium margin. A treaty may set no margin at all — plenty do — but
   * a recoverable is not optional: if we cannot collect it, the security is the only thing that pays.
   */
  securityRequirement(counterparty: string, asOf: string): { treaties: Treaty[]; recoverable: Money; premium: Money; requirement: Money } {
    const treaties = [...this.treaties.values()].filter((t) => t.counterparty === counterparty);
    if (treaties.length === 0) {
      throw new ReinsuranceError(`no treaty on this register is written by ${counterparty}: security is held against a promise we can name`);
    }
    const recoverable = this.recoveries
      .filter((r) => r.source !== 'deposit' && r.treatment === 'risk-transferring'
        && this.treaty(r.treatyId).counterparty === counterparty && r.at.slice(0, 10) <= asOf)
      .reduce((total, r) => add(total, sub(r.amount, r.settled)), zero(this.currency));
    const premium = treaties
      .filter((t) => !t.depositAccounted)
      .reduce((total, t) => add(total, applyBps(this.cededPremiumWritten(t.id, asOf), t.securityRequiredBps ?? 0)), zero(this.currency));
    return { treaties, recoverable, premium, requirement: add(recoverable, premium) };
  }

  /** Ceded premium written under one treaty on or before a day: the base a security clause applies to. */
  cededPremiumWritten(treatyId: string, asOf: string): Money {
    return this.cessions
      .filter((c) => c.treatyId === treatyId && c.treatment === 'risk-transferring' && c.at.slice(0, 10) <= asOf)
      .reduce((total, c) => add(total, c.cededPremium), zero(this.currency));
  }

  /** An instrument is in force when it was taken, has not lapsed, and has something left to give back. */
  private inForce(instrument: SecurityInstrument, asOf: string): boolean {
    if (instrument.at.slice(0, 10) > asOf) return false;
    if (instrument.expiresAt && instrument.expiresAt < asOf) return false;
    return sub(instrument.amount, instrument.released).minor > 0n;
  }

  private lapsed(instrument: SecurityInstrument, asOf: string): boolean {
    return !!instrument.expiresAt && instrument.expiresAt < asOf && instrument.at.slice(0, 10) <= asOf;
  }

  /** The position for one counterparty: what it owes, what it has secured, and the gap between them. */
  securityPosition(counterparty: string, asOf: string): CollateralPosition {
    const { treaties, recoverable, premium, requirement } = this.securityRequirement(counterparty, asOf);
    const instruments = this.securityInstruments.filter((i) => i.counterparty === counterparty).map((i) => ({ ...i }));
    const live = instruments.filter((i) => this.inForce(i, asOf));
    const value = (list: readonly SecurityInstrument[]) => list.reduce((total, i) => add(total, sub(i.amount, i.released)), zero(this.currency));
    const held = value(live);
    const onBalance = value(live.filter((i) => i.onBalanceSheet));
    const offBalance = value(live.filter((i) => !i.onBalanceSheet));
    const shortfall = requirement.minor > held.minor ? sub(requirement, held) : zero(this.currency);
    const surplus = held.minor > requirement.minor ? sub(held, requirement) : zero(this.currency);
    const coverBps = requirement.minor === 0n ? 10_000 : Number((held.minor * 10_000n) / requirement.minor);
    const expiringSoon = live.filter((i) => !!i.expiresAt && daysBetween(asOf, i.expiresAt!) <= SECURITY_EXPIRY_WINDOW_DAYS);
    const expired = instruments.filter((i) => this.lapsed(i, asOf));
    const calls = this.cashCalls.filter((c) => c.counterparty === counterparty).map((c) => ({ ...c, settlements: [...c.settlements] }));

    const notes: string[] = [];
    if (recoverable.minor > 0n) {
      notes.push(`${formatAmount(recoverable)} of claims is still owed to us by ${counterparty}; that is the first thing security has to cover`);
    }
    if (premium.minor > 0n) {
      notes.push(`a further ${formatAmount(premium)} is required against premium still unearned under ${treaties.map((t) => t.id).join(', ')}`);
    }
    for (const treaty of treaties.filter((t) => t.depositAccounted)) {
      notes.push(`${treaty.id} is deposit accounted, so it carries no security requirement: the deposit on account is already ours to draw on`);
    }
    if (surplus.minor > 0n) {
      notes.push(`${formatAmount(surplus)} is held beyond the requirement and is doing nothing: release it, or the treaty is paying for cover it does not need`);
    }

    return {
      counterparty, treaties: treaties.map((t) => t.id), recoverable, premiumRequirement: premium, requirement,
      held, heldOnBalanceSheet: onBalance, heldOffBalanceSheet: offBalance, shortfall, surplus, coverBps,
      expiringSoon, expired, instruments, calls, secured: shortfall.minor === 0n, notes,
    };
  }

  securityPositions(asOf: string): CollateralPosition[] {
    const counterparties = [...new Set([...this.treaties.values()].map((t) => t.counterparty))];
    return counterparties
      .map((c) => this.securityPosition(c, asOf))
      .sort((a, b) => (a.shortfall.minor === b.shortfall.minor ? a.counterparty.localeCompare(b.counterparty) : a.shortfall.minor > b.shortfall.minor ? -1 : 1));
  }

  /**
   * The security statement: every counterparty, what is required of it, what is actually held, and
   * every reason the two do not match. This is the page that answers "and who pays if the reinsurer
   * does not?" — with a name, an amount and a document.
   */
  securityStatement(input: { asOf: string }): SecurityStatement {
    const asOf = input.asOf;
    const positions = this.securityPositions(asOf);
    const total = (pick: (p: CollateralPosition) => Money) => positions.reduce((t, p) => add(t, pick(p)), zero(this.currency));
    const requirement = total((p) => p.requirement);
    const held = total((p) => p.held);
    const shortfall = total((p) => p.shortfall);
    const unsecured = positions.filter((p) => !p.secured).map((p) => `${p.counterparty} ${formatAmount(p.shortfall)}`);

    const notes: string[] = [];
    const ageing = this.ageing({ asOf });
    for (const item of ageing.items) {
      if (item.overdueDays === 0) continue;
      const position = positions.find((p) => p.counterparty === this.treaty(item.treatyId).counterparty);
      if (position && position.shortfall.minor > 0n) {
        notes.push(`${position.counterparty} is ${item.overdueDays} days past the settlement terms on ${formatAmount(item.outstanding)} and the security behind it is ${formatAmount(position.shortfall)} short: that is the exposure, dated`);
      }
    }
    if (positions.every((p) => p.secured)) {
      notes.push('every counterparty is covered by the security it was asked for, or is owed nothing');
    }
    const holdingsOff = total((p) => p.heldOffBalanceSheet);
    if (holdingsOff.minor > 0n) {
      notes.push(`${formatAmount(holdingsOff)} of the cover is letters of credit and guarantees: relied on, disclosed, and not posted as cash`);
    }
    notes.push('a deposit accounted treaty holds no security because there is no transfer of risk to secure — the money is already in our hands');
    const interest = this.ledger.hasAccount(this.collateralInterest()) ? this.ledger.balance(this.collateralInterest()) : zero(this.currency);

    return {
      asOf, positions, requirement, held, shortfall, unsecured,
      findings: this.securityFindings(asOf), notes,
      ledger: {
        restrictedCash: this.ledger.hasAccount(this.securedCash()) ? this.ledger.balance(this.securedCash()) : zero(this.currency),
        receivedAsSecurity: this.ledger.hasAccount(this.securityLiability()) ? this.ledger.balance(this.securityLiability()) : zero(this.currency),
        interestCredited: interest,
        offBalanceSheet: holdingsOff,
      },
    };
  }

  securityFindings(asOf: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const positions = this.securityPositions(asOf);
    for (const p of positions) {
      if (p.shortfall.minor > 0n) {
        findings.push({
          code: 'REINS-060', severity: 'error', counterparty: p.counterparty,
          what: `${p.counterparty} is ${formatAmount(p.shortfall)} short of the security its treaties require: ${formatAmount(p.requirement)} required, ${formatAmount(p.held)} held, ${(p.coverBps / 100).toFixed(2)}% covered`,
        });
      }
      for (const instrument of p.expiringSoon) {
        findings.push({
          code: 'REINS-061', severity: 'warning', counterparty: p.counterparty,
          what: `${instrument.reference} (${formatAmount(sub(instrument.amount, instrument.released))}) expires on ${instrument.expiresAt}, ${daysBetween(asOf, instrument.expiresAt!)} days from ${asOf}: replace it or call the cash`,
        });
      }
      for (const instrument of p.expired) {
        findings.push({
          code: 'REINS-062', severity: p.shortfall.minor > 0n ? 'error' : 'warning', counterparty: p.counterparty,
          what: `${instrument.reference} lapsed on ${instrument.expiresAt} and nothing has replaced it${instrument.released.minor > 0n ? ` (${formatAmount(instrument.released)} already returned)` : ''}`,
        });
      }
      for (const call of p.calls) {
        if (call.status === 'settled') continue;
        const past = daysBetween(call.dueBy, asOf);
        if (past > 0) {
          findings.push({
            code: 'REINS-063', severity: 'warning', counterparty: p.counterparty,
            what: `cash call ${call.id} for ${formatAmount(sub(call.amount, call.settled))} was due on ${call.dueBy} and is ${past} days unanswered`,
          });
        }
      }
      if (p.surplus.minor > 0n) {
        findings.push({
          code: 'REINS-064', severity: 'warning', counterparty: p.counterparty,
          what: `${formatAmount(p.surplus)} of security is held beyond what ${p.counterparty} is required to give: it secures nothing and ties up their capacity`,
        });
      }
    }
    const offBalance = positions.reduce((t, p) => add(t, p.heldOffBalanceSheet), zero(this.currency));
    if (offBalance.minor > 0n) {
      findings.push({
        code: 'REINS-065', severity: 'info',
        what: `${formatAmount(offBalance)} of security is held in letters of credit and guarantees: it is relied on, disclosed, and cannot be spent`,
      });
    }
    for (const waiver of this.releaseWaivers) {
      findings.push({
        code: 'REINS-066', severity: 'warning', counterparty: waiver.counterparty,
        what: `${formatAmount(waiver.amount)} of security was returned on ${waiver.at.slice(0, 10)} against an unsecured exposure of ${formatAmount(waiver.leftUnsecured)}, approved by ${waiver.approvedBy}: ${waiver.reason}`,
      });
    }
    return findings;
  }

  /**
   * Take security against a counterparty's promises. Cash and withheld premium are posted; letters of
   * credit and guarantees are recorded and disclosed. Nothing is taken from a counterparty that does
   * not write on this register: security is held against a promise we can name.
   */
  holdSecurity(input: {
    counterparty: string; kind: SecurityKind; amount: Money; at: string;
    expiresAt?: string; reference?: string; treatyId?: string; by?: string; fundId?: string;
  }): SecurityInstrument {
    const amount = input.amount;
    if (amount.minor <= 0n) throw new ReinsuranceError('security has to be worth something');
    if (amount.currency !== this.currency) {
      throw new ReinsuranceError(`a ${this.currency} ledger cannot hold ${amount.currency} security without a rate: convert it first, at a rate you can show`);
    }
    if (input.expiresAt && input.expiresAt < input.at.slice(0, 10)) {
      throw new ReinsuranceError(`security taken on ${input.at.slice(0, 10)} cannot expire on ${input.expiresAt}`);
    }
    if (input.treatyId) {
      const treaty = this.treaty(input.treatyId);
      if (treaty.counterparty !== input.counterparty) {
        throw new ReinsuranceError(`${input.treatyId} is written by ${treaty.counterparty}, not ${input.counterparty}`);
      }
    } else if (![...this.treaties.values()].some((t) => t.counterparty === input.counterparty)) {
      throw new ReinsuranceError(`no treaty on this register is written by ${input.counterparty}: security is held against a promise we can name`);
    }
    const onBalanceSheet = input.kind === 'cash' || input.kind === 'funds-withheld';
    const id = `SEC-${this.entityId}-${String(++this.securitySeq).padStart(6, '0')}`;
    const by = input.by ?? 'treasury';
    const base = this.ledger.toBase(amount, this.entityId, input.at);
    let journalId: string | undefined;

    if (input.kind === 'cash') {
      const entry = this.ledger.post({
        id: this.journalId(), entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: id,
        ...(input.fundId ? { fundId: input.fundId } : {}),
        description: `${formatAmount(amount)} posted by ${input.counterparty} as cash security (${input.reference ?? id})`,
        postings: [
          posting(this.securedCash(), 'debit', amount, base, 'cash held as security, and returnable'),
          posting(this.securityLiability(), 'credit', amount, base, input.counterparty),
        ],
      });
      journalId = entry.id;
    } else if (input.kind === 'funds-withheld') {
      const payable = this.ledger.hasAccount(this.account('PAYABLE')) ? this.ledger.balance(this.account('PAYABLE')) : zero(this.currency);
      if (payable.minor < amount.minor) {
        throw new ReinsuranceError(`funds withheld is premium we keep instead of paying: only ${formatAmount(payable)} is payable to reinsurers, so ${formatAmount(amount)} cannot be withheld`);
      }
      const entry = this.ledger.post({
        id: this.journalId(), entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: id,
        ...(input.fundId ? { fundId: input.fundId } : {}),
        description: `${formatAmount(amount)} payable to ${input.counterparty} withheld as security (${input.reference ?? id})`,
        postings: [
          posting(this.account('PAYABLE'), 'debit', amount, base, 'withheld as security rather than paid'),
          posting(this.securityLiability(), 'credit', amount, base, input.counterparty),
        ],
      });
      journalId = entry.id;
    }

    const instrument: Mutable<SecurityInstrument> = {
      id, counterparty: input.counterparty, kind: input.kind, amount, at: input.at, reference: input.reference ?? id,
      onBalanceSheet, by, released: zero(this.currency), interest: zero(this.currency),
      ...(input.fundId ? { fundId: input.fundId } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.treatyId ? { treatyId: input.treatyId } : {}),
      ...(journalId ? { journalId } : {}),
    };
    this.did('hold-security', input.at, journalId ?? '', input);
    this.securityInstruments.push(instrument);
    this.notes.push(`${by}: ${formatAmount(amount)} of security held from ${input.counterparty} (${input.kind}, ${instrument.reference})`);
    return { ...instrument };
  }

  /**
   * Call the shortfall. A cash call is not a threat and not a wish: it is the difference between what
   * the treaties require and what the counterparty has actually put up, named to the dirham, with a
   * due date. The engine refuses to call for more than that difference, or for anything at all when
   * the security already covers it.
   */
  callSecurity(input: { counterparty: string; at: string; amount?: Money; reason?: string; by?: string; dueInDays?: number }): CashCall {
    const day = input.at.slice(0, 10);
    const position = this.securityPosition(input.counterparty, day);
    if (position.requirement.minor === 0n) {
      throw new ReinsuranceError(`nothing is owed to us by ${input.counterparty} and no premium margin applies: there is nothing to secure`);
    }
    if (position.shortfall.minor === 0n) {
      throw new ReinsuranceError(`no shortfall to call: ${input.counterparty} holds ${formatAmount(position.held)} against a requirement of ${formatAmount(position.requirement)}`);
    }
    const amount = input.amount ?? position.shortfall;
    if (amount.minor <= 0n) throw new ReinsuranceError('a cash call has to ask for something');
    if (amount.minor > position.shortfall.minor) {
      throw new ReinsuranceError(`${input.counterparty} is ${formatAmount(position.shortfall)} short; a call for ${formatAmount(amount)} would take security beyond the exposure it secures`);
    }
    const dueDays = input.dueInDays ?? 30;
    if (dueDays <= 0) throw new ReinsuranceError('a cash call needs a due date in the future to mean anything');
    const open = position.calls.filter((c) => c.status !== 'settled').reduce((t, c) => add(t, sub(c.amount, c.settled)), zero(this.currency));
    if (sub(position.shortfall, open).minor < amount.minor) {
      throw new ReinsuranceError(`${input.counterparty} already has ${formatAmount(open)} called and unanswered: calling ${formatAmount(amount)} more would double-count the same shortfall`);
    }
    const call: CashCallRecord = {
      id: `CALL-${this.entityId}-${String(++this.callSeq).padStart(6, '0')}`,
      counterparty: input.counterparty, amount, shortfallAtRaise: position.shortfall,
      reason: input.reason ?? 'security held is below what the treaties require',
      at: input.at, dueBy: dayAfter(day, dueDays), by: input.by ?? 'treasury',
      settled: zero(this.currency), status: 'open', settlements: [],
    };
    this.did('call-security', input.at, '', input);
    this.cashCalls.push(call);
    this.notes.push(`${call.by}: cash call ${call.id} on ${input.counterparty} for ${formatAmount(amount)}, due ${call.dueBy} — ${call.reason}`);
    return { ...call, settlements: [] };
  }

  cashCallList(): readonly CashCall[] {
    return this.cashCalls.map((c) => ({ ...c, settlements: [...c.settlements] }));
  }

  /**
   * The counterparty answers the call: usually in cash, often with a letter of credit. A part answer
   * leaves the call open for the rest; answering more than was called is refused, because money taken
   * beyond the exposure is money we would have to give back with interest attached.
   */
  settleCall(input: {
    callId?: string; counterparty?: string; at: string; kind?: SecurityKind; amount?: Money;
    reference?: string; expiresAt?: string; by?: string; fundId?: string;
  }): { call: CashCall; instrument: SecurityInstrument } {
    const candidates = this.cashCalls.filter((c) => c.status !== 'settled'
      && (!input.callId || c.id === input.callId) && (!input.counterparty || c.counterparty === input.counterparty));
    if (input.callId && candidates.length === 0) {
      const known = this.cashCalls.find((c) => c.id === input.callId);
      if (!known) throw new ReinsuranceError(`unknown cash call ${input.callId}`);
      throw new ReinsuranceError(`cash call ${input.callId} is settled in full: there is nothing left to answer`);
    }
    if (candidates.length === 0) throw new ReinsuranceError('every cash call on this register has been answered');
    const call = candidates[0]!;
    const outstanding = sub(call.amount, call.settled);
    const amount = input.amount ?? outstanding;
    if (amount.minor <= 0n) throw new ReinsuranceError('answering a cash call with nothing is not an answer');
    if (amount.minor > outstanding.minor) {
      throw new ReinsuranceError(`cash call ${call.id} asks for ${formatAmount(outstanding)}; ${formatAmount(amount)} answers more than was called`);
    }
    const instrument = this.holdSecurity({
      counterparty: call.counterparty, kind: input.kind ?? 'cash', amount, at: input.at,
      reference: input.reference ?? `${call.id}/answer`, by: input.by ?? 'treasury',
      ...(input.fundId ? { fundId: input.fundId } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    call.settled = add(call.settled, amount);
    call.status = call.settled.minor === call.amount.minor ? 'settled' : 'part-settled';
    call.settlements.push({ at: input.at, amount, kind: instrument.kind, instrumentId: instrument.id });
    this.notes.push(`${input.by ?? 'treasury'}: ${formatAmount(amount)} ${instrument.kind} answered cash call ${call.id} (${instrument.reference})`);
    return { call: { ...call, settlements: [...call.settlements] }, instrument };
  }

  private readonly releaseWaivers: Array<{ counterparty: string; amount: Money; at: string; leftUnsecured: Money; approvedBy: string; reason: string }> = [];

  /**
   * Give security back. Releasing is only refused where the numbers say it should be: an instrument
   * that never existed, one already returned, one that has lapsed, or a release that would leave the
   * exposure unsecured with nobody's name against it. A named approver may release anyway — the engine
   * records the waiver and reports it, rather than pretending the exposure is not there.
   */
  releaseSecurity(input: {
    instrumentId: string; at: string; amount?: Money; reason: string; by?: string; approvedBy?: string;
  }): { instrument: SecurityInstrument; released: Money; journalId?: string } {
    const instrument = this.securityInstruments.find((i) => i.id === input.instrumentId);
    if (!instrument) throw new ReinsuranceError(`unknown security instrument ${input.instrumentId}`);
    const day = input.at.slice(0, 10);
    if (this.lapsed(instrument, day)) {
      throw new ReinsuranceError(`${instrument.reference} lapsed on ${instrument.expiresAt}: there is nothing to return, the instrument simply expired`);
    }
    const remaining = sub(instrument.amount, instrument.released);
    if (remaining.minor <= 0n) throw new ReinsuranceError(`${instrument.reference} has already been released in full`);
    const amount = input.amount ?? remaining;
    if (amount.minor <= 0n) throw new ReinsuranceError('a release has to return something');
    if (amount.minor > remaining.minor) {
      throw new ReinsuranceError(`${instrument.reference} holds ${formatAmount(remaining)}; ${formatAmount(amount)} cannot be released against it`);
    }
    const position = this.securityPosition(instrument.counterparty, day);
    const afterMinor = position.held.minor - amount.minor;
    const leftUnsecured = afterMinor >= position.requirement.minor ? zero(this.currency) : money(position.requirement.minor - afterMinor, this.currency);
    if (leftUnsecured.minor > 0n && !input.approvedBy) {
      throw new ReinsuranceError(`releasing ${formatAmount(amount)} would leave ${instrument.counterparty} ${formatAmount(leftUnsecured)} short of what its treaties require; name an approver to release against an unsecured exposure`);
    }
    let journalId: string | undefined;
    if (instrument.onBalanceSheet) {
      const base = this.ledger.toBase(amount, this.entityId, input.at);
      const credit = instrument.kind === 'cash' ? this.securedCash() : this.account('PAYABLE');
      const entry = this.ledger.post({
        id: this.journalId(), entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: instrument.id,
        ...(instrument.fundId ? { fundId: instrument.fundId } : {}),
        description: `${formatAmount(amount)} of ${instrument.kind} security returned to ${instrument.counterparty} (${instrument.reference}): ${input.reason}`,
        postings: [
          posting(this.securityLiability(), 'debit', amount, base, instrument.reference),
          posting(credit, 'credit', amount, base, instrument.kind === 'cash' ? 'restricted cash released' : 'premium now paid instead of withheld'),
        ],
      });
      journalId = entry.id;
    }
    instrument.released = add(instrument.released, amount);
    instrument.releasedAt = input.at;
    instrument.releasedBy = input.by ?? 'treasury';
    if (leftUnsecured.minor > 0n) {
      this.releaseWaivers.push({
        counterparty: instrument.counterparty, amount, at: input.at, leftUnsecured,
        approvedBy: input.approvedBy!, reason: input.reason,
      });
      this.notes.push(`${input.approvedBy} approved releasing ${formatAmount(amount)} against an unsecured exposure of ${formatAmount(leftUnsecured)} for ${instrument.counterparty}: ${input.reason}`);
    } else {
      this.notes.push(`${input.by ?? 'treasury'}: ${formatAmount(amount)} of security released to ${instrument.counterparty} — ${input.reason}`);
    }
    this.did('release-security', input.at, journalId ?? '', input);
    return { instrument: { ...instrument }, released: amount, ...(journalId ? { journalId } : {}) };
  }

  releaseWaiverList(): readonly { counterparty: string; amount: Money; at: string; leftUnsecured: Money; approvedBy: string; reason: string }[] {
    return this.releaseWaivers;
  }

  /**
   * Interest on cash held as security. On a conventional treaty it belongs to the counterparty and is
   * carried as more of what we owe them. On a retakaful treaty there is no interest to carry: a return
   * on cash posted for a participant's risk would be riba, and the engine refuses rather than posting
   * something a Shariah committee would have to unpick later.
   */
  creditCollateralInterest(input: { instrumentId: string; at: string; amount: Money; by?: string }): { instrument: SecurityInstrument; journalId: string } {
    const instrument = this.securityInstruments.find((i) => i.id === input.instrumentId);
    if (!instrument) throw new ReinsuranceError(`unknown security instrument ${input.instrumentId}`);
    if (input.amount.minor <= 0n) throw new ReinsuranceError('interest on nothing is not a posting');
    if (instrument.kind !== 'cash') {
      throw new ReinsuranceError(`interest belongs to cash held as security; a ${instrument.kind} earns nothing to pass on`);
    }
    const treaties = [...this.treaties.values()].filter((t) => t.counterparty === instrument.counterparty);
    if (treaties.some((t) => t.basis === 'takaful')) {
      throw new ReinsuranceError("security taken under a retakaful treaty earns no interest: a return on cash held for a participant's risk would be riba, and this engine will not post it");
    }
    const base = this.ledger.toBase(input.amount, this.entityId, input.at);
    const entry = this.ledger.post({
      id: this.journalId(), entityId: this.entityId, at: input.at, source: 'reinsurance', sourceRef: instrument.id,
      ...(instrument.fundId ? { fundId: instrument.fundId } : {}),
      description: `${formatAmount(input.amount)} of interest credited to ${instrument.counterparty} on cash security ${instrument.reference}`,
      postings: [
        posting(this.collateralInterest(), 'debit', input.amount, base, 'interest earned on their cash, owed to them'),
        posting(this.securityLiability(), 'credit', input.amount, base, instrument.counterparty),
      ],
    });
    this.did('credit-collateral-interest', input.at, entry.id, input);
    instrument.interest = add(instrument.interest, input.amount);
    this.notes.push(`${input.by ?? 'treasury'}: ${formatAmount(input.amount)} of interest credited to ${instrument.counterparty} on ${instrument.reference} (${entry.id})`);
    return { instrument: { ...instrument }, journalId: entry.id };
  }

  private securedCash(): string { return `${this.entityId}:COLLATERAL:CASH`; }
  private securityLiability(): string { return `${this.entityId}:RECEIVED-AS-SECURITY`; }
  private collateralInterest(): string { return `${this.entityId}:COLLATERAL:INTEREST`; }

  /** Every journal this engine posts shares one sequence, so ids never collide and always sort. */
  private journalId(): string { return this.nextJournalId(); }

  private account(suffix: string): string { return `${this.entityId}:REINS:${suffix}`; }
  /** Cash belongs to the entity's chart, not to the reinsurance sub-ledger. */
  private cash(): string { return `${this.entityId}:CASH`; }
}

export const REINSURANCE_SEED: ReadonlyArray<Omit<Treaty, 'currency'>> = [
  {
    id: 'QS-25-2026', name: 'Quota share 25% — 2026', counterparty: 'Gulf Reinsurance PSC',
    kind: 'quota-share', basis: 'conventional', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 2_500, commissionBps: 1_500, securityRequiredBps: 3_000,
  },
  {
    id: 'SURPLUS-10', name: 'Surplus 10 lines over 200,000', counterparty: 'MENA Re',
    kind: 'surplus', basis: 'conventional', lineOfBusiness: 'life', from: '2026-01-01', to: '2026-12-31',
    retention: money(200_000_00, 'AED'), lines: 10, commissionBps: 1_000,
  },
  {
    id: 'XOL-CAT-5M', name: 'Catastrophe excess of loss 5m xs 1m', counterparty: 'Emirates Re',
    kind: 'excess-of-loss', basis: 'conventional', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    attachment: money(1_000_000_00, 'AED'), limit: money(5_000_000_00, 'AED'), commissionBps: 0,
    annualPremium: money(250_000_00, 'AED'),        // 5% rate on line
    reinstatements: 2, reinstatementBps: 5_000, freeReinstatements: 1,   // the first is free, the second costs half
    settlementDays: 14,                            // catastrophe claims settle quickly, or they do not settle
    securityRequiredBps: 4_000,                    // and the security behind it is watched as closely as the claims
  },
  {
    id: 'AGG-SL-DEPOSIT', name: 'Aggregate stop loss — deposit accounted', counterparty: 'Gulf Reinsurance PSC',
    kind: 'excess-of-loss', basis: 'conventional', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    attachment: money(500_000_00, 'AED'), limit: money(2_000_000_00, 'AED'), commissionBps: 0,
    depositAccounted: true, depositPremium: money(300_000_00, 'AED'), rateOnLineBps: 350,   // 3.5% of the subject premium
  },
  {
    id: 'FAC-MOTOR', name: 'Facultative motor — per risk', counterparty: 'Al Wathba Re',
    kind: 'facultative', basis: 'conventional', lineOfBusiness: 'motor', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 4_000, commissionBps: 1_250,
  },
  {
    id: 'RTKF-QS-20', name: 'Retakaful quota share 20% (wakalah)', counterparty: 'Takaful Re International',
    kind: 'quota-share', basis: 'takaful', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 2_000, commissionBps: 2_000, securityRequiredBps: 2_500,
  },
];
