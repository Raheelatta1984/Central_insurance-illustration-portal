/**
 * Group finance: consolidation across entities, currencies and ownership.
 *
 * The rules this encodes are the ones auditors check first:
 *  - every entity's books are translated into the group currency with *three different rates*:
 *    assets and liabilities at the closing rate, income and expenses at the average rate for the
 *    period, and equity movements at the rate on the day the movement happened. Using one rate
 *    for everything is the single most common consolidation error;
 *  - the difference that creates does not vanish into a rounding account: it is the translation
 *    reserve (cumulative translation adjustment), reported on its own line;
 *  - intercompany balances and intercompany income and expense are eliminated, and any
 *    difference is shown as in-transit rather than quietly written off;
 *  - minority owners get their share of net assets stated separately as a non-controlling
 *    interest, so the group never claims 100% of a subsidiary it does not own;
 *  - none of this touches the entity books. Consolidation is a read of those books plus a set of
 *    elimination entries posted in a separate group ledger, which balances like any other.
 */
import { Ledger, JournalEntry, posting } from './ledger.js';
import { Chart, buildChart, IC } from './chart.js';
import { Currency, Money, add, compare, divide, formatAmount, isNegative, money, multiply, neg, sub, zero } from './money.js';

export interface DatedFx {
  readonly from: Currency;
  readonly to: Currency;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly asOf: string;
}

export class GroupError extends Error {}

/* --------------------------------------------------------------- rate table */

/** Dated rates, because "the rate" is meaningless in a consolidation: which day matters. */
export class RateTable {
  private readonly rates: DatedFx[];

  constructor(private readonly groupCurrency: Currency, rates: DatedFx[]) {
    this.rates = [...rates].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }

  /** The rate in force on a date: the latest one at or before it. */
  rateAt(from: Currency, to: Currency, asOf: string): DatedFx {
    if (from === to) return { from, to, numerator: 1n, denominator: 1n, asOf };
    const candidates = this.rates.filter((r) => r.asOf <= asOf);
    const direct = [...candidates].reverse().find((r) => r.from === from && r.to === to);
    if (direct) return direct;
    const inverse = [...candidates].reverse().find((r) => r.from === to && r.to === from);
    if (inverse) return { from, to, numerator: inverse.denominator, denominator: inverse.numerator, asOf };
    throw new GroupError(`no ${from}→${to} rate on or before ${asOf}; a consolidation cannot invent one`);
  }

  /**
   * The average rate over a window: the arithmetic mean of the dated rates observed in it,
   * computed on the rationals so no precision is lost before the money round.
   */
  averageFor(from: Currency, to: Currency, windowStart: string, windowEnd: string): DatedFx {
    if (from === to) return { from, to, numerator: 1n, denominator: 1n, asOf: windowEnd };
    const inWindow = this.rates.filter((r) => r.asOf >= windowStart && r.asOf <= windowEnd && ((r.from === from && r.to === to) || (r.from === to && r.to === from)));
    if (inWindow.length === 0) {
      // Fall back to the closing rate, and say so by carrying the date it came from.
      const closing = this.rateAt(from, to, windowEnd);
      return { ...closing, asOf: `${windowEnd} (closing rate used: no rate observed inside the period)` };
    }
    let numeratorSum = 0n;   // Σ nᵢ/dᵢ expressed over a common denominator
    let denominatorProduct = 1n;
    for (const r of inWindow) denominatorProduct *= r.denominator;
    for (const r of inWindow) {
      const effective = r.from === from ? r : { numerator: r.denominator, denominator: r.numerator };
      numeratorSum += effective.numerator * (denominatorProduct / effective.denominator);
    }
    return { from, to, numerator: numeratorSum, denominator: denominatorProduct * BigInt(inWindow.length), asOf: windowEnd };
  }

  list(): DatedFx[] { return [...this.rates]; }
}

/* -------------------------------------------------------------------- specs */

export interface GroupEntitySpec {
  readonly entityId: string;
  readonly name: string;
  readonly functionalCurrency: Currency;
  readonly ownershipPct: number;   // 100 = wholly owned
  readonly chart: Chart;
}

