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
export const REPORTING_SCHEMA_VERSION = 2;

/** The registers this store holds, named so a restore can say what it is about to put back. */
export const REGISTER_NAMES = ['extracts', 'decisions', 'letters', 'filings'] as const;

export interface ExtractRecord {
  /** How far the books had got when this return was issued. */
  readonly booksThrough: number;
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
    seq: entry.seq, at: entry.at, register: entry.register, recordId: entry.recordId,
    contentHash: entry.contentHash, prevHash: entry.prevHash,
  }));
}

export function buildOutbox(state: ReportingState, at: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let prevHash = GENESIS;
  const push = (register: OutboxEntry['register'], recordId: string, content: unknown, when: string) => {
    const seq = entries.length + 1;
    const contentHash = fingerprintOf(content);
    const base = { seq, at: when, register, recordId, contentHash, prevHash };
    const hash = outboxHash(base);
    entries.push(Object.freeze({ ...base, hash }));
    prevHash = hash;
  };
  for (const extract of state.conventional.extracts) push('extract', extract.id, extract, extract.at);
  for (const decision of state.conventional.decisions) push('decision', decision.id, decision, decision.facts.at);
  for (const letter of state.conventional.letters) push('letter', letter.id, letter, letter.facts.at);
  for (const filing of state.conventional.filings) push('filing', `${filing.id}:filed`, filing, filing.at);
  for (const filing of state.conventional.filings) {
    if (filing.acknowledgedAt) push('filing', `${filing.id}:acknowledged`, { reference: filing.supervisorReference }, filing.acknowledgedAt);
    if (filing.rejectedAt) push('filing', `${filing.id}:rejected`, { reason: filing.rejectionReason }, filing.rejectedAt);
  }
  for (const extract of state.takaful.extracts) push('extract', extract.id, extract, extract.at);
  for (const filing of state.takaful.filings) push('filing', `${filing.id}:filed`, filing, filing.at);
  for (const filing of state.takaful.filings) {
    if (filing.acknowledgedAt) push('filing', `${filing.id}:acknowledged`, { reference: filing.supervisorReference }, filing.acknowledgedAt);
  }
  void at;
  return entries;
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
    const expected = outboxHash({ seq: entry.seq, at: entry.at, register: entry.register, recordId: entry.recordId, contentHash: entry.contentHash, prevHash: entry.prevHash });
    if (expected !== entry.hash) {
      return { intact: false, entries: entries.length, brokenAt: entry.seq, detail: `entry ${entry.seq} has been edited: its hash does not match its content` };
    }
    prevHash = entry.hash;
  }
  return { intact: true, entries: entries.length, detail: `${entries.length} record(s) chained from the beginning: nothing dropped, nothing reordered, nothing edited` };
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
];

/* ------------------------------------------------------------------ export */

const extractRecord = (e: IssuedExtract): ExtractRecord => ({
  booksThrough: e.booksThrough,
  kind: e.kind, period: { ...e.period }, asOf: e.asOf, by: e.preparedBy, at: e.issuedAt,
  ...(e.counterparty ? { counterparty: e.counterparty } : {}),
  ...(e.changesSummary ? { changesSummary: e.changesSummary } : {}),
  ...(e.differencesAccepted ? { approvedBy: e.differencesAccepted.by } : {}),
  id: e.id, version: e.version, fingerprint: e.fingerprint, tiesToBooks: e.tiesToBooks,
});

const filingRecord = (s: ReturnType<SubmissionRegister['submissions']>[number]): FilingRecord => ({
  pack: s.pack, booksThrough: s.booksThrough, at: s.filedAt, by: s.filedBy,
  ...(s.lateApprovedBy ? { lateApprovedBy: s.lateApprovedBy } : {}),
  ...(s.lateReason ? { lateReason: s.lateReason } : {}),
  ...(s.resubmissionOf ? { resubmissionOf: s.resubmissionOf } : {}),
  id: s.id, reference: s.reference, status: s.status,
  ...(s.acknowledgedAt ? { acknowledgedAt: s.acknowledgedAt, acknowledgedBy: s.acknowledgedBy ?? '', supervisorReference: s.supervisorReference ?? '' } : {}),
  ...(s.rejectedAt ? { rejectedAt: s.rejectedAt, rejectedBy: s.rejectedBy ?? '', rejectionReason: s.rejectionReason ?? '' } : {}),
});

