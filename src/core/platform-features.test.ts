import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

async function call(state: ReturnType<typeof createRuntimeState>, method: string, path: string, payload: Record<string, unknown> = {}, query = '') {
  return dispatchApiRoute(state, method, path, new URLSearchParams(query), payload);
}

describe('new operational tabs are backed by the world and API', () => {
  it('files a sub-channel under its parent channel and enforces the partner relationship', async () => {
    const state = createRuntimeState();
    await call(state, 'POST', '/master/channels/bootstrap');
    await call(state, 'POST', '/master/partners', { partnerId: 'BROKER-1', name: 'Broker One', channelCode: 'BROKER', country: 'AE', currency: 'AED', commissionBps: [1000] });
    const saved = await call(state, 'POST', '/master/subchannels', {
      code: 'BROKER-DIFC', name: 'DIFC desk', parentChannelCode: 'BROKER', partnerId: 'BROKER-1',
      channelType: 'branch', supports: { quote: true, bind: false, service: true, claim: false }, commissionOverrideBps: 900,
    });
    expect(saved.status).toBe(200);
    const channels = await call(state, 'GET', '/master/channels');
    expect((channels.body as { subChannels: Array<{ code: string }> }).subChannels.map(s => s.code)).toContain('BROKER-DIFC');
    await expect(call(state, 'POST', '/master/subchannels', { code: 'BAD-PARENT', name: 'Wrong parent', parentChannelCode: 'DIRECT-PORTAL', partnerId: 'BROKER-1', channelType: 'digital' })).rejects.toThrow(/not parent channel/);
  });

  it('posts event-specific fund vouchers into the ledger with policy context', async () => {
    const state = createRuntimeState();
    const result = await call(state, 'POST', '/funds-accounting/event', {
      policyId: 'UL-000123', productId: 'PROD-UL-GLOBAL', fundId: 'FGLOBAL', eventType: 'deposit-amount',
      amount: '37.25', currency: 'AED', country: 'AE', partnerId: 'DXB-BROKER-01', omniChannel: 'BROKER',
      subChannel: 'BROKER-DIFC', at: '2026-10-05T12:00:00+04:00',
    });
    expect(result.status).toBe(200);
    const voucher = (result.body as { voucher: { mappingId: string; ledgerJournalId: string; description: string; balanced: boolean } }).voucher;
    expect(voucher.mappingId).toBe('MAP-0001');
    expect(voucher.ledgerJournalId).toBeTruthy();
    expect(voucher.balanced).toBe(true);
    expect(voucher.description).toContain('UL-000123');
    expect(voucher.description).toContain('BROKER-DIFC');
    expect(state.world.ledger.journal(voucher.ledgerJournalId)).toBeTruthy();
    expect(state.world.ledger.proof(state.world.conventionalEntity).balanced).toBe(true);
  });

  it('runs monthly super charges, allocates income through a voucher and re-consolidates changed books', async () => {
    const state = createRuntimeState();
    const charges = await call(state, 'POST', '/super-funds/charge', { at: '2026-10-05T10:00:00Z' });
    expect(charges.status).toBe(200);
    const run = (charges.body as { runs: Array<{ policyCharges: Array<{ totalMinor: string | bigint }> }> }).runs[0]!;
    expect(run.policyCharges.length).toBeGreaterThan(0);

    const allocation = await call(state, 'POST', '/super-funds/allocate', { fundId: 'SUPER-BAL', period: '2026-10', gainAmount: '80.00', currency: 'AUD', at: '2026-10-05T13:00:00Z' });
    expect(allocation.status).toBe(200);
    expect((allocation.body as { voucherIds: string[] }).voucherIds.length).toBeGreaterThan(0);
    const group = await call(state, 'POST', '/group/consolidate', { asOf: '2026-11-30', periodStart: '2026-11-01' });
    expect(group.status).toBe(200);
    expect((group.body as { ok: boolean }).ok).toBe(true);
  });

  it('exports full warehouse data and persists a scoped theme through API routes', async () => {
    const state = createRuntimeState();
    const exported = await call(state, 'POST', '/warehouse/export', { datasetId: 'voucher-fact', format: 'csv', by: 'analyst' });
    expect(exported.status).toBe(200);
    const payload = exported.body as { content: string; rows: number; fingerprint: string; filename: string };
    expect(payload.filename).toMatch(/voucher-fact-.*\.csv/);
    expect(payload.content).toContain('voucher_id,event_id,event_type');
    expect(payload.content).toContain('VCH-0001001');
    expect(payload.rows).toBeGreaterThan(0);
    expect(payload.fingerprint.length).toBe(16);

    const theme = await call(state, 'POST', '/themes/upload', {
      scope: 'partner', ownerId: 'BROKER-1', ownerName: 'Broker One', useAi: true,
      palette: { primary: '#aa3355', accent: '#ffd000' }, images: { logoFileName: 'broker.png' },
    });
    expect(theme.status).toBe(200);
    const layer = (theme.body as { layer: { applyScope: string; generatedBy: string; cssVariables: Record<string, string> } }).layer;
    expect(layer.applyScope).toBe('partner-surfaces');
    expect(layer.generatedBy).toBe('ai');
    expect(layer.cssVariables['--accent']).toBe('#aa3355');
    const themes = await call(state, 'GET', '/themes');
    expect((themes.body as { partnerThemes: Array<{ ownerId: string }> }).partnerThemes.some(t => t.ownerId === 'BROKER-1')).toBe(true);
  });
});
