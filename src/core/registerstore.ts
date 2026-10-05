/**
 * What has to survive a restart: the reporting registers.
 *
 * The returns, the rule decisions, the letters and the filings are the records an insurer is asked
 * to produce years after the fact. They live in `Map`s and arrays today, which is fine until the
 * process stops. This module gives them the same treatment the books already have — a canonical,
 * checksummed, versioned snapshot with a migration path — and adds the two things a reporting
 * register needs that a ledger does not:
 *
 *  - **Replayable facts.** A decision is stored with the placement it was taken on, a letter with the
 *    facts it was generated from. Restoring therefore does not just copy records back: it **replays**
 *    them through the same engines and checks it gets the same answer. A register that cannot be
 *    re-derived is a register nobody can trust.
 *  - **An outbox.** Every record is written to a hash-chained log — each entry carries the hash of the
 *    entry before it — so a restore can tell the difference between "these are all the records" and
 *    "these are the records that survived". A gap, a reorder or an edited entry breaks the chain.
 *
 * Nothing here is a database. It is the shape a database will have to hold: if the payload cannot be
 * sealed, migrated, restored and re-proved, moving it into Postgres will not make it trustworthy.
 */
import { Ledger } from './ledger.js';
import { LedgerState, importLedger } from './persistence.js';
import { RegisterAction, ReplayContext, ReplayableRegister } from './actionlog.js';
import { Money } from './money.js';
import { ExtractEngine, ExtractKind, ExtractPeriod, IssuedExtract } from './extracts.js';
import { PlacementFacts, UaeRuleBook } from './uae.js';
import { WordingBook, WordingDocument, WordingFacts } from './wording.js';
import { SubmissionRegister, SubmissionPack } from './submission.js';
import {
  Migration, Snapshot, fingerprint, fingerprintOf, open, seal, snapshotText, toJson,
} from './persistence.js';

export class RegisterStoreError extends Error {}

/** Schema 1 is "the books only". Schema 2 is the books plus the reporting registers. */
export const REPORTING_SCHEMA_VERSION = 4;

/** The registers this store holds, named so a restore can say what it is about to put back. */
export const REGISTER_NAMES = ['extracts', 'decisions', 'letters', 'filings'] as const;

export interface ExtractRecord {
  /** How far the books had got when this return was issued. */
  readonly booksThrough: number;
  /** How many register actions had been taken when this return was issued. */
  readonly actionsThrough?: number;
  readonly kind: ExtractKind;
  readonly period: ExtractPeriod;
  readonly asOf: string;
  readonly by: string;
  readonly at: string;
  readonly counterparty?: string;
  readonly changesSummary?: string;
  readonly approvedBy?: string;
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly tiesToBooks: boolean;
}

export interface DecisionRecord {
  readonly facts: PlacementFacts;
  readonly id: string;
  readonly decision: 'allow' | 'escalate' | 'refuse';
  readonly evidence: string;
  readonly findingCount: number;
}

export interface LetterRecord {
  readonly type: WordingDocument['type'];
  readonly facts: WordingFacts;
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
}

export interface FilingRecord {
  readonly pack: SubmissionPack;
  /** How far the books had got when this return went out. */
  readonly booksThrough: number;
  /** How many register actions had been taken when this return went out. */
  readonly actionsThrough?: number;
  readonly at: string;
  readonly by: string;
  readonly lateApprovedBy?: string;
  readonly lateReason?: string;
  readonly resubmissionOf?: string;
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedBy?: string;
  readonly supervisorReference?: string;
  readonly rejectedAt?: string;
  readonly rejectedBy?: string;
  readonly rejectionReason?: string;
}

export interface ReportingState {
  /**
   * Every money-moving action the registers took, in the order they took them, each one tagged with
   * the register it belongs to and the journal it posted. This is what lets a restart put the
   * registers back the way they were rather than only the rows they ended up holding.
   */
  readonly actions: readonly RegisterAction[];
  readonly conventional: {
    readonly extracts: readonly ExtractRecord[];
    readonly decisions: readonly DecisionRecord[];
    readonly letters: readonly LetterRecord[];
    readonly filings: readonly FilingRecord[];
  };
  readonly takaful: {
    readonly extracts: readonly ExtractRecord[];
    readonly filings: readonly FilingRecord[];
  };
}

export interface OutboxEntry {
  readonly seq: number;
  readonly at: string;
  /**
   * Which book reported it. Two filings can carry the same reference — the conventional and the
   * takaful returns both number from SUB-000001 — so a record's identity is the book it was reported
   * in, the register that reported it and its own id, and the chain hashes all three.
   */
  readonly book: 'conventional' | 'takaful';
  readonly register: 'extract' | 'decision' | 'letter' | 'filing';
  readonly recordId: string;
  readonly contentHash: string;
  readonly prevHash: string;
  readonly hash: string;
}

const GENESIS = '0'.repeat(16);

/** One entry's hash covers its own content and the entry before it, so order is part of the proof. */
export function outboxHash(entry: Omit<OutboxEntry, 'hash'>): string {
  return fingerprint(toJson({
    seq: entry.seq, at: entry.at, book: entry.book, register: entry.register,
    recordId: entry.recordId, contentHash: entry.contentHash, prevHash: entry.prevHash,
  }));
}

export interface OutboxItem {
  readonly book: OutboxEntry['book'];
  readonly register: OutboxEntry['register'];
  readonly recordId: string;
  readonly content: unknown;
  readonly at: string;
}

