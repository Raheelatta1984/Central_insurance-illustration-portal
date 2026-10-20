/**
 * The product configuration grid: the sheet the product factory is edited as.
 *
 * The product master used to be a form — one variety at a time, twelve fields, a Save button — which is
 * how a product gets filed and how a tariff of ninety varieties gets filed *never*. The screen is a
 * table now, so the same has to be true of the file: this module says what a row of that table holds
 * (the columns, their labels, which ones are required, what each one means), prints the template a
 * tenant fills in, reads a filled-in sheet back into the rows `ErpManager.defineProductMasters` files,
 * and writes what is on file out again so a review can diff it.
 *
 * A column here is the same field the form used, and the same one the underwriting manual holds: the
 * grid is a view of the product master, never a second copy of it. Business rules — an entry range that
 * admits nobody, a facultative threshold below the automatic binding limit, a takaful variety quietly
 * turned conventional — are enforced where they always were, in the ERP, row by row, so a bulk save
 * cannot smuggle past them.
 */
import { parseCsv, toCsv } from './csv.js';
import type { ProductRowInput } from './erp.js';
import { parseAmount } from './money.js';
import { PRODUCT_CATEGORIES, PRODUCT_LINES } from './products.js';

export class ProductConfigError extends Error {}

export interface ProductColumn {
  readonly key: keyof ProductRowInput & string;
  readonly label: string;
  readonly required: boolean;
  readonly kind: 'text' | 'number' | 'money' | 'category' | 'line';
  readonly hint: string;
}

/** The columns of the grid, in the order they print: identity, distribution, eligibility, price, limits. */
export const PRODUCT_COLUMNS: readonly ProductColumn[] = Object.freeze([
  { key: 'productId', label: 'Product ID', required: true, kind: 'text', hint: 'the filed id, upper-cased; a new id files a new variety' },
  { key: 'name', label: 'Registered name', required: true, kind: 'text', hint: 'what the filing and the policy schedule call it' },
  { key: 'secondaryName', label: 'Omni-channel name', required: false, kind: 'text', hint: 'what the shelf, the app and the partner portal call it (blank = the registered name)' },
  { key: 'category', label: 'Book', required: true, kind: 'category', hint: `one of: ${PRODUCT_CATEGORIES.join(', ')}` },
  { key: 'line', label: 'Line of business', required: true, kind: 'line', hint: `one of: ${PRODUCT_LINES.map((l) => l.id).join(', ')}` },
  { key: 'minAge', label: 'Age from', required: true, kind: 'number', hint: 'the youngest entry age the variety admits' },
  { key: 'maxAge', label: 'Age to', required: true, kind: 'number', hint: 'the oldest entry age it admits; the rating grid fills the bands inside these' },
  { key: 'maxBmi', label: 'Max BMI', required: false, kind: 'number', hint: 'above this the build test rates or refers' },
  { key: 'baseRatePerThousand', label: 'Base rate per 1000', required: true, kind: 'money', hint: 'the standard-life annual rate, in the local currency' },
  { key: 'incomeMultiple', label: 'Income multiple', required: false, kind: 'number', hint: 'the most cover a life may hold as a multiple of income' },
  { key: 'automaticBindingLimit', label: 'Auto binding limit', required: false, kind: 'money', hint: 'per life, before the reinsurer must see it' },
  { key: 'facultativeThreshold', label: 'Facultative threshold', required: false, kind: 'money', hint: 'per policy; must sit at or above the binding limit' },
  { key: 'aiStraightThroughLimit', label: 'AI straight-through', required: false, kind: 'money', hint: 'what an agent may accept without a human; must sit at or below the binding limit' },
]);

export const PRODUCT_COLUMN_LABELS: readonly string[] = PRODUCT_COLUMNS.map((c) => c.label);

const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function columnFor(header: string): ProductColumn | undefined {
  const want = slugKey(header);
  if (!want) return undefined;
  return PRODUCT_COLUMNS.find((c) => slugKey(c.key) === want || slugKey(c.label) === want
    || (c.key === 'baseRatePerThousand' && (want === 'rateper1000' || want === 'baserate' || want === 'rate')));
}

export interface ProductRowIssue { readonly line: number; readonly productId: string; readonly reasons: string[] }

export interface ProductSheetReport {
  read: number;
  applied: number;
  rejected: ProductRowIssue[];
  warnings: string[];
  rows: ProductRowInput[];
}

/**
 * The blank sheet, with this tenant's real products in it: one row per variety already on file, so a
 * bulk edit starts from the numbers that exist rather than from an empty grid, and a filled-in sheet of
 * that shape is exactly what `readProductSheet` reads back.
 */
export function productTemplateCsv(products: ReadonlyArray<{
  productId: string; name: string; secondaryName?: string; category: string; line: string;
  minAge: number; maxAge: number; maxBmi?: number | null; baseRatePerThousand: string;
  incomeMultiple?: number | null; automaticBindingLimit: string; facultativeThreshold: string; aiStraightThroughLimit: string;
}>): string {
  const header = PRODUCT_COLUMN_LABELS;
  const rows = products.map((p) => [
    p.productId, p.name, p.secondaryName ?? '', p.category, p.line, String(p.minAge), String(p.maxAge),
    String(p.maxBmi ?? ''), p.baseRatePerThousand, String(p.incomeMultiple ?? ''),
    p.automaticBindingLimit, p.facultativeThreshold, p.aiStraightThroughLimit,
  ]);
  return toCsv(header, rows);
}