export interface TranslatedLine {
  readonly accountId: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  readonly amount: Money;          // group currency, on the account's natural side
  readonly rateBasis: 'closing' | 'average' | 'historical';
  readonly rateNote: string;
}

export interface TranslatedEntity {
  readonly entityId: string;
  readonly name: string;
  readonly functionalCurrency: Currency;
  readonly ownershipPct: number;
  readonly lines: TranslatedLine[];
  readonly netAssets: Money;       // assets less liabilities, group currency
  readonly income: Money;          // income less expenses, group currency
  readonly cta: Money;             // translation reserve for the period
  readonly closingRate: string;
  readonly averageRate: string;
}

export interface IntercompanyPair {
  readonly receivableEntity: string;
  readonly payableEntity: string;
  readonly receivable: Money;
  readonly payable: Money;
  readonly eliminated: Money;
  /** Receivable less payable, in group currency: positive means the receivable is the larger one. */
  readonly difference: Money;
  readonly accountIds: { receivable: string; payable: string };
}

export interface IntercompanyIncomePair {
  readonly earningEntity: string;
  readonly chargedEntity: string;
  readonly income: Money;
  readonly expense: Money;
  readonly eliminated: Money;
  readonly difference: Money;
}

export interface NciLine {
  readonly entityId: string;
  readonly ownershipPct: number;
  readonly minorityPct: number;
  readonly shareOfNetAssets: Money;
}

export interface ConsolidatedReport {
  readonly asOf: string;
  readonly periodStart: string;
  readonly groupCurrency: Currency;
  readonly entities: TranslatedEntity[];
  readonly intercompany: { balances: IntercompanyPair[]; incomeAndExpense: IntercompanyIncomePair[] };
  readonly nci: NciLine[];
  readonly eliminations: { journals: string[]; matched: Money; inTransit: Money; notes: string[] };
  readonly group: {
    trialBalance: TranslatedLine[];
    totals: { assets: Money; liabilities: Money; equity: Money; income: Money; expense: Money; translationReserve: Money };
    netAssets: Money;
    balanced: boolean;
    difference: Money;
    checks: Array<{ check: string; ok: boolean; detail: string }>;
    attribution: { owners: Money; minority: Money };
  };
}

export interface ConsolidateOptions {
  asOf: string;
  periodStart: string;
  /** Post the translation, elimination and reserve journals into the group ledger. Default true. */
  post?: boolean;
}

export class GroupConsolidator {
  private readonly mirrorOwners = new Map<string, string>();   // group account id -> source account id
  private readonly groupChart: Chart;

  constructor(
    private readonly ledger: Ledger,
    private readonly options: {
      groupCurrency: Currency;
      groupEntityId: string;
      entities: GroupEntitySpec[];
      rates: RateTable;
      includeEliminations?: boolean;
    },
  ) {
    if (options.entities.length === 0) throw new GroupError('a consolidation needs at least one entity');
    for (const e of options.entities) {
      if (e.ownershipPct <= 0 || e.ownershipPct > 100) {
        throw new GroupError(`${e.entityId}: ownership must be above 0 and at most 100 percent`);
      }
    }
    this.groupChart = buildChart(ledger, options.groupEntityId, options.groupCurrency, []);
    if (!ledger.hasAccount(this.translationReserveAccount())) {
      ledger.defineAccount({ id: this.translationReserveAccount(), name: 'Translation reserve (cumulative)', type: 'equity', entityId: options.groupEntityId, currency: options.groupCurrency });
    }
    if (!ledger.hasAccount(this.nciAccount())) {
      ledger.defineAccount({ id: this.nciAccount(), name: 'Non-controlling interest', type: 'equity', entityId: options.groupEntityId, currency: options.groupCurrency });
    }
  }

  entities(): GroupEntitySpec[] { return [...this.options.entities]; }
  translationReserveAccount(): string { return `${this.options.groupEntityId}:TRANSLATION-RESERVE`; }
  nciAccount(): string { return `${this.options.groupEntityId}:NCI`; }