/** What identifies a record in the outbox: one register, one id, recorded once and never again. */
export function outboxKey(record: {
  readonly book: string; readonly register: string; readonly recordId: string;
}): string {
  return `${record.book}|${record.register}|${record.recordId}`;
}

/**
 * Every reportable record the registers hold, in the order the outbox chains them. `buildOutbox` and
 * `extendOutbox` both fold over this one list, so the incremental path cannot walk a different order
 * from the full one — they are the same walk, one of them starting from the last entry instead of
 * from the beginning.
 */
export function outboxItems(state: ReportingState): OutboxItem[] {
  const items: OutboxItem[] = [];
  const push = (book: OutboxEntry['book'], register: OutboxEntry['register'], recordId: string, content: unknown, when: string) => {
    items.push({ book, register, recordId, content, at: when });
  };
  for (const extract of state.conventional.extracts) push('conventional', 'extract', extract.id, extract, extract.at);
  for (const decision of state.conventional.decisions) push('conventional', 'decision', decision.id, decision, decision.facts.at);
  for (const letter of state.conventional.letters) push('conventional', 'letter', letter.id, letter, letter.facts.at);
  for (const filing of state.conventional.filings) push('conventional', 'filing', `${filing.id}:filed`, filing, filing.at);
  for (const filing of state.conventional.filings) {
    if (filing.acknowledgedAt) push('conventional', 'filing', `${filing.id}:acknowledged`, { reference: filing.supervisorReference }, filing.acknowledgedAt);
    if (filing.rejectedAt) push('conventional', 'filing', `${filing.id}:rejected`, { reason: filing.rejectionReason }, filing.rejectedAt);
  }
  for (const extract of state.takaful.extracts) push('takaful', 'extract', extract.id, extract, extract.at);
  for (const filing of state.takaful.filings) push('takaful', 'filing', `${filing.id}:filed`, filing, filing.at);
  for (const filing of state.takaful.filings) {
    if (filing.acknowledgedAt) push('takaful', 'filing', `${filing.id}:acknowledged`, { reference: filing.supervisorReference }, filing.acknowledgedAt);
  }
  return items;
}

/**
 * Chain a list of records onto the end of a log: entry numbers continue, each entry carries the hash
 * of the one before it, and the entries come back frozen.
 */
export function chainOutbox(items: readonly OutboxItem[], from: readonly OutboxEntry[] = []): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let prevHash = from.length ? from[from.length - 1]!.hash : GENESIS;
  const seqBase = from.length ? from[from.length - 1]!.seq : 0;
  for (const item of items) {
    const seq = seqBase + entries.length + 1;
    const contentHash = fingerprintOf(item.content);
    const base = { seq, at: item.at, book: item.book, register: item.register, recordId: item.recordId, contentHash, prevHash };
    const hash = outboxHash(base);
    entries.push(Object.freeze({ ...base, hash }));
    prevHash = hash;
  }
  return entries;
}

/** The whole log, from the beginning. What the drill verifies and what a reader who wants proof asks for. */
export function buildOutbox(state: ReportingState, at: string): OutboxEntry[] {
  void at;
  return chainOutbox(outboxItems(state));
}

/**
 * The same log, built by adding only what the log does not already hold. The console reports a thing
 * the moment it happens; rebuilding the whole chain to say so is work that grows with the day, so the
 * store keeps the chain and this walks the registers for the difference. A record is identified by
 * its register and id, which is why a thing is recorded once and a repeat is refused rather than
 * chained twice.
 */
export function extendOutbox(prev: readonly OutboxEntry[], state: ReportingState): OutboxEntry[] {
  const held = new Set(prev.map((entry) => outboxKey(entry)));
  const fresh = outboxItems(state).filter((item) => !held.has(outboxKey(item)));
  return chainOutbox(fresh, prev);
}

export interface ChainVerdict {
  readonly intact: boolean;
  readonly entries: number;
  readonly detail: string;
  readonly brokenAt?: number;
}

export function verifyOutbox(entries: readonly OutboxEntry[]): ChainVerdict {
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.seq !== i + 1) {
      return { intact: false, entries: entries.length, brokenAt: entry.seq, detail: `entry ${entry.seq} appears at position ${i + 1}: the log has been reordered or a record was dropped` };
    }
    if (entry.prevHash !== prevHash) {
      return { intact: false, entries: entries.length, brokenAt: entry.seq, detail: `entry ${entry.seq} does not carry the hash of the entry before it: the log has a gap` };
    }
    const expected = outboxHash({ seq: entry.seq, at: entry.at, book: entry.book, register: entry.register, recordId: entry.recordId, contentHash: entry.contentHash, prevHash: entry.prevHash });
    if (expected !== entry.hash) {
      return { intact: false, entries: entries.length, brokenAt: entry.seq, detail: `entry ${entry.seq} has been edited: its hash does not match its content` };
    }
    prevHash = entry.hash;
  }
  return { intact: true, entries: entries.length, detail: `${entries.length} record(s) chained from the beginning: nothing dropped, nothing reordered, nothing edited` };
}

/**
 * Compare two logs entry for entry. This is the check the store cannot do for itself: a log that was
 * rebuilt from the registers after a restart is an independent witness to what the registers held —
 * the same walk, from the same records — and if one entry differs, a record was dropped, re-created
 * differently or reordered, and the difference is named rather than counted.
 */
/**
 * The record an entry stands for, found by its book, register and id. A comparison can only say two
 * entries differ; this is what a reader needs to see *what* differs — the return's version, the
 * decision's facts, the letter's fingerprint — without opening a snapshot by hand.
 */