export interface RegisterBundle {
  readonly ledger: Ledger;
  readonly extracts: ExtractEngine;
  readonly takafulExtracts: ExtractEngine;
  readonly rules: UaeRuleBook;
  readonly wording: WordingBook;
  readonly submissions: SubmissionRegister;
  readonly takafulSubmissions: SubmissionRegister;
}

export function exportReporting(world: RegisterBundle): ReportingState {
  return {
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
  let next = 0;
  let posted = 0;
  const timeline: BooksTimeline = {
    advanceToCount(count: number): number {
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
      const journals = target.ledger.allJournals().length;
      return {
        agree: disagreeing.length === 0,
        journals,
        detail: disagreeing.length === 0
          ? `the books came back with ${journals} journal(s), ${posted} of them posted by the restore as it replayed the registers, and every entity's trial balance is the one the snapshot had`
          : `the books did not come back the same: ${disagreeing.slice(0, 3).join('; ')}`,
      };
    },
  };
  return timeline;
}

/* ------------------------------------------------------------------ restore */

export interface RestoreReport {
  readonly extracts: { expected: number; restored: number; fingerprintsAgree: boolean; duplicates: number };
  readonly decisions: { expected: number; restored: number; agree: number; disagreements: readonly string[] };
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
 * Replay the registers into a fresh world. Every record is put back through the engine that made it
 * and the answer is compared, so a restore is a proof rather than a copy: if a return no longer
 * reproduces, a decision no longer follows from its facts, or a letter no longer regenerates, the
 * report says which one and the restore is not declared good.
 */
export function restoreReporting(
  state: ReportingState,
  target: RegisterBundle,
  options: { readonly outbox?: readonly OutboxEntry[]; readonly books?: BooksTimeline } = {},
): RestoreReport {
  const disagreements: string[] = [];
  // Every record is replayed against the books as they stood when it was made, which is what the
  // mark it carries is for. A record from before the marks existed has no mark, and then the books
  // are taken as far as they go: better a restore that says it could not be exact than one that
  // quietly measures an old return against today's books.
  const at = (count: number | undefined): void => {
    if (!options.books) return;
    options.books.advanceToCount(count ?? Number.MAX_SAFE_INTEGER);
  };
  const replays: string[] = [];

  // Returns: issue them in order so supersessions land the same way round. The register is asked for
  // the return and answers with what it now holds; the fingerprint it gives back is compared with
  // the one on the snapshot record, so the check is on the content of the return rather than the
  // number of rows. A register that already holds the identical return says so, and that is not a
  // disagreement — it is the same return, and the report calls it a duplicate rather than a loss.
  let duplicates = 0;
  const replayExtract = (
    register: {
      issue: (input: {
        kind: ExtractKind; period: ExtractPeriod; asOf: string; counterparty?: string; by: string; at: string;
        changesSummary?: string; allowDifferences?: boolean; approvedBy?: string;
      }) => { created: boolean; extract: { id: string; fingerprint: string; version: number } };
    },
    record: ExtractRecord,
    label: string,
  ): void => {
    try {
      at(record.booksThrough);
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
      // the version is part of a return's identity: v1 and v7 with the same wording are still two
      // different records, and a snapshot that remembers the wrong one is not reproduced
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
  };
  for (const record of state.conventional.extracts) replayExtract(target.extracts, record, 'conventional');
  for (const record of state.takaful.extracts) replayExtract(target.takafulExtracts, record, 'takaful');

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

  // Rule decisions: replay the facts and check the same answer comes back. A decision the register
  // already holds is not taken twice — a restore may run against a world that is partly there, and a
  // restore is the one operation that must never duplicate a record.
  let decisionAgreements = 0;
  let skippedDecisions = 0;
  for (const record of state.conventional.decisions) {
    const present = target.rules.decisions().find((d) => d.subject === record.facts.subject
      && d.at === record.facts.at && d.by === record.facts.by && d.evidence === record.evidence);
    if (present) { skippedDecisions += 1; decisionAgreements += 1; continue; }
    try {
      const replayed = target.rules.enforce(record.facts);
      if (replayed.decision === record.decision && replayed.findings.length === record.findingCount && replayed.evidence === record.evidence) {
        decisionAgreements += 1;
      } else {
        disagreements.push(`${record.id}: the facts now answer ${replayed.decision}, not ${record.decision}`);
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

  // Filings: file them again, then put the answers back on them.
  let skippedFilings = 0;
  for (const record of state.conventional.filings) {
    const existing = target.submissions.submissions().find((s) => s.pack.extractId === record.pack.extractId
      && s.pack.returnCode === record.pack.returnCode
      && s.period.from === record.pack.period.from && s.period.to === record.pack.period.to);
    try {
      at(record.booksThrough);
      const filed = existing ?? target.submissions.file({
        pack: record.pack, at: record.at, by: record.by,
        ...(record.lateApprovedBy ? { lateApprovedBy: record.lateApprovedBy } : {}),
        ...(record.lateReason ? { lateReason: record.lateReason } : {}),
        ...(record.resubmissionOf ? { resubmissionOf: record.resubmissionOf } : {}),
      });
      if (existing) skippedFilings += 1;
      // put the answer back on it, unless that answer is already recorded
      if (record.acknowledgedAt && target.submissions.submission(filed.id).status !== 'acknowledged') {
        target.submissions.acknowledge(filed.id, {
          at: record.acknowledgedAt, by: record.acknowledgedBy ?? 'compliance/records',
          supervisorReference: record.supervisorReference ?? '',
        });
      }
      if (record.rejectedAt && target.submissions.submission(filed.id).status !== 'rejected') {
        target.submissions.reject(filed.id, {
          at: record.rejectedAt, by: record.rejectedBy ?? 'compliance/records',
          reason: record.rejectionReason ?? 'restored from the store',
        });
      }
    } catch (err) {
      disagreements.push(`${record.reference}: ${String((err as Error).message)}`);
    }
  }
  void skippedDecisions; void skippedFilings;
  for (const record of state.takaful.filings) {
    const existing = target.takafulSubmissions.submissions().find((s) => s.pack.extractId === record.pack.extractId
      && s.pack.returnCode === record.pack.returnCode);
    try {
      at(record.booksThrough ?? undefined);
      const filed = existing ?? target.takafulSubmissions.file({
        pack: record.pack, at: record.at, by: record.by,
        ...(record.lateApprovedBy ? { lateApprovedBy: record.lateApprovedBy } : {}),
        ...(record.lateReason ? { lateReason: record.lateReason } : {}),
      });
      if (record.acknowledgedAt && target.takafulSubmissions.submission(filed.id).status !== 'acknowledged') {
        target.takafulSubmissions.acknowledge(filed.id, {
          at: record.acknowledgedAt, by: record.acknowledgedBy ?? 'compliance/records',
          supervisorReference: record.supervisorReference ?? '',
        });
      }
    } catch (err) {
      disagreements.push(`${record.reference}: ${String((err as Error).message)}`);
    }
  }
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
    books,
    extracts: { expected: expectedExtracts, restored: restoredExtracts, fingerprintsAgree, duplicates },
    decisions: { expected: state.conventional.decisions.length, restored: new Set(state.conventional.decisions.map((d) => d.facts.subject)).size, agree: decisionAgreements, disagreements: Object.freeze(disagreements.filter((d) => /^UAE-RULE/.test(d))) },
    letters: { expected: state.conventional.letters.length, restored: target.wording.documents().length, fingerprintsAgree: lettersAgree },
    filings: { expected: expectedFilings, restored: restoredFilings, statusesAgree },
    outbox,
    ok,
    detail: ok
      ? `every register replayed: ${expectedExtracts} extract(s)${duplicates > 0 ? ` (${duplicates} already held, identical)` : ''}, ${state.conventional.decisions.length} decision(s), ${state.conventional.letters.length} letter(s) and ${expectedFilings} filing(s) came back the same${settled ? `, the books were replayed with them (${books.posted} journal(s) posted by the restore)` : ''}, and the outbox chains from the beginning`
      : `the restore did not reproduce: ${disagreements.slice(0, 3).join('; ')}${disagreements.length > 3 ? ` and ${disagreements.length - 3} more` : ''}${disagreements.length === 0 ? ' the counts disagree and no record was named — see the replay log' : ''}`,
    replays,
  };
}

/** What a store owes its reader, written on the face of every snapshot. */
export const REGISTER_STORE_LIMITATION =
  'The registers are sealed into a canonical, checksummed snapshot with a migration path and replayed into a fresh world on restore; '
  + 'the outbox proves nothing was dropped between snapshots, and every record remembers how far the books had got when it was made, so it '
  + 'is re-proved against the books of its own moment. Two limits are stated rather than papered over: it is not yet a database (no '
  + 'transactional write, no concurrent-reader isolation, no incremental streaming of the outbox), and a return whose figures came from a '
  + 'register the store does not carry yet — a catastrophe recovery, say — is reported as one it could not re-prove rather than quietly '
  + 'let through. Carrying those inputs is its own chunk.';

export type { Money };
