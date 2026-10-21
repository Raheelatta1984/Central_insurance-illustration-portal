/**
 * SQL classification for the read plane — the one place that decides "may this go to a replica?".
 *
 * This is a *router's* classifier, not a parser: it never interprets a value, never rewrites the
 * statement, and never guesses in the caller's favour. Four answers, and the default is the
 * expensive one:
 *
 *   - **write** — anything that changes data, takes a row lock (`SELECT … FOR UPDATE`), calls a
 *     sequence, or creates a table through `SELECT … INTO`. Primary only.
 *   - **session** — `BEGIN`, `SET`, `LISTEN`, `PREPARE`, advisory locks. These only mean anything
 *     on the connection that issued them, so they must not be load-balanced. Primary only.
 *   - **read** — a plain `SELECT`/`VALUES`/`TABLE`, including a `WITH` whose final statement is a
 *     read. A replica may serve it, if it is fresh enough and the caller is not pinned.
 *   - **unknown** — anything this module does not understand, including a string with more than one
 *     statement. Primary only.
 *
 * Comments, string literals, dollar-quoted bodies and quoted identifiers are stripped first, so a
 * `'delete'` inside a label cannot turn a read into a write (or the reverse).
 */

export type StatementKind = 'read' | 'write' | 'session' | 'unknown';

export interface ClassifiedStatement {
  readonly kind: StatementKind;
  /** Why — shown to an operator and asserted in tests, never a bare enum. */
  readonly reason: string;
  /** True only for a read with no volatile function in it. */
  readonly cacheable: boolean;
  readonly leadingKeyword: string;
}

const READ_KEYWORDS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW']);
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP',
  'COMMENT', 'GRANT', 'REVOKE', 'COPY', 'REINDEX', 'VACUUM', 'ANALYZE', 'CLUSTER', 'REFRESH',
  'IMPORT', 'SECURITY',
]);
const SESSION_KEYWORDS = new Set([
  'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE', 'SET', 'RESET',
  'LISTEN', 'UNLISTEN', 'NOTIFY', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DISCARD', 'LOCK',
  'CHECKPOINT', 'DO', 'CALL', 'LOAD',
]);