export function recordForEntry(state: ReportingState, entry: OutboxEntry): unknown {
  const book = entry.book === 'takaful' ? state.takaful : state.conventional;
  switch (entry.register) {
    case 'extract': return book.extracts.find((e) => e.id === entry.recordId);
    case 'filing': {
      const id = entry.recordId.split(':')[0]!;
      const filing = book.filings.find((f) => f.id === id);
      if (!filing) return undefined;
      // one filing is three possible entries: filed, acknowledged, rejected
      const part = entry.recordId.split(':')[1];
      if (part === 'acknowledged') return { id: filing.id, acknowledgedAt: filing.acknowledgedAt, supervisorReference: filing.supervisorReference };
      if (part === 'rejected') return { id: filing.id, rejectedAt: filing.rejectedAt, rejectionReason: filing.rejectionReason };
      return filing;
    }
    case 'decision': {
      const decisions = (state.conventional.decisions as readonly { id: string }[]);
      const inBook = (book as unknown as { decisions?: readonly { id: string }[] }).decisions;
      return (inBook ?? decisions).find((d) => d.id === entry.recordId);
    }
    case 'letter': {
      const inBook = (book as unknown as { letters?: readonly { id: string }[] }).letters;
      return inBook?.find((d) => d.id === entry.recordId);
    }
    default: return undefined;
  }
}

export interface OutboxComparison {
  readonly agrees: boolean;
  readonly detail: string;
  readonly divergedAt?: number;
  /** When the two logs part company, the two entries, so a reader sees what differs and not only that
   *  something does. An entry a reader cannot inspect is a difference a reader cannot act on. */
  readonly divergence?: { readonly held: OutboxEntry; readonly rebuilt: OutboxEntry };
}

export function compareOutboxes(
  held: readonly OutboxEntry[],
  rebuilt: readonly OutboxEntry[],
): OutboxComparison {
  const limit = Math.min(held.length, rebuilt.length);
  /** Every field an entry is, in the order a reader would notice them differing. */
  const FIELDS: readonly (keyof OutboxEntry)[] = ['seq', 'book', 'register', 'recordId', 'contentHash', 'prevHash', 'hash'];
  for (let i = 0; i < limit; i += 1) {
    const a = held[i]!;
    const b = rebuilt[i]!;
    const differs = FIELDS.filter((field) => a[field] !== b[field]);
    if (differs.length === 0) continue;
    const field = differs[0]!;
    const why = field === 'seq'
      ? `entry ${i + 1} is numbered ${a.seq} in one log and ${b.seq} in the other`
      : field === 'recordId'
        ? `entry ${a.seq} records ${a.recordId} in one log and ${b.recordId} in the other${differs.includes('hash') ? '' : ', under the hash of the record it replaced'}`
        : field === 'contentHash'
          ? `entry ${a.seq} (${a.book} ${a.register} ${a.recordId}) carries different content: ${a.contentHash} against ${b.contentHash}`
          : field === 'book' || field === 'register'
            ? `entry ${a.seq} belongs to ${a.book} ${a.register} in one log and ${b.book} ${b.register} in the other`
            : `entry ${a.seq} ${field === 'prevHash' ? 'does not carry the same hash of the entry before it' : 'carries a different hash'}: ${String(a[field])} against ${String(b[field])}`;
    return { agrees: false, detail: why, divergedAt: a.seq, divergence: { held: a, rebuilt: b } };
  }
  if (held.length !== rebuilt.length) {
    const longer = held.length > rebuilt.length ? 'held' : 'rebuilt';
    return {
      agrees: false, divergedAt: limit + 1,
      detail: `the two logs part company after entry ${limit}: the ${longer} one carries ${Math.max(held.length, rebuilt.length)} entr(ies) and the other ${Math.min(held.length, rebuilt.length)}`,
    };
  }
  return {
    agrees: true,
    detail: `${held.length} entr(ies) agree entry for entry, hash for hash: nothing dropped, nothing re-created differently, nothing reordered`,
  };
}

/** Schema 1 held the books and nothing else; schema 2 adds the four reporting registers. */
export const REPORTING_MIGRATIONS: readonly Migration[] = [
  {
    from: 1, to: 2,
    describe: 'add the reporting registers (extracts, rule decisions, letters, filings) to a books-only payload',
    apply: (payload: any) => ({
      ...payload,
      reporting: {
        conventional: { extracts: [], decisions: [], letters: [], filings: [], ...(payload?.reporting?.conventional ?? {}) },
        takaful: { extracts: [], filings: [], ...(payload?.reporting?.takaful ?? {}) },
      },
      outbox: payload?.outbox ?? [],
    }),
  },
  {
    from: 2,
    to: 3,
    describe: 'every register action the store holds, so a restart can put the registers back and not only their rows',
    apply: (payload: any) => ({ ...payload, actions: payload.actions ?? [] }),
  },
  {
    from: 3,
    to: 4,
    describe: "the registers' own clock, so an action that posts no journal can be ordered against a return issued around it",
    // a v3 payload has the actions but not their tickets; absent tickets are treated as unknown and
    // the record sorts after the actions at the same book position, which is what v3 could say
    apply: (payload: any) => payload,
  },
];

/* ------------------------------------------------------------------ export */

const extractRecord = (e: IssuedExtract): ExtractRecord => ({
  booksThrough: e.booksThrough, actionsThrough: e.actionsThrough,
  kind: e.kind, period: { ...e.period }, asOf: e.asOf, by: e.preparedBy, at: e.issuedAt,
  ...(e.counterparty ? { counterparty: e.counterparty } : {}),
  ...(e.changesSummary ? { changesSummary: e.changesSummary } : {}),
  ...(e.differencesAccepted ? { approvedBy: e.differencesAccepted.by } : {}),
  id: e.id, version: e.version, fingerprint: e.fingerprint, tiesToBooks: e.tiesToBooks,
});

