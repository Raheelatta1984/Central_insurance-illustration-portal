import { describe, expect, it } from 'vitest';
import { ReportingStore } from './reportingstore.js';
import { RegisterStoreError, buildOutbox, outboxKey, verifyOutbox } from './registerstore.js';
import { buildWorld, ensureFilings, extractSnapshot, submissionSnapshot, uaeRuleSnapshot, wordingSnapshot } from './demo.js';
import { exportReporting } from './registerstore.js';

/** A world with its reporting registers standing up, exactly as the console stands them up. */
function live() {
  const world = buildWorld();
  extractSnapshot(world);
  wordingSnapshot(world);
  uaeRuleSnapshot(world);
  submissionSnapshot(world);
  ensureFilings(world);
  return world;
}

const item = (recordId: string, at = '2026-10-05T10:00:00+04:00') => ({ book: 'conventional', register: 'extract', recordId, content: { recordId }, at });

describe('the reporting store', () => {
  it('writes the registers\' own records, and equals the whole-log build entry for entry', () => {
    const world = live();
    const state = exportReporting(world);
    const store = new ReportingStore();
    const written = store.appendFrom(state);
    expect(written).toBeGreaterThan(0);
    expect(store.head.seq).toBe(written);
    // the same log, built two ways: from the beginning and by adding the difference
    const whole = buildOutbox(state, '2026-10-05');
    expect(store.head.entries.map((e) => e.hash)).toEqual(whole.map((e) => e.hash));
    const verdict = verifyOutbox(store.head.entries);
    expect(verdict.intact, verdict.detail).toBe(true);
    expect(verdict.entries).toBe(written);
  });

  it('adds only what is new, and refuses a record it already holds rather than chaining it twice', () => {
    const world = live();
    const state = exportReporting(world);
    const store = new ReportingStore();
    const written = store.appendFrom(state);
    expect(store.appendFrom(state)).toBe(0);
    expect(store.head.seq).toBe(written);
    // a repeat is a stop: the log answers 'already recorded' with the entry that holds it
    expect(() => store.append([{ book: 'conventional', register: 'extract', recordId: state.conventional.extracts[0]!.id, content: {}, at: '2026-10-05T10:00:00+04:00' }]))
      .toThrow(/already in the log at entry 1/);
    expect(store.head.seq).toBe(written);
  });

  it('is all or nothing: a batch that fails part-way leaves the store exactly as it was', () => {
    const store = new ReportingStore();
    store.append([item('A-1'), item('A-2')]);
    const version = store.head.version;
    const seq = store.head.seq;
    const hash = store.head.headHash;
    // the writer dies after one entry of a three-entry write
    expect(() => store.append([item('B-1'), item('B-2'), item('B-3')], { abortAfter: 1 }))
      .toThrow(/nothing committed: the store is still at version/);
    expect(store.head.version).toBe(version);
    expect(store.head.seq).toBe(seq);
    expect(store.head.headHash).toBe(hash);
    // and a batch that is refused for its content moves nothing either
    expect(() => store.append([item('C-1'), { book: 'conventional', register: 'extract', recordId: 'C-2', content: {}, at: 'yesterday' }]))
      .toThrow(/is not a timestamp/);
    expect(() => store.append([item('D-1'), { book: 'conventional', register: 'ledger', recordId: 'D-2', content: {}, at: '2026-10-05T10:00:00+04:00' }]))
      .toThrow(/not a register the outbox knows/);
    expect(() => store.append([item('D-3'), { book: 'offshore', register: 'extract', recordId: 'D-4', content: {}, at: '2026-10-05T10:00:00+04:00' }]))
      .toThrow(/not a book the outbox knows/);
    expect(store.head.seq).toBe(seq);
    // what did survive is chained and whole
    const verdict = verifyOutbox(store.head.entries);
    expect(verdict.intact, verdict.detail).toBe(true);
  });

  it('never lets a reader see a half-written version', () => {
    const store = new ReportingStore();
    store.append([item('R-1')]);
    const opened = store.read();
    const seen = opened.entries.length;
    store.append([item('R-2'), item('R-3')]);
    // the reader's version is the same object it opened, holding the same entries
    expect(opened.version).toBe(1);
    expect(opened.entries.length).toBe(seen);
    expect(store.read().entries.length).toBe(3);
    // and the old version is still readable, unchanged, by anyone
    expect(store.read(1)!.entries.map((e) => e.recordId)).toEqual(['R-1']);
    expect(() => store.read(9)).toThrow(/version 9 is not in the store/);
  });

  it('streams the log from an entry number, and refuses a number that is not there yet', () => {
    const store = new ReportingStore();
    store.append([item('S-1'), item('S-2')]);
    store.append([item('S-3')]);
    const first = store.outboxSince(0, 2);
    expect(first.from).toBe(1);
    expect(first.to).toBe(2);
    expect(first.entries.map((e) => e.recordId)).toEqual(['S-1', 'S-2']);
    const rest = store.outboxSince(first.to);
    expect(rest.entries.map((e) => e.recordId)).toEqual(['S-3']);
    expect(store.outboxSince(3).entries).toEqual([]);
    expect(() => store.outboxSince(4)).toThrow(/nothing after 4/);
    // the head hash comes with the page, so a reader can tell whether it is already current
    expect(rest.headHash).toBe(store.head.headHash);
  });

  it('proves the tail from the last checkpoint, and says exactly what it covered', () => {
    // one entry at a time with a checkpoint every three, so the last checkpoint trails the head —
    // which is how a store lives: the checkpoint is a place the log has already been proved to
    const store = new ReportingStore({ checkpointEvery: 3 });
    for (const id of ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']) store.append([item(id)]);
    const marks = store.checkpoints();
    expect(marks.map((m) => m.seq)).toEqual([0, 3]);
    expect(marks[1]!.hash).toBe(store.read().entries[2]!.hash);
    const tail = store.verifySinceCheckpoint();
    expect(tail.intact, tail.detail).toBe(true);
    expect(tail.entries).toBe(2);
    // the store hands out frozen entries and never edits one, so a rewrite is staged by opening a
    // doctored view of the head — which is what a reader handed a tampered store would be looking at
    const real = store.head;
    const staged = (at: number, fields: Record<string, unknown>) => {
      const entries = real.entries.map((e, i) => (i === at ? Object.freeze({ ...e, ...fields }) : e));
      Object.defineProperty(store, 'head', { configurable: true, get: () => Object.freeze({ ...real, entries: Object.freeze(entries) }) });
    };
    // the entry the checkpoint names still has to carry the hash it recorded: caught without walking
    staged(2, { hash: 'y'.repeat(16) });
    const rewritten = store.verifySinceCheckpoint();
    expect(rewritten.intact).toBe(false);
    expect(rewritten.detail).toMatch(/checkpoint/);
    // an edit above the checkpoint is caught by the tail walk instead, and the walk stops there
    staged(3, { contentHash: 'x'.repeat(16) });
    const edited = store.verifySinceCheckpoint();
    expect(edited.intact).toBe(false);
    expect(edited.detail).toMatch(/edited/);
    expect(edited.entries).toBe(0);
    expect(store.read().entries.length).toBe(5);
    // and the store itself is untouched by all of it: drop the staged view and look at the real head
    delete (store as unknown as { head?: unknown }).head;
    expect(store.head.entries[3]!.contentHash).not.toBe('x'.repeat(16));
    expect(store.verifySinceCheckpoint().intact).toBe(true);
  });

  it('takes a payload the earlier schema wrote and goes on chaining with the same keys', () => {
    const world = live();
    const state = exportReporting(world);
    const whole = buildOutbox(state, '2026-10-05');
    const store = new ReportingStore();
    // a store that starts from a payload already in the log — what a restart does
    for (const entry of whole.slice(0, 3)) {
      store.append([{ book: entry.book, register: entry.register, recordId: entry.recordId, content: entry, at: entry.at }]);
    }
    expect(store.head.entries.map((e) => e.hash)).not.toEqual(whole.slice(0, 3).map((e) => e.hash));
    // the difference is honest: the payload is the entry, not the thing the entry was made from, so
    // a restart that carries real content reuses the ids and never collides
    const keys = new Set(store.head.entries.map((entry) => outboxKey(entry)));
    expect(keys.size).toBe(store.head.seq);
    const verdict = verifyOutbox(store.head.entries);
    expect(verdict.intact, verdict.detail).toBe(true);
  });

  it('refuses an empty append and a nameless record', () => {
    const store = new ReportingStore();
    expect(() => store.append([])).toThrow(RegisterStoreError);
    expect(() => store.append([{ book: 'conventional', register: 'extract', recordId: '  ', content: {}, at: '2026-10-05T10:00:00+04:00' }]))
      .toThrow(/a record identity is required/);
    expect(() => store.append([item('E-1', 'sometime last Tuesday')])).toThrow(/not a timestamp/);
    expect(store.head.seq).toBe(0);
  });
});
