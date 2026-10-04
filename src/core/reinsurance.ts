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
import {
  Currency, Money, add, applyBps, applyRatio, compare, formatAmount, isNegative, lte, money, sub, zero,
} from './money.js';

export class ReinsuranceError extends Error {}

export type TreatyKind = 'quota-share' | 'surplus' | 'excess-of-loss' | 'facultative';
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
}

export interface Cession {
  readonly treatyId: string;
  readonly kind: TreatyKind;
  readonly basis: Basis;
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
  readonly notes: readonly string[];
}

const DAY = 86_400_000;
const isoDay = (at: string) => at.slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Only the bit of the claims engine a reinsurance recovery needs, so the two modules stay apart. */
export interface ClaimsForRecovery {
  recover(claimId: string, input: {
    type: 'reinsurance'; amount: Money; at: string; by?: string; receivedInto?: string;
  }): { id: string; amount: Money };
}

export class TreatyRegister {
  private readonly treaties = new Map<string, Treaty>();
  private readonly cessions: CessionPosting[] = [];
  private readonly accepted = new Map<string, Set<string>>();   // facultative: treatyId -> risk ids
  private readonly schedule = new Map<string, Cession>();       // policyId -> the cession that applies
  private seq = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly entityId: string,
    private readonly currency: Currency,
  ) {
    const id = (n: string) => `${entityId}:${n}`;
    this.ledger.defineAccount({ id: id('REINS:CEDED-PREMIUM'), name: 'Ceded premium / contribution (expense)', type: 'expense', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:PAYABLE'), name: 'Payable to reinsurers / retakaful operators', type: 'liability', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:RECEIVABLE'), name: 'Receivable from reinsurers / retakaful operators', type: 'asset', entityId, currency });
    this.ledger.defineAccount({ id: id('REINS:COMMISSION'), name: 'Ceding commission / wakalah fee', type: 'income', entityId, currency });
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
    return treaty;
  }

  acceptedRisks(treatyId: string): string[] {
    return [...(this.accepted.get(treatyId) ?? new Set<string>())].sort();
  }

  private readonly notes: string[] = [];

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
      treatyId: treaty.id, kind: treaty.kind, basis: treaty.basis, riskId: input.riskId,
      sumInsured, ceded, retainedAfter: sub(sumInsured, ceded),
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
    const id = `RI-${this.entityId}-${String(++this.seq).padStart(6, '0')}`;
    const entry = this.ledger.post({
      id, entityId: this.entityId, at: input.at, source: 'reinsurance',
      sourceRef: `${input.policyId}/${input.treatyId}`,
      // A retakaful cession belongs to the participant risk fund, not to the operator: the journal
      // says so, so a fund-level view can never quietly treat it as shareholder money.
      ...(input.fundId ? { fundId: input.fundId } : {}),
      description: `Cession of ${formatAmount(cededPremium)} premium (${cession.shareBps / 100}% of ${formatAmount(input.premium)}) to ${this.treaty(input.treatyId).counterparty} under ${input.treatyId}`,
      postings: [
        posting(this.account('CEDED-PREMIUM'), 'debit', cededPremium, this.ledger.toBase(cededPremium, this.entityId, input.at), `${input.riskId} ceded premium`),
        posting(this.account('PAYABLE'), 'credit', cededPremium, this.ledger.toBase(cededPremium, this.entityId, input.at), `${this.treaty(input.treatyId).counterparty}`),
        posting(this.account('RECEIVABLE'), 'debit', commission, this.ledger.toBase(commission, this.entityId, input.at), `ceding commission due`),
        posting(this.account('COMMISSION'), 'credit', commission, this.ledger.toBase(commission, this.entityId, input.at), `${this.treaty(input.treatyId).counterparty}`),
      ],
    });
    const postingRecord: CessionPosting = {
      ...cession, policyId: input.policyId, ref, premium: input.premium, cededPremium, commission,
      netRetainedPremium, journalId: entry.id, at: input.at,
    };
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
    this.recoveries.push({ claimId: input.claimId, ref, amount, at: input.at, treatyId: cession.treatyId, recoveryId: recovery.id });
    return { amount, shareBps: cession.shareBps, recoveryId: recovery.id };
  }

  private readonly recoveries: Array<{ claimId: string; ref: string; amount: Money; at: string; treatyId: string; recoveryId: string }> = [];
  recoveryList(): readonly { claimId: string; ref: string; amount: Money; at: string; treatyId: string; recoveryId: string }[] { return this.recoveries; }

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
      const recoveries = this.recoveries.filter((r) => r.treatyId === treaty.id).reduce((t, r) => add(t, r.amount), zero(this.currency));
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
      });
    }
    const grossPremium = rows.reduce((t, r) => add(t, r.premiumWritten), zero(this.currency));
    const cededPremium = rows.reduce((t, r) => add(t, r.premiumCeded), zero(this.currency));
    const commissionIncome = rows.reduce((t, r) => add(t, r.commissionEarned), zero(this.currency));
    const recoveries = this.recoveries.reduce((t, r) => add(t, r.amount), zero(this.currency));
    // What reinsurers still owe us: commission plus recoveries not yet settled, straight off the books.
    const recoverable = this.ledger.balance(this.account('RECEIVABLE'));
    return {
      asOf: input.asOf, basis: input.basis, grossPremium, cededPremium,
      netRetainedPremium: add(sub(grossPremium, cededPremium), commissionIncome),
      cessionBps: grossPremium.minor === 0n ? 0 : Number((cededPremium.minor * 10_000n) / grossPremium.minor),
      commissionIncome, recoveries, recoverable, treaties: rows, notes: this.notes.slice(-8),
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

  private account(suffix: string): string { return `${this.entityId}:REINS:${suffix}`; }
}

export const REINSURANCE_SEED: ReadonlyArray<Omit<Treaty, 'currency'>> = [
  {
    id: 'QS-25-2026', name: 'Quota share 25% — 2026', counterparty: 'Gulf Reinsurance PSC',
    kind: 'quota-share', basis: 'conventional', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 2_500, commissionBps: 1_500,
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
  },
  {
    id: 'FAC-MOTOR', name: 'Facultative motor — per risk', counterparty: 'Al Wathba Re',
    kind: 'facultative', basis: 'conventional', lineOfBusiness: 'motor', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 4_000, commissionBps: 1_250,
  },
  {
    id: 'RTKF-QS-20', name: 'Retakaful quota share 20% (wakalah)', counterparty: 'Takaful Re International',
    kind: 'quota-share', basis: 'takaful', lineOfBusiness: 'all', from: '2026-01-01', to: '2026-12-31',
    cessionBps: 2_000, commissionBps: 2_000,
  },
];
