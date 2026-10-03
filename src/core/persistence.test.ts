import { describe, expect, it } from 'vitest';
import {
  CODEC_VERSION,
  LedgerState,
  Migration,
  SnapshotError,
  Snapshot,
  encode,
  decode,
  exportLedger,
  fingerprint,
  fingerprintOf,
  fromJson,
  importLedger,
  open,
  planMigrations,
  seal,
  snapshotFromText,
  snapshotText,
  toJson,
} from './persistence.js';
import { Ledger } from './ledger.js';
import { buildChart } from './chart.js';
import { money } from './money.js';

function tinyLedger(): Ledger {
  const ledger = new Ledger('AED');
  buildChart(ledger, 'ACME', 'AED', []);
  ledger.post({
    id: 'J-1',
    entityId: 'ACME',
    at: '2026-10-01T09:00:00.000Z',
    recordedAt: '2026-10-01T09:00:00.000Z',
    source: 'test',
    sourceRef: 'REF-1',
    description: 'premium received',
    postings: [
      { accountId: 'ACME:CASH', side: 'debit', amount: money(150_00n, 'AED'), baseAmount: money(150_00n, 'AED') },
      { accountId: 'ACME:PREMIUM-INCOME', side: 'credit', amount: money(150_00n, 'AED'), baseAmount: money(150_00n, 'AED') },
    ],
  });
  return ledger;
}

describe('canonical codec', () => {
  it('carries bigints that JSON.stringify would refuse', () => {
    const value = { units: 123456789012345678901234567890n, cash: money(150_00n, 'AED') };
    expect(() => JSON.stringify(value)).toThrow();
    const text = toJson(value);
    expect(text).toContain('"$big"');
    const back = fromJson<typeof value>(text);
    expect(back.units).toBe(123456789012345678901234567890n);
    expect(back.cash.minor).toBe(150_00n);
    expect(typeof back.cash.minor).toBe('bigint');
  });

  it('round-trips Date, Map and Set, and rejects what it cannot represent', () => {
    const value = {
      at: new Date('2026-10-05T12:00:00.000Z'),
      byCurrency: new Map<string, bigint>([['AED', 1n], ['USD', 2n]]),
      tags: new Set(['motor', 'life']),
      nothing: undefined,
    };
    const back = fromJson<typeof value>(toJson(value));
    expect(back.at.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(back.at instanceof Date).toBe(true);
    expect([...back.byCurrency.entries()]).toEqual([['AED', 1n], ['USD', 2n]]);
    // Set members come back canonically sorted: byte-stability beats insertion order.
    expect([...back.tags]).toEqual(['life', 'motor']);
    expect('nothing' in back && back.nothing === undefined).toBe(true);
    expect(() => encode({ x: Number.NaN })).toThrow(SnapshotError);
    expect(() => encode({ f: () => 1 })).toThrow(SnapshotError);
  });

  it('is byte-stable: key order and Map insertion order cannot change the bytes', () => {
    const a = { b: 2n, a: new Map([['z', 1n], ['a', 2n]]) };
    const b = { a: new Map([['a', 2n], ['z', 1n]]), b: 2n };
    expect(toJson(a)).toBe(toJson(b));
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf({ b: 3n, a: new Map([['z', 1n], ['a', 2n]]) })).not.toBe(fingerprintOf(a));
  });

  it('fingerprints are 16 hex characters and change with the input', () => {
    const f = fingerprint('hello');
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint('hello')).toBe(f);
    expect(fingerprint('hellp')).not.toBe(f);
  });
});