const filingRecord = (s: ReturnType<SubmissionRegister['submissions']>[number]): FilingRecord => ({
  pack: s.pack, booksThrough: s.booksThrough, actionsThrough: s.actionsThrough, at: s.filedAt, by: s.filedBy,
  ...(s.lateApprovedBy ? { lateApprovedBy: s.lateApprovedBy } : {}),
  ...(s.lateReason ? { lateReason: s.lateReason } : {}),
  ...(s.resubmissionOf ? { resubmissionOf: s.resubmissionOf } : {}),
  id: s.id, reference: s.reference, status: s.status,
  ...(s.acknowledgedAt ? { acknowledgedAt: s.acknowledgedAt, acknowledgedBy: s.acknowledgedBy ?? '', supervisorReference: s.supervisorReference ?? '' } : {}),
  ...(s.rejectedAt ? { rejectedAt: s.rejectedAt, rejectedBy: s.rejectedBy ?? '', rejectionReason: s.rejectionReason ?? '' } : {}),
});

export interface RegisterBundle {
  readonly ledger: Ledger;
  /** The registers that can say what they did and do it again. Optional: a bundle without them still exports its rows. */
  readonly registers?: readonly ReplayableRegister[];
  readonly extracts: ExtractEngine;
  readonly takafulExtracts: ExtractEngine;
  readonly rules: UaeRuleBook;
  readonly wording: WordingBook;
  readonly submissions: SubmissionRegister;
  readonly takafulSubmissions: SubmissionRegister;
}

export function exportReporting(world: RegisterBundle): ReportingState {
  return {
    actions: (world.registers ?? []).flatMap((r) => r.actionLog()),
    conventional: {
      extracts: world.extracts.list().map(extractRecord),
      decisions: world.rules.decisions().map((d) => ({
        facts: d.facts, id: d.id, decision: d.decision, evidence: d.evidence, findingCount: d.findings.length,
      })),
      letters: world.wording.documents().map((d) => ({
        type: d.type, facts: d.facts, id: d.id, version: d.version, fingerprint: d.fingerprint,
      })),
      filings: world.submissions.submissions().map(filingRecord),
    },
    takaful: {
      extracts: world.takafulExtracts.list().map(extractRecord),
      filings: world.takafulSubmissions.submissions().map(filingRecord),
    },
  };
}

export interface ReportingSnapshot {
  readonly snapshot: Snapshot;
  readonly text: string;
  readonly outbox: readonly OutboxEntry[];
}

export function sealReporting(state: ReportingState, at: string): ReportingSnapshot {
  const payload = { reporting: state, outbox: buildOutbox(state, at) };
  const snapshot = seal(payload, { schemaVersion: REPORTING_SCHEMA_VERSION, takenAt: at });
  return { snapshot, text: snapshotText(snapshot), outbox: buildOutbox(state, at) };
}

export function openReporting(snapshot: Snapshot): { state: ReportingState; outbox: readonly OutboxEntry[] } {
  const payload = open(snapshot, { expectSchema: REPORTING_SCHEMA_VERSION, migrations: REPORTING_MIGRATIONS }) as
    { reporting: ReportingState; outbox: readonly OutboxEntry[] };
  if (!payload || typeof payload !== 'object' || !payload.reporting) {
    throw new RegisterStoreError('the snapshot opened but carries no reporting registers');
  }
  return { state: payload.reporting, outbox: payload.outbox ?? [] };
}

/* ------------------------------------------------------------------ the books under the registers */

/**
 * The books move forward with the registers.
 *
 * A restart is not only the registers. A return carries figures taken from the books, so a restore
 * that re-issues it has to be holding the books it was issued against — and that is not the books
 * as they end up. A corrected return filed after a catastrophe recovery was prepared with the
 * recovery in the books, while the return it superseded was prepared without it; replaying both
 * against one set of end-of-day books refuses the first and proves nothing.
 *
 * So the books are opened as a timeline: journals are posted in the order they were recorded, and
 * the restore advances them to the moment of each record before replaying it — a return is measured
 * against the books as they stood when it was issued, which is the only way it can ever tie again.
 *
 * The world a restart hands over is already seeded, so the journals it holds are left alone and
 * only the ones it has gained are posted. The end state is checked rather than assumed: every
 * entity's trial balance is compared, account by account, with a reference rebuild of the same
 * payload.
 */
export interface BooksTimeline {
  /**
   * Post journals, in the order they were recorded, until the books hold `count` of them; returns
   * how many landed. The count is the mark a record carries — the books as far as it could see.
   */
  advanceToCount(count: number): number;
  /** How many journals this timeline has posted so far. */
  readonly posted: number;
  /** Take the books all the way to the end of the payload and say whether they came back the same. */
  settle(): { agree: boolean; detail: string; journals: number };
}

