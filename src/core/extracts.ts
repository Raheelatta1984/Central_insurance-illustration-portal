/**
 * Regulatory and actuarial reporting extracts.
 *
 * Everything the reinsurance module knows has to leave the building in the shape someone outside
 * actually asks for: the reinsurance schedules on a supervisory return, the exhibits an appointed
 * actuary signs, and the bordereaux a reinsurer reconciles its own records against. This engine
 * produces all three **from the ledger and the register — never from a spreadsheet**, and it states
 * its own controls on the face of every extract.
 *
 * The rules that make the output worth something:
 *
 *  - **An extract that does not tie to the books cannot be issued.** Each control names the ledger
 *    account it compares against and the difference. A difference stops the issue; a named approver
 *    can accept it, and then the extract carries the waiver on its face for as long as it exists.
 *  - **Issued extracts are immutable.** Content is fingerprinted; issuing the same content twice
 *    returns the first extract (idempotent), and issuing different content supersedes the previous
 *    version — with a written reason from a person and the old version kept. A return is never
 *    quietly rewritten.
 *  - **Limitations are printed, not hidden.** What this engine does not know (an IBNR estimate, the
 *    unexpired premium on annual business) is listed as a limitation rather than filled with a
 *    plausible number. An actuary can use an honest gap; they cannot use an invented figure.
 *  - A takaful window files its own return, from its own register, in its own fund — participant
 *    money is never reported inside the operator's numbers.
 */
import { Ledger } from './ledger.js';
import { Currency, Money, add, compare, formatAmount, sub, zero } from './money.js';
import { Basis, TreatyRegister } from './reinsurance.js';
import { Claim, ClaimsEngine } from './claims.js';
import { fingerprintOf } from './persistence.js';

export class ExtractError extends Error {}

export type ExtractKind = 'regulatory-return' | 'actuarial-exhibits' | 'treaty-bordereau';
export type ControlState = 'agrees' | 'difference' | 'informational';

export interface ExtractPeriod {
  readonly from: string;                    // ISO day, inclusive
  readonly to: string;                      // ISO day, inclusive
}

/**
 * A cell is an amount, a ratio, or nothing at all where the column does not apply to that line.
 * A ratio is kept as basis points in its own type rather than dressed up as an amount in a currency
 * called "BPS": a percentage that can be read as money is a percentage that will be reported as money.
 */
export interface Ratio { readonly ratioBps: number; }
export type Cell = Money | Ratio | null;

export interface ExtractRow {
  readonly code: string;
  readonly line: string;
  readonly values: readonly Cell[];
  readonly note?: string;
}

export interface ExtractTable {
  readonly code: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly ExtractRow[];
  readonly totals?: readonly Cell[] | null;
  readonly source: string;                  // where the numbers came from, in one sentence
}

export interface ExtractControl {
  readonly code: string;
  readonly what: string;
  readonly state: ControlState;
  readonly detail: string;
}

export interface ExtractDraft {
  readonly kind: ExtractKind;
  readonly title: string;
  readonly entityId: string;
  readonly jurisdiction: string;
  readonly basis: Basis;
  readonly currency: Currency;
  readonly period: ExtractPeriod;
  readonly asOf: string;
  readonly preparedBy: string;
  readonly counterparty?: string;
  readonly tables: readonly ExtractTable[];
  readonly controls: readonly ExtractControl[];
  readonly notes: readonly string[];
  readonly limitations: readonly string[];
}

export interface IssuedExtract extends ExtractDraft {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly issuedAt: string;
  readonly supersedes: string | null;
  readonly changesSummary: string | null;
  readonly differencesAccepted: { readonly by: string; readonly reason: string } | null;
  readonly tiesToBooks: boolean;
}

export interface IssuedExtractSummary {
  readonly id: string;
  readonly kind: ExtractKind;
  readonly title: string;
  readonly version: number;
  readonly period: ExtractPeriod;
  readonly asOf: string;
  readonly issuedAt: string;
  readonly fingerprint: string;
  readonly tiesToBooks: boolean;
  readonly differences: number;
  readonly counterparty?: string;
}

export interface ExtractEngineOptions {
  readonly ledger: Ledger;
  readonly entityId: string;
  readonly currency: Currency;
  readonly basis: Basis;
  readonly jurisdiction: string;
  readonly register: TreatyRegister;
  readonly claims: ClaimsEngine;
}

/**
 * A reason has to be a sentence. "update", "fix" and "a later entry" are not reasons: they are what
 * people write when the field is not long enough to hold the truth, and a return is not the place for it.
 */
const REASON_MINIMUM = 24;

const day = (iso: string): string => iso.slice(0, 10);
const inPeriod = (at: string, period: ExtractPeriod): boolean => {
  const d = day(at);
  return d >= period.from && d <= period.to;
};
const month = (iso: string): string => iso.slice(0, 7);

/** Claim causes, mapped to the lines of business the treaty programme and the return are written in. */
const LINE_OF: Record<string, string> = {
  death: 'life', disability: 'life', 'critical-illness': 'life',
  medical: 'medical', motor: 'motor', property: 'property', travel: 'travel', other: 'other',
};

export class ExtractEngine {
  private readonly issued: IssuedExtract[] = [];
  private seq = 0;

  constructor(private readonly deps: ExtractEngineOptions) {}

  /* ------------------------------------------------------------------ building */

