/** Movement totals are sums of displayed legs, not cash receipts or closing balances. */
import { formatAmount, money, parseAmount } from './money.js';
import { unitsFromDecimal, unitsToDecimal } from './units.js';
import type { UnitLinkedStatementLine } from './unitlinked-statement.js';

export function filteredMovementTotals(lines: readonly UnitLinkedStatementLine[], currency: string, fundId = '', movementKind = '') {
  const selected = lines.filter((line) => (!fundId || line.fundId === fundId) && (!movementKind || line.movementKind === movementKind));
  const amount = (field: 'grossAmount' | 'deductionAmount' | 'netCashAmount') => formatAmount(money(selected.reduce((sum, line) => {
    const suffix = ` ${currency}`;
    if (!line[field].endsWith(suffix)) throw new Error('Statement movement currency mismatch');
    return sum + parseAmount(line[field].slice(0, -suffix.length), currency).minor;
  }, 0n), currency));
  return { lines: selected, count: selected.length, gross: amount('grossAmount'), deductions: amount('deductionAmount'), netCash: amount('netCashAmount'), units: unitsToDecimal(selected.reduce((sum, line) => sum + unitsFromDecimal(line.unitsDelta.replace(/^\+/, '')), 0n)) };
}
