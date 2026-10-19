import { describe, expect, it } from 'vitest';
import { FundsAccountingRegistry } from './funds-accounting.js';
import { Ledger } from './ledger.js';

function setup() {
  const ledger = new Ledger('AED');
  const registry = new FundsAccountingRegistry({
    ledger,
    defaultEntity: { entityId: 'ALK-CONV', currency: 'AED' },
    entityForCountry: country => country === 'MY'
      ? { entityId: 'ALK-MY', currency: 'MYR' }
      : { entityId: 'ALK-CONV', currency: 'AED' },
  });
  registry.bootstrapDefaults();
  return { ledger, registry };
}

describe('country-aware funds accounting', () => {
  it('files country standards and refuses malformed country, currency and fiscal dates', () => {
    const { registry } = setup();
    expect(registry.listConfigs().map(c => c.country)).toEqual(['AE', 'AU', 'GB', 'MY', 'SA']);
    expect(() => registry.upsertConfig({ country: 'UAE', standard: 'IFRS17', currency: 'AED' })).toThrow(/ISO-2/);
    expect(() => registry.upsertConfig({ country: 'ZZ', standard: 'IFRS17', currency: 'ABC' })).toThrow(/unsupported currency/);
    expect(() => registry.upsertConfig({ country: 'ZZ', standard: 'IFRS17', currency: 'AED', fiscalYearEnd: '13-45' })).toThrow(/MM-DD/);
    expect(() => registry.upsertRule({ country: 'ZZ', fundId: 'F1' })).toThrow(/country accounting standard/);
  });

  it('resolves the most specific event × product × channel × partner × sub-channel × policy mapping', () => {
    const { ledger, registry } = setup();
    const specific = registry.upsertMapping({
      id: 'MAP-TEST-SPECIFIC', country: 'AE', fundId: 'FGLOBAL', eventType: 'deposit-amount',
      productId: 'PROD-UL-GLOBAL', partnerId: 'DXB-BROKER-01', omniChannel: 'BROKER',
      subChannel: 'BROKER-DIFC', policyId: 'UL-000123',
      debitAccount: 'AE:POLICY-ACCRUAL:FGLOBAL', creditAccount: 'AE:POLICY-FUND-LIABILITY:FGLOBAL',
      priority: 99,
      descriptionTemplate: 'Accrue {{amount}} to {{policyId}} / {{productId}} via {{partnerId}} / {{omniChannel}} / {{subChannel}}',
    });
    const voucher = registry.postEvent({
      policyId: 'UL-000123', productId: 'PROD-UL-GLOBAL', fundId: 'FGLOBAL', eventType: 'deposit-amount',
      amount: '125.50', currency: 'AED', country: 'AE', partnerId: 'DXB-BROKER-01', omniChannel: 'BROKER',
      subChannel: 'BROKER-DIFC', at: '2026-10-05T10:00:00Z', by: 'test',
    });
    expect(voucher.mappingId).toBe(specific.id);
    expect(voucher.description).toContain('policy UL-000123');
    expect(voucher.description).toContain('product PROD-UL-GLOBAL');
    expect(voucher.description).toContain('partner DXB-BROKER-01');
    expect(voucher.description).toContain('channel BROKER');
    expect(voucher.description).toContain('sub-channel BROKER-DIFC');
    expect(voucher.lines[0]?.amountMinor).toBe(12550n);
    expect(voucher.balanced).toBe(true);
    expect(voucher.ledgerJournalId).toBeTruthy();
    expect(ledger.journal(voucher.ledgerJournalId!)?.description).toBe(voucher.description);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('posts event-specific mappings without letting one event steal another event\'s accounts', () => {
    const { registry } = setup();
    const received = registry.postEvent({
      policyId: 'POL-1', productId: 'PROD-LIFE-TERM', fundId: 'FGLOBAL',
      eventType: 'premium-received', amount: '100.00', currency: 'AED', country: 'AE',
    });
    const deposit = registry.postEvent({
      policyId: 'POL-1', productId: 'PROD-LIFE-TERM', fundId: 'FGLOBAL',
      eventType: 'deposit-amount', amount: '100.00', currency: 'AED', country: 'AE',
    });
    expect(received.mappingId).toBeUndefined();
    expect(deposit.mappingId).toBe('MAP-0001');
    expect(received.lines[0]?.account).not.toBe(deposit.lines[0]?.account);
  });

  it('refuses invalid mappings and never writes an unbalanced or unlinked voucher', () => {
    const { registry } = setup();
    expect(() => registry.upsertMapping({ fundId: 'FGLOBAL', debitAccount: 'same', creditAccount: 'same' })).toThrow(/must differ/);
    expect(() => registry.upsertMapping({ fundId: 'FGLOBAL', eventType: 'not-an-event' as never, debitAccount: 'D', creditAccount: 'C' })).toThrow(/unknown fund event/);
    expect(() => registry.postEvent({ policyId: '', productId: 'P', fundId: 'F', eventType: 'premium-received', amount: '1' })).toThrow(/policy, product and fund/);
    expect(() => registry.postEvent({ policyId: 'P', productId: 'P', fundId: 'F', eventType: 'premium-received', amount: '-1' })).toThrow(/positive/);
  });
});