  /**
   * The supervisory return, schedule by schedule: premium, claims, the balance owed to and by each
   * reinsurer, and the deposit-accounted treaties. Every figure is a register figure, and the four
   * balance schedules are checked against the ledger accounts they are meant to agree with.
   */
  regulatoryReturn(input: { period: ExtractPeriod; asOf: string; preparedBy?: string }): ExtractDraft {
    const { register, ledger, currency, basis, entityId, jurisdiction } = this.deps;
    const preparedBy = input.preparedBy ?? 'finance/reporting';
    const cessions = register.cessionSchedule().filter((c) => inPeriod(c.at, input.period));
    const reinstatements = register.reinstatements().filter((r) => inPeriod(r.at, input.period) && r.premium.minor > 0n);
    const recoveries = register.recoveryList();
    const received = recoveries.filter((r) => r.settledAt && inPeriod(r.settledAt, input.period));
    const outstanding = recoveries.filter((r) => r.source !== 'deposit' && day(r.at) <= input.asOf && r.outstanding.minor > 0n);

    const sum = (list: readonly Money[]): Money => list.reduce((t, m) => add(t, m), zero(currency));
    // Premium recognised on a deposit-accounted treaty when its period is settled: it is ceded premium
    // on the books, and a return that omits it does not tie to the expense account it belongs to.
    const depositRecognised = register.depositAccounts()
      .filter((d) => d.settled && d.settledAt && inPeriod(d.settledAt, input.period))
      .reduce((t, d) => add(t, d.technicalPremium ?? zero(currency)), zero(currency));
    const grossPremium = sum(cessions.map((c) => c.premium));
    const cededPremium = sum(cessions.map((c) => c.cededPremium));
    const reinstatementPremium = sum(reinstatements.map((r) => r.premium));
    const commission = sum(cessions.map((c) => c.commission));
    const paidOnCededRisks = sum(this.cededClaims().map((c) => c.paid));
    const recovered = sum(received.map((r) => r.settled));
    const outstandingRecoveries = sum(outstanding.map((r) => r.outstanding));
    const grossReserve = sum(this.openCededClaims().map((c) => c.reserve));
    const cededReserve = this.cededReserveShare();

    /* --- Schedule A: premium */
    const cededTotal = add(add(cededPremium, reinstatementPremium), depositRecognised);
    const premium: ExtractTable = {
      code: 'RS-A',
      title: 'Premium ceded to reinsurers and retakaful operators',
      columns: ['Gross', 'Ceded', 'Net'],
      source: 'The cession register: every cession posted in the period, with its ceded premium and commission.',
      rows: [
        { code: 'A.1', line: 'Premium written on risks subject to the treaty programme', values: [grossPremium, null, grossPremium], note: 'the premium on the population the treaties actually cover, not the whole book' },
        { code: 'A.2', line: 'Premium ceded to reinsurers', values: [null, cededPremium, sub(zero(currency), cededPremium)] },
        { code: 'A.3', line: 'Reinstatement premium payable', values: [null, reinstatementPremium, sub(zero(currency), reinstatementPremium)], note: reinstatementPremium.minor === 0n ? 'no paid reinstatement fell in this period; the first reinstatement of the catastrophe cover is free by treaty' : undefined },
        {
          code: 'A.4', line: 'Deposit premium recognised on settling a deposit-accounted treaty',
          values: [null, depositRecognised, sub(zero(currency), depositRecognised)],
          note: depositRecognised.minor === 0n
            ? 'no deposit-accounted period was settled in this period: the deposit stays an asset until it is'
            : 'the premium the period actually earned, recognised now rather than when the deposit was paid',
        },
        { code: 'A.5', line: 'Total ceded premium', values: [null, cededTotal, sub(zero(currency), cededTotal)] },
        { code: 'A.6', line: 'Net premium retained before commission', values: [grossPremium, cededTotal, sub(grossPremium, cededTotal)] },
        { code: 'A.7', line: 'Ceding commission / operator wakalah fee receivable', values: [commission, null, commission], note: basis === 'takaful' ? 'the operator\u2019s wakalah fee, which is not participant money and is not reported as such' : 'received from reinsurers; it is income, not a deduction from gross premium' },
        { code: 'A.8', line: 'Net premium retained after commission', values: [grossPremium, cededTotal, sub(add(grossPremium, commission), cededTotal)] },
      ],
      totals: [grossPremium, cededTotal, sub(add(grossPremium, commission), cededTotal)],
    };

    /* --- Schedule B: claims and recoveries */
    const claimsTable: ExtractTable = {
      code: 'RS-B',
      title: 'Claims, recoveries and the reserve',
      columns: ['Gross', 'Ceded', 'Net'],
      source: 'The claims module for the gross figures, the recovery register for the ceded ones, and the cession schedule for the share of each reserve.',
      rows: [
        { code: 'B.1', line: 'Claims paid in the period on ceded risks', values: [paidOnCededRisks, null, paidOnCededRisks] },
        { code: 'B.2', line: 'Recoveries received from reinsurers in the period', values: [null, recovered, sub(zero(currency), recovered)] },
        { code: 'B.3', line: 'Recoveries still to collect at the reporting date', values: [null, outstandingRecoveries, sub(zero(currency), outstandingRecoveries)], note: 'aged against each treaty\u2019s own settlement terms in the reinsurance ageing statement' },
        { code: 'B.4', line: 'Outstanding claims reserve on ceded risks at the reporting date', values: [grossReserve, null, grossReserve] },
        { code: 'B.5', line: 'Reinsurers\u2019 share of that reserve', values: [null, cededReserve, sub(zero(currency), cededReserve)] },
        { code: 'B.6', line: 'Net outstanding claims reserve', values: [grossReserve, cededReserve, sub(grossReserve, cededReserve)] },
      ],
      totals: [grossReserve, add(recovered, add(outstandingRecoveries, cededReserve)), sub(add(grossReserve, recovered), add(outstandingRecoveries, cededReserve))],
    };

    /* --- Schedule C: the balance with each reinsurer, per counterparty */
    const positions = register.securityPositions(input.asOf);
    const counterparties = [...new Set(register.list().map((t) => t.counterparty))].sort();
    // Receivable from a counterparty at the reporting date is recoveries still to collect (claimed
    // before the date) less settlements received up to it, plus commission due. The ledger carries the
    // same thing, and the register-to-books reconciliation proves it line by line.
    const receivableOf = (name: string) => {
      const mine = register.recoveryList().filter((r) => r.source !== 'deposit' && register.treaty(r.treatyId).counterparty === name && day(r.at) <= input.asOf);
      const claimed = sum(mine.map((r) => r.amount));
      const settled = sum(mine.filter((r) => r.settledAt && day(r.settledAt) <= input.asOf).map((r) => r.settled));
      return add(sub(claimed, settled), this.commissionOf(name));
    };
    const payableOf = (name: string) => this.payableOf(name, input.asOf);
    const depositOf = (name: string) =>
      sum(register.depositAccounts().filter((d) => register.treaty(d.treatyId).counterparty === name).map((d) => d.assetRemaining));
    const securityOf = (name: string) => positions.find((p) => p.counterparty === name)?.held ?? zero(currency);

    const balances: ExtractTable = {
      code: 'RS-C',
      title: 'Balances with reinsurers and retakaful operators',
      columns: ['Receivable', 'Payable', 'Deposit on account', 'Security held', 'Net receivable'],
      source: 'The recovery register, the cession register, the deposit accounts and the security instruments, each counterparty at a time.',
      rows: counterparties.map((name) => {
        const receivable = receivableOf(name);
        const payable = payableOf(name);
        const deposit = depositOf(name);
        const security = securityOf(name);
        return {
          code: `C.${name}`,
          line: name,
          values: [receivable, payable, deposit, security, sub(receivable, payable)],
          note: security.minor > 0n && positions.find((p) => p.counterparty === name)?.shortfall.minor !== 0n
            ? `security held is ${formatAmount(positions.find((p) => p.counterparty === name)!.shortfall)} short of what the treaties require`
            : undefined,
        };
      }),
      totals: [
        sum(counterparties.map(receivableOf)), sum(counterparties.map(payableOf)),
        sum(counterparties.map(depositOf)), sum(counterparties.map(securityOf)),
        sub(sum(counterparties.map(receivableOf)), sum(counterparties.map(payableOf))),
      ],
    };

    /* --- Schedule D: deposit-accounted treaties */
    const deposits = register.depositAccounts();
    const depositTable: ExtractTable = {
      code: 'RS-D',
      title: 'Deposit-accounted treaties',
      columns: ['Deposit paid', 'Technical premium', 'Adjustment', 'Asset remaining'],
      source: 'The deposit accounts: premium paid on account is an asset until the period is settled against the real subject premium.',
      rows: deposits.map((d) => ({
        code: `D.${d.treatyId}`, line: d.treatyId,
        values: [
          d.depositPaid,
          d.technicalPremium ?? null,
          sum(d.adjustments.map((a) => a.amount)),
          d.assetRemaining,
        ],
        note: d.settled ? `settled ${d.adjustments.at(-1)?.kind ?? ''}` : 'still on account: no premium income and no claim expense has been recognised',
      })),
      totals: [
        sum(deposits.map((d) => d.depositPaid)), null,
        sum(deposits.flatMap((d) => d.adjustments.map((a) => a.amount))),
        sum(deposits.map((d) => d.assetRemaining)),
      ],
    };

    /* --- controls: the return against the books */
    const controls: ExtractControl[] = [];
    const ledgerBalance = (accountId: string): Money => ledger.hasAccount(accountId) ? ledger.balance(accountId) : zero(currency);
    const money = (cells: readonly Cell[] | null | undefined, index: number): Money => {
      const cell = cells?.[index];
      if (!cell || isRatioCell(cell)) throw new ExtractError(`a control total is missing or is not an amount (${codeName(index)})`);
      return cell;
    };
    const codeName = (index: number): string => `column ${index + 1}`;
    const tie = (code: string, what: string, fromRegister: Money, accountId: string, note?: string): void => {
      const books = ledgerBalance(accountId);
      const difference = sub(fromRegister, books);
      controls.push({
        code, what,
        state: difference.minor === 0n ? 'agrees' : 'difference',
        detail: difference.minor === 0n
          ? `${formatAmount(fromRegister)} agrees with ${accountId}`
          : `the return says ${formatAmount(fromRegister)} and ${accountId} says ${formatAmount(books)}: a difference of ${formatAmount(difference)}${note ? ` — ${note}` : ''}`,
      });
    };
    tie('RS-A.5', 'Total ceded premium on the return ties to the ceded premium account', cededTotal, this.account('REINS:CEDED-PREMIUM'),
      depositRecognised.minor > 0n ? `${formatAmount(depositRecognised)} of it is a deposit-accounted period settled in this period` : undefined);
    tie('RS-A.7', 'Commission on the return ties to the commission account', commission, this.account('REINS:COMMISSION'));
    // Recoveries still to collect is a stock and can be tied to the balance sheet; money received is a
    // flow and cannot. The ledger receivable holds recoveries plus commission due, so commission comes
    // out before the comparison, and the note says so rather than leaving the reader to work it out.
    {
      const books = sub(this.balance(this.account('REINS:RECEIVABLE')), commission);
      const difference = sub(outstandingRecoveries, books);
      controls.push({
        code: 'RS-B.3',
        what: 'Recoveries still to collect tie to the receivable account once commission due is taken out',
        state: difference.minor === 0n ? 'agrees' : 'difference',
        detail: difference.minor === 0n
          ? `${formatAmount(outstandingRecoveries)} agrees with the receivable account less ${formatAmount(commission)} of commission due`
          : `the return says ${formatAmount(outstandingRecoveries)} of recoveries are still to collect and the receivable account less commission says ${formatAmount(books)}: a difference of ${formatAmount(difference)}`,
      });
    }
    // The reserve account must equal the reserves the claims module holds, claim by claim — an orphan
    // reserve, or a released one with no journal, shows up here. The reinsurers' share is a memorandum
    // against the receivable: it is not posted to the reserve, and the note says so.
    {
      const heldByModule = this.deps.claims.list().reduce((t, c) => add(t, c.reserve), zero(currency));
      const inAccount = this.balance(this.claimsReserveAccount());
      const difference = sub(heldByModule, inAccount);
      controls.push({
        code: 'RS-B.4',
        what: 'The claims the module holds carry the reserves the reserve account holds',
        state: difference.minor === 0n ? 'agrees' : 'difference',
        detail: difference.minor === 0n
          ? `${formatAmount(inAccount)} of reserve agrees, claim by claim, with the reserve account; ${formatAmount(grossReserve)} of it sits on risks this return covers and ${formatAmount(cededReserve)} is the reinsurers' share`
          : `the claims module holds ${formatAmount(heldByModule)} of reserve and the reserve account says ${formatAmount(inAccount)}: a difference of ${formatAmount(difference)}`,
      });
    }
    tie('RS-C.receivable', 'Receivable from reinsurers, every counterparty, ties to the receivable account', money(balances.totals, 0), this.account('REINS:RECEIVABLE'));
    tie('RS-C.payable', 'Payable to reinsurers, every counterparty, ties to the payable account', money(balances.totals, 1), this.account('REINS:PAYABLE'),
      'premium withheld as security is not payable and is excluded, exactly as it is excluded from the ledger payable');
    tie('RS-C.deposit', 'Deposit premium on account, every counterparty, ties to the deposit asset', money(balances.totals, 2), this.account('REINS:DEPOSIT-PREMIUM'));
    // Only cash security is posted, so only cash security can be tied. Letters of credit and guarantees
    // are counted in the cover and disclosed, and the control says how much is in each part rather than
    // pretending the whole of the security is on the balance sheet.
    {
      const cashSecurity = positions.flatMap((p) => p.instruments)
        .filter((i) => i.onBalanceSheet && i.kind === 'cash' && i.released.minor < i.amount.minor)
        .reduce((t, i) => add(t, sub(i.amount, i.released)), zero(currency));
      const disclosed = sub(money(balances.totals, 3), cashSecurity);
      const books = this.balance(this.securityAccount());
      const difference = sub(cashSecurity, books);
      controls.push({
        code: 'RS-C.security',
        what: 'Cash held as security ties to restricted cash; letters of credit and guarantees are disclosed',
        state: difference.minor === 0n ? 'agrees' : 'difference',
        detail: difference.minor === 0n
          ? `${formatAmount(cashSecurity)} of cash security agrees with restricted cash, and ${formatAmount(disclosed)} of letters of credit, guarantees and withheld premium is counted, disclosed and kept off the balance sheet`
          : `the register holds ${formatAmount(cashSecurity)} of cash security and restricted cash says ${formatAmount(books)}: a difference of ${formatAmount(difference)} — ${formatAmount(disclosed)} of the total ${formatAmount(money(balances.totals, 3))} is disclosed rather than posted`,
      });
    }

    const differences = controls.filter((c) => c.state === 'difference').length;
    return {
      kind: 'regulatory-return',
      title: basis === 'takaful' ? 'Retakaful return — participant risk fund' : 'Reinsurance return',
      entityId, jurisdiction, basis, currency,
      period: input.period, asOf: input.asOf, preparedBy,
      tables: [premium, claimsTable, balances, depositTable],
      controls,
      notes: [
        basis === 'takaful'
          ? 'Every figure on this return is derived from the retakaful register and the participant risk fund ledger; participant money is reported in its own fund and never mixed into the operator\u2019s numbers, and the wakalah fee is the operator\u2019s income, shown separately.'
          : 'Every figure on this return is derived from the reinsurance register and the general ledger; nothing here is re-keyed from a spreadsheet.',
        differences === 0
          ? 'Every control agrees with the books as at the reporting date.'
          : `${differences} control(s) do not agree: this return cannot be issued without a named approver accepting the difference.`,
        'The receivable includes ceding commission due from each counterparty, which is why it is larger than the recoveries still to collect.',
      ],
      limitations: [
        'Premium here is the premium on risks the treaty programme covers. Total book premium is a different figure and is not reported by this module.',
        'The reserve is the claims module\u2019s case reserve. No IBNR estimate is computed here: that is the appointed actuary\u2019s model, and this return says so rather than inventing a figure.',
        'Amounts are in the entity\u2019s reporting currency. Foreign-currency business is translated when the cession is posted, at the rate recorded on that journal.',
      ],
    };
  }

