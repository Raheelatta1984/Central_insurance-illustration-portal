/** Environment-configured live adapters. No demo fallback: an unset adapter stays undefined and the
 * financial service refuses the corresponding live path. Configured adapters talk to an authoritative
 * HTTPS verification/source service and never accept raw PAN/CVV. */
import { createHash } from 'node:crypto';
import { FinancialError, type CardProvider, type PaymentVerifier, type VerifiedPayment } from '../../core/financial/model.js';
import type { SourceRecordReader } from '../../core/financial/service.js';

export interface FinancialAdapters {
  readonly paymentVerifier?: PaymentVerifier;
  readonly cardProvider?: CardProvider;
  readonly sourceReader?: SourceRecordReader;
}
export interface AdapterEnv {
  FINANCE_PAYMENT_VERIFIER_URL?: string; FINANCE_PAYMENT_VERIFIER_TOKEN?: string;
  FINANCE_CARD_PROVIDER_URL?: string; FINANCE_CARD_PROVIDER_TOKEN?: string;
  FINANCE_SOURCE_READER_URL?: string; FINANCE_SOURCE_READER_TOKEN?: string;
  FINANCE_PROVIDER_TIMEOUT_MS?: string;
}
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
function serviceUrl(raw: string | undefined, name: string): URL | undefined {
  const value = raw?.trim(); if (!value) return undefined;
  let url: URL; try { url = new URL(value); } catch { throw new FinancialError(`${name} must be an absolute URL`, 500, 'PROVIDER_CONFIG'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw new FinancialError(`${name} must use HTTPS (loopback HTTP is test-only)`, 500, 'PROVIDER_CONFIG');
  return url;
}
function token(raw: string | undefined, name: string): string { const value = raw?.trim(); if (!value) throw new FinancialError(`${name} is required when its URL is configured`, 500, 'PROVIDER_CONFIG'); return value; }
const timeoutMs = (env: AdapterEnv) => { const n = Number(env.FINANCE_PROVIDER_TIMEOUT_MS ?? 10000); if (!Number.isFinite(n) || n < 1 || n > 60000) throw new FinancialError('FINANCE_PROVIDER_TIMEOUT_MS must be 1–60000', 500, 'PROVIDER_CONFIG'); return n; };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
async function call(url: URL, bearer: string, body: unknown | undefined, key: string, ms: number, method: 'GET' | 'POST' = 'POST'): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json', 'idempotency-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ms),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new FinancialError(`financial provider returned HTTP ${response.status}`, 503, 'PROVIDER_UNAVAILABLE');
    try { return await response.json() as unknown; } catch { throw new FinancialError('financial provider returned invalid JSON', 503, 'PROVIDER_BAD_RESPONSE'); }
  } catch (error) {
    if (error instanceof FinancialError) throw error;
    throw new FinancialError('financial provider is unavailable or timed out', 503, 'PROVIDER_UNAVAILABLE');
  }
}
const object = (value: unknown, what: string): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinancialError(`${what} returned a non-object payload`, 503, 'PROVIDER_BAD_RESPONSE'); return value as Record<string, unknown>; };
const verifiedAt = (value: unknown, what: string): { verifiedAt: string } => { const row = object(value, what); if (typeof row['verifiedAt'] !== 'string' || !Number.isFinite(Date.parse(row['verifiedAt']))) throw new FinancialError(`${what} returned invalid verifiedAt`, 503, 'PROVIDER_BAD_RESPONSE'); return { verifiedAt: row['verifiedAt'] }; };
const child = (base: URL, path: string): URL => new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);

export function createFinancialAdapters(env: AdapterEnv = process.env): FinancialAdapters {
  const ms = timeoutMs(env);
  const paymentUrl = serviceUrl(env.FINANCE_PAYMENT_VERIFIER_URL, 'FINANCE_PAYMENT_VERIFIER_URL');
  const cardUrl = serviceUrl(env.FINANCE_CARD_PROVIDER_URL, 'FINANCE_CARD_PROVIDER_URL');
  const sourceUrl = serviceUrl(env.FINANCE_SOURCE_READER_URL, 'FINANCE_SOURCE_READER_URL');
  const paymentToken = paymentUrl ? token(env.FINANCE_PAYMENT_VERIFIER_TOKEN, 'FINANCE_PAYMENT_VERIFIER_TOKEN') : undefined;
  const cardToken = cardUrl ? token(env.FINANCE_CARD_PROVIDER_TOKEN, 'FINANCE_CARD_PROVIDER_TOKEN') : undefined;
  const sourceToken = sourceUrl ? token(env.FINANCE_SOURCE_READER_TOKEN, 'FINANCE_SOURCE_READER_TOKEN') : undefined;
  const paymentVerifier: PaymentVerifier | undefined = paymentUrl ? {
    verify: async (input) => {
      const result = object(await call(paymentUrl, paymentToken!, input, `payment-${digest(input)}`, ms), 'payment verifier');
      for (const key of ['provider', 'reference', 'amountMinor', 'currency', 'policyId', 'verifiedAt'] as const) {
        if (typeof result[key] !== 'string' || !result[key]) throw new FinancialError(`payment verifier returned invalid ${key}`, 503, 'PROVIDER_BAD_RESPONSE');
      }
      if (result['provider'] !== input.provider) throw new FinancialError('payment verifier returned a different provider', 503, 'PROVIDER_BAD_RESPONSE');
      return result as unknown as VerifiedPayment;
    },
  } : undefined;
  const cardProvider: CardProvider | undefined = cardUrl ? {
    verifyToken: async (input) => verifiedAt(await call(child(cardUrl, 'verify-token'), cardToken!, input, `card-token-${digest(input)}`, ms), 'card token verifier'),
    verifyCollection: async (input) => verifiedAt(await call(child(cardUrl, 'verify-collection'), cardToken!, input, `card-collection-${digest(input)}`, ms), 'card collection verifier'),
  } : undefined;
  const sourceReader: SourceRecordReader | undefined = sourceUrl ? {
    read: async (sourceRecordId, policyId) => {
      const url = new URL(sourceUrl.href); url.searchParams.set('sourceRecordId', sourceRecordId); url.searchParams.set('policyId', policyId);
      return await call(url, sourceToken!, undefined, `source-${digest({ sourceRecordId, policyId })}`, ms, 'GET');
    },
  } : undefined;
  return { paymentVerifier, cardProvider, sourceReader };
}