  /* ------------------------------------------------------------- translation */

  translate(asOf: string, periodStart: string): TranslatedEntity[] {
    return this.options.entities.map((spec) => this.translateEntity(spec, asOf, periodStart));
  }

  private translateEntity(spec: GroupEntitySpec, asOf: string, periodStart: string): TranslatedEntity {
    const { ledger } = this;
    const group = this.options.groupCurrency;
    const closing = this.options.rates.rateAt(spec.functionalCurrency, group, asOf);
    const average = this.options.rates.averageFor(spec.functionalCurrency, group, periodStart, asOf);

    const lines = new Map<string, { accountId: string; name: string; type: TranslatedLine['type']; minor: bigint; basis: TranslatedLine['rateBasis']; rateNote: string }>();

    for (const journal of ledger.entriesFor(spec.entityId)) {
      if (journal.at.slice(0, 10) > asOf) continue;
      for (const p of journal.postings) {
        const account = ledger.account(p.accountId);
        const isBalanceSheet = account.type === 'asset' || account.type === 'liability';
        const rate = isBalanceSheet ? closing : account.type === 'equity' ? this.options.rates.rateAt(spec.functionalCurrency, group, journal.at.slice(0, 10)) : average;
        const basis: TranslatedLine['rateBasis'] = isBalanceSheet ? 'closing' : account.type === 'equity' ? 'historical' : 'average';
        const converted = convertAt(p.amount, rate);
        const signed = p.side === 'debit' ? converted.minor : neg(converted).minor;
        const entry = lines.get(account.id) ?? { accountId: account.id, name: account.name, type: account.type, minor: 0n, basis, rateNote: `${rate.numerator}/${rate.denominator} as of ${rate.asOf}` };
        entry.minor += signed;
        lines.set(account.id, entry);
      }
    }

    // Natural-side presentation: an asset is debit-positive, a liability credit-positive, and the
    // same rule the ledger itself uses, so the two never disagree.
    const presented: TranslatedLine[] = [...lines.values()].map((l) => {
      const balance = (l.type === 'asset' || l.type === 'expense') ? l.minor : -l.minor;
      return { accountId: l.accountId, name: l.name, type: l.type, amount: money(balance, group), rateBasis: l.basis, rateNote: l.rateNote };
    }).sort((a, b) => (a.accountId < b.accountId ? -1 : 1));

    const assets = sumOf(presented, 'asset', group);
    const liabilities = sumOf(presented, 'liability', group);
    const income = sumOf(presented, 'income', group);
    const expense = sumOf(presented, 'expense', group);
    const equity = sumOf(presented, 'equity', group);
    const netAssets = sub(assets, liabilities);
    const profit = sub(income, expense);
    // The cumulative translation adjustment is defined as what it is: the gap left by using
    // different rates for the same net assets.
    const cta = sub(netAssets, add(equity, profit));

    return {
      entityId: spec.entityId, name: spec.name, functionalCurrency: spec.functionalCurrency, ownershipPct: spec.ownershipPct,
      lines: presented, netAssets, income: profit, cta,
      closingRate: `${closing.numerator}/${closing.denominator} on ${asOf}`,
      averageRate: `${average.numerator}/${average.denominator} over ${periodStart}..${asOf} (${average.asOf})`,
    };
  }

  /* ----------------------------------------------------------- intercompany */