  /**
   * The actuary's exhibits: technical provisions by line of business, the cession and retention
   * picture per treaty, loss ratios, and the run-off of claims actually paid month by month.
   */
  actuarialExhibits(input: { period: ExtractPeriod; asOf: string; preparedBy?: string }): ExtractDraft {
    const { register, currency, basis, entityId, jurisdiction, claims } = this.deps;
    const preparedBy = input.preparedBy ?? 'actuarial';
    const cessions = register.cessionSchedule();
    // The line of business travels on the cession: a quota share treaty covers 'all', but the motor
    // claim on it belongs in the motor line, and an exhibit that says otherwise is wrong.
    const lineOfTreaty = (treatyId: string, cessionLine?: string) => cessionLine ?? register.treaty(treatyId).lineOfBusiness;
    const lines = [...new Set([
      ...cessions.map((c) => lineOfTreaty(c.treatyId, c.lineOfBusiness)),
      ...this.cededClaims().map((c) => LINE_OF[c.cause] ?? 'other'),
    ])].sort();

    const byLine = (line: string) => {
      const lineCessions = cessions.filter((c) => lineOfTreaty(c.treatyId, c.lineOfBusiness) === line);
      const lineClaims = this.cededClaims().filter((c) => (LINE_OF[c.cause] ?? 'other') === line);
      const premium = lineCessions.reduce((t, c) => add(t, c.premium), zero(currency));
      const cededPremium = lineCessions.reduce((t, c) => add(t, c.cededPremium), zero(currency));
      const commission = lineCessions.reduce((t, c) => add(t, c.commission), zero(currency));
      const paid = lineClaims.reduce((t, c) => add(t, c.paid), zero(currency));
      const open = lineClaims.filter((c) => this.isOpen(c));
      const reserve = open.reduce((t, c) => add(t, c.reserve), zero(currency));
      const cededReserve = open.reduce((t, c) => add(t, this.shareOf(c.policyId, c.reserve)), zero(currency));
      const recovered = lineClaims.reduce((t, c) => add(t, c.recoveries.filter((r) => r.type === 'reinsurance').reduce((x, r) => add(x, r.amount), zero(currency))), zero(currency));
      return { line, premium, cededPremium, commission, paid, reserve, cededReserve, recovered, claims: lineClaims.length, open: open.length };
    };
    const rows = lines.map(byLine);
    const sumOf = (pick: (r: (typeof rows)[number]) => Money) => rows.reduce((t, r) => add(t, pick(r)), zero(currency));
    const grossPremium = sumOf((r) => r.premium);
    const cededPremium = sumOf((r) => r.cededPremium);
    const depositRecognised = this.deps.register.depositAccounts()
      .filter((d) => d.settled && d.settledAt && inPeriod(d.settledAt, input.period))
      .reduce((t, d) => add(t, d.technicalPremium ?? zero(currency)), zero(currency));
    const grossReserve = sumOf((r) => r.reserve);
    const cededReserve = sumOf((r) => r.cededReserve);
    const paid = sumOf((r) => r.paid);
    const recovered = sumOf((r) => r.recovered);
    const bps = (part: Money, whole: Money): number => whole.minor === 0n ? 0 : Number((part.minor * 10_000n) / whole.minor);

    const provisionsRows: readonly ExtractRow[] = [
      {
        code: 'AE.1.1', line: 'Outstanding claims reserve (case reserves)', values: [grossReserve, cededReserve, sub(grossReserve, cededReserve)],
        note: `${rows.reduce((t, r) => t + r.open, 0)} open claim(s) on ceded risks`,
      },
      {
        code: 'AE.1.2', line: 'Unearned premium reserve', values: [zero(currency), zero(currency), zero(currency)],
        note: 'nil by construction for premium charged only between an explicit start and stop; for annual business this is the policy administration module\u2019s figure, not this one',
      },
      {
        code: 'AE.1.3', line: 'Deposit premium on account (asset, not expense)', values: [zero(currency), null, this.depositAsset()],
        note: 'a deposit-accounted treaty transfers too little risk to be insurance: the money stays an asset until the period is settled',
      },
      {
        code: 'AE.1.4', line: 'Technical provisions, total', values: [grossReserve, cededReserve, sub(add(grossReserve, this.depositAsset()), cededReserve)],
      },
    ];

    const provisions: ExtractTable = {
      code: 'AE-1',
      title: 'Technical provisions by line of business',
      columns: ['Gross', 'Reinsurers\u2019 share', 'Net'],
      source: 'Case reserves from the claims module, and each claim\u2019s cession share taken from the cession that actually applied to its policy.',
      rows: provisionsRows,
      totals: [grossReserve, cededReserve, sub(grossReserve, cededReserve)],
    };

    const cessionTable: ExtractTable = {
      code: 'AE-2',
      title: 'Cession, retention and security by treaty',
      columns: ['Capacity', 'Ceded to date', 'Headroom', 'Premium ceded', 'Commission', 'Recoveries', 'Recoverable', 'Security held'],
      source: 'The treaty register: utilisation, recoveries outstanding and the security in force at the reporting date.',
      rows: register.list().map((treaty) => {
        const statement = register.utilisation({ asOf: input.asOf, basis });
        const utilisation = statement.treaties.find((t) => t.treatyId === treaty.id);
        const position = register.securityPositions(input.asOf).find((p) => p.counterparty === treaty.counterparty);
        const recoverable = register.recoveryList()
          .filter((r) => r.treatyId === treaty.id && r.source !== 'deposit' && r.outstanding.minor > 0n)
          .reduce((t, r) => add(t, r.outstanding), zero(currency));
        return {
          code: `AE.2.${treaty.id}`, line: `${treaty.id} — ${treaty.counterparty}`,
          values: [
            utilisation?.capacity ?? null, utilisation?.cededSumInsured ?? null,
            utilisation?.headroom ?? null, utilisation?.premiumCeded ?? null, utilisation?.commissionEarned ?? null,
            utilisation?.recoveries ?? null, recoverable, position?.held ?? zero(currency),
          ],
          note: utilisation
            ? `${utilisation.risks} risk(s); cover ${formatAmount(utilisation.cover.available)} of ${formatAmount(utilisation.cover.limit)} available with ${utilisation.reinstatementsLeft} reinstatement(s) left`
            : undefined,
        };
      }),
      totals: null,
    };

    const lossTable: ExtractTable = {
      code: 'AE-3',
      title: 'Loss ratios by line of business',
      columns: ['Gross premium', 'Ceded premium', 'Paid claims', 'Recovered', 'Reserve', 'Loss ratio (gross)', 'Cession ratio'],
      source: 'Premium from the cession register, claims from the claims module: the same figures the return is built from, arranged the way an actuary reads them.',
      rows: rows.map((r) => ({
        code: `AE.3.${r.line}`, line: r.line,
        values: [
          r.premium, r.cededPremium, r.paid, r.recovered, r.reserve,
          r.premium.minor === 0n ? null : { ratioBps: bps(r.paid, r.premium) },
          r.premium.minor === 0n ? null : { ratioBps: bps(r.cededPremium, r.premium) },
        ],
        note: `${r.claims} claim(s), ${r.open} still open`,
      })),
      totals: [
        grossPremium, cededPremium, paid, recovered, grossReserve,
        { ratioBps: bps(paid, grossPremium) }, { ratioBps: bps(cededPremium, grossPremium) },
      ],
    };

    /* --- AE-4: the run-off, month by month, from the claims that were actually paid */
    const payments: Array<{ at: string; amount: Money; cause: string }> = [];
    for (const claim of this.deps.claims.list()) {
      for (const decision of claim.decisions) {
        if (decision.action !== 'settled' && decision.action !== 'settled-from-pool') continue;
        if (!decision.amount || !inPeriod(decision.at, { from: '2000-01-01', to: input.asOf })) continue;
        payments.push({ at: decision.at, amount: decision.amount, cause: claim.cause });
      }
    }
    const months = [...new Set(payments.map((p) => month(p.at)))].sort();
    let cumulative = zero(currency);
    const runOff: ExtractTable = {
      code: 'AE-4',
      title: 'Claims paid, month by month (run-off)',
      columns: ['Claims paid', 'Cumulative'],
      source: 'Every settlement decision on the claims module\u2019s own log, with the date it was made — the run-off pattern the actuary needs, without a triangle nobody can reconcile.',
      rows: months.map((m) => {
        const paidInMonth = payments.filter((p) => month(p.at) === m).reduce((t, p) => add(t, p.amount), zero(currency));
        cumulative = add(cumulative, paidInMonth);
        return {
          code: `AE.4.${m}`, line: m, values: [paidInMonth, cumulative],
          note: `${payments.filter((p) => month(p.at) === m).length} settlement(s)`,
        };
      }),
      totals: [cumulative, cumulative],
    };

    const controls: ExtractControl[] = [];
    void claims.position();
    const grossCase = this.openCededClaims().reduce((t, c) => add(t, c.reserve), zero(currency));
    const heldByModule = this.deps.claims.list().reduce((t, c) => add(t, c.reserve), zero(currency));
    const claimsReserve = this.balance(this.claimsReserveAccount());
    controls.push({
      code: 'AE.1.1',
      what: 'Case reserves held by the claims module tie to the reserve account',
      state: heldByModule.minor === claimsReserve.minor ? 'agrees' : 'difference',
      detail: heldByModule.minor === claimsReserve.minor
        ? `${formatAmount(claimsReserve)} of reserve agrees claim by claim; ${formatAmount(grossCase)} of it is on risks the treaty programme covers`
        : `the claims module holds ${formatAmount(heldByModule)} of reserve and the reserve account says ${formatAmount(claimsReserve)}`,
    });
    controls.push({
      code: 'AE.2.premium',
      what: 'Premium ceded on the exhibits, including deposit premium recognised, ties to the ceded premium account',
      state: add(cededPremium, depositRecognised).minor === this.cededPremiumLedger().minor ? 'agrees' : 'difference',
      detail: add(cededPremium, depositRecognised).minor === this.cededPremiumLedger().minor
        ? `${formatAmount(add(cededPremium, depositRecognised))} agrees with the ceded premium account${depositRecognised.minor > 0n ? `, ${formatAmount(depositRecognised)} of it recognised on settling a deposit-accounted period` : ''}`
        : `the exhibits say ${formatAmount(add(cededPremium, depositRecognised))} and the ceded premium account says ${formatAmount(this.cededPremiumLedger())}`,
    });
    // Two kinds of recovery, two accounts, two controls: an event recovery is income on the
    // reinsurance account, a policy recovery is attached to the claim that produced it.
    const policyRecoveries = this.deps.register.recoveryList()
      .filter((r) => r.source === 'policy')
      .reduce((t, r) => add(t, r.amount), zero(currency));
    const claimsRecoveryAccount = this.balance(this.account('CLAIM-RECOVERY'));
    // The claims recovery account also holds salvage and third-party money, which is not reinsurance
    // and must come out before the comparison: comparing unlike things is how a control tells a lie.
    const otherRecoveries = this.deps.claims.list()
      .flatMap((c) => c.recoveries)
      .filter((r) => r.type !== 'reinsurance')
      .reduce((t, r) => add(t, r.amount), zero(currency));
    const reinsuranceInAccount = sub(claimsRecoveryAccount, otherRecoveries);
    controls.push({
      code: 'AE.3.recovered',
      what: 'Policy recoveries on the exhibits tie to the reinsurance money in the claims recovery account',
      state: policyRecoveries.minor === reinsuranceInAccount.minor ? 'agrees' : 'difference',
      detail: policyRecoveries.minor === reinsuranceInAccount.minor
        ? `${formatAmount(policyRecoveries)} agrees with the claims recovery account once ${formatAmount(otherRecoveries)} of salvage and third-party money is taken out`
        : `the register claims ${formatAmount(policyRecoveries)} of policy recoveries against ${formatAmount(reinsuranceInAccount)} on the books (the account holds ${formatAmount(claimsRecoveryAccount)}, of which ${formatAmount(otherRecoveries)} is salvage and third-party money)`,
    });
    const eventRecoveries = this.deps.register.eventRecoveryList()
      .reduce((t, e) => add(t, e.amount), zero(currency));
    const eventRecoveryAccount = this.balance(this.account('REINS:RECOVERY'));
    controls.push({
      code: 'AE.2.event',
      what: 'Catastrophe and event recoveries tie to the recovery income account',
      state: eventRecoveries.minor === eventRecoveryAccount.minor ? 'agrees' : 'difference',
      detail: eventRecoveries.minor === eventRecoveryAccount.minor
        ? `${formatAmount(eventRecoveries)} agrees with the event recovery account`
        : `the register claims ${formatAmount(eventRecoveries)} of event recoveries against ${formatAmount(eventRecoveryAccount)} on the books`,
    });
    controls.push({
      code: 'AE.limitation',
      what: 'What this exhibit does not compute is stated on its face',
      state: 'informational',
      detail: 'IBNR, discounting and the unexpired premium on annual business are the appointed actuary\u2019s own working: this exhibit gives the paid and reserved facts and says where its arithmetic stops',
    });

    const differences = controls.filter((c) => c.state === 'difference').length;
    return {
      kind: 'actuarial-exhibits',
      title: basis === 'takaful' ? 'Actuarial exhibits — participant risk fund' : 'Actuarial exhibits',
      entityId, jurisdiction, basis, currency,
      period: input.period, asOf: input.asOf, preparedBy,
      tables: [provisions, cessionTable, lossTable, runOff],
      controls,
      notes: [
        `Cession ratio across the ceded population: ${(bps(cededPremium, grossPremium) / 100).toFixed(2)}% of premium ceded for ${(bps(cededReserve, grossReserve) / 100).toFixed(2)}% of the reserve.`,
        'Loss ratios are on a paid basis with case reserves included in the reserve column; no development factor has been applied.',
        differences === 0 ? 'Every exhibit control agrees with the books.' : `${differences} control(s) disagree: an actuary would not sign this without an explanation.`,
      ],
      limitations: [
        'No IBNR estimate: the paid-and-case facts are here and the reserving model is the actuary\u2019s own.',
        'No discounting of reserves, and no risk adjustment: both are actuarial judgements, not ledger facts.',
        'Unexpired premium on annual business is the policy administration module\u2019s figure; for premium charged only between start and stop, the unearned premium is nil by construction.',
        'Large-loss sensitivity is not shown: the catastrophe recovery is a single event and its effect is visible in the run-off rather than smoothed.',
      ],
    };
  }

