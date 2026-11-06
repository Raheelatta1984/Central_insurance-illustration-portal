import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FinancialError } from '../../core/financial/model.js';
import { createFinancialAdapters } from './adapters.js';

let server: Server; let base: string;
const requests: Array<{ method: string; url: string; auth: string | undefined; key: string | undefined; body: unknown }> = [];
let mode: 'ok' | 'missing' | 'error' | 'slow' | 'bad-json' | 'bad-payment' = 'ok';
const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let data = ''; req.on('data', (chunk) => { data += String(chunk); }); req.on('end', () => resolve(data)); });
beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, key: req.headers['idempotency-key'] as string | undefined, body: body ? JSON.parse(body) : undefined });
      if (mode === 'slow') { await new Promise((r) => setTimeout(r, 80)); }
      if (mode === 'error') { res.writeHead(500); res.end('no'); return; }
      if (mode === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{'); return; }
      if (mode === 'missing' && req.method === 'GET') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('verify-token') || req.url?.includes('verify-collection')) { res.end(JSON.stringify({ verifiedAt: '2026-11-06T00:00:00.000Z' })); return; }
      if (req.method === 'GET') { res.end(JSON.stringify({ policyId: 'P1', distribution: { channelCode: 'BANCA' } })); return; }
      if (mode === 'bad-payment') { res.end(JSON.stringify({ provider: 'bank' })); return; }
      res.end(JSON.stringify({ provider: 'bank', reference: 'R1', amountMinor: '100', currency: 'USD', policyId: 'P1', verifiedAt: '2026-11-06T00:00:00.000Z' }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

describe('live financial adapters', () => {
  it('stays undefined when no provider/source is configured, so the service refuses live money paths', () => {
    expect(createFinancialAdapters({})).toEqual({ paymentVerifier: undefined, cardProvider: undefined, sourceReader: undefined });
  });
  it('requires HTTPS except loopback tests and a bearer token when a URL is configured', () => {
    expect(() => createFinancialAdapters({ FINANCE_PAYMENT_VERIFIER_URL: 'http://provider.example/verify', FINANCE_PAYMENT_VERIFIER_TOKEN: 't' })).toThrow(FinancialError);
    expect(() => createFinancialAdapters({ FINANCE_PAYMENT_VERIFIER_URL: `${base}/verify` })).toThrow(/FINANCE_PAYMENT_VERIFIER_TOKEN/);
  });
  it('verifies payment evidence through the configured authoritative endpoint with an idempotency key', async () => {
    mode = 'ok';
    const { paymentVerifier } = createFinancialAdapters({ FINANCE_PAYMENT_VERIFIER_URL: `${base}/verify`, FINANCE_PAYMENT_VERIFIER_TOKEN: 'secret' });
    const input = { provider: 'bank', reference: 'R1', amountMinor: '100', currency: 'USD', policyId: 'P1' };
    await expect(paymentVerifier!.verify(input)).resolves.toMatchObject(input);
    const last = requests.at(-1)!;
    expect(last.auth).toBe('Bearer secret'); expect(last.key).toMatch(/^payment-/); expect(last.body).toEqual(input);
  });
  it('verifies card tokens and collections without accepting raw PAN/CVV fields', async () => {
    const { cardProvider } = createFinancialAdapters({ FINANCE_CARD_PROVIDER_URL: `${base}/cards`, FINANCE_CARD_PROVIDER_TOKEN: 'secret' });
    await expect(cardProvider!.verifyToken({ provider: 'cards', token: 'tok', mandateReference: 'M1', consentReference: 'C1', policyId: 'P1', last4: '4242' })).resolves.toEqual({ verifiedAt: '2026-11-06T00:00:00.000Z' });
    await expect(cardProvider!.verifyCollection({ provider: 'cards', eventId: 'E1', token: 'tok', policyId: 'P1', purchaseMinor: '150', collectedMinor: '50', currency: 'USD', at: '2026-11-06T00:00:00.000Z' })).resolves.toEqual({ verifiedAt: '2026-11-06T00:00:00.000Z' });
    expect(requests.at(-2)!.url).toBe('/cards/verify-token'); expect(requests.at(-1)!.url).toBe('/cards/verify-collection');
  });
  it('reads authoritative source records by exact policy link and treats 404 as missing evidence', async () => {
    const { sourceReader } = createFinancialAdapters({ FINANCE_SOURCE_READER_URL: `${base}/source`, FINANCE_SOURCE_READER_TOKEN: 'secret' });
    await expect(sourceReader!.read('S1', 'P1')).resolves.toMatchObject({ policyId: 'P1' });
    expect(requests.at(-1)!.url).toBe('/source?sourceRecordId=S1&policyId=P1');
    mode = 'missing'; await expect(sourceReader!.read('S2', 'P1')).resolves.toBeNull(); mode = 'ok';
  });
  it('fails closed on provider errors, invalid JSON, malformed payment payloads and timeouts', async () => {
    const adapters = createFinancialAdapters({ FINANCE_PAYMENT_VERIFIER_URL: `${base}/verify`, FINANCE_PAYMENT_VERIFIER_TOKEN: 'secret', FINANCE_PROVIDER_TIMEOUT_MS: '20' });
    const input = { provider: 'bank', reference: 'R1', amountMinor: '100', currency: 'USD', policyId: 'P1' };
    mode = 'error'; await expect(adapters.paymentVerifier!.verify(input)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    mode = 'bad-json'; await expect(adapters.paymentVerifier!.verify(input)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_BAD_RESPONSE' });
    mode = 'bad-payment'; await expect(adapters.paymentVerifier!.verify(input)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_BAD_RESPONSE' });
    mode = 'slow'; await expect(adapters.paymentVerifier!.verify(input)).rejects.toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    mode = 'ok';
  });
});
