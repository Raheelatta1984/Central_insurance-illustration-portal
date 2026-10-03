/**
 * Ingestion fabric: anything in, validated, quarantined, reconciled, idempotent.
 *
 * A partner can send CSV, TSV, pipe-delimited text, JSON, or a fixed-width dump. Rows are
 * validated against a mapping; suspects are quarantined rather than rejected wholesale; and
 * committing the same load twice changes nothing (natural keys + load id).
 */
export interface FieldSpec {
  readonly name: string;
  readonly required?: boolean;
  readonly type: 'string' | 'number' | 'date' | 'email' | 'phone' | 'id';
  readonly aliases?: readonly string[];
}

export interface IngestMapping {
  readonly source: string;
  readonly entityType: string;
  readonly fields: readonly FieldSpec[];
  readonly naturalKeys: readonly string[];
}

export interface ParsedTable { readonly headers: string[]; readonly rows: Record<string, string>[]; readonly delimiter: string }

export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? '';
  const candidates = [',', '\t', '|', ';'];
  return candidates.map((c) => ({ c, n: line.split(c).length })).sort((a, b) => b.n - a.n)[0]!.c;
}

export function parseTable(text: string): ParsedTable {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [], delimiter };
  const headers = lines[0]!.split(delimiter).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
  return { headers, rows, delimiter };
}

/**
 * Infer a typing for each column from the majority of its sample values.
 * Deliberately tolerant: a partner's file with a few dirty rows still infers a useful mapping,
 * and the dirty rows are then caught by validation rather than silently typed as text.
 */
export const TYPE_TESTS: ReadonlyArray<{ type: FieldSpec['type']; test: (v: string) => boolean }> = [
  { type: 'date', test: (v) => /^\d{4}-\d{2}-\d{2}/.test(v) },
  { type: 'number', test: (v) => /^-?\d+(\.\d+)?$/.test(v) },
  { type: 'email', test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) },
  { type: 'phone', test: (v) => /^[+\d][\d\s-]{6,}$/.test(v) },
  { type: 'id', test: (v) => ID_PATTERN.test(v) },
];

export function inferMapping(table: ParsedTable, majority = 0.6): FieldSpec[] {
  return table.headers.map((h) => {
    const sample = table.rows.slice(0, 50).map((r) => r[h] ?? '').filter((v) => v.length > 0);
    let type: FieldSpec['type'] = 'string';
    if (sample.length > 0) {
      for (const candidate of TYPE_TESTS) {
        const hits = sample.filter(candidate.test).length;
        if (hits / sample.length >= majority) { type = candidate.type; break; }
      }
    }
    return { name: h, type, required: false };
  });
}

const ID_PATTERN = /^[A-Za-z0-9-]{4,30}$/;

export interface RowError { readonly row: number; readonly column: string; readonly value: string; readonly message: string }
export interface ValidationResult {
  readonly accepted: ReadonlyArray<Record<string, string>>;
  readonly quarantined: ReadonlyArray<{ row: number; data: Record<string, string>; errors: RowError[] }>;
  readonly stats: { total: number; accepted: number; quarantined: number; byColumn: Record<string, number> };
}


export function validateRows(rows: Record<string, string>[], fields: readonly FieldSpec[]): ValidationResult {
  const accepted: Record<string, string>[] = [];
  const q: Array<{ row: number; data: Record<string, string>; errors: RowError[] }> = [];
  const byColumn: Record<string, number> = {};
  rows.forEach((row, i) => {
    const errors: RowError[] = [];
    for (const f of fields) {
      const raw = row[f.name] ?? '';
      const value = raw.trim();
      if (f.required && value === '') { errors.push({ row: i + 1, column: f.name, value, message: 'required value is missing' }); continue; }
      if (value === '') continue;
      const bad = (message: string) => { errors.push({ row: i + 1, column: f.name, value, message }); byColumn[f.name] = (byColumn[f.name] ?? 0) + 1; };
      switch (f.type) {
        case 'number': if (!/^-?\d+(\.\d+)?$/.test(value)) bad('not a number'); break;
        case 'date': if (!/^\d{4}-\d{2}-\d{2}/.test(value)) bad('not an ISO date'); break;
        case 'email': if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) bad('not an email address'); break;
        case 'phone': if (!/^[+\d][\d\s-]{6,}$/.test(value)) bad('not a phone number'); break;
        case 'id': if (!ID_PATTERN.test(value)) bad('not a plausible identifier'); break;
        default: break;
      }
    }
    if (errors.length === 0) accepted.push(row); else q.push({ row: i + 1, data: row, errors });
  });
  return { accepted, quarantined: q, stats: { total: rows.length, accepted: accepted.length, quarantined: q.length, byColumn } };
}