  /**
   * The bordereau a counterparty reconciles against: what we ceded, what we claimed back, what has
   * been paid to us and what is still owed, treaty by treaty, with the closing balance.
   */
  bordereau(input: { counterparty: string; period: ExtractPeriod; asOf: string; preparedBy?: string }): ExtractDraft {
    const { register, currency, basis, entityId, jurisdiction } = this.deps;
    const treaties = register.list().filter((t) => t.counterparty === input.counterparty);
    if (treaties.length === 0) throw new ExtractError(`no treaty on this register is written by ${input.counterparty}: there is nothing to send them`);
    const preparedBy = input.preparedBy ?? 'reinsurance/desk';
    const ids = treaties.map((t) => t.id);

    const cessions = register.cessionSchedule().filter((c) => ids.includes(c.treatyId) && inPeriod(c.at, input.period));
    const recoveries = register.recoveryList().filter((r) => ids.includes(r.treatyId) && (inPeriod(r.at, input.period) || (r.settledAt && inPeriod(r.settledAt, input.period))));
    const security = register.securityPositions(input.asOf).find((p) => p.counterparty === input.counterparty);
    const sum = (list: readonly Money[]) => list.reduce((t, m) => add(t, m), zero(currency));

    const cessionTable: ExtractTable = {
      code: 'BD-1',
      title: 'Cessions in the period',
      columns: ['Sum insured', 'Ceded', 'Premium', 'Ceded premium', 'Commission', 'Net retained'],
      source: 'The cession register, in the order the cessions were posted, with the journal each one produced.',
      rows: cessions.map((c) => ({
        code: c.journalId, line: `${c.policyId} · ${c.riskId} (${c.treatyId})`,
        values: [c.sumInsured, c.ceded, c.premium, c.cededPremium, c.commission, c.netRetainedPremium],
        note: `${c.shareBps / 100}% ceded — ${c.explanation}`,
      })),
      totals: [
        sum(cessions.map((c) => c.sumInsured)), sum(cessions.map((c) => c.ceded)),
        sum(cessions.map((c) => c.premium)), sum(cessions.map((c) => c.cededPremium)),
        sum(cessions.map((c) => c.commission)), sum(cessions.map((c) => c.netRetainedPremium)),
      ],
    };

    const recoveryTable: ExtractTable = {
      code: 'BD-2',
      title: 'Recoveries claimed and settled',
      columns: ['Claimed', 'Settled', 'Outstanding', 'Due by'],
      source: 'The recovery register: one row per recovery, with the terms of the treaty that governs it.',
      rows: recoveries.map((r) => ({
        code: r.recoveryId, line: `${r.claimId} · ${r.treatyId}`,
        values: [r.amount, r.settled, r.outstanding, null],
        note: r.settledAt ? `settled ${day(r.settledAt)}` : 'still to settle',
      })),
      totals: [sum(recoveries.map((r) => r.amount)), sum(recoveries.map((r) => r.settled)), sum(recoveries.map((r) => r.outstanding)), null],
    };

    const securityTable: ExtractTable = {
      code: 'BD-3',
      title: 'Security held at the closing date',
      columns: ['Amount', 'Released', 'In force', 'Expires'],
      source: 'The security instruments held from this counterparty, reported whether or not they are posted to the balance sheet.',
      rows: (security?.instruments ?? []).map((i) => ({
        code: i.id, line: `${i.kind} · ${i.reference}`,
        values: [i.amount, i.released, sub(i.amount, i.released), null],
        note: i.expiresAt ? `expires ${i.expiresAt}${i.onBalanceSheet ? '' : ' (disclosed, not posted)'}` : (i.onBalanceSheet ? 'no expiry: an open instrument' : 'disclosed, not posted'),
      })),
      totals: [
        sum((security?.instruments ?? []).map((i) => i.amount)), sum((security?.instruments ?? []).map((i) => i.released)),
        security?.held ?? zero(currency), null,
      ],
    };

    const receivable = (security?.recoverable ?? zero(currency));
    const payable = this.payableOf(input.counterparty);
    const closing: ExtractTable = {
      code: 'BD-4',
      title: 'Closing balance',
      columns: ['Amount'],
      source: 'The same figures the supervisory return carries for this counterparty, so the desk and the regulator are reading one number.',
      rows: [
        { code: 'BD.4.1', line: 'Recoveries still to collect (before commission)', values: [receivable] },
        { code: 'BD.4.2', line: 'Commission due from the counterparty', values: [this.commissionOf(input.counterparty)] },
        { code: 'BD.4.3', line: 'Premium payable to the counterparty', values: [payable] },
        { code: 'BD.4.4', line: 'Security held against the balance', values: [security?.held ?? zero(currency)] },
        { code: 'BD.4.5', line: 'Requirement, and whether it is covered', values: [security?.requirement ?? zero(currency)],
          note: security && security.shortfall.minor > 0n ? `${formatAmount(security.shortfall)} short: called or to be called` : 'covered by the security in force' },
      ],
      totals: [receivable],
    };

    const controls: ExtractControl[] = [];
    const statement = register.securityStatement({ asOf: input.asOf });
    const mine = statement.positions.find((p) => p.counterparty === input.counterparty);
    controls.push({
      code: 'BD.held',
      what: 'Security on the bordereau ties to the security statement',
      state: (mine?.held.minor ?? 0n) === (security?.held.minor ?? -1n) ? 'agrees' : 'difference',
      detail: `${formatAmount(security?.held ?? zero(currency))} held at ${input.asOf}, taken from the same instruments the security statement reports`,
    });
    controls.push({
      code: 'BD.recovery',
      what: 'Recoveries on the bordereau tie to the recovery register for this counterparty',
      state: recoveries.reduce((t, r) => add(t, r.amount), zero(currency)).minor
        === register.recoveryList().filter((r) => ids.includes(r.treatyId)).reduce((t, r) => add(t, r.amount), zero(currency)).minor
        ? 'agrees' : 'difference',
      detail: 'one register, so the bordereau cannot disagree with the ageing statement the credit committee reads',
    });
    const differences = controls.filter((c) => c.state === 'difference').length;

    return {
      kind: 'treaty-bordereau',
      title: `Treaty bordereau — ${input.counterparty}`,
      entityId, jurisdiction, basis, currency,
      period: input.period, asOf: input.asOf, preparedBy,
      counterparty: input.counterparty,
      tables: [cessionTable, recoveryTable, securityTable, closing],
      controls,
      notes: [
        `${cessions.length} cession(s) and ${recoveries.length} recovery/recoveries in the period, sent to ${input.counterparty} to reconcile against their own records.`,
        'Totals on this bordereau are the register\u2019s figures; the ledger agrees with the register line by line in the reconciliation statement, so a counterparty query lands on one of two numbers, not three.',
        differences === 0 ? 'Both controls agree.' : `${differences} control(s) disagree: do not send this bordereau until they are explained.`,
      ],
      limitations: [
        'Written on the treaty terms as agreed. A settlement discount, a cash call agreed outside the treaty or a commutation is reported only once it is posted here.',
        'Foreign-currency treaties are reported in the entity\u2019s currency at the rate on each journal; the counterparty may see a small difference from its own translation, and the journal date is stated so the difference can be found.',
      ],
    };
  }