/** The header text a column is known by on the sheet — what a refusal message should call it. */
function labelOf(key: string): string {
  return PRODUCT_COLUMNS.find((c) => String(c.key) === key)?.label ?? key;
}

/**
 * Read a filled-in sheet. Shape only: a missing required cell, a book or line nobody filed, an age
 * that is not a whole number, a rate that is not an amount. The business rules run afterwards, in the
 * ERP, against the product being filed — which is why a row that looks fine here can still be refused
 * there, and the screen shows both reports side by side.
 */
export function readProductSheet(text: string, options: { limit?: number } = {}): ProductSheetReport {
  // One shared codec (`csv.ts`): quoted cells may contain commas and newlines, which the old
  // line-at-a-time split mangled — this module's own export could not always be re-imported.
  const sheet = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0) && !(r[0] ?? '').trim().startsWith('#'));
  const report: ProductSheetReport = { read: 0, applied: 0, rejected: [], warnings: [], rows: [] };
  if (sheet.length < 2) throw new ProductConfigError('The sheet has no rows under its header.');
  const header = sheet[0]!;
  const mapping = header.map((h, i) => ({ i, col: columnFor(h) })).filter((m): m is { i: number; col: ProductColumn } => m.col !== undefined);
  if (mapping.length === 0) throw new ProductConfigError(`No column in the header was recognised (${header.slice(0, 4).join(', ')}…). Download the template and fill that.`);
  const ignored = header.filter((h, i) => h.trim().length > 0 && !mapping.some((m) => m.i === i));
  if (ignored.length > 0) report.warnings.push(`Ignored column(s) this system does not have a field for: ${ignored.join(', ')}.`);
  const missing = PRODUCT_COLUMNS.filter((c) => c.required && !mapping.some((m) => m.col.key === c.key)).map((c) => c.label);
  if (missing.length > 0) throw new ProductConfigError(`The sheet is missing required column(s): ${missing.join(', ')}.`);

  const limit = options.limit ?? 500;
  const body = sheet.slice(1);
  if (body.length > limit) throw new ProductConfigError(`This sheet has ${body.length} rows and a grid saves at most ${limit} at a time. Split it by line of business and save again — rows already filed stay filed.`);

  body.forEach((cells, index) => {
    const raw: Record<string, string> = {};
    for (const m of mapping) raw[m.col.key] = cells[m.i] ?? '';
    const productId = (raw['productId'] ?? '').trim().toUpperCase();
    const reasons: string[] = [];
    if (!productId) reasons.push('Product ID is required.');
    const row: ProductRowInput = { productId };
    for (const m of mapping) {
      const value = (cells[m.i] ?? '').trim();
      if (value === '') continue;
      (row as Record<string, unknown>)[m.col.key] = m.col.kind === 'number' ? Number(value) : value;
    }
    if (!String(raw['name'] ?? '').trim()) reasons.push('A row has to name the product it files (or name an id already on file).');
    const category = String(row.category ?? '').trim().toLowerCase();
    if (category && !PRODUCT_CATEGORIES.includes(category as never)) {
      reasons.push(`Book "${row.category}" is not one of ${PRODUCT_CATEGORIES.join(', ')}.`);
    }
    const lineOfBusiness = String(row.line ?? '').trim().toLowerCase();
    if (lineOfBusiness && !PRODUCT_LINES.some((l) => l.id === lineOfBusiness)) {
      reasons.push(`Line of business "${row.line}" is not filed on this tenant.`);
    }
    // The message quotes the column header the person is looking at, and the text they typed into it —
    // not the internal field name, which is the last thing a bulk uploader has ever seen.
    const typed = (key: string): string => String(raw[key] ?? '').trim();
    for (const key of ['minAge', 'maxAge', 'maxBmi', 'incomeMultiple'] as const) {
      const v = row[key];
      if (v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        reasons.push(`${labelOf(key)} must be a whole number, not "${typed(key)}".`);
      }
    }
    for (const key of ['baseRatePerThousand', 'automaticBindingLimit', 'facultativeThreshold', 'aiStraightThroughLimit'] as const) {
      const v = row[key];
      if (v === undefined || String(v).trim() === '') continue;
      try {
        if (parseAmount(String(v), 'AED').minor < 0n) reasons.push(`${labelOf(key)} cannot be negative.`);
      } catch { reasons.push(`${labelOf(key)} "${typed(key)}" is not a decimal amount.`); }
    }
    report.read += 1;
    if (reasons.length > 0) { report.rejected.push({ line: index + 2, productId, reasons }); return; }
    report.rows.push(row);
  });
  report.applied = report.rows.length;
  return report;
}

/** What the grid's own export writes: the filed masters in sheet form, for review or for re-upload. */
export function productExportCsv(masters: ReadonlyArray<Record<string, unknown>>): string {
  const rows = masters.map((p) => PRODUCT_COLUMNS.map((c) => {
    const value = p[c.key];
    return value === undefined || value === null ? '' : String(value);
  }));
  return toCsv(PRODUCT_COLUMN_LABELS, rows);
}
