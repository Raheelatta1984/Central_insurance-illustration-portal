import { describe, expect, it } from 'vitest';
import { BatchRegistry, type BatchSubject } from './batch.js';
import { PiiMasker, sha256Hex } from './pii-masking.js';
import { AUTO_WHATS_NEW_ENTRIES } from './whatsnew.auto.js';
import { WHATS_NEW_SEED, WhatsNewRegistry, generateFromCommits, categoriseCommit } from './whatsnew.js';

const policy = (id: string, status: BatchSubject['status'], basisMinor = 1_000_000_00n): BatchSubject => ({
  id, kind: 'policy', status, productId: 'PROD-UL-GLOBAL', currency: 'AED', basisMinor, anniversaryDay: 5, fundId: 'FGLOBAL',
});

describe('batch processing', () => {
  it('requires event-based accounting setup and refuses disabled or unknown events', () => {
    const batch = new BatchRegistry();
    expect(() => batch.run({ eventType: 'anniversary-mortality', period: '2026-10', subjects: [] })).toThrow(/no batch event setup/);
    batch.bootstrapDefaults();
    batch.upsertDefinition({ eventType: 'anniversary-mortality', enabled: false });
    expect(() => batch.run({ eventType: 'anniversary-mortality', period: '2026-10', subjects: [] })).toThrow(/disabled/);
  });

  it('posts monthly anniversary mortality from the filed setup, only for live policies due that month', () => {
    const batch = new BatchRegistry(); batch.bootstrapDefaults();
    const run = batch.run({ eventType: 'anniversary-mortality', period: '2026-10-05', subjects: [policy('P1', 'in-force'), policy('P2', 'paid-up'), { ...policy('P3', 'in-force'), anniversaryDay: 9 }] });
    expect(run.posted).toBe(2);
    expect(run.lines.find((l) => l.subjectId === 'P3')?.status).toBe('skipped-not-due');
    const line = run.lines.find((l) => l.subjectId === 'P1')!;
    // 9 bps of 1,000,000.00 AED = 900.00 AED = 90000 minor
    expect(line.amountMinor).toBe('90000');
    expect(line.debitAccount).toBe('5100-MORTALITY-CHARGE');
    expect(line.voucherRef).toMatch(/^BVCH-/);
  });

  it('stops all batches at lapse, full withdrawal and surrender — except clawback, which targets leavers', () => {
    const batch = new BatchRegistry(); batch.bootstrapDefaults();
    const subjects = [policy('P-LAPSED', 'lapsed'), policy('P-SURR', 'surrendered'), policy('P-WD', 'fully-withdrawn'), policy('P-LIVE', 'in-force')];
    const fmc = batch.run({ eventType: 'anniversary-fund-management-charge', period: '2026-10', subjects });
    expect(fmc.posted).toBe(1);
    expect(fmc.lines.filter((l) => l.status === 'skipped-terminal')).toHaveLength(3);
    const clawback = batch.run({ eventType: 'anniversary-clawback', period: '2026-10', subjects });
    expect(clawback.posted).toBe(3);
    expect(clawback.lines.find((l) => l.subjectId === 'P-LIVE')?.status).toBe('skipped-terminal');
  });

  it('is idempotent per job + period + subject: re-running never double-charges', () => {
    const batch = new BatchRegistry(); batch.bootstrapDefaults();
    const subjects = [policy('P1', 'in-force')];
    expect(batch.run({ eventType: 'anniversary-premium-accrual', period: '2026-10', subjects }).posted).toBe(1);
    const again = batch.run({ eventType: 'anniversary-premium-accrual', period: '2026-10', subjects });
    expect(again.posted).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(batch.run({ eventType: 'anniversary-premium-accrual', period: '2026-11', subjects }).posted).toBe(1);
  });

  it('generates quotations, illustrations and issuance only for open quotations', () => {
    const batch = new BatchRegistry(); batch.bootstrapDefaults();
    const subjects: BatchSubject[] = [
      { id: 'QT-1', kind: 'quotation', status: 'quotation-open', productId: 'P', currency: 'AED', basisMinor: 100_00n, anniversaryDay: 1 },
      { id: 'QT-2', kind: 'quotation', status: 'quotation-expired', productId: 'P', currency: 'AED', basisMinor: 100_00n, anniversaryDay: 1 },
    ];
    for (const eventType of ['quotation-generation', 'illustration-generation', 'policy-issuance'] as const) {
      const run = batch.run({ eventType, period: '2026-10-05', subjects });
      expect(run.posted, eventType).toBe(1);
      expect(run.skipped, eventType).toBe(1);
    }
  });
});