  /* ------------------------------------------------------------------ issuing */

  /**
   * Issue an extract. The content is built, its controls are run, and it is fingerprinted and kept.
   * There are exactly three outcomes: issued, returned as already issued (identical content), or
   * refused — because a control disagrees, or because the same period already has an extract with
   * different content and nobody has said what changed.
   */
  issue(input: {
    kind: ExtractKind;
    period: ExtractPeriod;
    asOf: string;
    counterparty?: string;
    by: string;
    at: string;
    changesSummary?: string;
    allowDifferences?: boolean;
    approvedBy?: string;
  }): { created: boolean; extract: IssuedExtract } {
    const draft = this.build(input);
    const fingerprint = fingerprintOf({ ...draft, controls: draft.controls });
    const sameScope = this.issued.filter((e) => e.kind === draft.kind
      && e.period.from === draft.period.from && e.period.to === draft.period.to
      && (e.counterparty ?? null) === (draft.counterparty ?? null)
      && e.basis === draft.basis && e.entityId === draft.entityId);

    if (sameScope.some((e) => e.fingerprint === fingerprint)) {
      const existing = sameScope.find((e) => e.fingerprint === fingerprint)!;
      return { created: false, extract: existing };
    }

    const differences = draft.controls.filter((c) => c.state === 'difference');
    if (differences.length > 0 && !input.allowDifferences) {
      throw new ExtractError(`${differences.length} control(s) on this ${draft.kind.replace('-', ' ')} do not agree with the books; an extract that does not tie cannot be issued — ${differences[0]!.detail}`);
    }
    if (differences.length > 0) {
      if (!input.approvedBy) throw new ExtractError('accepting a difference on a regulatory extract needs a named approver; it goes on the face of the extract');
      if (!input.changesSummary || input.changesSummary.trim().length < REASON_MINIMUM) {
        throw new ExtractError('say why a difference is being accepted, in a sentence someone can quote later');
      }
    }

    const previous = sameScope[sameScope.length - 1] ?? null;
    if (previous) {
      if (!input.changesSummary || input.changesSummary.trim().length < REASON_MINIMUM) {
        throw new ExtractError(`${previous.id} already covers this period with different content; say what changed and why before superseding a return, in a sentence someone can quote later`);
      }
      if (input.asOf < previous.asOf) {
        throw new ExtractError(`this extract is dated ${input.asOf} and ${previous.id} is dated ${previous.asOf}: an earlier date cannot replace a later one — that is rewriting history, not correcting it`);
      }
    }

    const extract: IssuedExtract = {
      ...draft,
      id: `RI-EX-${this.deps.entityId}-${String(++this.seq).padStart(5, '0')}`,
      version: previous ? previous.version + 1 : 1,
      fingerprint,
      issuedAt: input.at,
      supersedes: previous ? previous.id : null,
      changesSummary: input.changesSummary ?? null,
      differencesAccepted: differences.length > 0 ? { by: input.approvedBy!, reason: input.changesSummary! } : null,
      tiesToBooks: differences.length === 0,
    };
    this.issued.push(extract);
    return { created: true, extract };
  }

