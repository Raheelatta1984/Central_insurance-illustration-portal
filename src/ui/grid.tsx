/**
 * The primitives behind every editable table in the console.
 *
 * A master-settings screen that is a *table* needs three things a read-only table never has to get
 * right: the cell you are typing into has to look like the cell it came from, the row that failed to
 * file has to say why inside itself rather than in a banner a page up, and one bad row must never cost
 * you the twenty good ones you also just typed. "Copy this line" is the fourth: nobody prices a new age
 * band from a blank form, they take the band beside it and change one number.
 *
 * So the grid is a draft — local state, dirty-tracked, with the server's refusal written back onto the
 * row it belongs to — and saving is a bulk call that reports per row. Nothing here holds a business
 * rule: what a row has to satisfy is decided in `src/core`, and this file only carries the answer back
 * to the line it was about.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------------ the draft */

export interface GridRow<T> {
  readonly key: string;
  readonly data: T;
  readonly dirty: boolean;
  readonly isNew: boolean;
  readonly errors: readonly string[];
  readonly savedAt: string | null;
}

let rowSeq = 0;
const nextKey = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++rowSeq}`;

export interface GridApi<T> {
  readonly rows: GridRow<T>[];
  readonly dirtyCount: number;
  readonly errorCount: number;
  /**
   * Patch a row's data (a cell edit). The row becomes dirty; nothing is filed by this. Pass
   * `markDirty: false` to adopt a value the server handed back — a new row id, say — without making a
   * row look unsaved the moment it has been saved.
   */
  readonly patch: (key: string, patch: Partial<T>, options?: { markDirty?: boolean }) => void;
  readonly replace: (key: string, data: T) => void;
  /** Copy a row — optionally changing cells on the copy — and return the new row's key. */
  readonly duplicate: (key: string, patch?: Partial<T>) => string | null;
  readonly add: (data: T) => void;
  readonly remove: (key: string) => void;
  readonly move: (key: string, direction: -1 | 1) => void;
  readonly markSaved: (savedKeys: readonly string[], failures: ReadonlyMap<string, readonly string[]>) => void;
  readonly setErrors: (errors: ReadonlyMap<string, readonly string[]>) => void;
  /** Rebuild the draft from the snapshot, dropping unsaved edits on purpose. */
  readonly reset: () => void;
  readonly rowFor: (key: string) => GridRow<T> | undefined;
}

/**
 * The draft itself: rows seeded from the snapshot, tracked until they are saved, and reseeded when the
 * world reloads — except for rows that still hold unsaved edits, which are the operator's work and are
 * not thrown away under them.
 */
export function useGrid<T extends object>(seed: T[], options: { prefix?: string } = {}): GridApi<T> {
  const prefix = options.prefix ?? 'ROW';
  // A signature rather than an identity check: the snapshot is rebuilt on every reload, and a grid that
  // reseeded on each of those would clear the row an operator is halfway through typing into.
  const signature = useMemo(() => JSON.stringify(seed), [seed]);
  const build = useCallback((): GridRow<T>[] => (JSON.parse(signature) as T[]).map((data) => ({
    key: nextKey(prefix), data, dirty: false, isNew: false, errors: [], savedAt: null,
  })), [signature, prefix]);
  const [rows, setRows] = useState<GridRow<T>[]>(build);
  const seededFrom = useRef(signature);

  const reset = useCallback(() => {
    seededFrom.current = signature;
    setRows(build());
  }, [signature, build]);

  useEffect(() => {
    if (seededFrom.current === signature) return;
    seededFrom.current = signature;
    setRows((current) => (current.some((r) => r.dirty) ? current : build()));
  }, [signature, build]);

  const patch = useCallback((key: string, value: Partial<T>, options?: { markDirty?: boolean }) => {
    const markDirty = options?.markDirty !== false;
    setRows((current) => current.map((r) => (r.key === key
      ? { ...r, data: { ...r.data, ...value }, ...(markDirty ? { dirty: true } : {}) }
      : r)));
  }, []);

  const replace = useCallback((key: string, value: T) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, data: value, dirty: true } : r)));
  }, []);

  const duplicate = useCallback((key: string, patch?: Partial<T>) => {
    const copyKey = nextKey(prefix);
    let copied = false;
    setRows((current) => {
      const index = current.findIndex((r) => r.key === key);
      if (index < 0) return current;
      copied = true;
      const source = current[index]!;
      const copy: GridRow<T> = { key: copyKey, data: { ...source.data, ...(patch ?? {}) }, dirty: true, isNew: true, errors: [], savedAt: null };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
    // The key is only meaningful when the copy was actually made; a caller that gets null shows nothing.
    return copied ? copyKey : null;
  }, [prefix]);

  const add = useCallback((value: T) => {
    setRows((current) => [...current, { key: nextKey(prefix), data: value, dirty: true, isNew: true, errors: [], savedAt: null }]);
  }, [prefix]);

  const remove = useCallback((key: string) => {
    setRows((current) => current.filter((r) => r.key !== key));
  }, []);

  const move = useCallback((key: string, direction: -1 | 1) => {
    setRows((current) => {
      const index = current.findIndex((r) => r.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, { ...row!, dirty: true });
      return next;
    });
  }, []);

  /**
   * Close the loop on a bulk save: the rows the server filed stop being dirty, the rows it refused stay
   * dirty and grow the sentence it refused them with. A row nobody mentioned is left exactly as it is —
   * an unlisted row is not a saved row.
   */
  const markSaved = useCallback((savedKeys: readonly string[], failures: ReadonlyMap<string, readonly string[]>) => {
    const saved = new Set(savedKeys);
    setRows((current) => current.map((r) => {
      if (!saved.has(r.key)) return r;
      const errors = failures.get(r.key) ?? [];
      return { ...r, errors, dirty: errors.length > 0, isNew: errors.length > 0 && r.isNew, savedAt: errors.length > 0 ? r.savedAt : new Date().toISOString() };
    }));
  }, []);

  const setErrors = useCallback((failures: ReadonlyMap<string, readonly string[]>) => {
    setRows((current) => current.map((r) => ({ ...r, errors: failures.get(r.key) ?? r.errors })));
  }, []);

  const rowFor = useCallback((key: string) => rows.find((r) => r.key === key), [rows]);

  return {
    rows,
    dirtyCount: rows.filter((r) => r.dirty).length,
    errorCount: rows.filter((r) => r.errors.length > 0).length,
    patch, replace, duplicate, add, remove, move, markSaved, setErrors, reset, rowFor,
  };
}

/* ------------------------------------------------------------------ the cells */

/** The tone-coloured pill every console panel already uses, kept here so a grid needs one import. */
export const Pill: React.FC<{ tone?: 'ok' | 'warn' | 'bad' | 'info'; children: React.ReactNode }> = ({ tone = 'info', children }) => (
  <span className={`pill ${tone}`}>{children}</span>
);

const cellClass = (dirty: boolean, error: boolean, extra = '') => `gcell ${dirty ? 'is-dirty' : ''}${error ? ' is-error' : ''} ${extra}`.trim();

export const TextCell: React.FC<{
  value: string; onChange: (v: string) => void; label: string; dirty?: boolean; error?: boolean;
  placeholder?: string; maxLength?: number; width?: number;
}> = ({ value, onChange, label, dirty, error, placeholder, maxLength, width }) => (
  <input
    type="text"
    className={cellClass(!!dirty, !!error, 'cellText')}
    style={width ? { width } : undefined}
    value={value}
    placeholder={placeholder}
    maxLength={maxLength}
    aria-label={label}
    onChange={(e) => onChange(e.target.value)}
  />
);

export const NumberCell: React.FC<{
  value: string | number; onChange: (v: string) => void; label: string; dirty?: boolean; error?: boolean;
  step?: string; min?: number; max?: number; width?: number; suffix?: string;
}> = ({ value, onChange, label, dirty, error, step, min, max, width, suffix }) => (
  <span className={cellClass(!!dirty, !!error, suffix ? 'withSuffix' : 'plain')}>
    <input
      type="number"
      className="cellNumber"
      style={width ? { width } : undefined}
      value={String(value ?? '')}
      step={step}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    />
    {suffix && <em>{suffix}</em>}
  </span>
);

export const SelectCell: React.FC<{
  value: string; onChange: (v: string) => void; label: string; options: ReadonlyArray<{ value: string; label: string }>;
  dirty?: boolean; error?: boolean;
}> = ({ value, onChange, label, options, dirty, error }) => (
  <select
    className={cellClass(!!dirty, !!error, 'cellSelect')}
    value={options.some((o) => o.value === value) ? value : ''}
    aria-label={label}
    onChange={(e) => onChange(e.target.value)}
  >
    {!options.some((o) => o.value === value) && <option value={value}>{value || '—'}</option>}
    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

/** A read-only cell in an editable grid: computed, filed elsewhere, or an id that must not be retyped. */
export const StaticCell: React.FC<{ children: React.ReactNode; muted?: boolean }> = ({ children, muted }) => (
  <span className={`cellStatic ${muted ? 'muted' : ''}`}>{children}</span>
);

/** The row's own actions: save what changed, copy it, drop it. Errors read out under the row. */
export const RowActions: React.FC<{
  onCopy?: () => void; onSave?: () => void; onRemove?: () => void; onUp?: () => void; onDown?: () => void;
  busy?: boolean; canCopy?: boolean; canRemove?: boolean; copyLabel?: string; saveLabel?: string;
  dirty?: boolean; errors?: readonly string[];
}> = ({ onCopy, onSave, onRemove, onUp, onDown, busy, canCopy = true, canRemove = true, copyLabel = '⧉ Copy line', saveLabel = 'Save', dirty, errors = [] }) => (
  <span className="rowActions">
    {errors.length > 0 && <span className="rowError" title={errors.join(' ')}>⚠ {errors[0]}</span>}
    {onUp && <button type="button" className="ghost iconBtn" onClick={onUp} aria-label="Move row up">↑</button>}
    {onDown && <button type="button" className="ghost iconBtn" onClick={onDown} aria-label="Move row down">↓</button>}
    {onCopy && <button type="button" className="ghost iconBtn" disabled={!canCopy || busy} onClick={onCopy} aria-label="Copy this line into a new row" title="Copy this line, then change the one cell that differs">{copyLabel}</button>}
    {onSave && <button type="button" disabled={!dirty || busy} onClick={onSave}>{saveLabel}</button>}
    {onRemove && <button type="button" className="ghost iconBtn" disabled={!canRemove || busy} onClick={onRemove} aria-label="Remove this row">✕</button>}
  </span>
);

/* ------------------------------------------------------------------ the chrome around the table */

export const GridBar: React.FC<{
  children?: React.ReactNode; right?: React.ReactNode;
}> = ({ children, right }) => (
  <div className="gbar">
    <div className="gbarLeft">{children}</div>
    {right && <div className="gbarRight">{right}</div>}
  </div>
);

/**
 * A wide grid on a narrow screen scrolls sideways inside its own box, with its header pinned. The caption
 * sits outside the scroller on purpose: it is where the page count and the "swipe sideways" hint belong,
 * and neither is any use once you have scrolled past it.
 */
export const GridFrame: React.FC<{ children: React.ReactNode; caption?: string; footer?: React.ReactNode }> = ({ children, caption, footer }) => (
  <div className="gframe">
    {caption && (
      <p className="gcaption muted small">
        <span className="gscrollHint">Scroll the table sideways · </span>
        {caption}
      </p>
    )}
    <div className="gframeScroll">{children}</div>
    {footer}
  </div>
);

export const FileInput: React.FC<{ label: string; accept?: string; onText: (filename: string, text: string) => void; busy?: boolean }> = ({ label, accept = '.csv,text/csv,text/plain', onText, busy }) => {
  const [name, setName] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <span className="fileInput">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="fileHidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setName(file.name);
          const text = await file.text();
          onText(file.name, text);
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
      <button type="button" className="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
        ⤒ {label}
      </button>
      {name && <span className="muted small">{name}</span>}
    </span>
  );
};

/**
 * A file download that works the same in a browser and in a server render: the caller hands over the
 * text, and the browser decides what to do with it. Nothing is fetched from another origin, which is
 * what lets the static bundle on Vercel ship the same templates as the API server.
 */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A result line that reads as a sentence and shows the payload when an operator wants to see it. */
export const RunNotice: React.FC<{ notice: string | null; error: string | null; busy?: boolean }> = ({ notice, error, busy }) => (
  <>
    {busy && <p className="small muted" role="status">Filing…</p>}
    {error && <div className="errorBox small"><b>Refused:</b> {error}</div>}
    {notice && <div className="okBox small">{notice}</div>}
  </>
);

/**
 * Every panel that writes needs the same three states and the same discipline: one call at a time, the
 * world reloaded after it, the answer kept where the operator is looking.
 */
export function useRunner(onReload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      await onReload();
      setNotice(typeof result === 'object' && result !== null ? `${label} — ${summarise(result)}` : `${label}: ${String(result ?? 'done')}`);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [onReload]);
  return { busy, notice, error, run, setNotice, setError };
}

/** A short, readable summary of a bulk result, so the notice is a sentence rather than a wall of JSON. */
export function summarise(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? 'done');
  const body = result as Record<string, unknown>;
  const parts: string[] = [];
  const order = ['saved', 'created', 'updated', 'applied', 'replaced', 'cleared', 'read', 'copiedRateRows', 'rows'];
  for (const key of order) if (typeof body[key] === 'number') parts.push(`${body[key]} ${key}`);
  const rejected = Array.isArray(body['rejected']) ? body['rejected'].length : Array.isArray(body['sheetRejected']) ? body['sheetRejected'].length : 0;
  if (rejected > 0) parts.push(`${rejected} refused`);
  if (typeof body['productId'] === 'string') parts.push(body['productId'] as string);
  if (typeof body['partnerId'] === 'string') parts.push(body['partnerId'] as string);
  if (typeof body['filename'] === 'string') parts.push(body['filename'] as string);
  return parts.length > 0 ? parts.join(' · ') : JSON.stringify(result).slice(0, 240);
}

/** A compact pill list, since a grid's headroom is the table, not a paragraph. */
export const StatPills: React.FC<{ items: ReadonlyArray<string | [string, React.ReactNode]> }> = ({ items }) => {
  const pills = useMemo(() => items.map((item, i) => {
    if (typeof item === 'string') return <span key={i} className="pill info">{item}</span>;
    const [label, value] = item;
    return <span key={`${i}-${label}`} className="pill info">{label}: <b>{value}</b></span>;
  }), [items]);
  return <div className="pills">{pills}</div>;
};
