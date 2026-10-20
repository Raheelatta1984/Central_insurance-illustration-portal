/** One CSV codec: round-trips must be lossless, and spreadsheets must not execute our cells. */
import { describe, expect, it } from 'vitest';
import { csvCell, isFormulaCell, parseCsv, toCsv } from './csv.js';

describe('csv codec', () => {
  it('round-trips commas, quotes and embedded newlines', () => {
    const rows = [
      ['PROD-1', 'Family, "Plus" Plan', 'line one\nline two'],
      ['PROD-2', 'Plain', ''],
    ];
    const text = toCsv(['id', 'name', 'note'], rows);
    expect(parseCsv(text)).toEqual([['id', 'name', 'note'], ...rows]);
  });

  it('accepts CRLF, LF and a BOM on read', () => {
    expect(parseCsv('﻿a,b\r\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('disarms spreadsheet formula cells but leaves real numbers alone', () => {
    expect(isFormulaCell('=SUM(A1:A9)')).toBe(true);
    expect(isFormulaCell('+2+2')).toBe(true);
    expect(isFormulaCell('-2+2')).toBe(true);
    expect(isFormulaCell('@cmd')).toBe(true);
    expect(isFormulaCell('-5.00')).toBe(false);
    expect(isFormulaCell('250000')).toBe(false);
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('-5.00')).toBe('-5.00');
  });
});