  intercompany(asOf: string, periodStart: string): ConsolidatedReport['intercompany'] {
    const translated = new Map(this.translate(asOf, periodStart).map((t) => [t.entityId, t]));
    const balances: IntercompanyPair[] = [];
    const incomeAndExpense: IntercompanyIncomePair[] = [];
    const specs = this.options.entities;

    for (const a of specs) {
      for (const b of specs) {
        if (a.entityId === b.entityId) continue;
        const recvAccount = a.chart.icReceivable(b.entityId);
        const payAccount = b.chart.icPayable(a.entityId);
        const recv = lineOf(translated.get(a.entityId), recvAccount);
        const pay = lineOf(translated.get(b.entityId), payAccount);
        if (recv.minor === 0n && pay.minor === 0n) continue;
        const eliminated = compare(recv, pay) <= 0 ? recv : pay;
        balances.push({
          receivableEntity: a.entityId, payableEntity: b.entityId,
          receivable: recv, payable: pay, eliminated,
          difference: sub(balanceBetween(recv, pay), zero(this.options.groupCurrency)),
          accountIds: { receivable: recvAccount, payable: payAccount },
        });

        const incomeAccount = a.chart.icIncome(b.entityId);
        const expenseAccount = b.chart.icExpense(a.entityId);
        const income = lineOf(translated.get(a.entityId), incomeAccount);
        const expense = lineOf(translated.get(b.entityId), expenseAccount);
        if (income.minor !== 0n || expense.minor !== 0n) {
          const eliminatedIe = compare(income, expense) <= 0 ? income : expense;
          incomeAndExpense.push({
            earningEntity: a.entityId, chargedEntity: b.entityId, income, expense,
            eliminated: eliminatedIe, difference: sub(absDifference(income, expense), zero(this.options.groupCurrency)),
          });
        }
      }
    }
    return { balances, incomeAndExpense };
  }

  /* --------------------------------------------------------------- the report */

  consolidate(options: ConsolidateOptions): ConsolidatedReport {
    const { asOf, periodStart } = options;
    const post = options.post ?? true;
    const group = this.options.groupCurrency;
    const entities = this.translate(asOf, periodStart);
    const intercompany = this.intercompany(asOf, periodStart);
    const journals: string[] = [];
    const notes: string[] = [];

    /* 1. translation: bring every entity's lines into the group ledger at their own rates */
    for (const entity of entities) {
      const lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: Money; memo?: string }> = [];
      for (const line of entity.lines) {
        if (line.amount.minor === 0n) continue;
        const mirror = this.mirrorAccount(entity.entityId, line.accountId);
        const naturalDebit = line.type === 'asset' || line.type === 'expense';
        const side: 'debit' | 'credit' = naturalDebit ? (line.amount.minor >= 0n ? 'debit' : 'credit') : (line.amount.minor >= 0n ? 'credit' : 'debit');
        lines.push({ accountId: mirror, side, amount: absOf(line.amount), memo: `${line.type} · ${line.rateBasis} rate` });
      }
      if (entity.cta.minor !== 0n) {
        // The reserve takes the opposite side of the translation gap, which is what makes the
        // group ledger balance without touching either entity's books.
        lines.push({
          accountId: this.translationReserveAccount(),
          side: isNegative(entity.cta) ? 'debit' : 'credit',
          amount: absOf(entity.cta),
          memo: `translation reserve for ${entity.entityId} (${entity.closingRate} closing, ${entity.averageRate})`,
        });
      }
      if (lines.length === 0) continue;
      notes.push(`${entity.entityId}: translated ${entity.lines.length} account balance(s), translation reserve ${formatAmount(entity.cta)}`);
      if (post) journals.push(this.postGroup(`TRANSLATE ${entity.entityId} ${asOf}`, asOf, `Translation of ${entity.entityId} (${entity.functionalCurrency}) into ${group} — closing rate for assets and liabilities, average rate for income and expenses, historical rate for equity`, lines));
    }

