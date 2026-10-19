/**
 * The product factory, as a table you can edit.
 *
 * Master settings section 6 used to be a read-only list of ninety-odd varieties with a twelve-field form
 * underneath: fine for filing one product, useless for pricing a line, and hopeless for the thing a
 * distribution manager actually does — take the row beside this one, change an age band and a rate, and
 * file it. So this is a grid: every filed variety is a line, every cell is the product master's own
 * field, "Copy line" duplicates a row so a new variety starts as an exact twin, and saving is one bulk
 * call that files the good rows and writes each refusal back into the row it belongs to.
 *
 * The grid is a *draft*. Nothing is filed until it is saved; dirty rows are marked as such; an unsaved
 * draft survives a reload of the world underneath it; and the row in focus is the row the section's
 * checklist and gates read, so the gate the rail enforces and the cell being edited cannot disagree
 * about what is about to be filed.
 *
 * One product field is new here rather than inherited: the **omni-channel name** — the secondary name a
 * plan carries on a shelf, in an app or on a partner's portal, while the filing keeps its registered
 * name. A channel or a partner can override it again (`src/core/channels.ts`); this is the product's own
 * answer, and it is a column rather than a dialog because ninety varieties are named in a sitting.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { downloadText, FileInput, GridBar, GridFrame, NumberCell, Pill, RowActions, SelectCell, StatPills, TextCell, useGrid } from './grid';
import { PRODUCT_COLUMNS } from '../core/product-config.js';
import { PRODUCT_CATEGORIES } from '../core/products.js';

/**
 * The draft the section's gate reads. The field names are the ones the master-settings screen has always
 * used, so the checklist, the blockers and the single-product save all keep working over the grid.
 */
export type ProductForm = {
  prodId: string;
  prodName: string;
  prodCat: 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg';
  prodLine: string;
  minAge: number;
  maxAge: number;
  maxBmi: number;
  baseRate: string;
  incomeMultiple: number;
  autoLimit: string;
  facThreshold: string;
  aiLimit: string;
  /** The omni-channel display name; the registered name is shown when this is blank. */
  secondaryName: string;
};

/** The id, under the name this screen's own state has always carried it. */
export const DEFAULT_PRODUCT_FORM: ProductForm = {
  prodId: 'PROD-UL-GLOBAL', prodName: 'Global Unit-Linked Plan', prodCat: 'unit-linked', prodLine: 'life',
  minAge: 18, maxAge: 65, maxBmi: 32, baseRate: '48.00', incomeMultiple: 15,
  autoLimit: '1,000,000.00', facThreshold: '1,500,000.00', aiLimit: '250,000.00',
  secondaryName: '',
};

/** A row of the grid, in the sheet's notation: every cell is a string until it is filed. */
export type ProductDraft = {
  productId: string;
  name: string;
  secondaryName: string;
  category: string;
  line: string;
  minAge: string;
  maxAge: string;
  maxBmi: string;
  baseRatePerThousand: string;
  incomeMultiple: string;
  automaticBindingLimit: string;
  facultativeThreshold: string;
  aiStraightThroughLimit: string;
};

type FiledProduct = WorldSnapshot['erp']['master']['products'][number];

/** Which registry key each column's caption lives under — the sheet's names are not the form's names. */
const LABEL_KEYS: Record<string, string> = {
  productId: 'master.product.id', name: 'master.product.name', secondaryName: 'master.product.secondaryName',
  category: 'master.product.category', line: 'master.product.line', minAge: 'master.product.minAge',
  maxAge: 'master.product.maxAge', maxBmi: 'master.product.maxBmi', baseRatePerThousand: 'master.product.baseRate',
  incomeMultiple: 'master.product.incomeMultiple', automaticBindingLimit: 'master.product.autoLimit',
  facultativeThreshold: 'master.product.facultativeThreshold', aiStraightThroughLimit: 'master.product.aiLimit',
};

/** A page of twenty-five: ninety-six varieties and a mobile screen do not belong in one table. */
export const PRODUCT_PAGE_SIZE = 25;

/** The snapshot prints money labelled ("1,000,000.00 AED"); a cell holds the amount and nothing else. */
function stripAmount(label: string): string {
  return String(label ?? '').replace(/\s*[A-Z]{3}\s*$/, '').trim();
}

