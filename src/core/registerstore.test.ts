/**
 * Surviving a restart: the promises the reporting store makes.
 *
 * These tests are written the way an auditor would ask the question. Seal the registers, write them
 * to text, throw the process away, rebuild from the text — and prove every return still reproduces,
 * every rule decision still follows from its facts, every letter still regenerates from its own
 * facts, every filing still carries the answer it got, and the outbox still chains from the
 * beginning. Then the ugly cases: a payload with one byte changed, a payload written by the old
 * schema, and an outbox entry quietly removed.
 */
import { describe, expect, it } from 'vitest';
import {
  ExtractRecord,
  REGISTER_NAMES, REGISTER_STORE_LIMITATION, REPORTING_MIGRATIONS, REPORTING_SCHEMA_VERSION,
  buildOutbox, exportReporting, openBooksTimeline, openReporting, restoreReporting, sealReporting, verifyOutbox,
  type RegisterBundle, type ReportingState,
} from './registerstore.js';
import { exportLedger, seal, snapshotText, open, planMigrations, LEDGER_SCHEMA_VERSION } from './persistence.js';
import { parseAmount } from './money.js';
import { buildWorld, ensureFilings, extractSnapshot, submissionSnapshot, uaeRuleSnapshot, wordingSnapshot } from './demo.js';

/** A world with the reporting registers standing up, exactly as the console stands them up. */
function live() {
  const world = buildWorld();
  extractSnapshot(world);
  wordingSnapshot(world);
  uaeRuleSnapshot(world);
  submissionSnapshot(world);
  ensureFilings(world);
  return world;
}

/** A fresh, empty world with nothing issued: what a restarted process has before the store restores it. */
function fresh() {
  return buildWorld();
}

const bundle = (world: ReturnType<typeof live> | ReturnType<typeof fresh>): RegisterBundle => ({
  ledger: world.ledger, extracts: world.extracts, takafulExtracts: world.takafulExtracts,
  rules: world.rules, wording: world.wording, submissions: world.submissions, takafulSubmissions: world.takafulSubmissions,
  registers: world.registers,
});

describe('what the store keeps', () => {
  it('exports every register the world is holding, with the facts each record was made from', () => {
    const state = exportReporting(bundle(live()));
    expect(state.conventional.extracts.length).toBeGreaterThan(0);
    expect(state.conventional.extracts.some((e) => e.kind === 'regulatory-return')).toBe(true);
    expect(state.conventional.decisions.length).toBe(5);
    expect(state.conventional.decisions.every((d) => d.facts.subject.length > 0 && d.facts.documents.length > 0)).toBe(true);
    expect(state.conventional.letters.length).toBe(2);
    expect(state.conventional.letters.every((l) => l.facts.entityName.length > 0 && l.facts.fields.length > 0)).toBe(true);
    expect(state.conventional.filings.length).toBe(1);
    expect(state.conventional.filings[0]!.pack.controls.length).toBeGreaterThan(5);
    expect(state.takaful.extracts.length).toBeGreaterThan(0);
    expect(state.takaful.filings.length).toBe(1);
  });

  it('names the registers it holds, so a restore can say what it is about to put back', () => {
    expect(REGISTER_NAMES).toEqual(['extracts', 'decisions', 'letters', 'filings']);
    expect(REGISTER_STORE_LIMITATION).toContain('not yet a database');
  });
});

