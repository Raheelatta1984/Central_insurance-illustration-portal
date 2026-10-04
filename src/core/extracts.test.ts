/**
 * Regulatory and actuarial reporting extracts.
 *
 * These tests hold the promises that make an extract worth sending: the return ties to the books or
 * it is not issued, an issued return is immutable and reproduces on demand, a difference needs a
 * name against it and travels on the face of the document, and the takaful window files from its own
 * register so participant money is never reported inside the operator's numbers.
 */
import { describe, expect, it } from 'vitest';
import { buildChart } from './chart.js';
import { Ledger } from './ledger.js';
import { Money, money } from './money.js';
import { ClaimsEngine } from './claims.js';
import { REINSURANCE_SEED, TreatyRegister } from './reinsurance.js';
import { ExtractEngine, ExtractError, formatCell, isRatioCell } from './extracts.js';

const period = { from: '2026-09-01', to: '2026-09-30' };
const asOf = '2026-10-05';

/** A conventional book with one quota-share cession, one paid claim and one catastrophe recovery. */
function conventional() {
  const ledger = new Ledger('AED');
  buildChart(ledger, 'ALK-CONV', 'AED', []);
  const register = new TreatyRegister(ledger, 'ALK-CONV', 'AED');
  for (const treaty of REINSURANCE_SEED) if (treaty.basis === 'conventional') register.register({ ...treaty, currency: 'AED' });
  const claims = new ClaimsEngine(ledger, {
    entityId: 'ALK-CONV',
    cash: () => 'ALK-CONV:CASH',
    claimExpense: () => 'ALK-CONV:CLAIM-EXPENSE',
    claimReserve: () => 'ALK-CONV:CLAIM-RESERVE',
    claimRecovery: () => 'ALK-CONV:CLAIM-RECOVERY',
  }, 'ALK-CONV', 'AED');

  register.cedePremium({
    treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441', sumInsured: money(250_000_00, 'AED'),
    premium: money(1_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-09-10T10:00:00+04:00', basis: 'conventional',
  });
  // One claim paid in September (which leaves the reserve released and a recovery claimed back), and
  // one claim still open with a reserve on it — so the return has both a paid line and a reserve line.
  const paidClaim = claims.register({
    policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-12', reportedAt: '2026-09-13T10:00:00+04:00',
    description: 'rear-end collision',
  });
  claims.setReserve(paidClaim.id, { amount: money(10_000_00, 'AED'), at: '2026-09-14T10:00:00+04:00', by: 'claims-officer' });
  claims.approve(paidClaim.id, { amount: money(10_000_00, 'AED'), at: '2026-09-15T10:00:00+04:00', by: 'claims-manager', role: 'claims-manager' });
  claims.settle(paidClaim.id, { amount: money(4_000_00, 'AED'), at: '2026-09-20T10:00:00+04:00', by: 'treasury' });
  register.recoverClaim({
    policyId: 'MTR-0441', claim: claims, claimId: paidClaim.id, paid: money(4_000_00, 'AED'),
    at: '2026-09-21T10:00:00+04:00', by: 'recovery-desk',
  });

  const openClaim = claims.register({
    policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-25', reportedAt: '2026-09-26T10:00:00+04:00',
    description: 'windscreen and wing damage, still being assessed',
  });
  claims.setReserve(openClaim.id, { amount: money(6_000_00, 'AED'), at: '2026-09-27T10:00:00+04:00', by: 'claims-officer' });
  register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-09-15T10:00:00+04:00', by: 'catastrophe-desk' });

  const extracts = new ExtractEngine({
    ledger, entityId: 'ALK-CONV', currency: 'AED', basis: 'conventional', jurisdiction: 'AE', register, claims,
  });
  return { ledger, register, claims, extracts, claimId: paidClaim.id, openClaimId: openClaim.id };
}

/** The takaful window: its own entity, its own register, its own reserve. */
function takaful() {
  const ledger = new Ledger('AED');
  buildChart(ledger, 'ALK-TKF', 'AED', []);
  const register = new TreatyRegister(ledger, 'ALK-TKF', 'AED');
  for (const treaty of REINSURANCE_SEED) if (treaty.basis === 'takaful') register.register({ ...treaty, currency: 'AED' });
  const claims = new ClaimsEngine(ledger, {
    entityId: 'ALK-TKF',
    cash: () => 'ALK-TKF:CASH',
    claimExpense: () => 'ALK-TKF:CLAIM-EXPENSE',
    claimReserve: () => 'ALK-TKF:CLAIM-RESERVE',
    claimRecovery: () => 'ALK-TKF:CLAIM-RECOVERY',
  }, 'ALK-TKF', 'AED');
  register.cedePremium({
    treatyId: 'RTKF-QS-20', policyId: 'TKF-0001', riskId: 'TKF-0001', sumInsured: money(100_000_00, 'AED'),
    premium: money(1_800_00, 'AED'), lineOfBusiness: 'life', at: '2026-09-12T10:00:00+04:00', basis: 'takaful', fundId: 'PRF',
  });
  const extracts = new ExtractEngine({
    ledger, entityId: 'ALK-TKF', currency: 'AED', basis: 'takaful', jurisdiction: 'AE', register, claims,
  });
  return { ledger, register, claims, extracts };
}

const row = (draft: { tables: readonly { code: string; rows: readonly { code: string; values: readonly unknown[] }[] }[] }, table: string, code: string) => {
  const t = draft.tables.find((x) => x.code === table)!;
  const r = t.rows.find((x) => x.code === code || x.code.startsWith(code));
  expect(r, `${table} row ${code}`).toBeDefined();
  return r!.values;
};

describe('regulatory return', () => {
  it('builds the four schedules from the register, with every control agreeing', () => {
    const { extracts } = conventional();
    const draft = extracts.regulatoryReturn({ period, asOf });
    expect(draft.tables.map((t) => t.code)).toEqual(['RS-A', 'RS-B', 'RS-C', 'RS-D']);
    expect(draft.controls.every((c) => c.state === 'agrees')).toBe(true);
    expect(draft.controls.map((c) => c.code)).toContain('RS-C.receivable');
    expect(draft.preparedBy).toBe('finance/reporting');

    // A.1 premium written on ceded risks = 1,000.00; A.2 ceded 25% = 250.00; A.6 commission 15% of ceded = 37.50
    const [gross, ceded, net] = row(draft, 'RS-A', 'A.1') as (Money | null)[];
    expect(gross!.minor).toBe(1_000_00n);
    expect(ceded).toBeNull();
    expect(net!.minor).toBe(1_000_00n);
    expect((row(draft, 'RS-A', 'A.2')[1] as Money).minor).toBe(250_00n);
    expect((row(draft, 'RS-A', 'A.7')[0] as Money).minor).toBe(37_50n);      // commission
    expect((row(draft, 'RS-A', 'A.6')[2] as Money).minor).toBe(750_00n);    // 1,000 less 250 ceded
    // A.4 is the deposit premium recognised on settlement: nil here, because nothing was settled yet.
    expect((row(draft, 'RS-A', 'A.4')[1] as Money).minor).toBe(0n);

    // B.1 claims paid on ceded risks 4,000.00; B.4 reserve 6,000.00 gross; B.5 the reinsurer's 25% = 1,500.00
    expect((row(draft, 'RS-B', 'B.1')[0] as Money).minor).toBe(4_000_00n);
    expect((row(draft, 'RS-B', 'B.4')[0] as Money).minor).toBe(6_000_00n);
    expect((row(draft, 'RS-B', 'B.5')[1] as Money).minor).toBe(1_500_00n);
    expect((row(draft, 'RS-B', 'B.6')[2] as Money).minor).toBe(4_500_00n);

    // C: one row per counterparty, and the catastrophe recovery is Emirates Re's
    const emirates = draft.tables.find((t) => t.code === 'RS-C')!.rows.find((r) => r.code === 'C.Emirates Re')!;
    expect((emirates.values[0] as Money).minor).toBe(600_000_00n);
    const gulf = draft.tables.find((t) => t.code === 'RS-C')!.rows.find((r) => r.code === 'C.Gulf Reinsurance PSC')!;
    // The policy recovery is this test's claim: 25% of the 4,000.00 paid, plus the 37.50 commission due.
    expect((gulf.values[0] as Money).minor).toBe(1_000_00n + 37_50n);
    expect((gulf.values[1] as Money).minor).toBe(250_00n);                 // premium ceded, unpaid
    expect(draft.limitations.join(' ')).toMatch(/No IBNR estimate/);
  });

  it('refuses to be issued when a control disagrees, and accepts a difference only with a named approver and a reason', () => {
    const { ledger, extracts } = conventional();
    // A journal posted straight to the receivable account that the register knows nothing about.
    ledger.post({
      id: 'TEST-ORPHAN', entityId: 'ALK-CONV', at: `${asOf}T09:00:00+04:00`, source: 'test', sourceRef: 'orphan',
      description: 'an orphan receivable the register cannot explain',
      postings: [
        { accountId: 'ALK-CONV:REINS:RECEIVABLE', side: 'debit', amount: money(1_000_00, 'AED'), baseAmount: money(1_000_00, 'AED') },
        { accountId: 'ALK-CONV:REINS:RECOVERY', side: 'credit', amount: money(1_000_00, 'AED'), baseAmount: money(1_000_00, 'AED') },
      ],
    });
    const draft = extracts.regulatoryReturn({ period, asOf });
    const control = draft.controls.find((c) => c.code === 'RS-C.receivable')!;
    expect(control.state).toBe('difference');
    expect(control.detail).toMatch(/a difference of -?1,000\.00 AED/);

    expect(() => extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00` }))
      .toThrow(/an extract that does not tie cannot be issued/);
    expect(() => extracts.issue({
      kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00`,
      allowDifferences: true, changesSummary: 'a recovered item was booked before the register was updated',
    })).toThrow(/needs a named approver/);
    expect(() => extracts.issue({
      kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00`,
      allowDifferences: true, approvedBy: 'chief-financial-officer', changesSummary: 'too short',
    })).toThrow(/say why a difference is being accepted/);

    const { created, extract } = extracts.issue({
      kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00`,
      allowDifferences: true, approvedBy: 'chief-financial-officer',
      changesSummary: 'a recovered item was booked a day before the register was updated; the register is right and the books catch up on Monday',
    });
    expect(created).toBe(true);
    expect(extract.tiesToBooks).toBe(false);
    expect(extract.differencesAccepted).toEqual({
      by: 'chief-financial-officer',
      reason: 'a recovered item was booked a day before the register was updated; the register is right and the books catch up on Monday',
    });
    // One orphan journal breaks two controls: the receivable itself, and the recoveries-still-to-collect
    // tie that reads through it. Both are reported, because both are true.
    expect(extract.controls.filter((c) => c.state === 'difference')).toHaveLength(2);
  });

  it('is idempotent, and a reissue for the same period needs a reason before it supersedes anything', () => {
    const { register, extracts } = conventional();
    const first = extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00` });
    expect(first.created).toBe(true);
    const again = extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T19:00:00+04:00` });
    expect(again.created).toBe(false);
    expect(again.extract.id).toBe(first.extract.id);
    expect(extracts.list()).toHaveLength(1);

    // A later transaction changes the figures: now a reissue is different content and needs a reason.
    register.recoverEvent('XOL-CAT-5M', { eventId: 'FLOOD-2', loss: money(1_100_000_00, 'AED'), at: '2026-09-28T10:00:00+04:00' });
    expect(() => extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T20:00:00+04:00` }))
      .toThrow(/say what changed and why before superseding a return/);
    const v2 = extracts.issue({
      kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T20:00:00+04:00`,
      changesSummary: 'FLOOD-2 was claimed on 28 September, after the first extract was prepared',
    });
    expect(v2.extract.version).toBe(2);
    expect(v2.extract.supersedes).toBe(first.extract.id);
    expect(extracts.history('regulatory-return', period).map((h) => h.version)).toEqual([1, 2]);

    // And history cannot be rewritten: an extract dated before the one it replaces is refused.
    expect(() => extracts.issue({
      kind: 'regulatory-return', period, asOf: '2026-10-04', by: 'finance/reporting', at: `${asOf}T21:00:00+04:00`,
      changesSummary: 'reissued for an earlier reporting date',
    })).toThrow(/cannot replace a later one — that is rewriting history/);
  });

  it('an issued extract reproduces exactly, and is honest when the books have since moved', () => {
    const { register, extracts } = conventional();
    const { extract } = extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/reporting', at: `${asOf}T18:00:00+04:00` });
    expect(extracts.verify(extract.id).intact).toBe(true);
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-LATER', loss: money(1_200_000_00, 'AED'), at: '2026-09-29T10:00:00+04:00' });
    const after = extracts.verify(extract.id);
    expect(after.intact).toBe(false);
    expect(after.detail).toMatch(/no longer reproduces/);
    expect(() => extracts.get('RI-EX-NOWHERE-00001')).toThrow(/unknown extract/);
  });
});

