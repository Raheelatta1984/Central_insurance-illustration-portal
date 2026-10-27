/**
 * The distribution-configuration API is a boundary, not a shortcut: references are validated against
 * the live masters, malformed percentages are 400s, and the active role must hold full tab access.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute } from './routes.js';
import { DEFAULT_CLAWBACK } from './channels.js';

async function call(state: ReturnType<typeof createRuntimeState>, method: 'GET' | 'POST', path: string, payload: Record<string, unknown> = {}) {
  return dispatchApiRoute(state, method, path, new URLSearchParams(), payload);
}

function prepared() {
  const state = createRuntimeState(1, () => '2026-10-27T10:00:00Z');
  const product = state.world.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
  state.world.erp.channels.bootstrap('2026-10-27T10:00:00Z', 'route-test');
  state.world.erp.channels.upsertPartner({
    partnerId: 'GULF-BROKERS', name: 'Gulf Brokers', channelCode: 'BROKER',
    productIds: [product.productId], commissionBps: [1000], settlementDays: 30,
    clawback: DEFAULT_CLAWBACK, by: 'route-test',
  });
  state.world.erp.channels.upsertSubChannel({
    code: 'BROKER-DIFC', name: 'DIFC desk', parentChannelCode: 'BROKER',
    partnerId: 'GULF-BROKERS', channelType: 'branch', by: 'route-test',
  });
  return { state, product };
}

function payloadFor(product: { productId: string; line: string; variety: string }, overrides: Record<string, unknown> = {}) {
  return {
    scope: 'partner',
    channelCode: 'BROKER',
    partnerId: 'GULF-BROKERS',
    productType: String(product.line),
    productId: product.productId,
    subProducts: [product.variety],
    enabled: true,
    commissionBps: [1500, 500, 250],
    premiumUpliftBps: 250,
    mortalityUpliftBps: 0,
    disbursement: {
      frequency: 'monthly',
      payoutTrigger: 'free-look-expired',
      settlementDays: 30,
      holdbackBps: 0,
      note: 'Monthly after free look.',
    },
    clawback: {
      trigger: 'cancellation-or-lapse',
      basis: 'policy-year',
      recoveryBps: [10000, 5000, 2500],
      note: 'Three-year recovery.',
    },
    note: 'Filed from the Partner configuration tab.',
    ...overrides,
  };
}

describe('distribution configuration API', () => {
  it('answers GET, files a referenced row, removes it and keeps the snapshot in step', async () => {
    const { state, product } = prepared();
    const empty = await call(state, 'GET', '/distribution/config');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ stats: { total: 0 } });

    const saved = await call(state, 'POST', '/distribution/config', payloadFor(product));
    expect(saved.status).toBe(200);
    const body = saved.body as { configuration: { key: string; commissionBps: number[] }; stats: { total: number } };
    expect(body.configuration.key).toContain('partner|BROKER|GULF-BROKERS');
    expect(body.configuration.commissionBps).toEqual([1500, 500, 250]);
    expect(body.stats.total).toBe(1);
    expect((await call(state, 'GET', '/distribution/config')).body).toMatchObject({ stats: { total: 1 } });

    const removed = await call(state, 'POST', '/distribution/config/remove', {
      scope: 'partner', channelCode: 'BROKER', partnerId: 'GULF-BROKERS', productId: product.productId,
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ stats: { total: 0 } });
  });

  it('refuses malformed basis points and a scope that contradicts the live masters', async () => {
    const { state, product } = prepared();
    await expect(call(state, 'POST', '/distribution/config', payloadFor(product, { commissionBps: ['bad'] })))
      .rejects.toThrow(/commissionBps must be a whole number/);
    await expect(call(state, 'POST', '/distribution/config', payloadFor(product, { channelCode: 'AGENCY' })))
      .rejects.toThrow(/filed on BROKER, not AGENCY/);
    await expect(call(state, 'POST', '/distribution/config', payloadFor(product, { commissionBps: [4000] })))
      .rejects.toThrow(/exceeds the 3000 bps ceiling/);
  });

  it('does not let an unrelated role or a read-only coordinator write another scope', async () => {
    const { state, product } = prepared();
    state.world.rbac.selectActiveRole('agent-1');
    await expect(call(state, 'POST', '/distribution/config', payloadFor(product)))
      .rejects.toThrow(/does not have write access/);

    state.world.rbac.selectActiveRole('partner-coordinator');
    const channelOnly = payloadFor(product, { scope: 'omni-channel', partnerId: '' });
    await expect(call(state, 'POST', '/distribution/config', channelOnly))
      .rejects.toThrow(/does not have write access to distribution-channels/);

    state.world.rbac.selectActiveRole('administration');
    expect((await call(state, 'POST', '/distribution/config', payloadFor(product))).status).toBe(200);
  });
});
