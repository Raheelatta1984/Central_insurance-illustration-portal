/**
 * The product sheet, tested at its own boundary (before, it was only reached sideways through
 * the router). In particular: what this module exports must be what it can read back.
 */
import { describe, expect, it } from 'vitest';
import { ProductConfigError, productTemplateCsv, readProductSheet } from './product-config.js';

const masters = [{
  productId: 'PROD-TEST-1', name: 'Family, "Plus"\nPlan', category: 'conventional', line: 'life',
  minAge: 18, maxAge: 65, baseRatePerThousand: '12.50',
  automaticBindingLimit: '500000', facultativeThreshold: '1000000', aiStraightThroughLimit: '100000',
}];

describe('product sheet', () => {
  it('round-trips a name containing a comma, quotes and a newline', () => {
    const report = readProductSheet(productTemplateCsv(masters));
    expect(report.rejected).toEqual([]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.name).toBe('Family, "Plus"\nPlan');
    expect(report.rows[0]?.minAge).toBe(18);
  });

  it('refuses a sheet with no recognisable header by name', () => {
    expect(() => readProductSheet('foo,bar\n1,2')).toThrow(ProductConfigError);
  });

  it('rejects dirty rows with reasons and keeps the clean ones', () => {
    const sheet = productTemplateCsv(masters).replace('12.50', 'not-a-rate');
    const report = readProductSheet(sheet);
    expect(report.rows).toHaveLength(0);
    expect(report.rejected[0]?.reasons.join(' ')).toMatch(/not a decimal amount/);
  });
});
