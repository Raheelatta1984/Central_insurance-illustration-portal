import { describe, expect, it } from 'vitest';
import { filteredMovementTotals } from './statement-filter.js';
import type { UnitLinkedStatementLine } from './unitlinked-statement.js';

const line = (fundId: string, movementKind: string, grossAmount: string, deductionAmount: string, netCashAmount: string, unitsDelta: string) => ({ fundId, movementKind, grossAmount, deductionAmount, netCashAmount, unitsDelta }) as UnitLinkedStatementLine;
describe('filtered movement totals', () => {
  const lines = [line('A', 'regular-premium-allocation', '1,000.00 AED', '10.00 AED', '990.00 AED', '+99'), line('B', 'admin-fee-deduction', '5.00 AED', '5.00 AED', '0.00 AED', '-0.5')];
  it('filters both dimensions and sums exact displayed legs', () => {
    expect(filteredMovementTotals(lines, 'AED', 'A', 'regular-premium-allocation')).toMatchObject({ count: 1, gross: '1,000.00 AED', deductions: '10.00 AED', netCash: '990.00 AED', units: '99' });
    expect(filteredMovementTotals(lines, 'AED')).toMatchObject({ count: 2, gross: '1,005.00 AED', units: '98.5' });
    expect(filteredMovementTotals(lines, 'AED', 'A', 'admin-fee-deduction')).toMatchObject({ count: 0, gross: '0.00 AED', units: '0' });
  });
  it('rejects currency mismatches rather than combining currencies', () => expect(() => filteredMovementTotals(lines, 'USD')).toThrow('currency mismatch'));
});