  build(input: { kind: ExtractKind; period: ExtractPeriod; asOf: string; counterparty?: string; preparedBy?: string }): ExtractDraft {
    switch (input.kind) {
      case 'regulatory-return':
        return this.regulatoryReturn({ period: input.period, asOf: input.asOf, ...(input.preparedBy ? { preparedBy: input.preparedBy } : {}) });
      case 'actuarial-exhibits':
        return this.actuarialExhibits({ period: input.period, asOf: input.asOf, ...(input.preparedBy ? { preparedBy: input.preparedBy } : {}) });
      case 'treaty-bordereau':
        if (!input.counterparty) throw new ExtractError('a treaty bordereau is addressed to one counterparty: name it');
        return this.bordereau({ counterparty: input.counterparty, period: input.period, asOf: input.asOf, ...(input.preparedBy ? { preparedBy: input.preparedBy } : {}) });
    }
  }

  list(): readonly IssuedExtract[] { return this.issued; }

  get(id: string): IssuedExtract {
    const extract = this.issued.find((e) => e.id === id);
    if (!extract) throw new ExtractError(`unknown extract ${id}`);
    return extract;
  }

  /** The version history of one period of one extract: what was issued, by whom, and what changed. */
  history(kind: ExtractKind, period: ExtractPeriod, counterparty?: string): IssuedExtractSummary[] {
    return this.issued
      .filter((e) => e.kind === kind && e.period.from === period.from && e.period.to === period.to && (e.counterparty ?? null) === (counterparty ?? null))
      .map((e) => this.summary(e));
  }

