/**
 * The rating tables: a product's price, by age band, gender, occupational rank and sum assured — and the
 * unit-linked cost of insurance beside it.
 *
 * The product grid above says a variety exists and what its standard-life tariff is. This is where the
 * tariff becomes a grid: rows an actuary files, bands they copy and taper, and the bulk sheet they upload
 * ninety products' worth of them in one sitting. Two kinds of row live here, and the difference between
 * them is the difference between a premium and a promise:
 *
 *  - `premium` is what a year of cover costs per 1,000 of sum assured;
 *  - `mortality` is what the unit-linked cost of insurance deducts per 1,000 of sum assured **per month**,
 *    which is the figure a long illustration is actually sensitive to — age, sex and occupational rank
 *    move it every policy month, so a flat number cannot tell the truth about it.
 *
 * Everything the grid can do the API can do, and the sample sheet the screen downloads is the same file
 * the engine parses back: the template carries this tenant's own product ids, currency and entry ages, and
 * the rows it demonstrates are rows the importer would accept. A file with a dirty line in it has the dirty
 * line refused, in words, with the row number — and the clean rows filed anyway, because a tariff is
 * never worth re-typing because of one inverted age band.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { downloadText, FileInput, GridBar, GridFrame, NumberCell, Pill, RowActions, SelectCell, StatPills, TextCell, useGrid } from './grid';

type RateDraft = {
  rowId: string;
  productId: string;
  kind: string;
  gender: string;
  ageFrom: string;
  ageTo: string;
  occupationClass: string;
  sumFrom: string;
  sumTo: string;
  channelCode: string;
  partnerId: string;
  ratePerThousand: string;
  currency: string;
  note: string;
};

type FiledRate = WorldSnapshot['erp']['master']['rating']['rows'][number];

const PAGE_SIZE = 25;
const GENDERS = [{ value: 'unisex', label: 'Unisex' }, { value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }];
const KINDS = [{ value: 'premium', label: 'Premium · per year' }, { value: 'mortality', label: 'Mortality · per month' }];
const CLASSES = [
  { value: '0', label: '0 — every class' },
  { value: '1', label: '1 — professional / clerical' },
  { value: '2', label: '2 — light manual' },
  { value: '3', label: '3 — trades / driving' },
  { value: '4', label: '4 — heavy / height / security' },
  { value: '5', label: '5 — underground / offshore / crew' },
];

const stripAmount = (label: string): string => String(label ?? '').replace(/\s*[A-Z]{3}\s*$/, '').trim();

function rateDraft(p: FiledRate): RateDraft {
  return {
    rowId: p.rowId,
    productId: p.productId,
    kind: p.kind,
    gender: p.gender,
    ageFrom: String(p.ageFrom),
    ageTo: String(p.ageTo),
    occupationClass: String(p.occupationClass),
    sumFrom: stripAmount(p.sumFrom),
    sumTo: p.sumTo === null || p.sumTo === undefined ? '' : stripAmount(p.sumTo),
    channelCode: p.channelCode ?? '',
    partnerId: p.partnerId ?? '',
    ratePerThousand: stripAmount(p.ratePerThousand),
    currency: p.currency,
    note: p.note ?? '',
  };
}

function ratePayload(row: RateDraft): Record<string, unknown> {
  return {
    ...(row.rowId ? { rowId: row.rowId } : {}),
    productId: row.productId,
    kind: row.kind,
    gender: row.gender,
    ageFrom: row.ageFrom,
    ageTo: row.ageTo,
    occupationClass: row.occupationClass,
    sumFrom: row.sumFrom || '0.00',
    ...(row.sumTo.trim() === '' ? { sumTo: null } : { sumTo: row.sumTo }),
    channelCode: row.channelCode.trim() === '' ? null : row.channelCode.trim().toUpperCase(),
    partnerId: row.partnerId.trim() === '' ? null : row.partnerId.trim().toUpperCase(),
    ratePerThousand: row.ratePerThousand,
    ...(row.currency.trim() === '' ? {} : { currency: row.currency.trim().toUpperCase() }),
    note: row.note,
  };
}

function rowIssues(row: RateDraft): string[] {
  const issues: string[] = [];
  if (!row.productId.trim()) issues.push('A rate row has to be filed against a product.');
  if (!/^[0-9]+$/.test(row.ageFrom.trim()) || !/^[0-9]+$/.test(row.ageTo.trim())) issues.push('Both ages must be whole numbers of years.');
  else if (Number(row.ageFrom) > Number(row.ageTo)) issues.push(`An age band of ${row.ageFrom}–${row.ageTo} admits nobody.`);
  if (!/^-?[0-9,]*(\.?[0-9]{1,4})?$/.test(row.ratePerThousand.trim()) || row.ratePerThousand.trim() === '') {
    issues.push('The rate is a decimal money amount per 1,000 of sum assured — a percentage or a bare word will not file.');
  }
  if (row.partnerId.trim() && !row.channelCode.trim()) issues.push('A partner row has to name the channel that partner sells through.');
  return issues.filter((i) => i.length > 0);
}

export const RatingTablesPanel: React.FC<{
  data: WorldSnapshot;
  busy: boolean;
  onRun: (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
  /** Open the grid on this product. The product shelf hands over the row it has selected. */
  productId?: string;
  onPickProduct?: (productId: string) => void;
}> = ({ data, busy, onRun, productId: wanted, onPickProduct }) => {
  const rows = data.erp.master.rating.rows;
  const stats = data.erp.master.rating.stats;
  const products = data.erp.master.products;
  const channels = data.erp.master.channels;
  const [ownProductId, setOwnProductId] = useState(() => stats.byProduct[0]?.productId ?? products[0]?.productId ?? 'PROD-UL-GLOBAL');
  const productId = wanted && products.some((p) => p.productId === wanted) ? wanted : ownProductId;
  const pickProduct = (next: string) => { setOwnProductId(next); onPickProduct?.(next); setPage(0); };
  const [kindFilter, setKindFilter] = useState<'all' | 'premium' | 'mortality'>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'base' | 'scoped'>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [report, setReport] = useState<{ title: string; body: Record<string, unknown> } | null>(null);
  const [diagnostics, setDiagnostics] = useState<{ gaps: unknown[]; overlaps: unknown[] } | null>(null);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [paste, setPaste] = useState('');
  const [probe, setProbe] = useState({ age: '34', gender: 'female', occupationClass: '2', sumAssured: '150,000.00', kind: 'premium', partnerId: '' });
  const [probeResult, setProbeResult] = useState<Record<string, unknown> | null>(null);

  const seed = useMemo(() => rows.map(rateDraft), [rows]);
  const grid = useGrid<RateDraft>(seed, { prefix: 'RATE' });

  const selectedProduct = products.find((p) => p.productId === productId);
  const visible = useMemo(() => grid.rows.filter((r) => {
    if (r.data.productId !== productId) return false;
    if (kindFilter !== 'all' && r.data.kind !== kindFilter) return false;
    if (scopeFilter === 'base' && (r.data.channelCode || r.data.partnerId)) return false;
    if (scopeFilter === 'scoped' && !r.data.channelCode && !r.data.partnerId) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${r.data.ageFrom}-${r.data.ageTo} ${r.data.gender} ${r.data.note} ${r.data.channelCode} ${r.data.partnerId}`.toLowerCase().includes(needle);
  }), [grid.rows, productId, kindFilter, scopeFilter, query]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = visible.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  // What the tariff on this product does not answer: the holes and the pairs that disagree.
  useEffect(() => {
    let cancelled = false;
    api<{ gaps: unknown[]; overlaps: unknown[] }>(`/master/rates?productId=${encodeURIComponent(productId)}&kind=${kindFilter === 'all' ? 'premium' : kindFilter}`)
      .then((result) => { if (!cancelled) setDiagnostics({ gaps: result.gaps, overlaps: result.overlaps }); })
      .catch(() => { if (!cancelled) setDiagnostics(null); });
    return () => { cancelled = true; };
  }, [productId, kindFilter]);

  const saveRows = async (keys: string[]) => {
    const byKey = new Map(grid.rows.map((r) => [r.key, r]));
    const sent = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (sent.length === 0) return;
    const broken = new Map<string, readonly string[]>();
    for (const row of sent) {
      const issues = rowIssues(row.data);
      if (issues.length > 0) broken.set(row.key, issues);
    }
    if (broken.size > 0) { grid.setErrors(broken); return; }
    const sentKeys = sent.map((r) => r.key);
    const result = await onRun(`${sent.length} rate row${sent.length === 1 ? '' : 's'} filed`, () =>
      api('/master/rates/bulk', 'POST', { rows: sent.map((r) => ratePayload(r.data)), by: 'master-settings' }));
    const body = (result ?? {}) as Record<string, unknown>;
    const rejected = Array.isArray(body['refusedRows']) ? (body['refusedRows'] as Array<{ index: number; reasons: string[] }>) : [];
    const failures = new Map<string, readonly string[]>();
    for (const item of rejected) {
      const key = sentKeys[Number(item.index)];
      if (key) failures.set(key, item.reasons ?? []);
    }
    grid.markSaved(sentKeys, failures);
    if (rejected.length === 0) {
      // The rows the engine filed carry their own ids: adopt them into the draft, so the next save
      // updates the row that is on file instead of adding a twin beside it.
      const filed = Array.isArray(body['rows']) ? (body['rows'] as Array<{ rowId: string }>) : [];
      filed.forEach((row, i) => {
        const key = sentKeys[i];
        if (key && row.rowId) grid.patch(key, { rowId: row.rowId }, { markDirty: false });
      });
      setReport({ title: 'Tariff filed', body: { saved: body['saved'], rows: body['count'] } });
    } else {
      setReport({ title: 'The tariff refused these rows', body });
    }
  };

  const removeRow = async (rowId: string) => {
    await onRun(`${rowId} withdrawn`, () => api('/master/rates/delete', 'POST', { rowId, by: 'master-settings' }));
  };

  const upload = async (csv: string) => {
    const result = await onRun('tariff uploaded', () => api('/master/rates/import', 'POST', { csv, mode, by: 'bulk-upload' }));
    setReport({ title: `Bulk upload (${mode})`, body: (result ?? {}) as Record<string, unknown> });
  };

  const download = async (path: string) => {
    try {
      const result = await api<{ filename: string; csv: string }>(path);
      downloadText(result.filename, result.csv);
      setReport({ title: 'Downloaded', body: { file: result.filename, rows: Math.max(0, result.csv.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('#')).length - 1) } });
    } catch (e) {
      setReport({ title: 'The download failed', body: { error: e instanceof Error ? e.message : String(e) } });
    }
  };

  const runProbe = async () => {
    const result = await onRun('risk priced from the tariff', () => api('/master/rates/price', 'POST', {
      productId,
      age: Number(probe.age) || 0,
      gender: probe.gender,
      occupationClass: Number(probe.occupationClass) || 0,
      sumAssured: probe.sumAssured,
      kind: probe.kind,
      ...(probe.partnerId.trim() ? { partnerId: probe.partnerId.trim().toUpperCase() } : {}),
    }));
    setProbeResult((result ?? {}) as Record<string, unknown>);
  };

  const dirty = grid.rows.filter((r) => r.dirty && r.data.productId === productId).map((r) => r.key);

  return (
    <>
      <StatPills items={[
        `${stats.rows} row(s) on file`,
        `${stats.productsCovered} of ${products.length} products priced by band`,
        `${stats.premiumRows} premium · ${stats.mortalityRows} mortality`,
        [`${stats.channelRows} channel-specific`, `${stats.partnerRows} partner-specific`],
        `${grid.dirtyCount} unsaved`,
      ]} />

      <GridBar
        right={(
          <>
            <button type="button" disabled={busy || dirty.length === 0} onClick={() => void saveRows(dirty)}>
              ⤓ Save tariff{dirty.length > 0 ? ` (${dirty.length})` : ''}
            </button>
            <button type="button" className="ghost" onClick={() => void download(`/master/rates/template?products=${encodeURIComponent(productId)}`)}>⤐ Rate sample template</button>
            <button type="button" className="ghost" onClick={() => void download(`/master/rates/export?productId=${encodeURIComponent(productId)}`)}>⤐ Export this product</button>
            <button type="button" className="ghost" onClick={() => void download('/master/rates/export')}>⤐ Export every tariff</button>
            <FileInput label="Bulk upload" busy={busy} onText={(_n, text) => void upload(text)} />
          </>
        )}
      >
        <label className="gfilter">
          Product
          <select value={productId} onChange={(e) => pickProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.productId} · {p.name} ({p.rateRows ?? 0} row{p.rateRows === 1 ? '' : 's'})
              </option>
            ))}
          </select>
        </label>
        <label className="gfilter">
          Rate type
          <select value={kindFilter} onChange={(e) => { setKindFilter(e.target.value as 'all' | 'premium' | 'mortality'); setPage(0); }}>
            <option value="all">Both kinds</option>
            <option value="premium">Premium only (annual, per 1,000)</option>
            <option value="mortality">Mortality / cost of insurance only (monthly, per 1,000)</option>
          </select>
        </label>
        <label className="gfilter">
          Scope
          <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as 'all' | 'base' | 'scoped')}>
            <option value="all">Base tariff and every override</option>
            <option value="base">Base tariff only</option>
            <option value="scoped">Channel and partner overrides only</option>
          </select>
        </label>
        <label className="gfilter">
          Find
          <input type="search" value={query} placeholder="ages, gender, note, channel" onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        </label>
      </GridBar>

      {selectedProduct && (
        <div className="pills tariffHead">
          <Pill tone="info">{selectedProduct.category}</Pill>
          <Pill tone="info">entry ages {selectedProduct.minAge}–{selectedProduct.maxAge}</Pill>
          <Pill tone="info">base rate {selectedProduct.baseRatePerThousand}</Pill>
          {(selectedProduct.category === 'unit-linked' || selectedProduct.category === 'takaful')
            ? <Pill tone="ok">mortality charged monthly from this grid</Pill>
            : <Pill tone="warn">not a unit-linked book: no monthly cost of insurance is deducted</Pill>}
          {kindFilter === 'mortality' || kindFilter === 'all'
            ? <Pill tone="info">{selectedProduct.rateRows ?? 0} row(s) filed</Pill>
            : null}
        </div>
      )}

      <GridFrame caption={`${visible.length} row(s) on ${productId}${kindFilter === 'all' ? '' : ` · ${kindFilter}`} · page ${currentPage + 1} of ${pageCount}`}>
        <table className="gridTable rateTable">
          <thead>
            <tr>
              <th title="The row the engine holds; a blank one is a row nobody has filed yet">Row</th>
              <th title="male / female rows beat unisex rows for the same band">Gender</th>
              <th title="inclusive">Age from</th>
              <th title="inclusive">Age to</th>
              <th title="0 prices every rank; 1-5 that rank only">Occ. rank</th>
              <th title="inclusive">Sum assured from</th>
              <th title="exclusive; blank means and above">Sum assured to</th>
              <th title="blank is the base tariff every channel reads">Channel</th>
              <th title="blank is not partner-specific">Partner</th>
              <th title="decimal money per 1,000 of sum assured: per year for premium, per month for mortality">Rate per 1000 *</th>
              <th title="the currency the rate is quoted in">Cur.</th>
              <th>Type</th>
              <th className="colNote">Note</th>
              <th className="colActions">Row</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={14} className="muted">
                  No {kindFilter === 'all' ? 'tariff' : kindFilter} rows for {productId} on this page — add one, or upload the sample sheet.
                </td>
              </tr>
            )}
            {shown.map((row, index) => {
              const issues = [...row.errors, ...(row.dirty ? rowIssues(row.data) : [])];
              const cls = `gridRow${row.dirty ? ' is-dirty' : ''}${row.isNew ? ' is-new' : ''}${issues.length > 0 ? ' is-error' : ''}`;
              const patch = (value: Partial<RateDraft>) => grid.patch(row.key, value);
              return (
                <tr key={row.key} className={cls}>
                  <td className="colNum muted">{currentPage * PAGE_SIZE + index + 1} · {row.data.rowId || 'new'}</td>
                  <td><SelectCell label="Gender" value={row.data.gender} options={GENDERS} dirty={row.dirty} onChange={(v) => patch({ gender: v })} /></td>
                  <td><NumberCell label="Age from" value={row.data.ageFrom} dirty={row.dirty} error={issues.length > 0} onChange={(v) => patch({ ageFrom: v })} width={58} /></td>
                  <td><NumberCell label="Age to" value={row.data.ageTo} dirty={row.dirty} error={issues.length > 0} onChange={(v) => patch({ ageTo: v })} width={58} /></td>
                  <td><SelectCell label="Occupation class" value={row.data.occupationClass} options={CLASSES} dirty={row.dirty} onChange={(v) => patch({ occupationClass: v })} /></td>
                  <td><TextCell label="Sum assured from" value={row.data.sumFrom} dirty={row.dirty} onChange={(v) => patch({ sumFrom: v })} width={92} /></td>
                  <td><TextCell label="Sum assured to" value={row.data.sumTo} placeholder="and above" dirty={row.dirty} onChange={(v) => patch({ sumTo: v })} width={92} /></td>
                  <td>
                    <select className="gcell cellSelect" value={row.data.channelCode} aria-label="Channel" onChange={(e) => patch({ channelCode: e.target.value })}>
                      <option value="">base tariff</option>
                      {channels.channels.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                      {row.data.channelCode && !channels.channels.some((c) => c.code === row.data.channelCode) && <option value={row.data.channelCode}>{row.data.channelCode}</option>}
                    </select>
                  </td>
                  <td>
                    <select className="gcell cellSelect" value={row.data.partnerId} aria-label="Partner" onChange={(e) => patch({ partnerId: e.target.value })}>
                      <option value="">any partner</option>
                      {channels.partners.map((p) => <option key={p.partnerId} value={p.partnerId}>{p.partnerId}</option>)}
                      {row.data.partnerId && !channels.partners.some((p) => p.partnerId === row.data.partnerId) && <option value={row.data.partnerId}>{row.data.partnerId}</option>}
                    </select>
                  </td>
                  <td><TextCell label="Rate per 1000" value={row.data.ratePerThousand} dirty={row.dirty} error={issues.length > 0} onChange={(v) => patch({ ratePerThousand: v })} width={92} /></td>
                  <td><span className="cellStatic">{row.data.currency}</span></td>
                  <td><SelectCell label="Rate type" value={row.data.kind} options={KINDS} dirty={row.dirty} onChange={(v) => patch({ kind: v })} /></td>
                  <td className="colNote"><TextCell label="Note" value={row.data.note} dirty={row.dirty} onChange={(v) => patch({ note: v })} width={220} /></td>
                  <td className="colActions">
                    <RowActions
                      busy={busy}
                      dirty={row.dirty}
                      errors={issues}
                      copyLabel="⧉ Copy band"
                      onCopy={() => {
                        grid.duplicate(row.key, { rowId: '', ageFrom: row.data.ageTo, ageTo: String(Math.min(120, Number(row.data.ageTo) + 5)), note: `Copied from ${row.data.rowId || 'the row above'}` });
                      }}
                      onSave={() => void saveRows([row.key])}
                      onRemove={() => {
                        if (row.data.rowId && !row.isNew) void removeRow(row.data.rowId);
                        else grid.remove(row.key);
                      }}
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
            rowId: '', productId, kind: kindFilter === 'mortality' ? 'mortality' : 'premium', gender: 'unisex',
            ageFrom: String(selectedProduct?.minAge ?? 18), ageTo: String(selectedProduct?.maxAge ?? 65),
            occupationClass: '0', sumFrom: '0.00', sumTo: '', channelCode: '', partnerId: '',
            ratePerThousand: '', currency: localCurrencyOf(data), note: '',
          })}
        >
          + Add a rate row to {productId}
        </button>
        <span className="pager">
          <button type="button" className="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹ Previous</button>
          <span className="muted small">page {currentPage + 1} of {pageCount}</span>
          <button type="button" className="ghost" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next ›</button>
        </span>
        <button type="button" className="ghost" disabled={busy || shown.filter((r) => r.dirty).length === 0} onClick={() => void saveRows(shown.filter((r) => r.dirty).map((r) => r.key))}>
          Save this page ({shown.filter((r) => r.dirty).length})
        </button>
      </div>

      <div className="subGrid">
        <h4>Bulk upload — the sheet, or a paste from a spreadsheet</h4>
        <p className="small muted">
          Download the sample, fill it in, upload it back. <b>Append</b> files the rows it holds on top of what is on file;
          <b> replace</b> first clears every row of each product the file names, so the file <i>is</i> that product's tariff.
          Rows are matched on product, type, gender, both ages, rank, sum band and scope: a row that names an existing one updates it.
        </p>
        <div className="row">
          <label className="checkLabel">
            <input type="radio" name="rate-mode" checked={mode === 'append'} onChange={() => setMode('append')} /> append to the tariff
          </label>
          <label className="checkLabel">
            <input type="radio" name="rate-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> replace each product's tariff
          </label>
          <button type="button" disabled={busy || paste.trim() === ''} onClick={() => void upload(paste)}>⤒ Upload these rows</button>
        </div>
        <textarea
          aria-label="Rate rows, pasted from a spreadsheet"
          value={paste}
          placeholder={'Product ID,Rate type,Gender,Age from,Age to,Occupation class,Sum assured from,Sum assured to,Channel,Partner,Rate per 1000,Currency,Note\r\nPROD-UL-GLOBAL,premium,unisex,18,25,0,0,,,,24.50,AED,Youth band'}
          onChange={(e) => setPaste(e.target.value)}
        />
      </div>

      <div className="subGrid">
        <h4>Price a life from this tariff</h4>
        <p className="small muted">
          The same lookup the quote engine uses: the most specific row that covers the life wins, and the answer says which row
          it was and what lost to it. Change a band above and re-run it to see the price move.
        </p>
        <div className="row">
          <label>Age<input type="number" value={probe.age} aria-label="Probe age" onChange={(e) => setProbe({ ...probe, age: e.target.value })} style={{ width: 70 }} /></label>
          <label>
            Gender
            <select value={probe.gender} aria-label="Probe gender" onChange={(e) => setProbe({ ...probe, gender: e.target.value })}>
              {GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </label>
          <label>
            Occupation rank
            <select value={probe.occupationClass} aria-label="Probe occupation class" onChange={(e) => setProbe({ ...probe, occupationClass: e.target.value })}>
              {CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label>Sum assured<input value={probe.sumAssured} aria-label="Probe sum assured" onChange={(e) => setProbe({ ...probe, sumAssured: e.target.value })} style={{ width: 130 }} /></label>
          <label>
            Kind
            <select value={probe.kind} aria-label="Probe rate type" onChange={(e) => setProbe({ ...probe, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          <label>Partner (optional)<input value={probe.partnerId} aria-label="Probe partner" placeholder="GULF-BROKERS" onChange={(e) => setProbe({ ...probe, partnerId: e.target.value.toUpperCase() })} style={{ width: 150 }} /></label>
          <button type="button" disabled={busy} onClick={() => void runProbe()}>Price it</button>
        </div>
        {probeResult && (
          <div className="code small">
            <pre>{JSON.stringify(probeResult, null, 2).slice(0, 1400)}</pre>
          </div>
        )}
      </div>

      {diagnostics && (
        <div className="subGrid">
          <h4>What this tariff does not answer</h4>
          <div className="pills">
            <Pill tone={diagnostics.gaps.length > 0 ? 'warn' : 'ok'}>{diagnostics.gaps.length} uncovered age band group(s)</Pill>
            <Pill tone={diagnostics.overlaps.length > 0 ? 'bad' : 'ok'}>{diagnostics.overlaps.length} overlapping row pair(s)</Pill>
          </div>
          {Array.isArray(diagnostics.gaps) && diagnostics.gaps.length > 0 && (
            <ul className="list small">
              {(diagnostics.gaps as Array<{ gender: string; occupationClass: number; gaps: Array<{ from: number; to: number }> }>).slice(0, 8).map((g, i) => (
                <li key={`${g.gender}-${g.occupationClass}-${i}`}>
                  {g.gender} · class {g.occupationClass || 'all'}: {g.gaps.map((gap) => `${gap.from}–${gap.to}`).join(', ')}
                </li>
              ))}
            </ul>
          )}
          {Array.isArray(diagnostics.overlaps) && diagnostics.overlaps.length > 0 && (
            <div className="warnBox small">
              {(diagnostics.overlaps as Array<{ why: string }>).slice(0, 5).map((o, i) => <div key={i}>{o.why}</div>)}
            </div>
          )}
        </div>
      )}

      {report && (
        <details className="code small" open={false}>
          <summary><b>{report.title}</b> — the tariff's own answer, row by row</summary>
          <pre>{JSON.stringify(report.body, null, 2).slice(0, 3000)}</pre>
        </details>
      )}
    </>
  );
};

function localCurrencyOf(data: WorldSnapshot): string {
  return data.erp.master.regional.localCurrency;
}