describe('snapshot envelope', () => {
  const payload = { tenant: 'alkhaleej', units: 81000007n };

  it('seals and opens', () => {
    const snap = seal(payload, { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    expect(snap.codecVersion).toBe(CODEC_VERSION);
    const back = open(snap) as typeof payload;
    expect(back.units).toBe(81000007n);
    expect(snap.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a payload that was edited after sealing', () => {
    const snap = seal(payload, { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    const tampered: Snapshot = { ...snap, payload: encode({ ...payload, units: 99999999n }) };
    expect(() => open(tampered)).toThrow(/fingerprint mismatch/);
  });

  it('refuses a snapshot written by a different codec generation, and non-envelopes', () => {
    const snap = seal(payload, { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    expect(() => open({ ...snap, codecVersion: 99 })).toThrow(/codec/);
    expect(() => snapshotFromText('{"hello":1}')).toThrow(SnapshotError);
  });

  it('is deterministic: sealing the same books twice gives the same fingerprint', () => {
    const state = exportLedger(tinyLedger());
    const at = '2026-10-05T00:00:00.000Z';
    const first = seal(state, { schemaVersion: 1, takenAt: at });
    const second = seal(exportLedger(tinyLedger()), { schemaVersion: 1, takenAt: at });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(snapshotText(second)).toBe(snapshotText(first));
    const later = seal(state, { schemaVersion: 1, takenAt: '2026-10-06T00:00:00.000Z' });
    expect(later.fingerprint).not.toBe(first.fingerprint);
  });

  it('survives a text round trip intact', () => {
    const snap = seal(payload, { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    const text = snapshotText(snap, true);
    expect(snapshotText(snapshotFromText(text))).toBe(snapshotText(snap));
  });
});

describe('schema migration', () => {
  const migrations: Migration[] = [
    { from: 1, to: 2, describe: 'add policy currency', apply: (p: any) => ({ ...p, currency: 'AED' }) },
    { from: 2, to: 3, describe: 'rename units to unitsMicro', apply: (p: any) => ({ ...p, unitsMicro: p.units, units: undefined }) },
  ];

  it('plans a multi-step chain in order', () => {
    expect(planMigrations(1, 3, migrations).map((m) => m.to)).toEqual([2, 3]);
    expect(planMigrations(2, 2, migrations)).toEqual([]);
    expect(() => planMigrations(1, 4, migrations)).toThrow(/no migration path/);
  });

  it('applies migrations when opening an older snapshot', () => {
    const snap = seal({ units: 81000007n }, { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    const migrated = open(snap, { expectSchema: 3, migrations }) as any;
    expect(migrated.currency).toBe('AED');
    expect(migrated.unitsMicro).toBe(81000007n);
    // Without a target schema the payload comes back as written — old snapshots stay readable.
    expect((open(snap) as any).units).toBe(81000007n);
  });
});

describe('ledger snapshot and restore', () => {
  it('rebuilds the books from a snapshot and balances', () => {
    const original = tinyLedger();
    const state = exportLedger(original);
    expect(state.journals).toHaveLength(1);

    const restored = importLedger(fromJson<LedgerState>(toJson(state)));
    expect(restored.allJournals()).toHaveLength(1);
    expect(restored.balance('ACME:CASH').minor).toBe(150_00n);
    expect(restored.proof('ACME').balanced).toBe(true);
    expect(restored.journal('J-1')?.description).toBe('premium received');
  });

  it('a snapshot of the books round-trips through the sealed envelope', () => {
    const original = tinyLedger();
    const snap = seal(exportLedger(original), { schemaVersion: 1, takenAt: '2026-10-05T00:00:00.000Z' });
    const state = open(snap, { expectSchema: 1 }) as LedgerState;
    const restored = importLedger(state);
    expect(restored.trialBalance('ACME').length).toBeGreaterThan(0);
    expect(restored.allJournals()[0]!.postings[0]!.baseAmount.minor).toBe(150_00n);
  });

  it('refuses to restore books whose journal does not balance', () => {
    const state = exportLedger(tinyLedger());
    const broken: LedgerState = {
      ...state,
      journals: [{
        ...state.journals[0]!,
        postings: [
          { ...state.journals[0]!.postings[0]!, amount: money(999_00n, 'AED'), baseAmount: money(999_00n, 'AED') },
          state.journals[0]!.postings[1]!,
        ],
      }],
    };
    expect(() => importLedger(broken)).toThrow(/does not balance/);
  });

  it('keeps the id-collision guard on restore: two journals cannot share an id', () => {
    const state = exportLedger(tinyLedger());
    const duplicated: LedgerState = { ...state, journals: [state.journals[0]!, { ...state.journals[0]!, description: 'different content' }] };
    expect(() => importLedger(duplicated)).toThrow(/already used by a different journal/);
  });
});