  summary(e: IssuedExtract): IssuedExtractSummary {
    return {
      id: e.id, kind: e.kind, title: e.title, version: e.version, period: e.period, asOf: e.asOf,
      issuedAt: e.issuedAt, fingerprint: e.fingerprint, tiesToBooks: e.tiesToBooks,
      differences: e.controls.filter((c) => c.state === 'difference').length,
      ...(e.counterparty ? { counterparty: e.counterparty } : {}),
    };
  }

  /** Verify what was issued: recompute it now and say whether the content still stands. */
  verify(id: string): { id: string; fingerprint: string; recomputed: string; intact: boolean; detail: string } {
    const extract = this.get(id);
    const draft = this.build({
      kind: extract.kind, period: extract.period, asOf: extract.asOf,
      ...(extract.counterparty ? { counterparty: extract.counterparty } : {}),
      preparedBy: extract.preparedBy,
    });
    const recomputed = fingerprintOf({ ...draft, controls: draft.controls });
    const intact = recomputed === extract.fingerprint;
    return {
      id, fingerprint: extract.fingerprint, recomputed, intact,
      detail: intact
        ? `${id} reproduces exactly: the figures it was issued with are the figures the books still produce`
        : `${id} no longer reproduces: the register or the books have moved since it was issued. That is normal after later transactions — it is why an issued return is kept and superseded rather than edited.`,
    };
  }

