import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError, posting } from './ledger.js';
import { money } from './money.js';

function testLedger() {
  const ledger = new Ledger('AED');
  ledger.defineAccount({ id: 'E1:CASH', name: 'Cash', type: 'asset', entityId: 'E1', currency: 'AED' });
  ledger.defineAccount({ id: 'E1:INCOME', name: 'Income', type: 'income', entityId: 'E1', currency: 'AED' });
  ledger.defineAccount({ id: 'E1:F1:ASSETS', name: 'Fund assets', type: 'asset', entityId: 'E1', fundId: 'F1', currency: 'AED' });
  ledger.defineAccount({ id: 'E1:F2:ASSETS', name: 'Fund assets 2', type: 'asset', entityId: 'E1', fundId: 'F2', currency: 'AED' });
  ledger.defineAccount({ id: 'E1:F1:PART', name: 'Participants', type: 'liability', entityId: 'E1', fundId: 'F1', currency: 'AED' });
  ledger.defineAccount({ id: 'E1:TKF:CASH', name: 'Takaful cash', type: 'asset', entityId: 'E2', currency: 'AED' });
  return ledger;
}

describe('ledger — double entry with segregation', () => {
  it('rejects an unbalanced journal', () => {
    const ledger = testLedger();
    expect(() => ledger.post({
      id: 'J1', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'bad',
      postings: [posting('E1:CASH', 'debit', money(100n, 'AED')), posting('E1:INCOME', 'credit', money(99n, 'AED'))],
    })).toThrow(LedgerError);
  });

  it('is idempotent by journal id', () => {
    const ledger = testLedger();
    const entry = {
      id: 'J1', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'premium',
      postings: [posting('E1:CASH', 'debit', money(1000n, 'AED')), posting('E1:INCOME', 'credit', money(1000n, 'AED'))],
    };
    ledger.post(entry);
    ledger.post(entry);
    ledger.post({ ...entry, postings: [...entry.postings] });
    expect(ledger.entriesFor('E1')).toHaveLength(1);
    expect(ledger.balance('E1:CASH').minor).toBe(1000n);
  });

  it('refuses an id reused for different content (the silent-loss trap)', () => {
    const ledger = testLedger();
    ledger.post({
      id: 'J1', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'unitlinked', sourceRef: 'a', description: 'premium',
      postings: [posting('E1:CASH', 'debit', money(1000n, 'AED')), posting('E1:INCOME', 'credit', money(1000n, 'AED'))],
    });
    expect(() => ledger.post({
      id: 'J1', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'takaful', sourceRef: 'b', description: 'contribution',
      postings: [posting('E1:CASH', 'debit', money(500n, 'AED')), posting('E1:INCOME', 'credit', money(500n, 'AED'))],
    })).toThrow(/already used by a different journal/);
    expect(ledger.balance('E1:CASH').minor).toBe(1000n);
  });

  it('corrects only by reversal, never by editing', () => {
    const ledger = testLedger();
    ledger.post({
      id: 'J1', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'charge',
      postings: [posting('E1:CASH', 'debit', money(500n, 'AED')), posting('E1:INCOME', 'credit', money(500n, 'AED'))],
    });
    ledger.reverse('J1', 'duplicate charge', 'J1R');
    expect(ledger.balance('E1:CASH').minor).toBe(0n);
    expect(ledger.entriesFor('E1')).toHaveLength(2);
    expect(ledger.journal('J1')!.description).toBe('charge');
  });

  it('refuses a posting that crosses a fund boundary', () => {
    const ledger = testLedger();
    expect(() => ledger.post({
      id: 'J2', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'cross fund', fundId: 'F1',
      postings: [posting('E1:F1:PART', 'debit', money(10n, 'AED')), posting('E1:F2:ASSETS', 'credit', money(10n, 'AED'))],
    })).toThrow(/fund boundary/);
  });

  it('refuses postings across entities and unknown accounts', () => {
    const ledger = testLedger();
    expect(() => ledger.post({
      id: 'J3', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'cross entity',
      postings: [posting('E1:CASH', 'debit', money(10n, 'AED')), posting('E1:TKF:CASH', 'credit', money(10n, 'AED'))],
    })).toThrow(/another entity/);
    expect(() => ledger.post({
      id: 'J4', entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: 'x', description: 'ghost',
      postings: [posting('E1:NOPE', 'debit', money(10n, 'AED'))], 
    })).toThrow(/unknown account/);
  });

  it('proves balance per currency and entity after many journals', () => {
    const ledger = testLedger();
    ledger.defineAccount({ id: 'E1:USD:CASH', name: 'USD cash', type: 'asset', entityId: 'E1', currency: 'USD' });
    ledger.defineAccount({ id: 'E1:USD:INC', name: 'USD income', type: 'income', entityId: 'E1', currency: 'USD' });
    for (let i = 0; i < 50; i++) {
      ledger.post({
        id: `J${i}`, entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: String(i), description: 'premium',
        postings: [posting('E1:CASH', 'debit', money(BigInt(i * 37), 'AED')), posting('E1:INCOME', 'credit', money(BigInt(i * 37), 'AED'))],
      });
      ledger.post({
        id: `U${i}`, entityId: 'E1', at: '2026-10-01T00:00:00Z', source: 'test', sourceRef: String(i), description: 'premium usd',
        postings: [
          posting('E1:USD:CASH', 'debit', money(BigInt(i), 'USD'), money(BigInt(i) * 367n / 100n, 'AED')),
          posting('E1:USD:INC', 'credit', money(BigInt(i), 'USD'), money(BigInt(i) * 367n / 100n, 'AED')),
        ],
      });
    }
    const proof = ledger.proof('E1');
    expect(proof.balanced).toBe(true);
    expect(proof.byCurrency.map((c) => c.currency).sort()).toEqual(['AED', 'USD']);
    expect(ledger.balance('E1:CASH').minor).toBe(50n * 49n / 2n * 37n);
    const tb = ledger.trialBalance('E1');
    expect(tb.length).toBeGreaterThan(3);
  });
});
