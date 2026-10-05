/**
 * The reporting store's write path.
 *
 * The registers keep everything in memory and the outbox is the proof of what they reported. This
 * store is the piece in between: a log of reportable records that is written in one piece or not at
 * all, read at a version that cannot move under the reader, and verified from the end instead of from
 * the beginning once the beginning has already been proved.
 *
 * Three properties, each one proved by a drill rather than asserted:
 *
 *   - **all or nothing.** A batch is validated completely, then chained completely, and only then
 *     does the store's head move. A batch that is refused — a bad timestamp, a record already in the
 *     log, a crash part-way through — leaves the store exactly as it was: same version, same entry
 *     count, same head hash.
 *   - **readers do not see halves.** A version is a frozen object holding a frozen list of frozen
 *     entries, and the store only ever appends new versions. A reader that opened version 4 can never
 *     observe version 5's records inside what it already holds.
 *   - **the tail is cheap to prove.** Every `checkpointEvery` entries the store records the hash at
 *     that point, so a reader can verify everything after the last checkpoint without walking the
 *     whole chain again — while the drill still verifies the whole chain from genesis once, because a
 *     checkpoint is only worth what the chain behind it is worth.
 */

import {
  RegisterStoreError, OutboxEntry, OutboxItem, OutboxComparison, outboxKey, chainOutbox, outboxItems,
  outboxHash, compareOutboxes, verifyOutbox,
} from './registerstore.js';
import { ReportingState } from './registerstore.js';

/** The registers an outbox knows. A record from anywhere else is refused rather than chained. */
const REGISTERS: readonly OutboxEntry['register'][] = ['extract', 'decision', 'letter', 'filing'];
/** The books a record can be reported in. The conventional and the takaful returns number apart. */
const BOOKS: readonly OutboxEntry['book'][] = ['conventional', 'takaful'];

export interface StoreVersion {
  /** 0 is the empty store; every append makes exactly one more. */
  readonly version: number;
  readonly entries: readonly OutboxEntry[];
  readonly headHash: string;
  /** How many entries the version holds — what a reader streams from. */
  readonly seq: number;
}

export interface StoreCheckpoint {
  readonly version: number;
  readonly seq: number;
  readonly hash: string;
}

export interface StoreHead {
  readonly version: number;
  readonly seq: number;
  readonly hash: string;
  readonly checkpoints: number;
}

/** A record on its way in: the book and register it belongs to, its id, its content, when it happened. */
export interface AppendItem {
  readonly book: string;
  readonly register: string;
  readonly recordId: string;
  readonly content: unknown;
  readonly at: string;
}

export interface AppendOptions {
  /**
   * Stop after building this many entries, as if the process had died there. Only a test sets it: it
   * is how the store's atomicity is proved rather than promised. The store is left exactly as it was.
   */
  readonly abortAfter?: number;
}

// A day on its own is a timestamp the registers really use — an extract is issued for a date, not at
// an instant — so a date-only value is accepted. The check is that the value is a time at all, not
// that it is a full instant: the chain, not the clock, is what proves the order of the log.
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/;

export class ReportingStore {
  /**
   * A store rebuilt from a snapshot's log. The snapshot is the durable artefact and this is the
   * running one, so a restart gets them back in step by construction: the chain is verified before it
   * is adopted, and a log that does not verify is refused outright rather than half-adopted.
   */
  static fromSnapshot(entries: readonly OutboxEntry[]): ReportingStore {
    const store = new ReportingStore();
    if (entries.length === 0) return store;
    const verdict = verifyOutbox(entries);
    if (!verdict.intact) {
      throw new RegisterStoreError(`the snapshot's log does not verify, so it is not adopted: ${verdict.detail}`);
    }
    store.adopt(entries);
    return store;
  }

  private readonly versions: StoreVersion[] = [];
  private readonly index = new Map<string, number>();
  private readonly marks: StoreCheckpoint[] = [];
  private readonly checkpointEvery: number;
  /** Why the last write did what it did, in a sentence — empty when the log simply grew. */
  private lastNote = '';

