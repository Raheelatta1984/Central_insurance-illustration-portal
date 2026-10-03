/**
 * Durability: the state that has to survive a restart, in a form that is byte-stable,
 * checksummed, versioned and migratable.
 *
 * Why this exists before a database does: every engine here keeps bigint minor units in
 * `Map`s. `JSON.stringify` refuses bigints outright, and even if it did not, key order would
 * change between runs and make fingerprints useless. So the platform gets one canonical codec
 * that every future store (file, Postgres jsonb, Kafka outbox) shares, plus an envelope that
 * makes a corrupted or half-migrated payload impossible to open silently.
 */
import { Ledger, Account, JournalEntry } from './ledger.js';
import { Currency, FxRate } from './money.js';

export const CODEC_VERSION = 1;

export class SnapshotError extends Error {}

/* ------------------------------------------------------------------ codec */

/** Canonical encode: bigint/Date/Map/Set survive, object keys are sorted for byte-stability. */
export function encode(value: unknown): unknown {
  if (typeof value === 'bigint') return { $big: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Map) {
    const pairs = [...value.entries()].map(([k, v]) => [encode(k), encode(v)] as [unknown, unknown]);
    pairs.sort(compareEncodedPairs);
    return { $map: pairs };
  }
  if (value instanceof Set) {
    const items = [...value].map(encode);
    items.sort(compareEncoded);
    return { $set: items };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SnapshotError(`cannot encode non-finite number ${value}`);
  }
  if (value === undefined) return { $undefined: true };
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = encode(source[key]);
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SnapshotError(`cannot encode ${typeof value}`);
  }
  return value;
}

/** Exact inverse of {@link encode}. */
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length === 1 && keys[0] === '$big') return BigInt(String(source.$big));
    if (keys.length === 1 && keys[0] === '$date') return new Date(String(source.$date));
    if (keys.length === 1 && keys[0] === '$undefined') return undefined;
    if (keys.length === 1 && keys[0] === '$map') {
      const pairs = source.$map as Array<[unknown, unknown]>;
      return new Map(pairs.map(([k, v]) => [decode(k), decode(v)]) as Array<[unknown, unknown]>);
    }
    if (keys.length === 1 && keys[0] === '$set') {
      return new Set((source.$set as unknown[]).map(decode));
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = decode(source[key]);
    return out;
  }
  return value;
}

export function toJson(value: unknown, pretty = false): string {
  return JSON.stringify(encode(value), null, pretty ? 2 : undefined);
}

export function fromJson<T = unknown>(text: string): T {
  return decode(JSON.parse(text)) as T;
}

function compareEncoded(a: unknown, b: unknown): number {
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}

function compareEncodedPairs(a: [unknown, unknown], b: [unknown, unknown]): number {
  return compareEncoded(a[0], b[0]) || compareEncoded(a[1], b[1]);
}

/* ------------------------------------------------------------ fingerprints */

/** FNV-1a 64 over UTF-16 code units, hex, 16 chars. Dependency-free so the console can verify too. */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function fingerprintOf(value: unknown): string {
  return fingerprint(toJson(value));
}

/* --------------------------------------------------------------- envelope */

export interface Snapshot {
  readonly codecVersion: number;
  readonly schemaVersion: number;
  readonly takenAt: string;
  readonly payload: unknown;      // already encoded
  readonly fingerprint: string;   // over codecVersion + schemaVersion + takenAt + payload
}

export function seal(value: unknown, opts: { schemaVersion: number; takenAt: string }): Snapshot {
  const payload = encode(value);
  const head = { codecVersion: CODEC_VERSION, schemaVersion: opts.schemaVersion, takenAt: opts.takenAt };
  const meta = toJson(head);
  const body = toJson(payload);
  return { ...head, payload, fingerprint: fingerprint(`${meta}|${body}`) };
}

export function snapshotText(snapshot: Snapshot, pretty = false): string {
  return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
}

export function snapshotFromText(text: string): Snapshot {
  const parsed = JSON.parse(text) as Snapshot;
  if (!parsed || typeof parsed !== 'object' || !('fingerprint' in parsed)) {
    throw new SnapshotError('not a snapshot envelope');
  }
  return parsed;
}

export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly describe: string;
  apply(payload: any): any;
}

/** The order a chain must be applied in to get from one schema version to another. */
export function planMigrations(from: number, to: number, chain: readonly Migration[]): Migration[] {
  const plan: Migration[] = [];
  let cursor = from;
  while (cursor !== to) {
    const step = chain.find((m) => m.from === cursor && m.to > cursor && m.to <= to);
    if (!step) {
      throw new SnapshotError(`no migration path from schema ${cursor} to ${to}`);
    }
    plan.push(step);
    cursor = step.to;
    if (plan.length > 100) throw new SnapshotError('migration chain looks cyclic');
  }
  return plan;
}

export function open(
  snapshot: Snapshot,
  opts: { expectSchema?: number; migrations?: readonly Migration[] } = {},
): unknown {
  if (snapshot.codecVersion !== CODEC_VERSION) {
    throw new SnapshotError(`snapshot codec ${snapshot.codecVersion}, this build speaks ${CODEC_VERSION}`);
  }
  const head = { codecVersion: snapshot.codecVersion, schemaVersion: snapshot.schemaVersion, takenAt: snapshot.takenAt };
  const expected = fingerprint(`${toJson(head)}|${toJson(snapshot.payload)}`);
  if (expected !== snapshot.fingerprint) {
    throw new SnapshotError(`snapshot fingerprint mismatch (expected ${expected}, found ${snapshot.fingerprint}) — payload was tampered with or written by a different encoder`);
  }
  let payload: any = decode(snapshot.payload);
  const target = opts.expectSchema;
  if (target !== undefined && snapshot.schemaVersion !== target) {
    const plan = planMigrations(snapshot.schemaVersion, target, opts.migrations ?? []);
    for (const step of plan) payload = step.apply(payload);
  }
  return payload;
}

/* ------------------------------------------------------------ ledger state */

export const LEDGER_SCHEMA_VERSION = 1;

export interface LedgerState {
  readonly baseCurrency: Currency;
  readonly fx: FxRate[];
  readonly accounts: Account[];
  readonly journals: JournalEntry[];
}

export function exportLedger(ledger: Ledger): LedgerState {
  return {
    baseCurrency: ledger.baseCurrency,
    fx: ledger.fxRates(),
    accounts: ledger.listAccounts(),
    journals: ledger.allJournals(),
  };
}

/**
 * Rebuild a ledger by re-posting every journal through the normal `post()` path. Restoring is
 * therefore also a validation: an unbalanced or fund-crossing journal in the payload throws here
 * rather than being written into a fresh books.
 */
export function importLedger(state: LedgerState, opts: { verify?: boolean } = {}): Ledger {
  const ledger = new Ledger(state.baseCurrency);
  for (const rate of state.fx) ledger.registerFx(rate);
  for (const account of state.accounts) ledger.defineAccount(account);
  for (const journal of state.journals) ledger.post({ ...journal, postings: journal.postings.map((p) => ({ ...p })) });
  if (opts.verify !== false) {
    const entityIds = [...new Set(state.accounts.map((a) => a.entityId))];
    for (const entityId of entityIds) {
      const proof = ledger.proof(entityId);
      if (!proof.balanced) throw new SnapshotError(`restored books for ${entityId} do not balance`);
    }
    if (ledger.allJournals().length !== state.journals.length) {
      throw new SnapshotError('restored journal count does not match the snapshot');
    }
  }
  return ledger;
}
