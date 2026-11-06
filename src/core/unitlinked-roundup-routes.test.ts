import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

describe('unit-linked and round-up read endpoints', () => {
  it('returns unit-linked statements and rejects missing or ineligible policy ids', async () => {
    const state = createRuntimeState();
    const get = (query: string) => dispatchApiRoute(state, 'GET', '/unit-linked/statement', new URLSearchParams(query), {});
    expect((await get('')).status).toBe(400);
    expect((await get('policyId=MTR-0441')).status).toBe(404);
    expect((await get('policyId=UL-000123')).body).toMatchObject({ policyId: 'UL-000123', reproducedFromLog: true });
    expect((await dispatchApiRoute(state, 'GET', '/unit-linked/statements', new URLSearchParams(), {})).status).toBe(200);
  });
  it('validates and updates demo settings without partially applying invalid requests', async () => {
    const state = createRuntimeState();
    const query = new URLSearchParams();
    const before = state.world.roundUp.snapshot(state.world).settings[0];
    await expect(dispatchApiRoute(state, 'POST', '/roundup/settings', query, { policyId: 'UL-000123', roundStepMajor: 5, multiplier: 1.5 })).rejects.toThrow();
    expect(state.world.roundUp.snapshot(state.world).settings[0]).toEqual(before);
    const result = await dispatchApiRoute(state, 'POST', '/roundup/settings', query, { policyId: 'UL-000123', enabled: false });
    expect(result.status).toBe(200);
    expect(state.world.roundUp.snapshot(state.world).settings[0]?.enabled).toBe(false);
    const preview = await dispatchApiRoute(state, 'POST', '/roundup/preview', query, { policyId: 'UL-000123', purchaseAmount: '4.50' });
    expect(preview.body).toMatchObject({ redirectedToInvestment: '0.50 AED' });
  });

  it('does not return a PAN or a card fingerprint in the round-up response', async () => {
    const state = createRuntimeState();
    const response = await dispatchApiRoute(state, 'GET', '/roundup', new URLSearchParams(), {});
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('4532015112830366');
    expect(JSON.stringify(response.body)).not.toContain('fingerprint');
  });
});