export function draftOf(p: FiledProduct): ProductDraft {
  return {
    productId: p.productId,
    name: p.name,
    secondaryName: p.secondaryName ?? '',
    category: p.category,
    line: p.line,
    minAge: String(p.minAge),
    maxAge: String(p.maxAge),
    maxBmi: p.maxBmi === null || p.maxBmi === undefined ? '' : String(p.maxBmi),
    baseRatePerThousand: stripAmount(p.baseRatePerThousand),
    incomeMultiple: p.incomeMultiple === null || p.incomeMultiple === undefined ? '' : String(p.incomeMultiple),
    automaticBindingLimit: stripAmount(p.automaticBindingLimit),
    facultativeThreshold: stripAmount(p.facultativeThreshold),
    aiStraightThroughLimit: stripAmount(p.aiStraightThroughLimit),
  };
}

/** The row in focus, in the shape the gate and the single-product save read. */
export function draftToForm(row: ProductDraft): ProductForm {
  return {
    prodId: row.productId,
    prodName: row.name,
    prodCat: row.category as ProductForm['prodCat'],
    prodLine: row.line,
    minAge: Number(row.minAge) || 0,
    maxAge: Number(row.maxAge) || 0,
    maxBmi: Number(row.maxBmi) || 0,
    baseRate: row.baseRatePerThousand,
    incomeMultiple: Number(row.incomeMultiple) || 0,
    autoLimit: row.automaticBindingLimit,
    facThreshold: row.facultativeThreshold,
    aiLimit: row.aiStraightThroughLimit,
    secondaryName: row.secondaryName,
  };
}

const numeric = (value: string): number | string => {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return '';
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : trimmed;
};

export function toRowInput(row: ProductDraft): Record<string, unknown> {
  return {
    productId: row.productId.trim().toUpperCase(),
    name: row.name.trim(),
    secondaryName: row.secondaryName.trim(),
    category: row.category,
    line: row.line,
    minAge: numeric(row.minAge),
    maxAge: numeric(row.maxAge),
    ...(String(row.maxBmi).trim() === '' ? {} : { maxBmi: numeric(row.maxBmi) }),
    baseRatePerThousand: row.baseRatePerThousand,
    ...(String(row.incomeMultiple).trim() === '' ? {} : { incomeMultiple: numeric(row.incomeMultiple) }),
    automaticBindingLimit: row.automaticBindingLimit,
    facultativeThreshold: row.facultativeThreshold,
    aiStraightThroughLimit: row.aiStraightThroughLimit,
  };
}

/** The client-side half of validation: cells that cannot even be numbers. The rules run in the core. */
export function draftIssues(row: ProductDraft): string[] {
  const issues: string[] = [];
  if (!row.productId.trim()) issues.push('A row needs a Product ID before it can be filed.');
  const ages = /^[0-9]+$/.test(String(row.minAge).trim()) && /^[0-9]+$/.test(String(row.maxAge).trim());
  if (!/^[0-9]+$/.test(String(row.minAge).trim())) issues.push('Age from must be a whole number of years.');
  if (!/^[0-9]+$/.test(String(row.maxAge).trim())) issues.push('Age to must be a whole number of years.');
  if (ages && Number(row.minAge) >= Number(row.maxAge)) issues.push(`An entry range of ${row.minAge}–${row.maxAge} admits nobody.`);
  if (!row.baseRatePerThousand.trim()) issues.push('A rate per 1,000 is required — a product with no tariff cannot be quoted.');
  if (!row.name.trim()) issues.push('A new variety has to be named.');
  return issues;
}

/** The next free copy id for a variety: `-COPY`, `-COPY-2`, … so a copied row never overwrites its source. */
export function copyIdFor(sourceId: string, taken: ReadonlySet<string>): string {
  const stem = sourceId.replace(/-COPY(-\d+)?$/, '').trim().toUpperCase() || 'PROD';
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? `${stem}-COPY` : `${stem}-COPY-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-COPY-${Date.now()}`;
}