  /* ------------------------------------------------------------------ internal */

  private account(suffix: string): string { return `${this.deps.entityId}:${suffix}`; }
  private recoverySettlementsAccount(): string { return this.account('REINS:RECEIVABLE'); }
  private claimsReserveAccount(): string { return this.account('CLAIM-RESERVE'); }
  private securityAccount(): string { return this.account('COLLATERAL:CASH'); }
  private cededPremiumLedger(): Money { return this.balance(this.account('REINS:CEDED-PREMIUM')); }
  private depositAsset(): Money { return this.balance(this.account('REINS:DEPOSIT-PREMIUM')); }

  private balance(accountId: string): Money {
    return this.deps.ledger.hasAccount(accountId) ? this.deps.ledger.balance(accountId) : zero(this.deps.currency);
  }

  /** Claim reserves, as the claims module's own reserve account sees them. */
  private claimsReservePosition(): Money {
    const reserved = this.deps.claims.position().reserved;
    return reserved;
  }

  /** The share of a claim's cost the treaties carry: taken from the cession that applied to its policy. */
  private shareOf(policyId: string, amount: Money): Money {
    try {
      const cession = this.deps.register.shareFor(policyId);
      const share = BigInt(cession.shareBps);
      return { minor: (amount.minor * share) / 10_000n, currency: amount.currency };
    } catch {
      return zero(amount.currency);   // no cession on that policy: the whole cost is ours, and that is a fact too
    }
  }

  private cededReserveShare(): Money {
    return this.openCededClaims().reduce((t, c) => add(t, this.shareOf(c.policyId, c.reserve)), zero(this.deps.currency));
  }

  /** A claim is open while it can still move: once settled, declined or withdrawn, the reserve is done. */
  private isOpen(claim: Claim): boolean {
    return claim.status === 'registered' || claim.status === 'under-review' || claim.status === 'approved';
  }

  private openCededClaims(): readonly Claim[] {
    return this.cededClaims().filter((c) => this.isOpen(c));
  }

  /** Claims on policies the treaty programme actually covers. */
  private cededClaims(): readonly Claim[] {
    return this.deps.claims.list().filter((c) => {
      try { this.deps.register.shareFor(c.policyId); return true; } catch { return false; }
    });
  }

  private commissionOf(counterparty: string): Money {
    const ids = this.deps.register.list().filter((t) => t.counterparty === counterparty).map((t) => t.id);
    return this.deps.register.cessionSchedule().filter((c) => ids.includes(c.treatyId))
      .reduce((t, c) => add(t, c.commission), zero(this.deps.currency));
  }

  /**
   * What we owe a counterparty at a date: premium ceded and reinstatement premium, less any premium
   * we are holding back as security. Withheld premium is not paid, so it is not payable either.
   */
  private payableOf(counterparty: string, asOf = '9999-12-31'): Money {
    const ids = this.deps.register.list().filter((t) => t.counterparty === counterparty).map((t) => t.id);
    const premium = this.deps.register.cessionSchedule().filter((c) => ids.includes(c.treatyId))
      .reduce((t, c) => add(t, c.cededPremium), zero(this.deps.currency));
    const reinstatement = this.deps.register.reinstatements().filter((r) => ids.includes(r.treatyId))
      .reduce((t, r) => add(t, r.premium), zero(this.deps.currency));
    const withheld = this.deps.register.securityPositions(asOf)
      .flatMap((p) => p.instruments)
      .filter((i) => i.counterparty === counterparty && i.kind === 'funds-withheld' && i.at.slice(0, 10) <= asOf)
      .reduce((t, i) => add(t, sub(i.amount, i.released)), zero(this.deps.currency));
    return sub(add(premium, reinstatement), withheld);
  }
}

/** One place that knows how to read a cell, so no screen has to guess. */
export function isRatioCell(cell: Cell): cell is Ratio {
  return cell !== null && typeof cell === 'object' && 'ratioBps' in cell;
}

export function formatCell(cell: Cell): string {
  if (cell === null) return '—';
  if (isRatioCell(cell)) return `${(cell.ratioBps / 100).toFixed(2)}%`;
  return formatAmount(cell);
}