describe('rotating one-way PII masking', () => {
  it('hashes with SHA-256 (known vector) and never leaves the raw value in the masked output', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const masker = new PiiMasker('test-vault-secret-123');
    const { masked } = masker.maskValue('PARTY-12345', 'party_id', 'txn-1');
    expect(masked).not.toContain('PARTY-12345');
    expect(masked).not.toContain('12345');
  });

  it('changes method and output with every transaction, so extracts cannot be joined across drops', () => {
    const masker = new PiiMasker('test-vault-secret-123');
    const rows = [{ party_id: 'PARTY-12345', policy_id: 'UL-1' }];
    const first = masker.maskRows(rows, 'txn-1');
    const second = masker.maskRows(rows, 'txn-2');
    expect(first.rows[0]!.party_id).not.toBe(second.rows[0]!.party_id);
    // Non-PII columns pass through untouched.
    expect(first.rows[0]!.policy_id).toBe('UL-1');
    expect(masker.maskRows(rows, 'txn-3').method).toBeDefined();
  });

  it('fingerprints secrets without storing or returning them', () => {
    const masker = new PiiMasker('test-vault-secret-123');
    const fp = masker.secretFingerprint('super-secret-api-key-999');
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(fp).not.toContain('super-secret');
  });
});

describe("what's new generation from commits", () => {
  it('categorises conventional commits and drafts why/what/action in the filed shape', () => {
    expect(categoriseCommit('feat(batch): monthly anniversary runs')).toBe('feature');
    expect(categoriseCommit('security(warehouse): rotate masking')).toBe('security');
    expect(categoriseCommit('feat!: change export format')).toBe('breaking');
    const [entry] = generateFromCommits([{ hash: 'abcdef123456', subject: 'feat(batch): monthly anniversary runs', body: 'Operators need governed batches.\n\nAdds the Batch tab with filed debit/credit setups.', pr: '#42' }]);
    expect(entry!.why).toContain('Operators need governed batches');
    expect(entry!.what).toContain('Adds the Batch tab');
    expect(entry!.whatYouNeedToDo.length).toBeGreaterThan(20);
    expect(entry!.source).toBe('#42');
  });

  it('refuses entries that do not say why, what and what to do', () => {
    const registry = new WhatsNewRegistry();
    expect(() => registry.file({ at: '2026-10-19', title: 'X', category: 'feature', source: 'test', why: '', what: 'w', whatYouNeedToDo: 'a', area: 'Overview', risk: 'low' })).toThrow(/why, what changed/);
    // Auto-filed PR entries may lead the list; the curated seed keeps its authored relative order.
    const entries = registry.snapshot().entries;
    const titles = entries.map((entry) => entry.title);
    const positions = WHATS_NEW_SEED.map((entry) => titles.indexOf(entry.title));
    expect(entries.length).toBeGreaterThan(5);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(entries[0]!.at >= WHATS_NEW_SEED[0]!.at).toBe(true);
    if (AUTO_WHATS_NEW_ENTRIES.length === 0) expect(entries[0]!.title).toBe(WHATS_NEW_SEED[0]!.title);
    expect(entries.some((entry) => entry.title.includes('Batch processing'))).toBe(true);
  });
});
