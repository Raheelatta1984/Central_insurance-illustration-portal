/**
 * Chart of accounts, built as data so any tenant can extend it without code changes.
 *
 * Fund segregation is visible in the ledger: every fund gets its own investment asset,
 * participant liability and residual account, so a takaful window and a conventional
 * book can never accidentally share a pool.
 */
import { Ledger } from './ledger.js';

export interface Chart {
  readonly entityId: string;
  cash(): string;
  bank(): string;
  premiumIncome(): string;
  fundClearing(): string;
  feeIncome(code: string): string;
  fundInvestments(fundId: string): string;
  participantLiability(fundId: string): string;
  fundResidual(fundId: string): string;
  fundAsset(): string;
  operatorFund(): string;
  qard(): string;
  claimExpense(): string;
  claimReserve(): string;
  claimRecovery(): string;
  icReceivable(counterparty: string): string;
  icPayable(counterparty: string): string;
  icIncome(counterparty: string): string;
  icExpense(counterparty: string): string;
}

/** Intercompany account suffixes, shared by the chart, the engines and the consolidator. */
export const IC = {
  receivable: (counterparty: string) => `IC:RECV:${counterparty}`,
  payable: (counterparty: string) => `IC:PAY:${counterparty}`,
  income: (counterparty: string) => `IC:INCOME:${counterparty}`,
  expense: (counterparty: string) => `IC:EXPENSE:${counterparty}`,
} as const;

/**
 * Intercompany accounts are per counterparty, so a balance can always be attributed to whoever
 * owes it. Without that, an elimination is guesswork.
 */
export function defineIntercompany(ledger: Ledger, entityId: string, currency: string, counterparties: string[]): void {
  for (const cp of counterparties) {
    const want = (suffix: string) => `${entityId}:${suffix}`;
    if (!ledger.hasAccount(want(IC.receivable(cp)))) {
      ledger.defineAccount({ id: want(IC.receivable(cp)), name: `Intercompany receivable — ${cp}`, type: 'asset', entityId, currency });
    }
    if (!ledger.hasAccount(want(IC.payable(cp)))) {
      ledger.defineAccount({ id: want(IC.payable(cp)), name: `Intercompany payable — ${cp}`, type: 'liability', entityId, currency });
    }
    if (!ledger.hasAccount(want(IC.income(cp)))) {
      ledger.defineAccount({ id: want(IC.income(cp)), name: `Intercompany income — ${cp}`, type: 'income', entityId, currency });
    }
    if (!ledger.hasAccount(want(IC.expense(cp)))) {
      ledger.defineAccount({ id: want(IC.expense(cp)), name: `Intercompany expense — ${cp}`, type: 'expense', entityId, currency });
    }
  }
}

export function buildChart(ledger: Ledger, entityId: string, currency: string, funds: string[]): Chart {
  const id = (n: string) => `${entityId}:${n}`;
  ledger.defineAccount({ id: id('CASH'), name: 'Cash at bank', type: 'asset', entityId, currency });
  ledger.defineAccount({ id: id('CLEARING'), name: 'Fund clearing', type: 'liability', entityId, currency });
  ledger.defineAccount({ id: id('PREMIUM-INCOME'), name: 'Premium / contribution income', type: 'income', entityId, currency });
  for (const code of ['allocation', 'coi', 'admin', 'switching', 'surrender', 'partial-withdrawal', 'topup', 'fund-management']) {
    ledger.defineAccount({ id: id(`FEE:${code}`), name: `Fee income — ${code}`, type: 'income', entityId, currency });
  }
  ledger.defineAccount({ id: id('OPERATOR-FUND'), name: 'Operator fund (shareholder)', type: 'equity', entityId, currency });
  ledger.defineAccount({ id: id('CLAIM-EXPENSE'), name: 'Claim expense (including reserve movement)', type: 'expense', entityId, currency });
  ledger.defineAccount({ id: id('CLAIM-RESERVE'), name: 'Claim reserve (outstanding)', type: 'liability', entityId, currency });
  ledger.defineAccount({ id: id('CLAIM-RECOVERY'), name: 'Claim recovery income', type: 'income', entityId, currency });
  ledger.defineAccount({ id: id('QARD'), name: 'Qard hasan receivable from participants', type: 'asset', entityId, currency });
  for (const f of funds) {
    const fid = `${entityId}:${f}`;
    ledger.defineAccount({ id: `${fid}:INVESTMENTS`, name: `Fund investments — ${f}`, type: 'asset', entityId, fundId: f, currency });
    ledger.defineAccount({ id: `${fid}:PARTICIPANTS`, name: `Participants' funds — ${f}`, type: 'liability', entityId, fundId: f, currency });
    ledger.defineAccount({ id: `${fid}:RESIDUAL`, name: `Rounding residual — ${f}`, type: 'equity', entityId, fundId: f, currency });
  }
  return {
    entityId,
    cash: () => id('CASH'),
    bank: () => id('CASH'),
    premiumIncome: () => id('PREMIUM-INCOME'),
    fundClearing: () => id('CLEARING'),
    feeIncome: (code: string) => id(`FEE:${code}`),
    fundInvestments: (fundId: string) => `${entityId}:${fundId}:INVESTMENTS`,
    participantLiability: (fundId: string) => `${entityId}:${fundId}:PARTICIPANTS`,
    fundResidual: (fundId: string) => `${entityId}:${fundId}:RESIDUAL`,
    fundAsset: () => id('CASH'),
    operatorFund: () => id('OPERATOR-FUND'),
    qard: () => id('QARD'),
    claimExpense: () => id('CLAIM-EXPENSE'),
    claimReserve: () => id('CLAIM-RESERVE'),
    claimRecovery: () => id('CLAIM-RECOVERY'),
    icReceivable: (counterparty: string) => id(IC.receivable(counterparty)),
    icPayable: (counterparty: string) => id(IC.payable(counterparty)),
    icIncome: (counterparty: string) => id(IC.income(counterparty)),
    icExpense: (counterparty: string) => id(IC.expense(counterparty)),
  };
}
