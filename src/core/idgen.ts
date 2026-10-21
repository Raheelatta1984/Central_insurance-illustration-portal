/**
 * `next_id()` — one 64-bit identifier, three fields, in the order that makes it sortable.
 *
 * Why not `uuid()` or `bigserial`? Two operational facts decide it:
 *
 *  - **`bigserial` cannot be generated off the primary.** Every insert then needs a round trip to
 *    one machine, and an id that is only unique because one server handed it out is exactly what a
 *    sharded image store or a multi-region write path cannot have.
 *  - **`uuid v4` sorts by nothing.** A random 128-bit value scatters an index across the whole
 *    B-tree, so every insert dirties a different leaf page and every `ORDER BY id` is a sort. An
 *    id whose high bits are a clock is append-only in practice, and the database can range-scan it.
 *
 * Layout (64 bits total, big-endian, so numeric order is chronological order):
 *
 * ```
 *   41 bits  milliseconds since EPOCH_MS   0 – 2,199,023,255,551 ms  (≈ 69.7 years)
 *   13 bits  logical shard reference       0 – 8,191 shards
 *   10 bits  per-shard counter             0 – 1,023 ids in the same millisecond
 * ```
 *
 * Capacity per shard is 1,024 ids/ms (≈ 1.02 M/s); across 8,192 shards that is ≈ 8.4 B ids/s, which
 * is far beyond any book of business this portal writes. The shard field makes the id *decode to
 * its owner*: `parseId()` tells an operator which logical shard wrote the row before they have
 * looked at the table.
 *
 * Two clocks are deliberately distinct: the **wall clock** and the **issuing clock**. If the wall
 * clock steps backwards (NTP, a restored VM, a container resumed from a snapshot) the generator
 * keeps issuing forward from the last millisecond it used. Duplicate ids are a correctness bug; a
 * few milliseconds of skew is not. Counter exhaustion inside one millisecond borrows the next
 * millisecond rather than sleeping, so an issuer never blocks a request thread on a timer.
 *
 * The id is returned as a **decimal string**, not a `bigint` or a `number`: JSON has no 64-bit
 * integer, and `Number` loses precision above 2^53. `compareIds()` and `sortKey()` do the ordering
 * without ever putting the value in a JS number.
 */
import { sha256Hex } from './hash.js';

export const ID_TIMESTAMP_BITS = 41;
export const ID_SHARD_BITS = 13;
export const ID_COUNTER_BITS = 10;

/** Exclusive upper bound of the shard field: 2^13 = 8,192 addressable logical shards. */
export const ID_SHARD_LIMIT = 2 ** ID_SHARD_BITS;
/** Exclusive upper bound of the counter field: 1,024 ids per shard per millisecond. */
export const ID_COUNTER_LIMIT = 2 ** ID_COUNTER_BITS;
export const ID_TIMESTAMP_LIMIT = 2 ** ID_TIMESTAMP_BITS;
export const ID_MAX = (1n << 64n) - 1n;

/**
 * Epoch for the 41-bit clock: 2026-01-01T00:00:00Z. Starting the clock at the era the portal was
 * written (rather than at 1970) buys the full 69.7 years of range instead of 41-bit-ms-from-1970,
 * which would have run out in 2039.
 */
export const ID_EPOCH_MS = Date.UTC(2026, 0, 1);
/** 2026-01-01 + 2^41-1 ms ≈ 2095-09-08 — the last millisecond this layout can encode. */
export const ID_EPOCH_END_MS = ID_EPOCH_MS + ID_TIMESTAMP_LIMIT - 1;

export class IdError extends Error {}

export interface ParsedId {
  /** The id, as it should be stored and compared (20-character zero-padded decimal is *not* this). */
  readonly id: string;
  /** Milliseconds since the UNIX epoch the id was minted at. */
  readonly timestampMs: number;
  /** Milliseconds since {@link ID_EPOCH_MS}. */
  readonly sinceEpochMs: number;
  readonly issuedAt: string;
  /** Which logical shard minted it (0 – 8,191). */
  readonly shard: number;
  /** Position inside that shard's millisecond (0 – 1,023). */
  readonly counter: number;
  readonly bits: string;
}