describe('deposit premium recognition', () => {
  it('brings a settled deposit into the return as ceded premium and mends the control', () => {
    const { extracts, register } = conventional();
    // A deposit-backed treaty earns no premium in the books until the period is settled, so before the
    // settlement the ledger carries ceded premium the register cannot see — the return must say so.
    register.register({
      id: 'AGG-SL-DEPOSIT-TEST', name: 'Aggregate stop loss — deposit accounted (test)', kind: 'excess-of-loss',
      basis: 'conventional', lineOfBusiness: 'all', counterparty: 'Gulf Reinsurance PSC', from: '2026-01-01', to: '2026-12-31',
      attachment: money(500_000_00, 'AED'), limit: money(2_000_000_00, 'AED'), commissionBps: 0,
      depositAccounted: true, depositPremium: money(280_000_00, 'AED'), rateOnLineBps: 350,
    });
    register.openDeposit('AGG-SL-DEPOSIT-TEST', { amount: money(280_000_00, 'AED'), at: '2026-09-05T10:00:00+04:00' });

    const before = extracts.regulatoryReturn({ period, asOf });
    expect((row(before, 'RS-A', 'A.4')[1] as Money | null)?.minor ?? 0n).toBe(0n);
    expect(before.controls.find((c) => c.code === 'RS-A.5')!.state).toBe('agrees');

    const settled = register.settleDeposit('AGG-SL-DEPOSIT-TEST', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-09-30T15:00:00+04:00' });
    expect(settled.settledAt).toBe('2026-09-30T15:00:00+04:00');

    const after = extracts.regulatoryReturn({ period, asOf });
    // 3,500 bps of 8,000,000.00 = 280,000.00 recognised on the day of settlement.
    expect((row(after, 'RS-A', 'A.4')[1] as Money).minor).toBe(280_000_00n);
    expect((row(after, 'RS-A', 'A.5')[1] as Money).minor).toBe(250_00n + 280_000_00n);
    expect(after.controls.every((c) => c.state === 'agrees')).toBe(true);

    const exhibits = extracts.actuarialExhibits({ period, asOf });
    expect(exhibits.controls.some((c) => c.state === 'difference')).toBe(false);
    expect(exhibits.controls.find((c) => c.code === 'AE.2.premium')!.detail).toContain('280,000.00');
  });
});

describe('actuarial exhibits', () => {
  it('reports provisions, cession and retention, loss ratios and the run-off, with ratios kept as ratios', () => {
    const { extracts } = conventional();
    const draft = extracts.actuarialExhibits({ period: { from: '2026-01-01', to: '2026-12-31' }, asOf });
    expect(draft.tables.map((t) => t.code)).toEqual(['AE-1', 'AE-2', 'AE-3', 'AE-4']);
    expect(draft.controls.filter((c) => c.state === 'difference')).toHaveLength(0);
    expect(draft.controls.some((c) => c.state === 'informational')).toBe(true);

    const provisions = draft.tables.find((t) => t.code === 'AE-1')!;
    const reserve = provisions.rows.find((r) => r.code === 'AE.1.1')!;
    expect((reserve.values[0] as Money).minor).toBe(6_000_00n);     // case reserve
    expect((reserve.values[1] as Money).minor).toBe(1_500_00n);     // the treaty's 25%
    expect((reserve.values[2] as Money).minor).toBe(4_500_00n);
    const unearned = provisions.rows.find((r) => r.code === 'AE.1.2')!;
    expect((unearned.values[0] as Money).minor).toBe(0n);
    expect(unearned.note).toMatch(/nil by construction/);

    const loss = draft.tables.find((t) => t.code === 'AE-3')!;
    expect(loss.columns).toContain('Loss ratio (gross)');
    const motor = loss.rows.find((r) => r.line === 'motor')!;
    expect((motor.values[0] as Money).minor).toBe(1_000_00n);        // premium
    const ratio = motor.values[5]!;
    expect(isRatioCell(ratio)).toBe(true);
    expect(formatCell(ratio)).toBe('400.00%');                       // 4,000 paid on 1,000 of premium
    expect(formatCell(motor.values[1]!)).toBe('250.00 AED');

    // AE-4 is the run-off: one September settlement of 4,000, cumulative 4,000
    const runOff = draft.tables.find((t) => t.code === 'AE-4')!;
    expect(runOff.rows).toHaveLength(1);
    expect((runOff.rows[0]!.values[0] as Money).minor).toBe(4_000_00n);
    expect((runOff.rows[0]!.values[1] as Money).minor).toBe(4_000_00n);
    expect(runOff.rows[0]!.note).toMatch(/1 settlement/);

    expect(draft.limitations.join(' ')).toMatch(/No discounting of reserves/);
    expect(draft.notes.join(' ')).toMatch(/Cession ratio across the ceded population/);
  });

  it('will not tie a reserve the claims module does not have on its books', () => {
    const { ledger, extracts } = conventional();
    // A reserve posted straight to the claims reserve account, which no claim knows about.
    ledger.post({
      id: 'TEST-RESERVE', entityId: 'ALK-CONV', at: `${asOf}T09:00:00+04:00`, source: 'test', sourceRef: 'reserve-orphan',
      description: 'a reserve lifted with no claim behind it',
      postings: [
        { accountId: 'ALK-CONV:CLAIM-RESERVE', side: 'debit', amount: money(2_500_00, 'AED'), baseAmount: money(2_500_00, 'AED') },
        { accountId: 'ALK-CONV:CLAIM-EXPENSE', side: 'credit', amount: money(2_500_00, 'AED'), baseAmount: money(2_500_00, 'AED') },
      ],
    });
    const draft = extracts.actuarialExhibits({ period: { from: '2026-01-01', to: '2026-12-31' }, asOf });
    const control = draft.controls.find((c) => c.code === 'AE.1.1')!;
    expect(control.state).toBe('difference');
    expect(control.detail).toMatch(/the reserve account says/);
  });
});

describe('treaty bordereau', () => {
  it('states the closing balance counterparty by counterparty, and refuses a name it does not write with', () => {
    const { extracts } = conventional();
    expect(() => extracts.bordereau({ counterparty: 'Nowhere Re', period, asOf: asOf })).toThrow(/nothing to send them/);

    const draft = extracts.bordereau({ counterparty: 'Emirates Re', period: { from: '2026-01-01', to: '2026-12-31' }, asOf });
    expect(draft.tables.map((t) => t.code)).toEqual(['BD-1', 'BD-2', 'BD-3', 'BD-4']);
    expect(draft.controls.every((c) => c.state === 'agrees')).toBe(true);
    const recoveries = draft.tables.find((t) => t.code === 'BD-2')!;
    expect(recoveries.rows).toHaveLength(1);
    expect((recoveries.totals![0] as Money).minor).toBe(600_000_00n);
    expect((recoveries.totals![2] as Money).minor).toBe(600_000_00n);   // nothing settled yet
    const closing = draft.tables.find((t) => t.code === 'BD-4')!;
    expect((closing.rows.find((r) => r.code === 'BD.4.1')!.values[0] as Money).minor).toBe(600_000_00n);
    expect(closing.rows.find((r) => r.code === 'BD.4.5')!.note).toMatch(/short/);   // no security held yet

    // Issued and immutable, like every other extract
    const { extract } = extracts.issue({ kind: 'treaty-bordereau', counterparty: 'Emirates Re', period: { from: '2026-01-01', to: '2026-12-31' }, asOf, by: 'reinsurance/desk', at: `${asOf}T18:00:00+04:00` });
    expect(extract.counterparty).toBe('Emirates Re');
    expect(extracts.verify(extract.id).intact).toBe(true);
  });
});

describe('the takaful window files its own return', () => {
  it('reports participant money from its own register, in its own entity, with nothing of the operator in it', () => {
    const { extracts } = takaful();
    const draft = extracts.regulatoryReturn({ period, asOf, preparedBy: 'finance/takaful' });
    expect(draft.entityId).toBe('ALK-TKF');
    expect(draft.basis).toBe('takaful');
    expect(draft.title).toMatch(/Retakaful return — participant risk fund/);
    expect(draft.controls.every((c) => c.state === 'agrees')).toBe(true);
    // 20% of the 1,800.00 tabarru is ceded, and the operator's wakalah fee is 20% of that.
    expect((row(draft, 'RS-A', 'A.1')[0] as Money).minor).toBe(1_800_00n);
    expect((row(draft, 'RS-A', 'A.2')[1] as Money).minor).toBe(360_00n);
    expect((row(draft, 'RS-A', 'A.7')[0] as Money).minor).toBe(72_00n);
    expect((row(draft, 'RS-A', 'A.7')[2] as Money).minor).toBe(72_00n);
    expect(draft.notes.join(' ')).toMatch(/participant money/);
    const { extract } = extracts.issue({ kind: 'regulatory-return', period, asOf, by: 'finance/takaful', at: `${asOf}T18:00:00+04:00` });
    expect(extract.tiesToBooks).toBe(true);
    expect(extracts.summary(extract).differences).toBe(0);
  });
});
