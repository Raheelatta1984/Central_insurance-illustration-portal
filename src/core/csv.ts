/**
 * One CSV codec for every sheet this platform reads or writes (product grid, rating tables,
 * warehouse exports).
 *
 * Why one codec: three hand-rolled writers/parsers had drifted apart — the product sheet's
 * reader split input on physical lines, so its own export of a name containing a newline could
 * not be re-imported; and no writer neutralised spreadsheet formula cells, so a customer or
 * partner name beginning `=`/`+`/`-`/`@` became a live formula in the Excel/Power BI exports
 * that are a headline feature of the warehouse.
 *
 * Rules: RFC 4180 quoting (fields containing comma, quote or newline are quoted; quotes are
 * doubled), CRLF row endings on write, LF/CRLF/CR accepted on read, quoted fields may span
 * lines, cells are trimmed on read (sheet-editing friendliness — a value that needs leading or
 * trailing spaces is not representable, and none of our sheets has one).
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * A cell a spreadsheet would execute as a formula. Plain numbers (including negatives like
 * `-5.00`, which rating sheets legitimately contain) are not formulas and pass through.
 */
export function isFormulaCell(value: string): boolean {
  const v = value.trimStart();
  if (v === '' || PLAIN_NUMBER.test(v)) return false;
  return /^[=+@\t\r-]/.test(v);
}

/** One cell, safe to open in a spreadsheet: formula cells are disarmed with a leading `'`. */
export function csvCell(value: string): string {
  const safe = isFormulaCell(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Quoted-CSV split: a product name or a note may contain a comma or a newline. */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  let touched = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; touched = true; continue; }
    if (ch === ',') { row.push(cell.trim()); cell = ''; touched = true; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = []; cell = ''; touched = false;
      continue;
    }
    cell += ch; touched = true;
  }
  if (touched || cell.length > 0 || row.length > 0) { row.push(cell.trim()); rows.push(row); }
  return rows;
}