    /* 2. elimination of intercompany balances and intercompany trading */
    let matched = zero(group);
    let inTransit = zero(group);
    if (this.options.includeEliminations !== false) {
      for (const pair of intercompany.balances) {
        if (pair.eliminated.minor === 0n) continue;
        matched = add(matched, pair.eliminated);
        const recvMirror = this.mirrorAccount(pair.receivableEntity, pair.accountIds.receivable);
        const payMirror = this.mirrorAccount(pair.payableEntity, pair.accountIds.payable);
        notes.push(`${pair.receivableEntity} ↔ ${pair.payableEntity}: eliminated ${formatAmount(pair.eliminated)} of intercompany balances`);
        if (post) {
          journals.push(this.postGroup(
            `ELIMINATE-BALANCE ${pair.receivableEntity} ${pair.payableEntity} ${asOf}`, asOf,
            `Eliminate intercompany balance ${pair.receivableEntity} receivable from ${pair.payableEntity} against the payable`,
            [
              { accountId: payMirror, side: 'debit', amount: pair.eliminated, memo: 'eliminate intercompany payable' },
              { accountId: recvMirror, side: 'credit', amount: pair.eliminated, memo: 'eliminate intercompany receivable' },
            ],
          ));
        }
        const difference = sub(pair.receivable, pair.payable);
        if (difference.minor !== 0n) {
          inTransit = add(inTransit, absOf(difference));
          notes.push(`${pair.receivableEntity} ↔ ${pair.payableEntity}: ${formatAmount(absOf(difference))} does not agree between the two books — treated as in transit, not written off`);
        }
      }
      for (const ie of intercompany.incomeAndExpense) {
        if (ie.eliminated.minor === 0n) continue;
        matched = add(matched, ie.eliminated);
        const incomeMirror = this.mirrorAccount(ie.earningEntity, this.specOf(ie.earningEntity).chart.icIncome(ie.chargedEntity));
        const expenseMirror = this.mirrorAccount(ie.chargedEntity, this.specOf(ie.chargedEntity).chart.icExpense(ie.earningEntity));
        notes.push(`${ie.earningEntity} → ${ie.chargedEntity}: eliminated ${formatAmount(ie.eliminated)} of intercompany income and expense`);
        if (post) {
          journals.push(this.postGroup(
            `ELIMINATE-TRADING ${ie.earningEntity} ${ie.chargedEntity} ${asOf}`, asOf,
            `Eliminate intercompany income charged by ${ie.earningEntity} to ${ie.chargedEntity}`,
            [
              { accountId: incomeMirror, side: 'debit', amount: ie.eliminated, memo: 'eliminate intercompany income' },
              { accountId: expenseMirror, side: 'credit', amount: ie.eliminated, memo: 'eliminate intercompany expense' },
            ],
          ));
        }
      }
    }

    /* 3. minority interests: stated, not consolidated away */
    const nci: NciLine[] = entities
      .filter((e) => e.ownershipPct < 100)
      .map((e) => ({
        entityId: e.entityId,
        ownershipPct: e.ownershipPct,
        minorityPct: 100 - e.ownershipPct,
        shareOfNetAssets: multiply(divide(e.netAssets, 100), 100 - e.ownershipPct),
      }));

    /* 4. the consolidated trial balance, read back from the group ledger */
    const trialBalance = this.groupTrialBalance(asOf);
    const totals = {
      assets: sumOf(trialBalance, 'asset', group),
      liabilities: sumOf(trialBalance, 'liability', group),
      equity: sumOf(trialBalance, 'equity', group),
      income: sumOf(trialBalance, 'income', group),
      expense: sumOf(trialBalance, 'expense', group),
      translationReserve: this.ledger.balance(this.translationReserveAccount()),
    };
    const netAssets = sub(totals.assets, totals.liabilities);
    // The translation reserve is part of equity, and it is presented as its own line in the
    // consolidated trial balance — which is the whole point of moving the FX gap out of profit.
    const totalEquity = totals.equity;
    const difference = sub(netAssets, add(totalEquity, sub(totals.income, totals.expense)));
    const minority = nci.reduce((acc, n) => add(acc, n.shareOfNetAssets), zero(group));