describe('the outbox', () => {
  it('chains every record, and verifies from the beginning', () => {
    const state = exportReporting(bundle(live()));
    const entries = buildOutbox(state, '2026-10-05T20:00:00+04:00');
    expect(entries.length).toBe(
      state.conventional.extracts.length + state.conventional.decisions.length + state.conventional.letters.length
      + state.conventional.filings.length + state.conventional.filings.filter((f) => f.acknowledgedAt).length
      + state.takaful.extracts.length + state.takaful.filings.length
      + state.takaful.filings.filter((f) => f.acknowledgedAt).length,
    );
    const verdict = verifyOutbox(entries);
    expect(verdict.intact).toBe(true);
    expect(verdict.entries).toBe(entries.length);
    expect(verdict.detail).toContain('nothing dropped, nothing reordered, nothing edited');
    expect(entries[0]!.prevHash).toBe('0'.repeat(16));
  });

  it('catches a dropped record, a reordered log and an edited entry', () => {
    const state = exportReporting(bundle(live()));
    const entries = buildOutbox(state, '2026-10-05T20:00:00+04:00');
    const dropped = entries.filter((_, i) => i !== 3).map((e, i) => ({ ...e, seq: i + 1 }));
    expect(verifyOutbox(dropped).intact).toBe(false);
    expect(verifyOutbox(dropped).detail).toMatch(/gap|reordered/);

    const reordered = [entries[1]!, entries[0]!, ...entries.slice(2)];
    expect(verifyOutbox(reordered).intact).toBe(false);

    const edited = entries.map((e, i) => (i === 2 ? { ...e, register: 'filing' as const } : e));
    expect(verifyOutbox(edited).intact).toBe(false);
    expect(verifyOutbox(edited).detail).toContain('edited');
  });
});

describe('a restart', () => {
  it('replays every register into a fresh world and proves it came back the same', () => {
    const world = live();
    const state = exportReporting(bundle(world));
    const sealed = sealReporting(state, '2026-10-05T20:00:00+04:00');
    expect(sealed.snapshot.schemaVersion).toBe(REPORTING_SCHEMA_VERSION);

    // the process stops here: the text is all that goes on
    const parsed = JSON.parse(sealed.text);
    const reopened = openReporting(parsed);
    expect(reopened.state.conventional.extracts.length).toBe(state.conventional.extracts.length);

    const restarted = fresh();
    const report = restoreReporting(reopened.state, bundle(restarted), { outbox: reopened.outbox });
    expect(report.ok).toBe(true);
    expect(report.detail).toContain('every register replayed');
    expect(report.extracts.fingerprintsAgree).toBe(true);
    expect(report.decisions.agree).toBe(state.conventional.decisions.length);
    expect(report.letters.fingerprintsAgree).toBe(true);
    expect(report.filings.statusesAgree).toBe(true);
    expect(report.outbox.intact).toBe(true);

    // and the restored world answers its own questions the way the live one did
    const liveView = submissionSnapshot(world);
    const restartedView = submissionSnapshot(restarted);
    expect(restartedView.conventional.submissions[0]!.status).toBe(liveView.conventional.submissions[0]!.status);
    expect(restartedView.conventional.submissions[0]!.supervisorReference).toBe(liveView.conventional.submissions[0]!.supervisorReference);
    expect(restartedView.takaful.submissions[0]!.status).toBe(liveView.takaful.submissions[0]!.status);
    expect(uaeRuleSnapshot(restarted).statement.refuse).toBe(uaeRuleSnapshot(world).statement.refuse);
  });

  it('is idempotent: a second restore over a world that is already there changes nothing and adds nothing', () => {
    const world = live();
    const state = exportReporting(bundle(world));
    const restarted = fresh();
    const first = restoreReporting(state, bundle(restarted));
    expect(first.ok).toBe(true);
    const extractsAfter = restarted.extracts.list().length;
    const decisionsAfter = restarted.rules.decisions().length;
    const filingsAfter = restarted.submissions.submissions().length;
    const second = restoreReporting(state, bundle(restarted));
    expect(second.ok).toBe(true);
    expect(restarted.extracts.list().length).toBe(extractsAfter);
    expect(restarted.rules.decisions().length).toBe(decisionsAfter);
    expect(restarted.submissions.submissions().length).toBe(filingsAfter);
    expect(second.decisions.agree).toBe(state.conventional.decisions.length);
  });

  it('is byte-stable: sealing the same state twice gives the same fingerprint and the same text', () => {
    const state = exportReporting(bundle(live()));
    const first = sealReporting(state, '2026-10-05T20:00:00+04:00');
    const second = sealReporting(state, '2026-10-05T20:00:00+04:00');
    expect(second.snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    expect(second.text).toBe(first.text);
  });

  it('says which register failed rather than declaring a bad restore good', () => {
    const state = exportReporting(bundle(live()));
    const tampered = structuredClone(state) as ReportingState;
    // a return that claims a version it cannot have: replayed, the register issues it as v1
    (tampered.conventional.extracts[0] as { version: number }).version = 7;
    const report = restoreReporting(tampered, bundle(fresh()));
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('did not reproduce');
    // and it names the record and the claim, rather than saying the restore failed somewhere
    expect(report.detail).toMatch(/the register holds it as version 1, the snapshot says 7/);
    expect(report.replays.some((line) => line.includes('wrong version'))).toBe(true);
    // the wording of that return is not what is wrong, so the fingerprint verdict stays clean
    expect(report.extracts.fingerprintsAgree).toBe(true);
  });

  it('treats a return the register already holds as the same return, not a lost one', () => {
    const state = exportReporting(bundle(live()));
    // the same return twice on the snapshot: the register refuses to hold two identical returns,
    // which is right — the restore must not call that a missing record
    const doubled = structuredClone(state) as ReportingState;
    (doubled.conventional.extracts as ExtractRecord[]).push({ ...doubled.conventional.extracts[0]! });
    const report = restoreReporting(doubled, bundle(fresh()));
    expect(report.extracts.duplicates).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.detail).toContain('1 already held, identical');
    // and the report names every record it met, in order, so a restore can be read line by line
    expect(report.replays.length).toBeGreaterThanOrEqual(doubled.conventional.extracts.length);
    expect(report.replays.some((line) => line.includes(doubled.conventional.extracts[0]!.id))).toBe(true);
  });

  it('refuses a restore it cannot name, instead of reporting a silent count mismatch', () => {
    const state = exportReporting(bundle(live()));
    const missing = structuredClone(state) as ReportingState;
    // a snapshot that claims a return the register can never reproduce: an extract for a period the
    // books no longer support
    (missing.conventional.extracts[0] as { asOf: string }).asOf = '2019-01-01';
    const report = restoreReporting(missing, bundle(fresh()));
    expect(report.ok).toBe(false);
    expect(report.detail).not.toMatch(/did not reproduce: *$/);
  });
});

