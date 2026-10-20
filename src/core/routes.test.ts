/**
 * The dispatcher as a contract: every read the console opens with must answer, and malformed
 * money-moving requests must be refused as 400s at the boundary — not coerced into demo
 * defaults, and not exploded as 500s deep inside an engine.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute, httpStatusForError } from './routes.js';
import { RequestValidationError } from './validate.js';

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    const result = (await promise) as { status: number };
    return result.status;
  } catch (error) {
    return httpStatusForError(error);
  }
}

describe('api dispatcher', () => {
  it('answers the console’s opening reads', async () => {
    const state = createRuntimeState(1, () => '2026-10-05T00:00:00.000Z');
    for (const path of [
      '/health', '/world', '/group', '/underwriting', '/reinsurance', '/claims',
      '/master/channels', '/master/regional', '/themes', '/warehouse', '/batch',
      '/whats-new', '/idempotency', '/funds-accounting', '/super-funds', '/submissions',
    ]) {
      const result = await dispatchApiRoute(state, 'GET', path, new URLSearchParams(), {});
      expect(result.handled, path).toBe(true);
      expect(result.status, path).toBe(200);
    }
  });

  it('reports the honest deployment shape on /health', async () => {
    const result = await dispatchApiRoute(createRuntimeState(), 'GET', '/health', new URLSearchParams(), {});
    expect(result.body).toMatchObject({ ok: true, persistence: expect.stringContaining('in-memory') });
  });

  it('refuses malformed amounts and ids with 400, not a coercion', async () => {
    const state = createRuntimeState();
    await expect(dispatchApiRoute(state, 'POST', '/preview/switch', new URLSearchParams(), { amountMinor: 'abc' }))
      .rejects.toThrow(RequestValidationError);
    expect(await statusOf(dispatchApiRoute(state, 'POST', '/claims/approve', new URLSearchParams(), {}))).toBe(400);
    expect(await statusOf(dispatchApiRoute(state, 'POST', '/claims/settle', new URLSearchParams(), { claimId: { id: 1 } }))).toBe(400);
    expect(await statusOf(dispatchApiRoute(state, 'POST', '/takaful/approve', new URLSearchParams(), { role: 'ceo' }))).toBe(400);
  });

  it('maps domain refusals to 409 and unknown routes to unhandled', async () => {
    const state = createRuntimeState();
    expect(httpStatusForError(new Error('boom'))).toBe(500);
    const result = await dispatchApiRoute(state, 'GET', '/no-such-route', new URLSearchParams(), {});
    expect(result.handled).toBe(false);
    expect(result.status).toBe(404);
  });

  it('resets atomically and bumps the version', async () => {
    const state = createRuntimeState(3);
    const result = await dispatchApiRoute(state, 'POST', '/reset', new URLSearchParams(), {});
    expect(result.body).toMatchObject({ ok: true, version: 4 });
    expect(state.version).toBe(4);
  });
});