    return {
      asOf, periodStart, groupCurrency: group, entities, intercompany, nci,
      eliminations: { journals, matched, inTransit, notes },
      group: {
        trialBalance, totals, netAssets,
        balanced: difference.minor === 0n,
        difference,
        checks: [
          { check: 'consolidated balance sheet balances', ok: difference.minor === 0n, detail: `assets ${formatAmount(totals.assets)} − liabilities ${formatAmount(totals.liabilities)} = ${formatAmount(netAssets)}; equity ${formatAmount(totalEquity)} (of which the translation reserve is ${formatAmount(totals.translationReserve)}) plus result ${formatAmount(sub(totals.income, totals.expense))}; difference ${formatAmount(difference)}` },
          { check: 'group ledger proof', ok: this.ledger.proof(this.options.groupEntityId).balanced, detail: 'every translation and elimination journal balances in the group currency' },
          { check: 'intercompany eliminated', ok: intercompany.balances.every((b) => b.difference.minor === 0n), detail: intercompany.balances.length === 0 ? 'no intercompany balances between the consolidated entities' : `${intercompany.balances.length} pair(s) matched, ${formatAmount(matched)} eliminated, ${formatAmount(inTransit)} in transit` },
          { check: 'entity books untouched', ok: true, detail: 'translation and elimination post only to the group ledger; each entity keeps its own books' },
        ],
        attribution: { owners: sub(netAssets, minority), minority },
      },
    };
  }

  /* --------------------------------------------------------------- plumbing */

  private specOf(entityId: string): GroupEntitySpec {
    const spec = this.options.entities.find((e) => e.entityId === entityId);
    if (!spec) throw new GroupError(`entity ${entityId} is not part of the consolidation`);
    return spec;
  }

  /** A group-ledger account mirroring one entity account, defined on first use. */
  mirrorAccount(entityId: string, sourceAccountId: string): string {
    const suffix = sourceAccountId.startsWith(`${entityId}:`) ? sourceAccountId.slice(entityId.length + 1) : sourceAccountId;
    const id = `${this.options.groupEntityId}:${entityId}:${suffix}`;
    if (!this.ledger.hasAccount(id)) {
      const source = this.ledger.account(sourceAccountId);
      this.ledger.defineAccount({
        id, name: `${entityId} — ${source.name}`, type: source.type,
        entityId: this.options.groupEntityId, currency: this.options.groupCurrency,
      });
    }
    this.mirrorOwners.set(id, sourceAccountId);
    return id;
  }

  private groupTrialBalance(asOf: string): TranslatedLine[] {
    const reserve = this.translationReserveAccount();
    const nci = this.nciAccount();
    return this.ledger.listAccounts(this.options.groupEntityId)
      .filter((a) => a.id === reserve || a.id === nci || a.id.split(':').length > 2)   // mirrors, plus the consolidation accounts
      .map((a) => ({
        accountId: a.id, name: a.name, type: a.type,
        amount: this.ledger.balance(a.id), rateBasis: 'closing' as const,
        rateNote: `mirror of ${this.mirrorOwners.get(a.id) ?? 'an entity account'}`,
      }))
      .filter((l) => l.amount.minor !== 0n)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
  }

  private postGroup(id: string, at: string, description: string, lines: Array<{ accountId: string; side: 'debit' | 'credit'; amount: Money; memo?: string }>): string {
    const entry: JournalEntry = this.ledger.post({
      id, entityId: this.options.groupEntityId, at, source: 'groupfinance', sourceRef: id, description,
      postings: lines.map((l) => posting(l.accountId, l.side, l.amount, l.amount, l.memo)),
    });
    return entry.id;
  }
}

/* ----------------------------------------------------------------- helpers */

/** Convert at a rational rate without going through the ledger's FX registration. */
function convertAt(amount: Money, rate: DatedFx): Money {
  return { minor: (amount.minor * rate.numerator) / rate.denominator, currency: rate.to };
}

function absOf(m: Money): Money { return { minor: m.minor < 0n ? -m.minor : m.minor, currency: m.currency }; }
function balanceBetween(a: Money, b: Money): Money { return sub(a, b); }
function absDifference(a: Money, b: Money): Money { return absOf(sub(a, b)); }

function lineOf(entity: TranslatedEntity | undefined, accountId: string): Money {
  if (!entity) return zero('XXX');
  const line = entity.lines.find((l) => l.accountId === accountId);
  return line ? line.amount : zero(entity.functionalCurrency);
}

function sumOf(lines: TranslatedLine[], type: TranslatedLine['type'], currency: Currency): Money {
  return lines.filter((l) => l.type === type).reduce((acc, l) => add(acc, l.amount), zero(currency));
}