export function openBooksTimeline(target: RegisterBundle, books: LedgerState): BooksTimeline {
  // The payload is the books in the order they were recorded, so a mark is an index into it.
  const pending = [...books.journals];
  // The chart travels with the journals. An engine that defines an account and posts nothing to it —
  // the group consolidator defines the group's own accounts — leaves a book that is one account
  // short, and the check would call that a failed restore when it is a missing account definition.
  const known = new Set(target.ledger.listAccounts().map((a) => a.id));
  const defineMissing = (): number => {
    let defined = 0;
    for (const account of books.accounts) {
      if (known.has(account.id)) continue;
      target.ledger.defineAccount(account);
      known.add(account.id);
      defined += 1;
    }
    return defined;
  };
  let next = 0;
  let posted = 0;
  const timeline: BooksTimeline = {
    advanceToCount(count: number): number {
      // accounts first: a journal cannot be posted to an account the books do not hold yet
      defineMissing();
      let landed = 0;
      while (next < pending.length && next < count) {
        const journal = pending[next]!;
        next += 1;
        if (target.ledger.journal(journal.id)) continue;
        target.ledger.post({ ...journal, postings: journal.postings.map((p) => ({ ...p })) });
        posted += 1;
        landed += 1;
      }
      return landed;
    },
    get posted() { return posted; },
    settle() {
      timeline.advanceToCount(books.journals.length);
      defineMissing();
      const reference = importLedger(books, { verify: false });
      const entities = [...new Set(books.accounts.map((a) => a.entityId))];
      const disagreeing: string[] = [];
      for (const entityId of entities) {
        const expected = reference.trialBalance(entityId);
        const rebuilt = target.ledger.trialBalance(entityId);
        if (rebuilt.length !== expected.length) {
          disagreeing.push(`${entityId}: ${rebuilt.length} account(s) in the rebuilt books, ${expected.length} in the snapshot`);
          continue;
        }
        for (const [i, row] of rebuilt.entries()) {
          const other = expected[i]!;
          if (row.account.id !== other.account.id || row.balance.minor !== other.balance.minor) {
            disagreeing.push(`${entityId}: ${row.account.id} stands at ${row.balance.minor} in the rebuilt books and ${other.balance.minor} in the snapshot`);
          }
        }
      }
      // The fixpoint: not just the balances, every journal. A replay that arrives at the same
      // totals through different entries has not reproduced the books, and the store is here to
      // notice that rather than to round it away.
      const rebuiltJournals = target.ledger.allJournals();
      if (rebuiltJournals.length !== books.journals.length) {
        disagreeing.push(`${rebuiltJournals.length} journal(s) in the rebuilt books, ${books.journals.length} in the snapshot`);
      } else {
        for (const [i, expected] of books.journals.entries()) {
          const got = rebuiltJournals[i]!;
          const same = got.id === expected.id && got.source === expected.source
            && got.postings.length === expected.postings.length
            && got.postings.every((posting, j) => {
              const want = expected.postings[j]!;
              return posting.accountId === want.accountId && posting.side === want.side && posting.amount.minor === want.amount.minor;
            });
          if (!same) disagreeing.push(`journal ${i + 1}: the snapshot has ${expected.id}, the rebuilt books hold ${got.id}`);
        }
      }
      const journals = target.ledger.allJournals().length;
      return {
        agree: disagreeing.length === 0,
        journals,
        detail: disagreeing.length === 0
          ? `the books came back journal for journal: ${journals} journal(s), ${posted} of them posted by the restore as it replayed the registers, every posting the same and every entity's trial balance the one the snapshot had`
          : `the books did not come back the same: ${disagreeing.slice(0, 3).join('; ')}`,
      };
    },
  };
  return timeline;
}

/* ------------------------------------------------------------------ restore */

export interface RestoreReport {
  readonly actions: { expected: number; replayed: number; skipped: number; disagreements: readonly string[] };
  readonly extracts: { expected: number; restored: number; fingerprintsAgree: boolean; duplicates: number };
  readonly decisions: {
    expected: number;
    /** Decisions the target already held under the same id, compared rather than taken again. */
    matched: number;
    /** Decisions the replay took, because the target did not hold them. */
    restored: number;
    agree: number;
    disagreements: readonly string[];
  };
  readonly letters: { expected: number; restored: number; fingerprintsAgree: boolean };
  readonly filings: { expected: number; restored: number; statusesAgree: boolean };
  readonly books: { posted: number; agree: boolean; detail: string };
  readonly outbox: ChainVerdict;
  readonly ok: boolean;
  readonly detail: string;
  /** One line per record the restore met, in the order it met them — what came back, and how. */
  readonly replays: readonly string[];
}

/**
 * Replay the registers into a fresh world, in the order the world lived them.
 *
 * Everything the store holds is placed on one timeline and put back in that order: the actions the
 * registers took, then the returns they issued, each at the point in the books where it belongs.
 * The order matters more than it looks. A return issued on Monday is measured against the books and
 * the registers as they stood on Monday; replay every action first and then every return, and the
 * Monday return is handed a register that has already seen Tuesday, so it refuses — and the restore
 * would be blaming the return for being right at the time.
 *
 * So this is a merge, not two passes. An action's mark is the journal it posted; a return's mark is
 * how far the books had got when it was issued. Where the two are the same number, the action comes
 * first: the journal that mark counts is the one the action posted, and the return was issued after
 * it. The books are advanced to the mark of each item before it is replayed, which is what makes the
 * whole thing reproducible rather than approximately reproducible.
 *
 * A restore is a proof and not a copy: a return must reproduce its fingerprint, an action must post
 * the journal it posted the first time (checked journal for journal at the end), a rule decision must
 * follow again from the facts it was decided on, and a letter must regenerate from its own facts.
 * Anything that does not is named, and the restore is not declared good.
 */