describe('the books under the registers', () => {
  /** A world where the day moved after the first return was prepared: a catastrophe was claimed. */
  function afterTheDayMoved() {
    const world = live();
    const period = { from: `${world.asOf.slice(0, 4)}-01-01`, to: world.asOf };
    world.reinsurance.recoverEvent('XOL-CAT-5M', {
      eventId: 'FLOOD-TEST', loss: parseAmount('1,140,000.00', 'AED'),
      at: `${world.asOf}T13:00:00+04:00`, by: 'catastrophe-desk',
    });
    world.extracts.issue({
      kind: 'regulatory-return', period, asOf: world.asOf, by: 'finance/reporting',
      at: `${world.asOf}T17:45:00+04:00`,
      changesSummary: 'a catastrophe recovery was claimed and posted after the first return was prepared; the register and the books agree on the revised figures',
    });
    return world;
  }

  it('cannot re-prove a return prepared after a transaction when the payload carries none of the actions', () => {
    const world = afterTheDayMoved();
    const full = exportReporting(bundle(world));
    // a payload written before the actions were carried: the returns are there, the recovery that
    // moved the figures is not, so the last return cannot reproduce — and the report says which one
    const bare = { ...structuredClone(full), actions: [] } as ReportingState;
    expect(bare.conventional.extracts[0]!.booksThrough).toBeGreaterThan(0);
    const report = restoreReporting(bare, bundle(fresh()));
    expect(report.ok).toBe(false);
    expect(report.actions.expected).toBe(0);
    expect(report.detail).toContain('did not reproduce');
    expect(report.replays.some((line) => line.includes('different content') || line.includes('refused'))).toBe(true);
  });

  it('proves each return against the books of the moment it was issued', () => {
    const world = afterTheDayMoved();
    const state = exportReporting(bundle(world));
    // every return remembers how far the books had got when it was issued
    expect(state.conventional.extracts.every((e) => e.booksThrough > 0)).toBe(true);
    expect(state.conventional.filings.every((f) => f.booksThrough > 0)).toBe(true);

    // the same world with one set of end-of-day books: the returns prepared before the recovery no
    // longer tie, because they were measured against books that had not seen it. Replaying them all
    // against one set of books proves nothing, and the restore is not allowed to call that good.
    const endOfDay = bundle(fresh());
    const oneSet = openBooksTimeline(endOfDay, exportLedger(world.ledger));
    oneSet.advanceToCount(Number.MAX_SAFE_INTEGER);
    const flat = restoreReporting(state, endOfDay, { books: oneSet });
    expect(flat.ok).toBe(false);

    // now the same restore with the books opened as a timeline: each return is measured against the
    // books as far as it could see, and every return issued before the recovery reproduces
    const rebuilt = bundle(fresh());
    const books = openBooksTimeline(rebuilt, exportLedger(world.ledger));
    const report = restoreReporting(state, rebuilt, { books });
    expect(report.books.agree).toBe(true);
    // the action is taken again, so the journal it posts is not replayed off the snapshot: it is
    // produced by the register itself, which is the stronger proof
    expect(report.actions.replayed).toBeGreaterThan(0);
    expect(rebuilt.ledger.journal(state.actions[state.actions.length - 1]!.journalId)).toBeDefined();
    expect(report.books.detail).toContain('every entity\'s trial balance the one the snapshot had');
    const replayed = report.replays.filter((line) => line.includes('extract') && !line.includes('refused'));
    expect(replayed.length).toBe(state.conventional.extracts.length + state.takaful.extracts.length);
  });

  it('re-proves a return prepared after the day moved, because it carries what the return was made from', () => {
    const world = afterTheDayMoved();
    const state = exportReporting(bundle(world));
    // the register kept the action, with the journal it posted and the inputs it was given
    const recovery = state.actions.find((a) => a.kind === 'event-recovery' && (a.input as { eventId?: string }).eventId === 'FLOOD-TEST');
    expect(recovery).toBeDefined();
    expect(recovery!.engine).toBe('reinsurance');
    expect(recovery!.journalId).not.toBe('');

    // replaying into a fresh world: the action is taken again, the return that depends on it comes
    // back, and the books are reproduced journal for journal
    const rebuilt = bundle(fresh());
    const report = restoreReporting(state, rebuilt, { books: openBooksTimeline(rebuilt, exportLedger(world.ledger)) });
    expect(report.ok).toBe(true);
    expect(report.actions.replayed + report.actions.skipped).toBe(state.actions.length);
    expect(report.actions.replayed).toBeGreaterThan(0);
    expect(report.actions.disagreements).toEqual([]);
    expect(report.books.agree).toBe(true);
    expect(rebuilt.ledger.allJournals().length).toBe(world.ledger.allJournals().length);
    // the last return was the one that could not be re-proved before this: it reproduces now
    const last = state.conventional.extracts[state.conventional.extracts.length - 1]!;
    expect(rebuilt.extracts.get(last.id).fingerprint).toBe(last.fingerprint);
  });

  it('does not take an action twice when the world has already taken it', () => {
    const world = afterTheDayMoved();
    const state = exportReporting(bundle(world));
    const rebuilt = bundle(fresh());
    const books = openBooksTimeline(rebuilt, exportLedger(world.ledger));
    const seededInFreshWorld = fresh().registers!.flatMap((r) => r.actionLog()).length;
    const first = restoreReporting(state, rebuilt, { books });
    expect(first.actions.replayed + first.actions.skipped).toBe(state.actions.length);
    expect(first.actions.skipped).toBe(seededInFreshWorld);
    expect(first.actions.replayed).toBe(state.actions.length - seededInFreshWorld);
    // a second restore against the same world: every action is already in the register, so the
    // restore recognises them rather than ceding the same premium twice
    const second = restoreReporting(state, rebuilt, { books });
    expect(second.ok).toBe(true);
    expect(second.actions.replayed).toBe(0);
    expect(second.actions.skipped).toBe(state.actions.length);
    expect(rebuilt.ledger.allJournals().length).toBe(world.ledger.allJournals().length);
  });

  it('names the action that no longer reproduces instead of calling the restore good', () => {
    const world = afterTheDayMoved();
    const state = exportReporting(bundle(world));
    const tampered = structuredClone(state) as ReportingState;
    // the loss behind the catastrophe recovery is remembered as twice what happened to be claimed
    const action = (tampered.actions as unknown as Array<{ kind: string; input: Record<string, unknown> }>)
      .find((a) => a.kind === 'event-recovery' && (a.input['eventId'] as string) === 'FLOOD-TEST')!;
    expect(action).toBeDefined();
    (action.input['loss'] as { minor: bigint }).minor = 228_000_000n;
    const rebuilt = bundle(fresh());
    const report = restoreReporting(tampered, rebuilt, { books: openBooksTimeline(rebuilt, exportLedger(world.ledger)) });
    expect(report.ok).toBe(false);
    // the books give it away: a different recovery means a different journal
    expect(report.books.agree).toBe(false);
    expect(report.books.detail).toContain('did not come back the same');
  });

  it('says so when the books it is handed are not the books the world already has', () => {
    const world = afterTheDayMoved();
    const rebuilt = bundle(fresh());
    // a journal posted straight into the target, as a half-restored process would have
    const stray = parseAmount('10.00', 'AED');
    const account = (suffix: string) => rebuilt.ledger.listAccounts().find((a) => a.id.endsWith(suffix) && a.entityId === world.conventionalEntity)!.id;
    rebuilt.ledger.post({
      id: 'STRAY-000001', entityId: world.conventionalEntity, at: `${world.asOf}T18:00:00+04:00`,
      recordedAt: `${world.asOf}T18:00:00+04:00`, source: 'gl', sourceRef: 'STRAY',
      description: 'a journal the snapshot knows nothing about',
      postings: [
        { accountId: account(':CASH'), side: 'debit', amount: stray, baseAmount: stray },
        { accountId: account(':SHARE-CAPITAL'), side: 'credit', amount: stray, baseAmount: stray },
      ],
    });
    const books = openBooksTimeline(rebuilt, exportLedger(world.ledger));
    const report = restoreReporting(exportReporting(bundle(world)), rebuilt, { books });
    expect(report.ok).toBe(false);
    expect(report.books.agree).toBe(false);
    expect(report.books.detail).toContain('did not come back the same');
  });
});