function assertShard(shard: number): void {
  if (!Number.isInteger(shard) || shard < 0 || shard >= ID_SHARD_LIMIT) {
    throw new IdError(`shard reference must be an integer in 0–${ID_SHARD_LIMIT - 1} (13 bits), got ${String(shard)}`);
  }
}

function assertEpoch(epochMs: number): void {
  if (!Number.isSafeInteger(epochMs)) throw new IdError(`epoch must be a safe integer of ms, got ${String(epochMs)}`);
}

/** Compose an id from its three fields, validating each field's range. Pure — used by tests and replays. */
export function composeId(
  fields: { timestampMs: number; shard: number; counter: number },
  epochMs: number = ID_EPOCH_MS,
): string {
  assertEpoch(epochMs);
  assertShard(fields.shard);
  if (!Number.isInteger(fields.counter) || fields.counter < 0 || fields.counter >= ID_COUNTER_LIMIT) {
    throw new IdError(`counter must be an integer in 0–${ID_COUNTER_LIMIT - 1} (10 bits), got ${String(fields.counter)}`);
  }
  if (!Number.isFinite(fields.timestampMs)) throw new IdError('timestamp must be a finite number of ms');
  const sinceEpoch = Math.floor(fields.timestampMs) - epochMs;
  if (sinceEpoch < 0) {
    throw new IdError(`timestamp ${new Date(fields.timestampMs).toISOString()} is before the id epoch ${new Date(epochMs).toISOString()}`);
  }
  if (sinceEpoch >= ID_TIMESTAMP_LIMIT) {
    throw new IdError(`timestamp ${new Date(fields.timestampMs).toISOString()} exhausts the 41-bit clock; start a new epoch`);
  }
  const value = (BigInt(sinceEpoch) << BigInt(ID_SHARD_BITS + ID_COUNTER_BITS))
    | (BigInt(fields.shard) << BigInt(ID_COUNTER_BITS))
    | BigInt(fields.counter);
  return value.toString();
}

/** Split an id back into its three fields. Throws on anything that is not a 64-bit decimal id. */
export function parseId(id: string, epochMs: number = ID_EPOCH_MS): ParsedId {
  assertEpoch(epochMs);
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) {
    throw new IdError(`id must be a decimal string of at most 20 digits, got ${JSON.stringify(id)}`);
  }
  const value = BigInt(id);
  if (value > ID_MAX) throw new IdError(`id ${id} does not fit in 64 bits`);
  const counter = Number(value & BigInt(ID_COUNTER_LIMIT - 1));
  const shard = Number((value >> BigInt(ID_COUNTER_BITS)) & BigInt(ID_SHARD_LIMIT - 1));
  const sinceEpoch = Number(value >> BigInt(ID_SHARD_BITS + ID_COUNTER_BITS));
  const timestampMs = epochMs + sinceEpoch;
  return {
    id: value.toString(),
    timestampMs,
    sinceEpochMs: sinceEpoch,
    issuedAt: new Date(timestampMs).toISOString(),
    shard,
    counter,
    bits: [
      sinceEpoch.toString(2).padStart(ID_TIMESTAMP_BITS, '0'),
      shard.toString(2).padStart(ID_SHARD_BITS, '0'),
      counter.toString(2).padStart(ID_COUNTER_BITS, '0'),
    ].join('|'),
  };
}

/**
 * A lexicographic sort key for an id: decimal strings sort wrongly (`"9" > "10"`), so pad to the
 * 20 digits a 64-bit value can need. Use this in a `text` column index; in a `bigint`/`numeric`
 * column the raw id already sorts correctly.
 */
export function sortKey(id: string): string {
  return BigInt(parseId(id).id).toString().padStart(20, '0');
}