export function restoreReporting(
  state: ReportingState,
  target: RegisterBundle,
  options: {
    readonly outbox?: readonly OutboxEntry[];
    readonly books?: BooksTimeline;
    /** The registers to replay into. Defaults to the ones the bundle carries. */
    readonly registers?: readonly ReplayableRegister[];
  } = {},
): RestoreReport {
  const disagreements: string[] = [];
  const replays: string[] = [];

  // Where the books have to be before each item is replayed. Without a timeline the caller has
  // supplied the books some other way (a fresh world, or a test), and the marks are not used.
  const at = (count: number | undefined): void => {
    if (!options.books) return;
    options.books.advanceToCount(count ?? Number.MAX_SAFE_INTEGER);
  };

  const registerByName = new Map<string, ReplayableRegister>();
  for (const register of options.registers ?? target.registers ?? []) registerByName.set(register.engineName, register);
  const homeOf = (engine: string): ReplayableRegister | undefined => {
    // the window's registers live on the window's bundle slots; names are unique, so one map is enough
    return registerByName.get(engine);
  };

  /* ---------------------------------------------------------------- the timeline */

  interface Timed {
    readonly mark: number;
    /** Where this item sits on the registers' own clock. */
    readonly clock: number;
    /** Actions before returns when both clocks agree. */
    readonly phase: 0 | 1;
    readonly order: number;
    readonly label: string;
    readonly run: () => void;
  }
  const timeline: Timed[] = [];
  let order = 0;

  const actionDisagreements: string[] = [];
  let actionsReplayed = 0;
  let actionsSkipped = 0;
  const asKey = (a: RegisterAction): string => `${a.engine}|${a.kind}|${a.at}|${a.journalId}|${toJson(a.input)}`;
  const alreadyTaken = new Set<string>();
  for (const register of registerByName.values()) for (const a of register.actionLog()) alreadyTaken.add(asKey(a));
  const replayContext: ReplayContext = { register: (name: string) => homeOf(name) };

  for (const action of state.actions ?? []) {
    if (alreadyTaken.has(asKey(action))) {
      actionsSkipped += 1;
      replays.push(`${action.engine} ${action.kind} at ${action.at} → already taken here, left alone`);
      continue;
    }
    const register = homeOf(action.engine);
    if (!register) {
      actionDisagreements.push(`${action.engine} took a ${action.kind} at ${action.at} and there is no ${action.engine} register here to take it again`);
      continue;
    }
    timeline.push({
      mark: action.mark,
      clock: action.seq ?? Number.MAX_SAFE_INTEGER,
      phase: 0,
      order: order++,
      label: `${action.engine} ${action.kind}`,
      run: () => {
        // the books go back to just before the action: the journal this mark counts is the one the
        // action is about to post, and an action that reads a balance must read the balance it read
        if (options.books) options.books.advanceToCount(Math.max(0, action.mark - 1));
        try {
          register.replay(action, replayContext);
          actionsReplayed += 1;
          replays.push(`${action.engine} ${action.kind} at ${action.at} → ${action.journalId || 'no journal'}${action.journalId && target.ledger.journal(action.journalId) ? ', journal reproduced' : ''}`);
        } catch (err) {
          actionDisagreements.push(`${action.engine} ${action.kind} at ${action.at}: ${String((err as Error).message)}`);
          replays.push(`${action.engine} ${action.kind} at ${action.at} → refused: ${String((err as Error).message)}`);
        }
      },
    });
  }

  /* ---------------------------------------------------------------- the returns */

  let duplicates = 0;
  const replayExtract = (
    register: ExtractEngine,
    record: ExtractRecord,
    label: string,
    mark: number,
  ): void => {
    timeline.push({
      mark,
      clock: record.actionsThrough ?? Number.MAX_SAFE_INTEGER,
      phase: 1,
      order: order++,
      label: `${label} extract ${record.id}`,
      run: () => {
        at(mark);
        // a return the register already holds, fingerprinted the same and on the same version, is
        // the same return: re-issuing it into a world that has already traded would measure it
        // against books that have moved on and call that a failure of the return
        const held = register.list().find((e) => e.id === record.id);
        if (held && held.fingerprint === record.fingerprint && held.version === record.version) {
          duplicates += 1;
          replays.push(`${label} extract ${record.id} → already held here, identical`);
          return;
        }
        try {
          const issued = register.issue({
            kind: record.kind, period: record.period, asOf: record.asOf, by: record.by, at: record.at,
            ...(record.counterparty ? { counterparty: record.counterparty } : {}),
            ...(record.changesSummary ? { changesSummary: record.changesSummary } : {}),
            ...(record.approvedBy ? { allowDifferences: true, approvedBy: record.approvedBy } : {}),
          });
          if (issued.extract.fingerprint !== record.fingerprint) {
            disagreements.push(`${record.id}: ${label} register gave back ${issued.extract.id} with a different fingerprint (${issued.extract.fingerprint} vs ${record.fingerprint})`);
            replays.push(`${label} extract ${record.id} → ${issued.extract.id}, different content`);
            return;
          }
          // the version is part of a return's identity: v1 and v7 with the same wording are still
          // two different records, and a snapshot that remembers the wrong one is not reproduced
          if (issued.extract.version !== record.version) {
            disagreements.push(`${record.id}: the register holds it as version ${issued.extract.version}, the snapshot says ${record.version}`);
            replays.push(`${label} extract ${record.id} → ${issued.extract.id}, wrong version`);
            return;
          }
          if (!issued.created) duplicates += 1;
          replays.push(`${label} extract ${record.id} → ${issued.extract.id}${issued.created ? '' : ' (already held, identical)'}`);
        } catch (err) {
          disagreements.push(`${record.id}: ${String((err as Error).message)}`);
          replays.push(`${label} extract ${record.id} → refused: ${String((err as Error).message)}`);
        }
      },
    });
  };
  for (const record of state.conventional.extracts) replayExtract(target.extracts, record, 'conventional', record.booksThrough ?? Number.MAX_SAFE_INTEGER);
  for (const record of state.takaful.extracts) replayExtract(target.takafulExtracts, record, 'takaful', record.booksThrough ?? Number.MAX_SAFE_INTEGER);

  /* ------------------------------------------------- the returns that went out */

  const filingDisagreements: string[] = [];
  let duplicatesFiled = 0;
  const replayFiling = (record: FilingRecord, register: SubmissionRegister, mark: number): void => {
    timeline.push({
      mark,
      clock: record.actionsThrough ?? Number.MAX_SAFE_INTEGER,
      phase: 1,
      order: order++,
      label: `filing ${record.reference}`,
      run: () => {
        at(mark);
        const existing = register.submissions().find((s) => s.pack.extractId === record.pack.extractId
          && s.pack.returnCode === record.pack.returnCode
          && s.period.from === record.pack.period.from && s.period.to === record.pack.period.to);
        try {
          const filed = existing ?? register.file({
            pack: record.pack, at: record.at, by: record.by,
            ...(record.lateApprovedBy ? { lateApprovedBy: record.lateApprovedBy } : {}),
            ...(record.lateReason ? { lateReason: record.lateReason } : {}),
            ...(record.resubmissionOf ? { resubmissionOf: record.resubmissionOf } : {}),
          });
          if (existing) duplicatesFiled += 1;
          // put the answer back on it, unless that answer is already recorded
          if (record.acknowledgedAt && register.submission(filed.id).status !== 'acknowledged') {
            register.acknowledge(filed.id, {
              at: record.acknowledgedAt, by: record.acknowledgedBy ?? 'compliance/records',
              supervisorReference: record.supervisorReference ?? '',
            });
          }
          if (record.rejectedAt && register.submission(filed.id).status !== 'rejected') {
            register.reject(filed.id, {
              at: record.rejectedAt, by: record.rejectedBy ?? 'compliance/records',
              reason: record.rejectionReason ?? 'restored from the store',
            });
          }
          replays.push(`filing ${record.reference} → ${filed.id} (${register.submission(filed.id).status})`);
        } catch (err) {
          filingDisagreements.push(`${record.reference}: ${String((err as Error).message)}`);
          replays.push(`filing ${record.reference} → refused: ${String((err as Error).message)}`);
        }
      },
    });
  };
  for (const record of state.conventional.filings) replayFiling(record, target.submissions, record.booksThrough ?? Number.MAX_SAFE_INTEGER);
  for (const record of state.takaful.filings) replayFiling(record, target.takafulSubmissions, record.booksThrough ?? Number.MAX_SAFE_INTEGER);

  /* ---------------------------------------------------------------- run it */

  // Two clocks and one order. The books say where in the ledger a thing belongs; the registers' clock
  // says where it belongs among the actions, which is the only way an action that posts no journal
  // can be placed against a return issued around it. When both agree, the action came first.
  timeline.sort((a, b) => (a.mark - b.mark) || (a.clock - b.clock) || (a.phase - b.phase) || (a.order - b.order));
  for (const item of timeline) item.run();

  // the books, all the way to the end, then checked journal for journal
  at(Number.MAX_SAFE_INTEGER);
  disagreements.push(...actionDisagreements, ...filingDisagreements);

  const restoredExtracts = target.extracts.list().length + target.takafulExtracts.list().length;
  const expectedExtracts = state.conventional.extracts.length + state.takaful.extracts.length;
  // Every return on the snapshot must be in the register afterwards, fingerprinted identically: an
  // extra row that is not on the snapshot is a disagreement too, but a duplicate the register
  // refuses to hold twice is not — it is the same return, and the counts say so.
  const snapshotFingerprints = [
    ...state.conventional.extracts.map((r) => `conventional:${r.fingerprint}`),
    ...state.takaful.extracts.map((r) => `takaful:${r.fingerprint}`),
  ];
  const restoredFingerprintList = [
    ...target.extracts.list().map((e) => `conventional:${e.fingerprint}`),
    ...target.takafulExtracts.list().map((e) => `takaful:${e.fingerprint}`),
  ];
  const fingerprintsAgree = snapshotFingerprints.every((f) => restoredFingerprintList.includes(f))
    && restoredFingerprintList.every((f) => snapshotFingerprints.includes(f));
  if (!fingerprintsAgree) {
    const missing = snapshotFingerprints.filter((f) => !restoredFingerprintList.includes(f));
    const extra = restoredFingerprintList.filter((f) => !snapshotFingerprints.includes(f));
    if (missing.length > 0) disagreements.push(`${missing.length} return(s) on the snapshot are not in the rebuilt register: ${missing.slice(0, 3).join(', ')}`);
    if (extra.length > 0) disagreements.push(`${extra.length} return(s) in the rebuilt register are not on the snapshot: ${extra.slice(0, 3).join(', ')}`);
  }

  /* ------------------------------------------------------- decisions and letters */

  // Rule decisions: replay the facts, in the order they were taken, and check that the same decision
  // comes back **under the same id**. A decision is matched by its id and never by its content: two
  // decisions taken the same day with the same facts are two records, and a restore that folded them
  // into one would hand back a log that is shorter than the one it was given. (That is not a
  // hypothesis — it is the defect this loop was rewritten for: the console ran the same unrated
  // counterparty check twice, and the rebuilt rules log came back one decision short.)
  let decisionAgreements = 0;
  let matchedDecisions = 0;
  let replayedDecisions = 0;
  for (const record of state.conventional.decisions) {
    const present = target.rules.decisions().find((d) => d.id === record.id);
    if (present) {
      matchedDecisions += 1;
      const sameFacts = toJson(present.facts) === toJson(record.facts);
      if (present.decision === record.decision && present.findings.length === record.findingCount
        && present.evidence === record.evidence && sameFacts) {
        decisionAgreements += 1;
      } else {
        disagreements.push(`${record.id}: the register already holds a different decision under this id — `
          + `${present.decision} against ${record.decision}${sameFacts ? '' : ', taken on different facts'}`);
      }
      continue;
    }
    try {
      const replayed = target.rules.enforce(record.facts);
      replayedDecisions += 1;
      const sameFacts = toJson(replayed.facts) === toJson(record.facts);
      if (replayed.id !== record.id) {
        disagreements.push(`${record.id}: the replay numbered this decision ${replayed.id} — decisions are replayed in the order they were taken, so the registers have lost their place`);
      } else if (replayed.decision !== record.decision || replayed.findings.length !== record.findingCount
        || replayed.evidence !== record.evidence || !sameFacts) {
        disagreements.push(`${record.id}: the facts now answer ${replayed.decision}, not ${record.decision}`);
      } else {
        decisionAgreements += 1;
      }
    } catch (err) {
      disagreements.push(`${record.id}: ${String((err as Error).message)}`);
    }
  }

  // Letters: regenerate from the stored facts and compare the fingerprint.
  for (const record of state.conventional.letters) {
    try {
      const regenerated = target.wording.generate({ type: record.type, facts: record.facts });
      if (regenerated.fingerprint !== record.fingerprint) {
        disagreements.push(`${record.id}: regenerating the letter gives a different document (${regenerated.fingerprint} vs ${record.fingerprint})`);
      }
    } catch (err) {
      disagreements.push(`${record.id}: ${String((err as Error).message)}`);
    }
  }
  const lettersAgree = state.conventional.letters.every((record) =>
    target.wording.documents().some((d) => d.id === record.id && d.fingerprint === record.fingerprint));

  /* ---------------------------------------------------------------------- verdict */

  const restoredFilings = target.submissions.submissions().length + target.takafulSubmissions.submissions().length;
  const expectedFilings = state.conventional.filings.length + state.takaful.filings.length;
  const statusesAgree = expectedFilings === restoredFilings
    && state.conventional.filings.every((record, i) => target.submissions.submissions()[i]?.status === record.status);

  const outbox = verifyOutbox(options.outbox ?? []);
  const settled = options.books ? options.books.settle() : null;
  const books = settled
    ? { posted: options.books!.posted, agree: settled.agree, detail: settled.detail }
    : { posted: 0, agree: true, detail: 'the books were not part of this restore' };
  if (settled && !settled.agree) disagreements.push(settled.detail);
  const ok = disagreements.length === 0 && fingerprintsAgree && lettersAgree && statusesAgree && books.agree && outbox.intact;
  return {
    actions: {
      expected: (state.actions ?? []).length,
      replayed: actionsReplayed,
      skipped: actionsSkipped,
      disagreements: Object.freeze(actionDisagreements),
    },
    books,
    extracts: { expected: expectedExtracts, restored: restoredExtracts, fingerprintsAgree, duplicates },
    decisions: {
      expected: state.conventional.decisions.length,
      matched: matchedDecisions,
      restored: replayedDecisions,
      agree: decisionAgreements,
      disagreements: Object.freeze(disagreements.filter((d) => /^UAE-RULE/.test(d))),
    },
    letters: { expected: state.conventional.letters.length, restored: target.wording.documents().length, fingerprintsAgree: lettersAgree },
    filings: { expected: expectedFilings, restored: restoredFilings, statusesAgree },
    outbox,
    ok,
    detail: ok
      ? `every register replayed: ${actionsReplayed} action(s) taken again${duplicatesFiled > 0 ? ` (${duplicatesFiled} filing(s) already there)` : ''} and ${expectedExtracts} extract(s)${duplicates > 0 ? ` (${duplicates} already held, identical)` : ''}, ${state.conventional.decisions.length} decision(s), ${state.conventional.letters.length} letter(s) and ${expectedFilings} filing(s) came back the same${settled ? ', the books were replayed with them' : ''}, and the outbox chains from the beginning`
      : `the restore did not reproduce: ${disagreements.slice(0, 3).join('; ')}${disagreements.length > 3 ? ` and ${disagreements.length - 3} more` : ''}${disagreements.length === 0 ? ' the counts disagree and no record was named — see the replay log' : ''}`,
    replays,
  };
}

/** What a store owes its reader, written on the face of every snapshot. */
export const REGISTER_STORE_LIMITATION =
  'The registers are sealed into a canonical, checksummed snapshot with a migration path and replayed into a fresh world on restore; '
  + 'the outbox proves nothing was dropped between snapshots; every record remembers how far the books had got when it was made and is '
  + 're-proved against the books of its own moment; and the registers carry the actions they took, so a restart puts them back by taking '
  + 'those actions again, checked journal for journal. Two limits are stated rather than papered over: it is not yet a database (no '
  + 'transactional write, no concurrent-reader isolation, no incremental streaming of the outbox), and an action that posts no journal — a '
  + 'cash call, a free reinstatement — is anchored by the number of journals the books held when it happened, which places it in the right '
  + 'window but cannot order two such actions that land inside the same journal.';

export type { Money };