/** Functions that make a statement unsafe to send to a replica, with the reason to report. */
const SESSION_FUNCTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bpg_(?:try_)?advisory_(?:xact_)?lock\b/i, reason: 'advisory lock is held by the connection, not the statement' },
  { pattern: /\bpg_(?:try_)?advisory_(?:xact_)?unlock(?:_all|_shared)?\b/i, reason: 'advisory lock is held by the connection, not the statement' },
  { pattern: /\bset_config\s*\(/i, reason: 'SET via set_config changes session state' },
  { pattern: /\b(?:lo_import|lo_export|lo_create|lo_unlink)\s*\(/i, reason: 'large-object functions mutate server state' },
  { pattern: /\bdblink(?:_exec)?\s*\(/i, reason: 'dblink opens a connection with the statement’s session' },
];

const WRITE_FUNCTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bnextval\s*\(/i, reason: 'nextval advances a sequence — a write' },
  { pattern: /\bsetval\s*\(/i, reason: 'setval changes a sequence — a write' },
  { pattern: /\bpg_(?:terminate|cancel)_backend\s*\(/i, reason: 'server administration is a write' },
];

/** Volatile functions: a cached answer would freeze the clock or randomise nothing. */
const VOLATILE = /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|random|gen_random_uuid|uuid_generate_v4|nextval|currval|lastval|current_setting|txid_current)\s*\(|\bcurrent_(?:timestamp|date|time|user|role|catalog|schema)\b|\bsession_user\b|\buser\b/i;

/** Replace comments, literals and quoted identifiers with spaces, preserving length. */
export function stripSql(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      out += '  ';
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; out += '  '; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; out += '  '; i += 2; continue; }
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
        if (sql[i] === "'") { out += ' '; i += 1; break; }
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { out += '  '; i += 2; continue; }
        if (sql[i] === '"') { out += ' '; i += 1; break; }
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      // Dollar quoting: $tag$ … $tag$ (an empty tag, $$ … $$, is the common case).
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return out; // unterminated: the classifier will call this unknown
        const length = end + tag.length - i;
        out += ' '.repeat(length);
        i += length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

function readWord(text: string, index: number): { word: string; next: number } {
  let i = index;
  while (i < text.length && /[A-Za-z_]/.test(text.charAt(i))) i += 1;
  return { word: text.slice(index, i).toUpperCase(), next: i };
}

/** Index just past the `)` matching the `(` at `index`, or -1 when unbalanced. */
function skipBalanced(text: string, index: number): number {
  if (text.charAt(index) !== '(') return -1;
  let depth = 0;
  for (let i = index; i < text.length; i += 1) {
    if (text.charAt(i) === '(') depth += 1;
    else if (text.charAt(i) === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Skip `name [(cols)] AS [MATERIALIZED] (query) [, …]` and return the index of the main statement. */
function afterWith(text: string, start: number): number {
  let i = skipWs(text, start);
  const first = readWord(text, i);
  if (first.word === 'RECURSIVE') i = skipWs(text, first.next);
  for (let guard = 0; guard < 100; guard += 1) {
    // CTE name
    let moved = false;
    while (i < text.length && /[A-Za-z0-9_$.]/.test(text.charAt(i))) { i += 1; moved = true; }
    if (!moved) return -1;
    i = skipWs(text, i);
    if (text.charAt(i) === '(') {
      const afterCols = skipBalanced(text, i);
      if (afterCols === -1) return -1;
      i = skipWs(text, afterCols);
    }
    const as = readWord(text, i);
    if (as.word !== 'AS') return -1;
    i = skipWs(text, as.next);
    const modifier = readWord(text, i);
    if (modifier.word === 'MATERIALIZED') i = skipWs(text, modifier.next);
    else if (modifier.word === 'NOT') {
      i = skipWs(text, modifier.next);
      const second = readWord(text, i);
      if (second.word !== 'MATERIALIZED') return -1;
      i = skipWs(text, second.next);
    }
    if (text.charAt(i) !== '(') return -1;
    const afterBody = skipBalanced(text, i);
    if (afterBody === -1) return -1;
    i = skipWs(text, afterBody);
    if (text.charAt(i) !== ',') return i;
    i = skipWs(text, i + 1);
  }
  return -1;
}

function classifyKeyword(word: string, text: string): ClassifiedStatement {
  const lower = word.toLowerCase();
  if (READ_KEYWORDS.has(word)) {
    if (word === 'SELECT') {
      if (/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i.test(text)) {
        return { kind: 'write', reason: 'SELECT … FOR UPDATE/SHARE takes row locks — it is a write to the read plane', cacheable: false, leadingKeyword: lower };
      }
      if (/\bINTO\b/i.test(text)) {
        return { kind: 'write', reason: 'SELECT … INTO creates a table', cacheable: false, leadingKeyword: lower };
      }
    }
    if (word === 'SHOW') {
      return { kind: 'read', reason: 'SHOW reads server metadata', cacheable: false, leadingKeyword: lower };
    }
    return {
      kind: 'read',
      reason: 'plain read',
      cacheable: !VOLATILE.test(text),
      leadingKeyword: lower,
    };
  }
  if (WRITE_KEYWORDS.has(word)) {
    return { kind: 'write', reason: `${lower} changes data`, cacheable: false, leadingKeyword: lower };
  }
  if (SESSION_KEYWORDS.has(word)) {
    return { kind: 'session', reason: `${lower} is session state, not a query`, cacheable: false, leadingKeyword: lower };
  }
  if (word === 'EXPLAIN') {
    const explain = text.slice(text.toUpperCase().indexOf('EXPLAIN') + 'EXPLAIN'.length);
    if (/\bANALYZE\b/i.test(explain) && /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i.test(explain)) {
      return { kind: 'write', reason: 'EXPLAIN ANALYZE executes the statement it explains', cacheable: false, leadingKeyword: lower };
    }
    return { kind: 'read', reason: 'EXPLAIN without ANALYZE only reads the planner', cacheable: false, leadingKeyword: lower };
  }
  return { kind: 'unknown', reason: `unrecognised statement starting with "${lower}"`, cacheable: false, leadingKeyword: lower };
}

export function classifySql(sql: string): ClassifiedStatement {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { kind: 'unknown', reason: 'empty statement', cacheable: false, leadingKeyword: '' };
  }
  const clean = stripSql(sql);
  if (clean.trim() === '') {
    return { kind: 'unknown', reason: 'statement is only a comment', cacheable: false, leadingKeyword: '' };
  }
  // More than one statement on one string cannot be routed as a unit: the first may be a read and
  // the second a write. Refusing to guess sends it to the primary, where it was always safe.
  const statements = clean.split(';').filter((part) => part.trim() !== '');
  if (statements.length > 1) {
    return { kind: 'unknown', reason: 'multiple statements in one string cannot be routed safely', cacheable: false, leadingKeyword: '' };
  }

  const upper = clean.toUpperCase();
  const start = skipWs(clean, 0);
  const first = readWord(clean, start);

  for (const { pattern, reason } of SESSION_FUNCTIONS) {
    if (pattern.test(clean)) {
      return { kind: 'session', reason, cacheable: false, leadingKeyword: first.word.toLowerCase() };
    }
  }
  for (const { pattern, reason } of WRITE_FUNCTIONS) {
    if (pattern.test(clean)) {
      return { kind: 'write', reason, cacheable: false, leadingKeyword: first.word.toLowerCase() };
    }
  }

  if (first.word === 'WITH') {
    const main = afterWith(clean, first.next);
    if (main === -1) {
      return { kind: 'unknown', reason: 'WITH clause could not be followed to its main statement', cacheable: false, leadingKeyword: 'with' };
    }
    const statement = readWord(clean, skipWs(clean, main));
    const classified = classifyKeyword(statement.word, clean.slice(main));
    if (classified.kind === 'read' && !classified.cacheable) {
      return { ...classified, reason: `WITH … ${classified.leadingKeyword}: volatile function in the statement` };
    }
    return classified.kind === 'read'
      ? { ...classified, reason: `WITH … ${classified.leadingKeyword}: the main statement is a read`, cacheable: !VOLATILE.test(upper) }
      : classified;
  }

  return classifyKeyword(first.word, clean);
}