export const ProductConfigGrid: React.FC<{
  data: WorldSnapshot;
  busy: boolean;
  /** The section's runner: it shows the spinner, files the call, reloads the world and returns the answer. */
  onRun?: (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
  onFocusRow?: (row: ProductForm) => void;
  label?: (key: string, fallback: string) => string;
}> = ({ data, busy, onRun, onFocusRow, label }) => {
  const run = onRun ?? (async (_label: string, fn: () => Promise<unknown>) => fn());
  const productMasters = data.erp.master.products;
  const productLines = data.erp.master.productLines;
  const localCurrency = data.erp.master.regional.localCurrency;
  const masterLabel = label ?? ((key: string, fallback: string) => data.labels.en[key] ?? fallback);

  const seed = useMemo(() => productMasters.map(draftOf), [productMasters]);
  const grid = useGrid<ProductDraft>(seed, { prefix: 'PROD' });

  const [lineFilter, setLineFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [report, setReport] = useState<{ title: string; body: Record<string, unknown> } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [copyDraft, setCopyDraft] = useState({ source: '', newId: '', newName: '', copyRates: true });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return grid.rows.filter((r) => {
      if (lineFilter !== 'all' && r.data.line !== lineFilter) return false;
      if (!needle) return true;
      return `${r.data.productId} ${r.data.name} ${r.data.secondaryName}`.toLowerCase().includes(needle);
    });
  }, [grid.rows, lineFilter, query]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PRODUCT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = visible.slice(currentPage * PRODUCT_PAGE_SIZE, currentPage * PRODUCT_PAGE_SIZE + PRODUCT_PAGE_SIZE);
  const filedById = useMemo(() => new Map(productMasters.map((p) => [p.productId, p])), [productMasters]);

  const focusRow = grid.rows.find((r) => r.key === focused) ?? shown[0] ?? grid.rows[0];
  const filed = focusRow ? filedById.get(focusRow.data.productId.trim().toUpperCase()) : undefined;

  // The section's gate reads the row in focus, so the checklist and the cell being edited agree.
  useEffect(() => {
    if (focusRow && onFocusRow) onFocusRow(draftToForm(focusRow.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRow?.key, focusRow?.data.productId, focusRow?.data.minAge, focusRow?.data.maxAge, focusRow?.data.baseRatePerThousand, focusRow?.data.secondaryName, focusRow?.data.category]);

  const failuresFrom = (rejected: unknown, sentKeys: string[]): Map<string, readonly string[]> => {
    const failures = new Map<string, readonly string[]>();
    if (Array.isArray(rejected)) {
      for (const item of rejected) {
        const index = Number((item as { index?: number })?.index);
        const reasons = (item as { reasons?: string[] })?.reasons ?? [];
        const key = Number.isInteger(index) ? sentKeys[index] : undefined;
        if (key) failures.set(key, reasons);
      }
    }
    return failures;
  };

  const saveRows = async (keys: string[]) => {
    const byKey = new Map(grid.rows.map((r) => [r.key, r]));
    const sent = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (sent.length === 0) return;
    const broken = new Map<string, readonly string[]>();
    for (const row of sent) {
      const issues = draftIssues(row.data);
      if (issues.length > 0) broken.set(row.key, issues);
    }
    if (broken.size > 0) {
      grid.setErrors(broken);
      setReport({ title: 'Not filed — fix these cells first', body: { refused: [...broken.entries()].map(([key, reasons]) => ({ row: byKey.get(key)?.data.productId ?? key, reasons })) } });
      return;
    }
    const sentKeys = sent.map((r) => r.key);
    const result = await run(`${sent.length} product row${sent.length === 1 ? '' : 's'} filed`, () =>
      api('/master/product/bulk', 'POST', { rows: sent.map((r) => toRowInput(r.data)), by: 'master-settings' }));
    const body = (result ?? {}) as Record<string, unknown>;
    const failures = failuresFrom(body['rejected'], sentKeys);
    grid.markSaved(sentKeys, failures);
    setReport(failures.size > 0 ? { title: 'The grid refused these rows', body } : { title: 'Filed', body });
  };

  const dirtyKeys = grid.rows.filter((r) => r.dirty).map((r) => r.key);
  const pageDirtyKeys = shown.filter((r) => r.dirty).map((r) => r.key);

  const upload = async (csv: string) => {
    const result = await run('product sheet uploaded', () => api('/master/product/import', 'POST', { csv, by: 'bulk-upload' }));
    setReport({ title: 'Bulk upload', body: (result ?? {}) as Record<string, unknown> });
  };

  const download = async (path: string) => {
    try {
      const result = await api<{ filename: string; csv: string }>(path);
      downloadText(result.filename, result.csv);
      setReport({ title: 'Downloaded', body: { file: result.filename, rows: result.csv.split(/\r?\n/).length - 1 } });
    } catch (e) {
      setReport({ title: 'The download failed', body: { error: e instanceof Error ? e.message : String(e) } });
    }
  };

  const copyProduct = async () => {
    const source = copyDraft.source.trim().toUpperCase();
    const productId = copyDraft.newId.trim().toUpperCase();
    if (!source) return;
    if (!productId) {
      setReport({ title: 'Copy a product', body: { error: 'Name the new Product ID first — a copy that keeps its id would overwrite the variety it came from.' } });
      return;
    }
    const result = await run(`${source} copied to ${productId}`, () => api('/master/product/copy', 'POST', {
      sourceProductId: source,
      productId,
      ...(copyDraft.newName.trim() ? { name: copyDraft.newName.trim() } : {}),
      copyRates: copyDraft.copyRates,
      by: 'product-factory-grid',
    }));
    setReport({ title: 'Copied', body: (result ?? {}) as Record<string, unknown> });
    setCopyDraft({ source: '', newId: '', newName: '', copyRates: true });
  };

  const categoryOptions = PRODUCT_CATEGORIES.map((c) => ({ value: c, label: c }));
  const lineOptions = productLines.map((l) => ({ value: l.line, label: `${l.family} · ${l.label}` }));
  const takenIds = new Set(grid.rows.map((r) => r.data.productId.trim().toUpperCase()));

  return (
    <>
      <StatPills items={[
        `${data.erp.master.catalogueSize} varieties on file`,
        [`${productLines.length} lines`, `${new Set(productLines.map((l) => l.family)).size} families`],
        `every amount in ${localCurrency}`,
        [`${grid.dirtyCount} unsaved`, `${visible.length} of ${grid.rows.length} shown`],
        `${grid.errorCount} refused`,
      ]} />

      <GridBar
        right={(
          <>
            <button type="button" disabled={busy || dirtyKeys.length === 0} onClick={() => void saveRows(dirtyKeys)}>
              ⤓ Save all{dirtyKeys.length > 0 ? ` (${dirtyKeys.length})` : ''}
            </button>
            <button type="button" className="ghost" disabled={busy || pageDirtyKeys.length === 0} onClick={() => void saveRows(pageDirtyKeys)}>
              Save this page{pageDirtyKeys.length > 0 ? ` (${pageDirtyKeys.length})` : ''}
            </button>
            <button type="button" className="ghost" disabled={grid.dirtyCount === 0} onClick={() => { grid.reset(); setReport(null); }}>Discard unsaved edits</button>
            <button type="button" className="ghost" onClick={() => void download('/master/product/template')}>⤐ Sample sheet</button>
            <button type="button" className="ghost" onClick={() => void download('/master/product/export')}>⤐ What is on file</button>
            <FileInput label="Upload sheet" busy={busy} onText={(_name, text) => void upload(text)} />
          </>
        )}
      >
        <label className="gfilter">
          {masterLabel('master.product.line', 'Line of business')}
          <select value={lineFilter} onChange={(e) => { setLineFilter(e.target.value); setPage(0); }}>
            <option value="all">All {productLines.length} lines ({productMasters.length} varieties)</option>
            {productLines.map((l) => <option key={l.line} value={l.line}>{l.family} · {l.label} ({l.count})</option>)}
          </select>
        </label>
        <label className="gfilter">
          Find
          <input type="search" value={query} placeholder="product id, name or omni-channel name" onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        </label>
        <span className="muted small gnote">
          Edit any cell · copy a line to start a new variety from an existing one · nothing is filed until you save.
        </span>
      </GridBar>

      <GridFrame caption={`${visible.length} row(s) across ${productLines.length} lines · ${PRODUCT_COLUMNS.length} editable columns · page ${currentPage + 1} of ${pageCount}`}>
        <table className="gridTable">
          <thead>
            <tr>
              <th className="colNum">#</th>
              {PRODUCT_COLUMNS.map((c) => (
                <th key={String(c.key)} title={c.hint}>
                  {masterLabel(LABEL_KEYS[String(c.key)] ?? `master.product.${String(c.key)}`, c.label)}
                  {c.required && <em className="req" title="required">*</em>}
                </th>
              ))}
              <th title="The rating grid filed against this variety, and the age bands it does not cover">Tariff</th>
              <th title="Which partners this product is on sale to, and the name it carries on the shelf">Distribution</th>
              <th className="colActions">Row</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={PRODUCT_COLUMNS.length + 4} className="muted">No variety on this line yet — add a row below the table.</td></tr>}
            {shown.map((row, index) => {
              const onFile = filedById.get(row.data.productId.trim().toUpperCase());
              const issues = [...row.errors, ...(row.dirty ? draftIssues(row.data) : [])];
              const cls = `gridRow${row.dirty ? ' is-dirty' : ''}${row.isNew ? ' is-new' : ''}${issues.length > 0 ? ' is-error' : ''}${focusRow?.key === row.key ? ' is-focused' : ''}`;
              return (
                <tr key={row.key} className={cls} onClick={() => setFocused(row.key)}>
                  <td className="colNum muted">{currentPage * PRODUCT_PAGE_SIZE + index + 1}</td>
                  <td>
                    {row.isNew || issues.length > 0 && !onFile
                      ? <TextCell label="Product ID" value={row.data.productId} dirty={row.dirty} error={issues.length > 0} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { productId: v.toUpperCase() }); }} width={150} />
                      : <span className="cellStatic"><b>{row.data.productId}</b></span>}
                  </td>
                  <td><TextCell label={masterLabel('master.product.name', 'Registered name')} value={row.data.name} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { name: v }); }} width={210} /></td>
                  <td>
                    <TextCell
                      label={masterLabel('master.product.secondaryName', 'Omni-channel name')}
                      placeholder={row.data.name}
                      value={row.data.secondaryName}
                      dirty={row.dirty}
                      onChange={(v) => { setFocused(row.key); grid.patch(row.key, { secondaryName: v }); }}
                      width={190}
                    />
                  </td>
                  <td><SelectCell label="Book" value={row.data.category} options={categoryOptions} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { category: v }); }} /></td>
                  <td><SelectCell label="Line of business" value={row.data.line} options={lineOptions} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { line: v }); }} /></td>
                  <td><NumberCell label="Age from" value={row.data.minAge} dirty={row.dirty} error={issues.length > 0} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { minAge: v }); }} width={62} /></td>
                  <td><NumberCell label="Age to" value={row.data.maxAge} dirty={row.dirty} error={issues.length > 0} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { maxAge: v }); }} width={62} /></td>
                  <td><NumberCell label="Max BMI" value={row.data.maxBmi} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { maxBmi: v }); }} width={62} /></td>
                  <td><TextCell label="Base rate per 1000" value={row.data.baseRatePerThousand} dirty={row.dirty} error={issues.length > 0} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { baseRatePerThousand: v }); }} width={92} /></td>
                  <td><NumberCell label="Income multiple" value={row.data.incomeMultiple} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { incomeMultiple: v }); }} width={62} suffix="×" /></td>
                  <td><TextCell label="Automatic binding limit" value={row.data.automaticBindingLimit} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { automaticBindingLimit: v }); }} width={104} /></td>
                  <td><TextCell label="Facultative threshold" value={row.data.facultativeThreshold} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { facultativeThreshold: v }); }} width={104} /></td>
                  <td><TextCell label="AI straight-through limit" value={row.data.aiStraightThroughLimit} dirty={row.dirty} onChange={(v) => { setFocused(row.key); grid.patch(row.key, { aiStraightThroughLimit: v }); }} width={104} /></td>
                  <td className="cellStack">
                    {onFile
                      ? <>
                        <span className="muted small">{onFile.rateRows ?? 0} rate row(s)</span>
                        {(onFile.rateGaps?.length ?? 0) > 0 ? <Pill tone="warn">{onFile.rateGaps!.length} age hole(s)</Pill> : <Pill tone="ok">ages covered</Pill>}
                      </>
                      : <Pill tone="info">not filed yet</Pill>}
                  </td>
                  <td className="cellStack">
                    <span className="muted small">{onFile?.partners?.length ?? 0} partner(s)</span>
                    {(onFile?.channelNames?.length ?? 0) > 0 ? <Pill tone="info">{onFile!.channelNames!.length} shelf name(s)</Pill> : null}
                  </td>
                  <td className="colActions">
                    <RowActions
                      busy={busy}
                      dirty={row.dirty}
                      errors={issues}
                      onCopy={() => {
                        const newId = copyIdFor(row.data.productId, takenIds);
                        const key = grid.duplicate(row.key, {
                          productId: newId,
                          name: `${row.data.name} (copy)`.slice(0, 90),
                          secondaryName: row.data.secondaryName ? `${row.data.secondaryName} (copy)`.slice(0, 90) : '',
                        });
                        if (key) setFocused(key);
                      }}
                      onSave={() => void saveRows([row.key])}
                      onRemove={row.isNew ? () => grid.remove(row.key) : undefined}
                      onUp={() => grid.move(row.key, -1)}
                      onDown={() => grid.move(row.key, 1)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GridFrame>

      <div className="gridFooter">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => grid.add({
            productId: '', name: '', secondaryName: '', category: 'conventional', line: lineFilter === 'all' ? 'life' : lineFilter,
            minAge: '18', maxAge: '65', maxBmi: '', baseRatePerThousand: '', incomeMultiple: '15',
            automaticBindingLimit: '1,000,000.00', facultativeThreshold: '2,000,000.00', aiStraightThroughLimit: '250,000.00',
          })}
        >
          + Add a product row
        </button>
        <span className="pager">
          <button type="button" className="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹ Previous</button>
          <span className="muted small">page {currentPage + 1} of {pageCount}</span>
          <button type="button" className="ghost" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next ›</button>
        </span>
      </div>

      <div className="subGrid">
        <h4>Copy a filed variety — with or without its tariff</h4>
        <p className="small muted">
          The grid's own <b>Copy line</b> duplicates a row in the draft. This copies it on the server instead, which is the
          difference that matters for a unit-linked plan: a copy taken here brings the whole rating grid with it, so the new
          variety can be quoted from the moment it exists.
        </p>
        <div className="row">
          <label>
            Product to copy
            <select value={copyDraft.source} onChange={(e) => setCopyDraft((t) => ({ ...t, source: e.target.value }))}>
              <option value="">— choose a filed variety —</option>
              {productMasters.map((p) => <option key={p.productId} value={p.productId}>{p.productId} · {p.name}</option>)}
            </select>
          </label>
          <label>
            New product id
            <input value={copyDraft.newId} onChange={(e) => setCopyDraft((t) => ({ ...t, newId: e.target.value.toUpperCase() }))} placeholder={copyDraft.source ? copyIdFor(copyDraft.source, takenIds) : 'PROD-…-COPY'} style={{ width: 200 }} />
          </label>
          <label>
            Its name (blank = the source's, with “(copy)” on the end)
            <input value={copyDraft.newName} onChange={(e) => setCopyDraft((t) => ({ ...t, newName: e.target.value }))} placeholder="Optional" style={{ width: 240 }} />
          </label>
          <label className="checkLabel">
            <input type="checkbox" checked={copyDraft.copyRates} onChange={(e) => setCopyDraft((t) => ({ ...t, copyRates: e.target.checked }))} />
            copy its rating grid too
          </label>
          <button type="button" disabled={busy || !copyDraft.source} onClick={() => void copyProduct()}>⧉ Copy product &amp; tariff</button>
        </div>
      </div>

      {focusRow && filed && (
        <div className="manualCard">
          <b>{filed.name}</b>
          {filed.secondaryName ? <span className="muted"> · shown on the shelf as “{filed.secondaryName}”</span> : <span className="muted"> · no omni-channel name filed, so the registered name shows everywhere</span>}
          <p className="small muted">{filed.blurb}</p>
          <div className="pills">
            <Pill tone="info">{filed.variety}</Pill>
            <Pill tone={filed.category === 'takaful' ? 'ok' : 'info'}>{filed.category}</Pill>
            <Pill tone="info">entry ages {filed.minAge}–{filed.maxAge}</Pill>
            <Pill tone="info">BMI ceiling {filed.maxBmi ?? '—'}</Pill>
            <Pill tone="info">{filed.rateRows ?? 0} tariff row(s)</Pill>
            <Pill tone="info">{filed.partners?.length ?? 0} partner(s)</Pill>
            <Pill tone="info">{filed.entityId} · {filed.currency}</Pill>
          </div>
          {(filed.channelNames?.length ?? 0) > 0 && (
            <ul className="list small">
              {filed.channelNames!.map((c) => (
                <li key={c.channelCode}>
                  {c.channelName}: <b>{c.secondaryName || 'the registered name'}</b>{c.partners > 0 ? ` · ${c.partners} partner(s) on this channel` : ''}
                </li>
              ))}
            </ul>
          )}
          {(filed.rateGaps?.length ?? 0) > 0 && (
            <div className="warnBox small">
              <b>The tariff has holes:</b> {filed.rateGaps!.slice(0, 4).map((g) => `${g.gender} · class ${g.occupationClass || 'all'} · ages ${g.from}–${g.to}`).join('; ')}
              {filed.rateGaps!.length > 4 ? ` and ${filed.rateGaps!.length - 4} more` : ''}. A life at an age with no row cannot be quoted — file the band in the rating tables below.
            </div>
          )}
        </div>
      )}

      {report && (
        <details className="code small" open={false}>
          <summary><b>{report.title}</b> — the grid's own answer, row by row</summary>
          <pre>{JSON.stringify(report.body, null, 2).slice(0, 3000)}</pre>
        </details>
      )}
    </>
  );
};