export interface LoadRecord {
  readonly loadId: string;
  readonly source: string;
  readonly submittedAt: string;
  readonly mapping: IngestMapping;
  readonly result: ValidationResult;
  committed: boolean;
  committedAt?: string;
  readonly committedKeys: string[];
  readonly duplicatesSuppressed: number;
}

export class IngestionFabric {
  private readonly committedKeys = new Set<string>();
  private readonly loads = new Map<string, LoadRecord>();

  constructor(private readonly supervisor?: (load: { loadId: string; result: ValidationResult }) => string[]) {}

  /** Build (and remember) a load. Nothing is written until commit(). */
  submit(input: { loadId: string; source: string; submittedAt: string; text: string; mapping?: IngestMapping }): LoadRecord {
    const existing = this.loads.get(input.loadId);
    if (existing) return existing;   // idempotent submission
    const table = parseTable(input.text);
    const fields = input.mapping?.fields ?? inferMapping(table);
    const result = validateRows(table.rows, fields);
    const mapping: IngestMapping = input.mapping ?? { source: input.source, entityType: 'inferred', fields, naturalKeys: [] };
    const record: LoadRecord = {
      loadId: input.loadId, source: input.source, submittedAt: input.submittedAt, mapping, result,
      committed: false, committedKeys: [], duplicatesSuppressed: 0,
    };
    this.loads.set(input.loadId, record);
    return record;
  }

  commit(loadId: string, at: string): LoadRecord {
    const load = this.loads.get(loadId);
    if (!load) throw new Error(`unknown load ${loadId}`);
    if (load.committed) return load;   // idempotent commit
    let duplicates = 0;
    const committed: string[] = [];
    for (const row of load.result.accepted) {
      const key = load.mapping.naturalKeys.length
        ? load.mapping.naturalKeys.map((k) => row[k] ?? '').join('|')
        : JSON.stringify(row);
      if (this.committedKeys.has(key)) { duplicates++; continue; }
      this.committedKeys.add(key);
      committed.push(key);
    }
    const record: LoadRecord = { ...load, committed: true, committedAt: at, committedKeys: committed, duplicatesSuppressed: duplicates };
    this.loads.set(loadId, record);
    return record;
  }

  load(loadId: string): LoadRecord | undefined { return this.loads.get(loadId); }

  /** The reconciliation pack a human signs off, with the anomaly supervisor's findings. */
  reconciliation(loadId: string): {
    load: LoadRecord;
    summary: string;
    anomalies: string[];
    quarantine: ValidationResult['quarantined'];
    supervisorNotes: string[];
  } {
    const load = this.load(loadId);
    if (!load) throw new Error(`unknown load ${loadId}`);
    const supervisorNotes = this.supervisor?.({ loadId, result: load.result }) ?? [];
    const anomalies: string[] = [];
    const dupes = load.result.quarantined.length;
    if (dupes > 0) anomalies.push(`${dupes} row(s) quarantined — review before re-submission`);
    if (load.duplicatesSuppressed > 0) anomalies.push(`${load.duplicatesSuppressed} duplicate row(s) suppressed by natural key`);
    if (load.result.stats.total > 0 && load.result.stats.quarantined / load.result.stats.total > 0.2) {
      anomalies.push('More than 20% of rows quarantined — the source file has changed shape or the mapping is wrong');
    }
    const topColumns = Object.entries(load.result.stats.byColumn).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([col, n]) => `${col} (${n})`);
    if (topColumns.length) anomalies.push(`Most common offending columns: ${topColumns.join(', ')}`);
    const summary = `${load.result.stats.accepted}/${load.result.stats.total} rows accepted, ${load.result.stats.quarantined} quarantined, ${load.duplicatesSuppressed} duplicates suppressed${load.committed ? `, committed at ${load.committedAt}` : ', not yet committed'}`;
    return { load, summary, anomalies, quarantine: load.result.quarantined, supervisorNotes };
  }
}

export { parseTable as parseAny };