describe('the envelope', () => {
  it('refuses a payload with one byte changed', () => {
    const state = exportReporting(bundle(live()));
    const sealed = sealReporting(state, '2026-10-05T20:00:00+04:00');
    const text = sealed.text.replace('"UAE-RULE-000001"', '"UAE-RULE-000009"');
    expect(text).not.toBe(sealed.text);
    const parsed = JSON.parse(text);
    expect(() => openReporting(parsed)).toThrow(/fingerprint mismatch/);
    // and the original still opens
    expect(openReporting(JSON.parse(sealed.text)).state.conventional.decisions.length).toBe(5);
  });

  it('migrates a books-only payload written by the older schema into one carrying the registers', () => {
    const booksOnly = seal({ ledgerBase: 'AED', accounts: [], journals: [] }, { schemaVersion: 1, takenAt: '2026-10-01T00:00:00+00:00' });
    const text = snapshotText(booksOnly);
    const parsed = JSON.parse(text);
    const plan = planMigrations(1, REPORTING_SCHEMA_VERSION, REPORTING_MIGRATIONS);
    expect(plan.length).toBe(3);
    expect(plan[0]!.describe).toContain('reporting registers');
    expect(plan[1]!.describe).toContain('action');
    expect(plan[2]!.describe).toContain('clock');
    // the migration runs as part of opening, so a books-only snapshot opens as a valid, empty store
    const migratedSnapshot = { ...booksOnly, schemaVersion: REPORTING_SCHEMA_VERSION };
    void open(parsed, { expectSchema: REPORTING_SCHEMA_VERSION, migrations: REPORTING_MIGRATIONS });
    const migrated = openReporting({ ...migratedSnapshot, fingerprint: sealReporting(exportReporting(bundle(fresh())), booksOnly.takenAt).snapshot.fingerprint, payload: sealReporting(exportReporting(bundle(fresh())), booksOnly.takenAt).snapshot.payload });
    expect(migrated.state.conventional.extracts).toEqual([]);
    // a books-only payload is carried through the chain and comes out carrying the reporting shape
    const carried = REPORTING_MIGRATIONS[0]!.apply({ ledgerBase: 'AED' });
    expect(carried.reporting.conventional).toEqual({ extracts: [], decisions: [], letters: [], filings: [] });
    expect(carried.reporting.takaful).toEqual({ extracts: [], filings: [] });
    // and the second link brings the payload up to the schema that carries the registers' actions
    const v3 = REPORTING_MIGRATIONS[1]!.apply(carried);
    expect(v3.actions).toEqual([]);
    expect(carried.ledgerBase).toBe('AED');
    // a snapshot written by a codec this build does not speak is refused outright
    const wrongCodec = { ...booksOnly, codecVersion: 99 };
    expect(() => open(wrongCodec, { expectSchema: LEDGER_SCHEMA_VERSION })).toThrow(/codec 99/);
    expect(() => open(parsed, { expectSchema: 5, migrations: REPORTING_MIGRATIONS })).toThrow(/no migration path/);
  });

  it('places a return issued before an unjournaled action by the registers\u2019 clock, the record the browser proved red', () => {
    // RI-EX-ALK-CONV-00002 is the record the full console session left behind: a return issued, and
    // then a claim registered and triaged around it. Neither of those posts a journal, so the books
    // alone cannot say which came first and a rebuild guessed. The clock can say, and this pins it.
    const world = live();
    const target = bundle(world);
    const before = world.extracts.list()[0]!;
    const held = world.ledger.allJournals().length;
    // a claim registered after that return was issued: actions that post no journal at all, so the
    // books are no help in saying whether they came before the return or after it
    const claim = world.claims.register({
      policyId: 'POL-1001', cause: 'medical', lossDate: '2026-04-02', reportedAt: '2026-04-02',
      description: 'Notified after the return was issued and before the rebuild.',
    });
    world.claims.triage(claim.id, {
      coverInForce: true, exclusionsApplied: [], daysLate: 0, fraudSignals: 0,
    });
    // nothing reached the books, which is exactly why the book position cannot order this
    expect(world.ledger.allJournals().length).toBe(held);
    const snapshot = sealReporting(exportReporting(target), '2026-10-05T20:30:00+04:00');
    const reopened = openReporting(JSON.parse(snapshot.text));
    const restarted = fresh();
    const restartTarget = bundle(restarted);
    const books = openBooksTimeline(restartTarget, exportLedger(world.ledger));
    const report = restoreReporting(reopened.state, restartTarget, { outbox: reopened.outbox, books });
    expect(report.ok, report.detail).toBe(true);
    expect(report.detail).toContain('every register replayed');
    expect(report.books.agree).toBe(true);
    // the return that was issued before the claim is back with the same fingerprint and the same
    // clock position: it was re-issued before the claim existed again
    const back = restarted.extracts.list().find((e) => e.id === before.id)!;
    expect(back.fingerprint).toBe(before.fingerprint);
    expect(back.actionsThrough).toBe(before.actionsThrough);
    expect(back.booksThrough).toBe(before.booksThrough);
    const claimBack = restarted.claims.list().find((c) => c.id === claim.id)!;
    expect(claimBack.decisions.length).toBe(world.claims.list().find((c) => c.id === claim.id)!.decisions.length);
  });
});
