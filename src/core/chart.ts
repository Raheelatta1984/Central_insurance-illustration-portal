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
  };
}
