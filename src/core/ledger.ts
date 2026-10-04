/**
 * Double-entry ledger. One ledger, many entities, many currencies, fund-aware.
 *
 * Invariants enforced here (and tested):
 *  - every journal balances in every currency it touches, and in base currency;
 *  - entries are append-only; corrections are reversals, never edits;
 *  - every posting carries its entity, and optionally its fund, so fund segregation is a
 *    ledger property rather than a naming convention.
 */
import { Currency, Money, add, convert, isZero, money, sub, sum, zero, FxRate } from './money.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalSide = 'debit' | 'credit';

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly entityId: string;
  readonly fundId?: string;
  readonly currency: Currency;
}

export interface Posting {
  readonly accountId: string;
  readonly side: NormalSide;
  readonly amount: Money;        // in the account's currency
  readonly baseAmount: Money;    // in the entity's base currency, at the rate applied
  readonly fxRateNote?: string;
  readonly memo?: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly entityId: string;
  readonly at: string;               // ISO timestamp of the economic event
  readonly recordedAt: string;
  readonly source: string;           // module that produced it, e.g. 'unitlinked', 'billing'
  readonly sourceRef: string;        // the instruction id this journal implements
  readonly description: string;
  readonly fundId?: string;
  readonly postings: Posting[];
  readonly reverses?: string;
}

export class LedgerError extends Error {}