  constructor(options: { readonly checkpointEvery?: number } = {}) {
    this.checkpointEvery = Math.max(1, options.checkpointEvery ?? 100);
    this.versions.push(Object.freeze({ version: 0, entries: Object.freeze([]), headHash: '0'.repeat(16), seq: 0 }));
    this.marks.push(Object.freeze({ version: 0, seq: 0, hash: '0'.repeat(16) }));
  }

  /**
   * Rebuild the log in the records' own order. A log is a chain: an entry can only follow the entries
   * before it, so a record created *later* that belongs **before** entries already logged cannot be
   * appended — the log would then carry an order that disagrees with the records it stands for, and a
   * reader comparing it with a fresh walk would find entry 7 to be a decision in one and an extract in
   * the other. When that happens the store rebuilds the log from the whole walk as a new version. The
   * chain is deterministic, so every entry that did not move keeps its hash; only the order is put
   * right. Older versions stay readable, so a reader mid-stream is never surprised.
   */
  private rebase(items: readonly OutboxItem[], note: string): StoreVersion {
    const entries = Object.freeze(chainOutbox(items));
    const version: StoreVersion = Object.freeze({
      version: this.head.version + 1, entries, headHash: entries[entries.length - 1]!.hash, seq: entries.length,
    });
    this.versions.push(version);
    this.index.clear();
    for (const entry of entries) this.index.set(outboxKey(entry), entry.seq);
    const last = this.marks[this.marks.length - 1]!;
    if (entries.length - last.seq >= this.checkpointEvery || entries.length < last.seq) {
      this.marks.push(Object.freeze({ version: version.version, seq: entries.length, hash: version.headHash }));
    }
    this.lastNote = note;
    return version;
  }

  /** Take a verified log as the store's own. Only the chain's own verdict opens this door. */
  private adopt(entries: readonly OutboxEntry[]): void {
    const merged = Object.freeze([...entries]);
    this.versions.push(Object.freeze({
      version: 1, entries: merged, headHash: merged[merged.length - 1]!.hash, seq: merged.length,
    }));
    for (const entry of entries) this.index.set(outboxKey(entry), entry.seq);
    this.marks.push(Object.freeze({ version: 1, seq: merged.length, hash: merged[merged.length - 1]!.hash }));
  }

  /**
   * Compare what the store holds with a log rebuilt from the registers. The rebuilt log is an
   * independent witness: same walk, same records, and if the two part company the entry is named.
   */
  reconcile(rebuilt: readonly OutboxEntry[]): OutboxComparison & { readonly held: number; readonly rebuilt: number } {
    const verdict = compareOutboxes(this.head.entries, rebuilt);
    return { ...verdict, held: this.head.entries.length, rebuilt: rebuilt.length };
  }

  /** The version a fresh reader gets. */
  get head(): StoreVersion {
    return this.versions[this.versions.length - 1]!;
  }

  headReport(): StoreHead {
    return {
      version: this.head.version, seq: this.head.seq, hash: this.head.headHash,
      checkpoints: this.marks.length,
    };
  }

  checkpoints(): readonly StoreCheckpoint[] {
    return this.marks;
  }

  /**
   * Open a version to read. The object handed back is the one the store holds and never edits, so the
   * reader keeps seeing the log as it was at that version however much is written afterwards.
   */
  read(version?: number): StoreVersion {
    const wanted = version ?? this.head.version;
    const held = this.versions.find((v) => v.version === wanted);
    if (!held) throw new RegisterStoreError(`version ${wanted} is not in the store: versions are 0 to ${this.head.version}`);
    return held;
  }

