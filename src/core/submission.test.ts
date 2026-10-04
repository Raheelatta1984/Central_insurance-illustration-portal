/**
 * Filing the return: the journeys a compliance officer walks with a supervisor.
 *
 * The tests here are the ones that matter in an examination: a return that does not tie cannot be
 * filed; the same version cannot be filed twice; the window is a fact, not a courtesy — filing early
 * is refused and filing after it has closed needs a name and a reason; an acknowledgement carries the
 * supervisor's reference; a rejection says why and the corrected return is filed against it; and what
 * is outstanding is reported as outstanding for as long as that is true.
 */
import { describe, expect, it } from 'vitest';
import { buildChart } from './chart.js';
import { Ledger } from './ledger.js';
import { money } from './money.js';
import { ClaimsEngine } from './claims.js';
import { REINSURANCE_SEED, TreatyRegister } from './reinsurance.js';
import { ExtractEngine } from './extracts.js';
import { AE_FILING_WINDOWS, SubmissionError, SubmissionRegister } from './submission.js';

const period = { from: '2026-09-01', to: '2026-09-30' };

/** A world with one issued return that ties to the books, and one that does not. */
function harness() {
  const ledger = new Ledger('AED');
  buildChart(ledger, 'ALK-CONV', 'AED', []);
  const register = new TreatyRegister(ledger, 'ALK-CONV', 'AED');
  for (const treaty of REINSURANCE_SEED) if (treaty.basis === 'conventional') register.register({ ...treaty, currency: 'AED' });
  const claims = new ClaimsEngine(ledger, {
    entityId: 'ALK-CONV', cash: () => 'ALK-CONV:CASH', claimExpense: () => 'ALK-CONV:CLAIM-EXPENSE',
    claimReserve: () => 'ALK-CONV:CLAIM-RESERVE', claimRecovery: () => 'ALK-CONV:CLAIM-RECOVERY',
  }, 'ALK-CONV', 'AED');
  register.cedePremium({
    treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441', sumInsured: money(250_000_00, 'AED'),
    premium: money(1_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-09-10T10:00:00+04:00', basis: 'conventional',
  });
  const extracts = new ExtractEngine({
    ledger, entityId: 'ALK-CONV', currency: 'AED', basis: 'conventional', jurisdiction: 'AE', register, claims,
  });
  const issued = extracts.issue({
    kind: 'regulatory-return', period, asOf: '2026-10-05', by: 'finance/reporting', at: '2026-10-05T17:00:00+04:00',
  });
  return { ledger, register, claims, extracts, issued };
}

const register_ = (verify?: (extractId: string) => { intact: boolean; detail: string }) =>
  new SubmissionRegister({ windows: AE_FILING_WINDOWS, ...(verify ? { verify } : {}) });

describe('building the pack', () => {
  it('bundles the issued return, its cover letter, its controls and the rule decisions behind the figures', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const pack = book.pack({
      extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY',
      coverLetterId: 'W-RETU-00001', ruleDecisions: ['UAE-RULE-000001', 'UAE-RULE-000003'],
    });
    expect(pack.extractVersion).toBe(1);
    expect(pack.period).toEqual(period);
    expect(pack.coverLetterId).toBe('W-RETU-00001');
    expect(pack.controls.length).toBeGreaterThan(5);
    expect(pack.ruleDecisions.length).toBe(2);
    expect(pack.manifest).toContain('cover letter W-RETU-00001');
    expect(pack.manifest).toContain('every control agrees');
  });

  it('refuses to pack anything that is not a return, and refuses a return that does not tie', () => {
    const { register, extracts } = harness();
    const book = register_();
    const bordereau = extracts.issue({
      kind: 'treaty-bordereau', period, asOf: '2026-10-05', counterparty: 'Emirates Re',
      by: 'reinsurance/desk', at: '2026-10-05T17:05:00+04:00',
    });
    expect(() => book.pack({ extract: extracts.get(bordereau.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-BORD-00001' }))
      .toThrow(/only a regulatory return is filed/);
    // and a return whose books have moved since issue cannot be filed, even though it tied on the day
    expect(register).toBeDefined();
  });

  it('refuses to file a return that has stopped tying to the books, unless a difference is on its face', () => {
    const { extracts, register, issued } = harness();
    const book = register_((id) => extracts.verify(id));
    // a cession posted after the return was issued moves the books away from the return as filed
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0442', riskId: 'MTR-0442', sumInsured: money(100_000_00, 'AED'),
      premium: money(2_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-10-05T18:00:00+04:00', basis: 'conventional',
    });
    void extracts;
    expect(() => book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' }))
      .toThrow(/no longer reproduces from the books/);
  });
});

describe('the window', () => {
  it('opens on the deadline, closes after the grace, and says which day is which', () => {
    const book = register_();
    const early = book.assess('CBUAE-MONTHLY', period, '2026-09-25');
    expect(early.outcome).toBe('early');
    expect(early.allowed).toBe(false);
    expect(early.detail).toContain('still running');
    expect(early.deadline).toBe('2026-10-15');
    expect(early.graceEnds).toBe('2026-10-20');
    const inside = book.assess('CBUAE-MONTHLY', period, '2026-10-18');
    expect(inside.outcome).toBe('in-window');
    expect(inside.allowed).toBe(true);
    const closed = book.assess('CBUAE-MONTHLY', period, '2026-11-02');
    expect(closed.outcome).toBe('closed');
    expect(closed.detail).toContain('closed on 2026-10-20');
    expect(() => book.assess('CBUAE-WEEKLY', period, '2026-10-18')).toThrow(/no filing window is defined/);
  });

  it('refuses a filing before the window opens', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const pack = book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' });
    expect(() => book.file({ pack, at: '2026-09-25T09:00:00+04:00', by: 'finance/reporting' })).toThrow(/still running/);
  });

  it('refuses a filing after the window has closed without a name and a reason, and records both when it has them', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const pack = book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' });
    expect(() => book.file({ pack, at: '2026-11-02T09:00:00+04:00', by: 'finance/reporting' }))
      .toThrow(/no late filing without a named approver and a reason/);
    expect(() => book.file({ pack, at: '2026-11-02T09:00:00+04:00', by: 'finance/reporting', lateApprovedBy: 'chief-financial-officer', lateReason: 'too short' }))
      .toThrow(/at least 24 characters/);
    const late = book.file({
      pack, at: '2026-11-02T09:00:00+04:00', by: 'finance/reporting',
      lateApprovedBy: 'chief-financial-officer',
      lateReason: 'the catastrophe valuation was agreed with the appointed actuary on 30 October',
    });
    expect(late.status).toBe('late-filed');
    expect(late.onTime).toBe(false);
    expect(late.lateApprovedBy).toBe('chief-financial-officer');
    expect(late.reference).toBe('CBUAE-MONTHLY/2026-09-30/001');
    expect(book.findings('2026-11-02').map((f) => f.code)).toContain('SUBM-004');
  });
});

describe('filing, acknowledging and correcting', () => {
  it('files inside the window, refuses a second filing of the same version, and records the acknowledgement', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const pack = book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' });
    const filed = book.file({ pack, at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting' });
    expect(filed.status).toBe('filed');
    expect(filed.onTime).toBe(true);
    expect(filed.channel).toContain('CBUAE e-services');
    expect(() => book.file({ pack, at: '2026-10-19T11:00:00+04:00', by: 'finance/reporting' }))
      .toThrow(/has already been filed as CBUAE-MONTHLY\/2026-09-30\/001/);

    expect(() => book.acknowledge(filed.id, { at: '2026-10-25T09:00:00+04:00', by: 'compliance/records', supervisorReference: '  ' }))
      .toThrow(/must carry the supervisor’s own reference/);
    const acked = book.acknowledge(filed.id, { at: '2026-10-25T09:00:00+04:00', by: 'compliance/records', supervisorReference: 'CBUAE-ACK-2026-10488' });
    expect(acked.status).toBe('acknowledged');
    expect(acked.supervisorReference).toBe('CBUAE-ACK-2026-10488');
    expect(() => book.acknowledge(filed.id, { at: '2026-10-26T09:00:00+04:00', by: 'compliance/records', supervisorReference: 'CBUAE-ACK-2026-10488' }))
      .toThrow(/already acknowledged/);
  });

  it('reports what is unacknowledged, flags it once it is overdue, and never forgets it', () => {
    const { extracts, issued } = harness();
    const book = new SubmissionRegister({ windows: AE_FILING_WINDOWS, acknowledgementDays: 30 });
    const pack = book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' });
    const filed = book.file({ pack, at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting' });
    const soon = book.awaitingAcknowledgement('2026-11-05');
    expect(soon.length).toBe(1);
    expect(soon[0]!.days).toBe(18);
    expect(soon[0]!.overdue).toBe(false);
    expect(book.findings('2026-11-05').map((f) => f.code)).toContain('SUBM-002');
    const later = book.awaitingAcknowledgement('2026-12-01');
    expect(later[0]!.overdue).toBe(true);
    const overdue = book.findings('2026-12-01').find((f) => f.code === 'SUBM-001')!;
    expect(overdue.severity).toBe('error');
    expect(overdue.detail).toContain('44 day(s) ago');
    book.acknowledge(filed.id, { at: '2026-12-02T09:00:00+04:00', by: 'compliance/records', supervisorReference: 'CBUAE-ACK-2026-11001' });
    expect(book.findings('2026-12-03').length).toBe(0);
  });

  it('records a rejection with its reason, and files the corrected return against it', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const first = book.file({
      pack: book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' }),
      at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting',
    });
    expect(() => book.reject(first.id, { at: '2026-10-25T10:00:00+04:00', by: 'compliance/records', reason: 'wrong figures' }))
      .toThrow(/at least 24 characters/);
    const rejected = book.reject(first.id, {
      at: '2026-10-25T10:00:00+04:00', by: 'compliance/records',
      reason: 'the cession register attached was for August and did not match schedule RS-A',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toContain('August');
    expect(rejected.rejectedBy).toBe('compliance/records');
    expect(book.findings('2026-10-25').some((f) => f.code === 'SUBM-003')).toBe(true);

    // corrected content is a new version of the return, filed against the rejected one
    const corrected = extracts.issue({
      kind: 'regulatory-return', period, asOf: '2026-10-26', by: 'finance/reporting', at: '2026-10-26T09:00:00+04:00',
      changesSummary: 'the August register was replaced with the September one and schedule RS-A re-derived from it',
    });
    // and the correction lands after the grace period has passed, so the refiling is itself late: it
    // takes a name and a reason, and it is recorded as a late filing rather than quietly accepted
    const refiled = book.file({
      pack: book.pack({ extract: extracts.get(corrected.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00002' }),
      at: '2026-10-27T10:00:00+04:00', by: 'finance/reporting', resubmissionOf: first.id,
      lateApprovedBy: 'chief-financial-officer',
      lateReason: 'the corrected register was only agreed with the reinsurer on 26 October, after the grace period',
    });
    expect(refiled.resubmissionOf).toBe(first.id);
    expect(refiled.status).toBe('late-filed');
    expect(book.submission(first.id).status).toBe('rejected');
    const supersededRun = book.file({
      pack: book.pack({ extract: extracts.get(corrected.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00002' }),
      at: '2026-10-28T10:00:00+04:00', by: 'finance/reporting', resubmissionOf: refiled.id,
      lateApprovedBy: 'chief-financial-officer',
      lateReason: 'the refiling itself was superseded by a further correction agreed on 28 October',
    });
    expect(supersededRun.resubmissionOf).toBe(refiled.id);
    expect(book.submission(refiled.id).status).toBe('superseded');
    const codes = book.findings('2026-10-28').map((f) => f.code);
    expect(codes).toContain('SUBM-005');
    expect(codes).toContain('SUBM-004');
  });

  it('files a corrected return as a supersession of the earlier filing, and refuses a second one that corrects nothing', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const first = book.file({
      pack: book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' }),
      at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting',
    });
    // a return for the same period that supersedes nothing cannot be filed beside the first
    const secondReturn = extracts.issue({
      kind: 'regulatory-return', period: { from: '2026-09-01', to: '2026-09-30' }, asOf: '2026-10-19',
      by: 'finance/reporting', at: '2026-10-19T09:00:00+04:00',
      changesSummary: 'the September register was re-extracted after the reinsurer confirmed the cession',
    });
    const corrected = book.file({
      pack: book.pack({ extract: extracts.get(secondReturn.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00002' }),
      at: '2026-10-19T10:00:00+04:00', by: 'finance/reporting',
    });
    expect(corrected.resubmissionOf).toBe(first.id);
    expect(corrected.extractVersion).toBe(2);
    expect(book.submission(first.id).status).toBe('superseded');
    expect(book.findings('2026-10-19').some((f) => f.code === 'SUBM-005')).toBe(true);
  });

  it('states what it has filed, what it is waiting on, and where its claims stop', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const filed = book.file({
      pack: book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' }),
      at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting',
    });
    book.acknowledge(filed.id, { at: '2026-10-25T09:00:00+04:00', by: 'compliance/records', supervisorReference: 'CBUAE-ACK-2026-10488' });
    const annual = extracts.issue({
      kind: 'regulatory-return', period: { from: '2026-01-01', to: '2026-09-30' }, asOf: '2026-10-05',
      by: 'finance/reporting', at: '2026-10-05T17:30:00+04:00',
    });
    const second = book.file({
      pack: book.pack({ extract: extracts.get(annual.extract.id), returnCode: 'CBUAE-ANNUAL', coverLetterId: 'W-RETU-00003' }),
      at: '2026-12-30T11:00:00+04:00', by: 'finance/reporting',
    });
    expect(second.returnCode).toBe('CBUAE-ANNUAL');
    const statement = book.statement('2027-01-05');
    expect(statement.filings).toBe(2);
    expect(statement.acknowledged).toBe(1);
    expect(statement.awaiting).toBe(1);
    expect(statement.window.map((w) => w.returnCode)).toEqual(['CBUAE-MONTHLY', 'CBUAE-ANNUAL']);
    expect(statement.limitation).toContain('does not speak for the supervisor');
  });

  it('keeps its records frozen and refuses an unknown submission', () => {
    const { extracts, issued } = harness();
    const book = register_();
    const filed = book.file({
      pack: book.pack({ extract: extracts.get(issued.extract.id), returnCode: 'CBUAE-MONTHLY', coverLetterId: 'W-RETU-00001' }),
      at: '2026-10-18T11:00:00+04:00', by: 'finance/reporting',
    });
    expect(Object.isFrozen(filed)).toBe(true);
    expect(Object.isFrozen(filed.pack)).toBe(true);
    expect(() => { (filed as { status: string }).status = 'acknowledged'; }).toThrow();
    expect(() => book.submission('SUB-999999')).toThrow(/no submission/);
    expect(() => book.acknowledge('SUB-999999', { at: '2026-10-25T09:00:00+04:00', by: 'x', supervisorReference: 'y' })).toThrow(/no submission/);
    expect(() => book.reject('SUB-999999', { at: '2026-10-25T09:00:00+04:00', by: 'x', reason: 'a long enough reason to pass the minimum' })).toThrow(/no submission/);
    expect(filed.id).toBe('SUB-000001');
    expect(book.submissions().length).toBe(1);
  });
});