export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly entries: JournalEntry[] = [];
  private readonly byId = new Map<string, JournalEntry>();
  private readonly fx: FxRate[] = [];

  constructor(readonly baseCurrency: Currency) {}

  defineAccount(account: Account): Account {
    if (this.accounts.has(account.id)) throw new LedgerError(`account ${account.id} already defined`);
    this.accounts.set(account.id, account);
    return account;
  }

  hasAccount(id: string): boolean { return this.accounts.has(id); }

  account(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new LedgerError(`unknown account ${id}`);
    return a;
  }

  listAccounts(entityId?: string): Account[] {
    const all = [...this.accounts.values()];
    return entityId ? all.filter((a) => a.entityId === entityId) : all;
  }

  registerFx(rate: FxRate): void { this.fx.push(rate); }

  fxRate(from: Currency, to: Currency, asOf: string): FxRate {
    if (from === to) return { from, to, numerator: 1n, denominator: 1n, asOf };
    const direct = [...this.fx].reverse().find((r) => r.from === from && r.to === to);
    if (direct) return direct;
    const inverse = [...this.fx].reverse().find((r) => r.from === to && r.to === from);
    if (inverse) return { from, to, numerator: inverse.denominator, denominator: inverse.numerator, asOf };
    throw new LedgerError(`no FX rate ${from}->${to}`);
  }

  /** Build a balanced journal before posting it. Throws if it cannot balance. */
  prepare(input: Omit<JournalEntry, 'recordedAt'> & { recordedAt?: string }): JournalEntry {
    const entry: JournalEntry = { ...input, recordedAt: input.recordedAt ?? new Date().toISOString() };
    const byCurrency = new Map<Currency, { debit: Money; credit: Money }>();
    const baseByCurrency = new Map<Currency, { debit: Money; credit: Money }>();
    for (const p of entry.postings) {
      const account = this.account(p.accountId);
      if (account.entityId !== entry.entityId) throw new LedgerError(`posting to ${p.accountId} of another entity`);
      if (entry.fundId && account.fundId && account.fundId !== entry.fundId) {
        throw new LedgerError(`posting crosses fund boundary: entry fund ${entry.fundId}, account fund ${account.fundId}`);
      }
      if (p.amount.currency !== account.currency) throw new LedgerError(`posting currency ${p.amount.currency} != account currency ${account.currency}`);
      const bucket = byCurrency.get(p.amount.currency) ?? { debit: zero(p.amount.currency), credit: zero(p.amount.currency) };
      if (p.side === 'debit') bucket.debit = add(bucket.debit, p.amount); else bucket.credit = add(bucket.credit, p.amount);
      byCurrency.set(p.amount.currency, bucket);
      const baseBucket = baseByCurrency.get(this.baseCurrency) ?? { debit: zero(this.baseCurrency), credit: zero(this.baseCurrency) };
      if (p.side === 'debit') baseBucket.debit = add(baseBucket.debit, p.baseAmount); else baseBucket.credit = add(baseBucket.credit, p.baseAmount);
      baseByCurrency.set(this.baseCurrency, baseBucket);
    }
    for (const [cur, b] of byCurrency) {
      if (!isZero(sub(b.debit, b.credit))) {
        throw new LedgerError(`journal ${entry.id} does not balance in ${cur}: debit ${b.debit.minor} credit ${b.credit.minor}`);
      }
    }
    const base = baseByCurrency.get(this.baseCurrency);
    if (base && !isZero(sub(base.debit, base.credit))) throw new LedgerError(`journal ${entry.id} does not balance in base currency`);
    if (entry.postings.length === 0) throw new LedgerError('journal has no postings');
    return entry;
  }

  post(entry: Omit<JournalEntry, 'recordedAt'> & { recordedAt?: string }): JournalEntry {
    const existing = this.byId.get(entry.id);
    if (existing) {
      // Idempotency applies only when the SAME journal is re-posted. An id reused for different
      // content is a bug (two modules numbering independently) and must never pass silently:
      // that is how money disappears.
      const sameShape = existing.entityId === entry.entityId
        && existing.source === entry.source
        && existing.sourceRef === entry.sourceRef
        && existing.at === entry.at
        && existing.fundId === entry.fundId
        && existing.reverses === entry.reverses
        && existing.description === entry.description
        && existing.postings.length === entry.postings.length
        && existing.postings.every((p, i) => {
          const q = entry.postings[i]!;
          return p.accountId === q.accountId && p.side === q.side
            && p.amount.minor === q.amount.minor && p.amount.currency === q.amount.currency;
        });
      if (!sameShape) {
        throw new LedgerError(`journal id ${entry.id} is already used by a different journal (source ${existing.source} vs ${entry.source}) — ids must be unique ledger-wide; corrections are reversals`);
      }
      return existing;
    }
    const checked = this.prepare(entry);
    this.entries.push(checked);
    this.byId.set(checked.id, checked);
    return checked;
  }

  /** Post a correction. The original entry stays visible forever. */
  reverse(entryId: string, reason: string, newId: string, at?: string): JournalEntry {
    const original = this.byId.get(entryId);
    if (!original) throw new LedgerError(`unknown journal ${entryId}`);
    if (original.reverses) throw new LedgerError('cannot reverse a reversal');
    return this.post({
      ...original,
      id: newId,
      description: `REVERSAL of ${entryId}: ${reason}`,
      reverses: entryId,
      at: at ?? new Date().toISOString(),
      postings: original.postings.map((p) => ({ ...p, side: p.side === 'debit' ? 'credit' : 'debit', memo: `reversal of ${p.memo ?? ''}` })),
    });
  }

  journal(id: string): JournalEntry | undefined { return this.byId.get(id); }

  /** Every journal in posting order — used by the durability layer to snapshot the books. */
  allJournals(): JournalEntry[] { return [...this.entries]; }

  /** Every registered FX rate, oldest first. */
  fxRates(): FxRate[] { return [...this.fx]; }

  /** All entries touching an entity, in posting order. */
  entriesFor(entityId: string, filter?: { fundId?: string; accountId?: string }): JournalEntry[] {
    return this.entries.filter((e) => e.entityId === entityId)
      .filter((e) => (filter?.fundId ? e.fundId === filter.fundId : true))
      .filter((e) => (filter?.accountId ? e.postings.some((p) => p.accountId === filter.accountId) : true));
  }

  /** Net balance of an account, in its own currency, on its normal side. */
  balance(accountId: string): Money {
    const account = this.account(accountId);
    let debit = zero(account.currency);
    let credit = zero(account.currency);
    for (const e of this.entries) {
      for (const p of e.postings) {
        if (p.accountId !== accountId) continue;
        if (p.side === 'debit') debit = add(debit, p.amount); else credit = add(credit, p.amount);
      }
    }
    const debitNormal: NormalSide = account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit';
    return debitNormal === 'debit' ? sub(debit, credit) : sub(credit, debit);
  }

  balanceBase(accountId: string): Money {
    const account = this.account(accountId);
    let debit = zero(this.baseCurrency);
    let credit = zero(this.baseCurrency);
    for (const e of this.entries) {
      for (const p of e.postings) {
        if (p.accountId !== accountId) continue;
        if (p.side === 'debit') debit = add(debit, p.baseAmount); else credit = add(credit, p.baseAmount);
      }
    }
    const debitNormal: NormalSide = account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit';
    return debitNormal === 'debit' ? sub(debit, credit) : sub(credit, debit);
  }

  trialBalance(entityId: string): Array<{ account: Account; balance: Money; baseBalance: Money }> {
    return this.listAccounts(entityId).map((a) => ({ account: a, balance: this.balance(a.id), baseBalance: this.balanceBase(a.id) }));
  }

  /** The proof that the books balance: sum of debits equals sum of credits, per currency, always. */
  proof(entityId: string): { balanced: boolean; byCurrency: Array<{ currency: Currency; debit: Money; credit: Money }> } {
    const map = new Map<Currency, { debit: Money; credit: Money }>();
    for (const e of this.entriesFor(entityId)) {
      for (const p of e.postings) {
        const b = map.get(p.amount.currency) ?? { debit: zero(p.amount.currency), credit: zero(p.amount.currency) };
        if (p.side === 'debit') b.debit = add(b.debit, p.amount); else b.credit = add(b.credit, p.amount);
        map.set(p.amount.currency, b);
      }
    }
    const byCurrency = [...map.entries()].map(([currency, b]) => ({ currency, ...b }));
    return { balanced: byCurrency.every((b) => b.debit.minor === b.credit.minor), byCurrency };
  }

  /** Convert an amount to base currency using the latest registered rate. */
  toBase(amount: Money, entityId: string, asOf: string): Money {
    return convert(amount, this.fxRate(amount.currency, this.baseCurrency, asOf));
  }

  totalsByFund(entityId: string): Array<{ fundId: string; total: Money }> {
    const map = new Map<string, Money>();
    for (const e of this.entriesFor(entityId)) {
      if (!e.fundId) continue;
      const bucket = map.get(e.fundId) ?? zero(this.baseCurrency);
      const debitBase = sum(e.postings.filter((p) => p.side === 'debit').map((p) => p.baseAmount), this.baseCurrency);
      const creditBase = sum(e.postings.filter((p) => p.side === 'credit').map((p) => p.baseAmount), this.baseCurrency);
      map.set(e.fundId, add(bucket, sub(debitBase, creditBase)));
    }
    return [...map.entries()].map(([fundId, total]) => ({ fundId, total }));
  }
}

export function posting(accountId: string, side: NormalSide, amount: Money, baseAmount?: Money, memo?: string): Posting {
  return { accountId, side, amount, baseAmount: baseAmount ?? money(amount.minor, amount.currency), memo };
}