  /** The registers' records, streamed from an entry number onwards — how a reader catches up. */
  outboxSince(seq: number, limit?: number): {
    readonly from: number; readonly to: number; readonly version: number;
    readonly headHash: string; readonly entries: readonly OutboxEntry[];
  } {
    if (!Number.isInteger(seq) || seq < 0) throw new RegisterStoreError(`an entry number must be a whole number from 0, not ${seq}`);
    const held = this.head.entries;
    if (seq > held.length) throw new RegisterStoreError(`the log holds ${held.length} entr(ies); there is nothing after ${seq}`);
    const from = seq + 1;
    const take = limit === undefined ? held.length : Math.max(0, limit);
    const entries = held.slice(from - 1, from - 1 + take);
    return Object.freeze({
      from, to: entries.length ? entries[entries.length - 1]!.seq : seq, version: this.head.version,
      headHash: this.head.headHash, entries: Object.freeze(entries),
    });
  }

  /**
   * Write a batch. Everything about the batch is checked first and the chain is built in full before
   * the store's head moves at all, so a batch that fails anywhere leaves nothing behind.
   */
  append(items: readonly AppendItem[], options: AppendOptions = {}): StoreVersion {
    if (items.length === 0) throw new RegisterStoreError('an append with nothing in it is a write that could not have been meant');
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const where = `item ${i + 1} of ${items.length}`;
      if (!BOOKS.includes(item.book as OutboxEntry['book'])) {
        throw new RegisterStoreError(`${where}: '${item.book}' is not a book the outbox knows (${BOOKS.join(', ')}); a record with no book cannot be told from the same reference in the other one`);
      }
      if (!REGISTERS.includes(item.register as OutboxEntry['register'])) {
        throw new RegisterStoreError(`${where}: '${item.register}' is not a register the outbox knows (${REGISTERS.join(', ')})`);
      }
      if (typeof item.recordId !== 'string' || item.recordId.trim() === '') {
        throw new RegisterStoreError(`${where}: a record identity is required — an entry nobody can name is an entry nobody can find`);
      }
      if (typeof item.at !== 'string' || !ISO.test(item.at)) {
        throw new RegisterStoreError(`${where}: '${String(item.at)}' is not a timestamp; the outbox orders by time as well as by chain`);
      }
      if (item.content === undefined) {
        throw new RegisterStoreError(`${where}: '${item.recordId}' carries no content, so there would be nothing to hash`);
      }
      const key = outboxKey({ book: item.book, register: item.register, recordId: item.recordId });
      const already = this.index.get(key);
      if (already !== undefined) {
        throw new RegisterStoreError(`${where}: '${key}' is already in the log at entry ${already}; a thing is recorded once, and a repeat is a stop rather than a second entry`);
      }
      if (seen.has(key)) {
        throw new RegisterStoreError(`${where}: '${key}' appears twice in this batch`);
      }
      seen.add(key);
    });

    const entries: OutboxEntry[] = [];
    const fresh = items.map((item) => ({
      book: item.book as OutboxEntry['book'], register: item.register as OutboxEntry['register'],
      recordId: item.recordId, content: item.content, at: item.at,
    }));
    const prevEntries = this.head.entries;
    const chain = chainOutbox(fresh, prevEntries);
    for (let i = 0; i < chain.length; i += 1) {
      if (options.abortAfter !== undefined && entries.length >= options.abortAfter) {
        throw new RegisterStoreError(`the write stopped after ${options.abortAfter} entr(ies) with nothing committed: the store is still at version ${this.head.version}, entry ${this.head.seq}`);
      }
      entries.push(chain[i]!);
    }

    // The head moves once, after every entry is ready. There is no step at which a reader can find a
    // version that exists but is not whole.
    const merged = Object.freeze([...prevEntries, ...entries]);
    const version: StoreVersion = Object.freeze({
      version: this.head.version + 1,
      entries: merged,
      headHash: merged[merged.length - 1]!.hash,
      seq: merged.length,
    });
    this.versions.push(version);
    for (const entry of entries) this.index.set(outboxKey(entry), entry.seq);
    const last = this.marks[this.marks.length - 1]!;
    if (merged.length - last.seq >= this.checkpointEvery) {
      this.marks.push(Object.freeze({ version: version.version, seq: merged.length, hash: version.headHash }));
    }
    return version;
  }

  /**
   * Write every record the registers hold that the store does not — the console's own catch-up. The
   * held log has to be a **prefix** of the records' own order for an append to be honest; when it is
   * not, the log is rebuilt rather than grown, and the answer says so.
   */
  appendFrom(state: ReportingState, options: { readonly batchSize?: number } = {}): {
    readonly written: number; readonly rebased: boolean; readonly note: string;
  } {
    const canonical = outboxItems(state);
    const heldKeys = this.head.entries.map((entry) => outboxKey(entry));
    const prefix = heldKeys.length <= canonical.length
      && heldKeys.every((key, i) => outboxKey(canonical[i]!) === key);
    if (!prefix) {
      const where = heldKeys.findIndex((key, i) => canonical[i] === undefined || outboxKey(canonical[i]!) !== key);
      const held = this.head.entries[where];
      const wanted = canonical[where];
      this.rebase(canonical, `the log was rebuilt in the records' own order: entry ${where + 1} is `
        + `${held ? `${held.book} ${held.register} ${held.recordId}` : 'absent'} in the log as it stood and `
        + `${wanted ? `${wanted.book} ${wanted.register} ${wanted.recordId}` : 'absent'} in the walk over the registers`);
      return { written: canonical.length, rebased: true, note: this.lastNote };
    }
    const fresh = canonical.slice(heldKeys.length);
    if (fresh.length === 0) {
      // nothing new is a real answer, not an error: the registers have not reported since the last write
      this.lastNote = '';
      return { written: 0, rebased: false, note: '' };
    }
    const size = Math.max(1, options.batchSize ?? 25);
    let written = 0;
    for (let i = 0; i < fresh.length; i += size) {
      const batch = fresh.slice(i, i + size);
      this.append(batch.map((item) => ({ book: item.book, register: item.register, recordId: item.recordId, content: item.content, at: item.at })));
      written += batch.length;
    }
    this.lastNote = '';
    return { written, rebased: false, note: '' };
  }

  /** What the last write had to say about itself. */
  get note(): string { return this.lastNote; }

  /**
   * Prove the tail: everything after the last checkpoint, starting from the checkpoint's own hash.
   * Cheap enough to run on every read, and honest about what it covers.
   */
  verifySinceCheckpoint(): ChainVerdict {
    const mark = this.marks[this.marks.length - 1]!;
    const entries = this.head.entries;
    if (mark.seq > entries.length) {
      return { intact: false, entries: 0, detail: `checkpoint at entry ${mark.seq} is past the end of a ${entries.length}-entry log` };
    }
    if (mark.seq > 0 && entries[mark.seq - 1]!.hash !== mark.hash) {
      return { intact: false, entries: 0, brokenAt: mark.seq, detail: `entry ${mark.seq} no longer carries the hash the checkpoint recorded: the log was rewritten below the checkpoint` };
    }
    let prevHash = mark.hash;
    let covered = 0;
    for (let i = mark.seq; i < entries.length; i += 1) {
      const entry = entries[i]!;
      if (entry.seq !== i + 1) {
        return { intact: false, entries: covered, brokenAt: entry.seq, detail: `entry ${entry.seq} sits at position ${i + 1}: the log has been reordered or a record dropped` };
      }
      if (entry.prevHash !== prevHash) {
        return { intact: false, entries: covered, brokenAt: entry.seq, detail: `entry ${entry.seq} does not carry the hash of the one before it` };
      }
      const expected = outboxHash({ seq: entry.seq, at: entry.at, book: entry.book, register: entry.register, recordId: entry.recordId, contentHash: entry.contentHash, prevHash: entry.prevHash });
      if (expected !== entry.hash) {
        return { intact: false, entries: covered, brokenAt: entry.seq, detail: `entry ${entry.seq} has been edited: its hash does not match its content` };
      }
      prevHash = entry.hash;
      covered += 1;
    }
    return {
      intact: true, entries: covered,
      detail: `the tail verifies from the checkpoint at entry ${mark.seq}: ${covered} entr(ies) after it are chained from the checkpoint's own hash`,
    };
  }
}

export interface ChainVerdict {
  readonly intact: boolean;
  readonly entries: number;
  readonly detail: string;
  readonly brokenAt?: number;
}