/** Numeric comparison without ever going through a JS `number`. */
export function compareIds(a: string, b: string): number {
  const left = BigInt(parseId(a).id);
  const right = BigInt(parseId(b).id);
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface IdGeneratorOptions {
  /** The logical shard this process mints for — the same 0–8,191 number the shard map uses. */
  readonly shard: number;
  /** Injectable for tests and replays; defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly epochMs?: number;
}

/**
 * One generator per shard per process. It is deliberately not shared across a cluster: two
 * processes minting with the same shard reference would need a lease or a counter service, and
 * that is exactly the single point of failure this layout exists to avoid. Give every issuer its
 * own shard reference (see `src/core/shardmap.ts`, which assigns 8,192 logical shards to machines).
 */
export class IdGenerator {
  readonly shard: number;
  readonly epochMs: number;
  private readonly clock: () => number;
  private lastMs = -1;
  private counter = 0;
  private issued = 0;

  constructor(options: IdGeneratorOptions) {
    assertShard(options.shard);
    this.shard = options.shard;
    this.clock = options.clock ?? (() => Date.now());
    this.epochMs = options.epochMs ?? ID_EPOCH_MS;
    assertEpoch(this.epochMs);
  }

  next(): string {
    const wallMs = Math.floor(this.clock());
    if (!Number.isFinite(wallMs)) throw new IdError('clock returned a non-finite number');
    // The generator works in milliseconds *since the epoch*; the id stores the offset, not the
    // absolute UNIX time, so the 41 bits buy the full 69.7 years.
    const wall = wallMs - this.epochMs;
    if (wall < 0) {
      throw new IdError(`clock says ${new Date(wallMs).toISOString()}, which is before the id epoch ${new Date(this.epochMs).toISOString()}`);
    }

    if (wall > this.lastMs) {
      // Normal path: a new millisecond, so the counter starts again.
      this.lastMs = wall;
      this.counter = 0;
    } else if (this.counter + 1 < ID_COUNTER_LIMIT) {
      // Same millisecond (or a clock that stepped backwards): stay monotonic.
      this.counter += 1;
    } else {
      // 1,024 ids inside one millisecond. Borrow the next millisecond instead of blocking.
      this.lastMs += 1;
      this.counter = 0;
    }
    const sinceEpoch = this.lastMs;
    if (sinceEpoch >= ID_TIMESTAMP_LIMIT) {
      throw new IdError('the 41-bit clock is exhausted for this epoch; widen the epoch or start a new one');
    }
    const value = (BigInt(sinceEpoch) << BigInt(ID_SHARD_BITS + ID_COUNTER_BITS))
      | (BigInt(this.shard) << BigInt(ID_COUNTER_BITS))
      | BigInt(this.counter);
    this.issued += 1;
    return value.toString();
  }

  /** How many ids this generator has minted in its lifetime (a metric, not a guarantee). */
  get count(): number {
    return this.issued;
  }
}

/**
 * Does an id look like one of ours, and does it claim a shard in range? Used by ingress validation
 * so an id from another system is refused at the boundary instead of being stored as if it meant
 * something. `shardCount` bounds it to the shards the tenant actually has.
 */
export function isIdOfShard(id: string, shardCount: number, epochMs: number = ID_EPOCH_MS): boolean {
  try {
    const parsed = parseId(id, epochMs);
    return Number.isInteger(shardCount) && shardCount > 0 && parsed.shard < shardCount;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * A deterministic issuer for demo/replay paths. Production code must pass a real clock; this is
 * only here so a recorded demo can mint the same ids on every run, and it is pinned by tests.
 * ------------------------------------------------------------------------ */

/** Stable 13-bit shard reference from a tenant/namespace name — the same answer on every machine. */
export function shardForName(name: string): number {
  return Number.parseInt(sha256Hex(name).slice(0, 8), 16) % ID_SHARD_LIMIT;
}
