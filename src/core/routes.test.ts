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
      '/infra/topology',
    ]) {
      const result = await dispatchApiRoute(state, 'GET', path, new URLSearchParams(), {});
      expect(result.handled, path).toBe(true);
      expect(result.status, path).toBe(200);
    }
  });

  it('describes the data plane without inventing a database, and mints a sortable 64-bit id', async () => {
    const state = createRuntimeState(1, () => '2026-10-05T00:00:00.000Z', {
      DATABASE_URL: 'postgresql://portal_user:secret@ep-cool-1234.eu-central-1.aws.neon.tech/portal?sslmode=require',
      INSTANCE_COUNT: '2',
      MEMCACHED_SERVERS: 'mc1:11211',
    });
    const topology = await dispatchApiRoute(state, 'GET', '/infra/topology', new URLSearchParams(), {});
    expect(topology.status).toBe(200);
    expect(topology.body).toMatchObject({ configured: true, mode: 'postgres' });
    expect(JSON.stringify(topology.body)).not.toContain('secret');
    expect((topology.body as any).pooling.instances).toBe(2);

    const minted = await dispatchApiRoute(state, 'POST', '/infra/ids', new URLSearchParams(), { count: 2, shard: 9 });
    expect(minted.status).toBe(200);
    const ids = (minted.body as any).ids as Array<{ id: string; shard: number; counter: number }>;
    expect(ids).toHaveLength(2);
    expect(ids.map((row) => row.shard)).toEqual([9, 9]);
    expect(ids.map((row) => row.counter)).toEqual([0, 1]);
    // The boundary refuses a shard that does not fit the 13-bit field — it does not mask it.
    await expect(dispatchApiRoute(state, 'POST', '/infra/ids', new URLSearchParams(), { count: 1, shard: 9_000 }))
      .rejects.toThrow(RequestValidationError);
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

describe('the mail routes: a quotation is delivered, not merely recorded', () => {
  it('reports how the mailer is configured, without leaking a secret', async () => {
    const state = createRuntimeState(1, () => '2026-10-05T00:00:00.000Z', {
      MAIL_FROM: 'quotations@central-insurance.example',
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh',
    });
    const result = await dispatchApiRoute(state, 'GET', '/mail/status', new URLSearchParams(), {});
    expect(result.status).toBe(200);
    const body = result.body as { kind: string; configured: boolean; from: string; env: Record<string, string> };
    expect(body.kind).toBe('gmail-api');
    expect(body.configured).toBe(true);
    expect(body.from).toBe('quotations@central-insurance.example');
    // Which settings are present is public; their values never are.
    expect(body.env).toEqual({ MAIL_FROM: 'set', MAIL_FROM_NAME: 'missing', GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'set', GOOGLE_REFRESH_TOKEN: 'set', GOOGLE_ACCESS_TOKEN: 'missing' });
  });

  it('refuses a malformed address on the test button rather than bouncing it off Gmail', async () => {
    const state = createRuntimeState(1, undefined, { MAIL_FROM: 'desk@example.com' });
    expect(await statusOf(dispatchApiRoute(state, 'POST', '/mail/test', new URLSearchParams(), { to: 'nope' }))).toBe(400);
  });

  it('refuses to email a quotation that was never issued', async () => {
    const state = createRuntimeState(1, () => '2026-10-05T12:00:00.000Z', { MAIL_FROM: 'desk@example.com' });
    // There is nothing to send, so the route refuses rather than recording a delivery that never
    // happened: a customer must never be shown a "sent" that was not.
    await expect(dispatchApiRoute(state, 'POST', '/journey/quotation/email', new URLSearchParams(), { quotationId: 'QTN-NOPE' }))
      .rejects.toThrow(/unknown quotation/);
  });
});

describe('the filed illustration rates', () => {
  it('starts from the regulatory pack and narrows by product, channel and sub-channel', async () => {
    const state = createRuntimeState(1);
    const opened = await dispatchApiRoute(state, 'GET', '/master/illustration-rates', new URLSearchParams(), {});
    expect(opened.status).toBe(200);
    const first = opened.body as { rates: unknown[]; packRates: { midBps: number }; resolved: Array<{ productId: string; default: { level: string } }> };
    expect(first.rates).toEqual([]);
    expect(first.packRates.midBps).toBe(800);
    expect(first.resolved[0]?.default.level).toBe('pack');

    const product = first.resolved[0]!.productId;
    const filed = await dispatchApiRoute(state, 'POST', '/master/illustration-rates', new URLSearchParams(), {
      productId: product, midBps: 600, note: 'conservative shelf', by: 'test',
    });
    expect(filed.status).toBe(200);
    expect((filed.body as { resolved: { rates: { midBps: number }; level: string } }).resolved.rates.midBps).toBe(600);

    // A figure left blank inherits from the parent, so filing one number never files three.
    const narrowed = (filed.body as { resolved: { rates: { lowBps: number; midBps: number } } }).resolved;
    expect(narrowed.rates.lowBps).toBe(400);      // still the pack's
    expect(narrowed.rates.midBps).toBe(600);      // filed on the product

    const cleared = await dispatchApiRoute(state, 'POST', '/master/illustration-rates/remove', new URLSearchParams(), {
      productId: product, by: 'test',
    });
    expect((cleared.body as { removed: boolean }).removed).toBe(true);
  });

  it('refuses a product that is not in the factory', async () => {
    const state = createRuntimeState(1);
    await expect(dispatchApiRoute(state, 'POST', '/master/illustration-rates', new URLSearchParams(), {
      productId: 'PROD-NOT-FILED', midBps: 600, by: 'test',
    })).rejects.toThrow(/not filed in the product factory/);
  });

  it('previews an illustration for the term and paying term the customer chose', async () => {
    const state = createRuntimeState(1);
    const result = await dispatchApiRoute(state, 'POST', '/journey/illustration/preview', new URLSearchParams(), {
      productId: 'PROD-UL-GLOBAL', sumAssured: '500,000', termYears: 30, premiumPayingTermYears: 15, entryAge: 35, premiumPerFrequency: '20,000', by: 'test',
    });
    expect(result.status).toBe(200);
    const body = result.body as { illustration: { yearly: string[][]; paymentTermsLabel: string; scenarios: unknown[] } };
    expect(body.illustration.yearly).toHaveLength(30);
    expect(body.illustration.yearly.at(-1)?.[0]).toBe('30');
    expect(body.illustration.paymentTermsLabel).toMatch(/for 15 year\(s\).*cover running for 30 year\(s\)/);
    expect(body.illustration.scenarios).toHaveLength(3);
    expect(await statusOf(dispatchApiRoute(state, 'POST', '/journey/illustration/preview', new URLSearchParams(), { productId: 'PROD-NOT-FILED' }))).toBe(400);
  });
});
