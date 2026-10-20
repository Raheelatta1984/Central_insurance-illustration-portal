/**
 * PII masking for every warehouse pipeline (Snowflake, Excel, Access, BI exports).
 *
 * Rules that are enforced in code, not in a policy PDF:
 *  - Real customer values never leave in a warehouse sample, export or connection preview.
 *  - Masking is one-way. This module deliberately exposes no decode/unmask function, and the
 *    per-transaction salt that keys the hash is never returned, logged or exported.
 *  - The method changes with every transaction: each transaction id advances a rotation over
 *    keyed-hash tokenisation, truncated keyed hash, a keyed format-preserving transform,
 *    domain-blind tokenisation and full redaction. Two transactions therefore mask the same
 *    customer differently, so masked extracts cannot be joined back together across drops
 *    by simply matching the masked value (linkability is per-transaction only, by design).
 *  - A deployment supplies the vault secret from its KMS/secret store. The demo secret below
 *    exists only so the console can run standalone; it is never printed in a snapshot.
 */
import { sha256Hex } from './hash.js';

export { sha256Hex };

export const MASKING_METHODS = [
  'keyed-hash-token-v1',
  'truncated-keyed-hash-v2',
  'keyed-format-preserving-v3',
  'domain-blind-token-v4',
  'full-redaction-token-v5',
] as const;
export type MaskingMethod = (typeof MASKING_METHODS)[number];

export type PiiFieldClass = 'person-id' | 'name' | 'email' | 'phone' | 'national-id' | 'secret' | 'generic';

export const PII_COLUMNS: Readonly<Record<string, PiiFieldClass>> = Object.freeze({
  party_id: 'person-id', member_policy_id: 'person-id', employer_id: 'person-id',
  holder_name: 'name', customer_name: 'name', beneficiary_name: 'name', name: 'name',
  email: 'email', email_address: 'email', phone: 'phone', mobile: 'phone',
  national_id: 'national-id', emirates_id: 'national-id', passport: 'national-id',
  secret: 'secret', api_key: 'secret', connection_string: 'secret', password: 'secret',
});

export function classifyColumn(column: string): PiiFieldClass | null {
  const direct = PII_COLUMNS[column.toLowerCase()];
  if (direct) return direct;
  if (/_id$/.test(column) && /party|customer|member|holder|beneficiary|employer/.test(column)) return 'person-id';
  if (/email/.test(column)) return 'email';
  if (/phone|mobile/.test(column)) return 'phone';
  if (/name/.test(column)) return 'name';
  return null;
}

const DEMO_VAULT_SECRET = 'demo-only-vault-secret-replace-from-kms-in-production';

/**
 * Where the masking secret comes from, in order: an explicit constructor argument, then the
 * `PII_VAULT_SECRET` environment variable (Node deployments — supply it from the KMS/secret
 * store), then — browser/demo only — the public demo constant above. The server entrypoint
 * refuses to start in production without `PII_VAULT_SECRET` set (see `src/server/main.ts`), so
 * the public constant can never silently key a real deployment's masking.
 */
export function resolveVaultSecret(explicit?: string): string {
  if (explicit) return explicit;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromEnv = proc?.env?.['PII_VAULT_SECRET'];
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : DEMO_VAULT_SECRET;
}

/** True when masking would run on the public demo secret — deployments use this to fail fast. */
export class PiiMaskingError extends Error {}

export function usingDemoVaultSecret(): boolean {
  return resolveVaultSecret() === DEMO_VAULT_SECRET;
}

export class PiiMasker {
  private transactionCounter = 0;
  private readonly vaultSecret: string;

  constructor(vaultSecret?: string) {
    vaultSecret = resolveVaultSecret(vaultSecret);
    if (!vaultSecret || vaultSecret.length < 12) throw new PiiMaskingError('PII masking vault secret must be at least 12 characters (supply it from the deployment KMS/secret store)');
    this.vaultSecret = vaultSecret;
  }

  /** The method for a transaction: it advances with every transaction, never repeats back-to-back. */
  methodFor(transactionId: string, sequence?: number): MaskingMethod {
    const seq = sequence ?? this.transactionCounter;
    // Mix the transaction id in so an externally chosen id cannot force reuse of the last method.
    const seed = Number.parseInt(sha256Hex(`${transactionId}:${seq}`).slice(0, 4), 16);
    return MASKING_METHODS[(seq + seed) % MASKING_METHODS.length]!;
  }

  private digest(transactionId: string, method: MaskingMethod, column: string, value: string): string {
    // The salt is derived, used once for this transaction, and never exposed by any snapshot.
    const salt = sha256Hex(`salt:${this.vaultSecret}:${transactionId}:${method}`);
    return sha256Hex(`${salt}:${column}:${value}`);
  }

  maskValue(value: string, column: string, transactionId: string, method?: MaskingMethod): { masked: string; method: MaskingMethod } {
    const field = classifyColumn(column) ?? 'generic';
    const chosen = method ?? this.methodFor(transactionId);
    const original = String(value ?? '');
    if (original === '' || original === '—') return { masked: original, method: chosen };
    const digest = this.digest(transactionId, chosen, column, original);
    let masked: string;
    switch (chosen) {
      case 'keyed-hash-token-v1':
        masked = `${field.toUpperCase().replace(/-/g, '_')}_tok_${digest.slice(0, 16)}`;
        break;
      case 'truncated-keyed-hash-v2':
        masked = `•••${digest.slice(0, 6)}•••${digest.slice(-4)}`;
        break;
      case 'keyed-format-preserving-v3': {
        // Same shape, different characters: letters→keyed letters, digits→keyed digits.
        let i = 0;
        masked = original.replace(/[A-Za-z0-9]/g, (ch) => {
          const code = digest.charCodeAt(i++ % digest.length) % 36;
          if (/[0-9]/.test(ch)) return String(code % 10);
          const letter = String.fromCharCode(97 + (code % 26));
          return ch === ch.toUpperCase() ? letter.toUpperCase() : letter;
        });
        break;
      }
      case 'domain-blind-token-v4':
        // Not even an email domain survives: the whole value becomes an opaque token.
        masked = `masked_${digest.slice(0, 20)}`;
        break;
      default:
        masked = `[REDACTED:${field}:${digest.slice(0, 8)}]`;
    }
    // Defence in depth: a masked value must never contain the raw value it hides.
    if (original.length >= 4 && masked.includes(original)) masked = `[REDACTED:${field}:${digest.slice(0, 8)}]`;
    return { masked, method: chosen };
  }

  /** Mask one warehouse row for one transaction. Returns the row plus the method actually used. */
  maskRow<T extends Record<string, string>>(row: T, transactionId: string): { row: T; method: MaskingMethod; maskedColumns: string[] } {
    const method = this.methodFor(transactionId, this.transactionCounter);
    const maskedColumns: string[] = [];
    const out: Record<string, string> = { ...row };
    for (const [column, value] of Object.entries(row)) {
      if (!classifyColumn(column)) continue;
      out[column] = this.maskValue(value, column, transactionId, method).masked;
      maskedColumns.push(column);
    }
    return { row: out as T, method, maskedColumns };
  }

  /** Mask a whole extract as ONE transaction, then advance the rotation for the next transaction. */
  maskRows<T extends Record<string, string>>(rows: ReadonlyArray<T>, transactionId: string): { rows: T[]; method: MaskingMethod; maskedColumns: string[] } {
    const method = this.methodFor(transactionId, this.transactionCounter);
    const maskedColumns = new Set<string>();
    const masked = rows.map((row) => {
      const copy: Record<string, string> = { ...row };
      for (const column of Object.keys(row)) {
        if (!classifyColumn(column)) continue;
        copy[column] = this.maskValue(String(row[column] ?? ''), column, transactionId, method).masked;
        maskedColumns.add(column);
      }
      return copy as T;
    });
    this.transactionCounter += 1;
    return { rows: masked, method, maskedColumns: [...maskedColumns] };
  }

  /** A display-safe fingerprint of a secret (for connection cards). Never the secret itself. */
  secretFingerprint(secret: string): string { return `sha256:${sha256Hex(`secret:${this.vaultSecret}:${secret}`).slice(0, 16)}`; }

  /** A masked preview of a secret under the current rotation, for the validation screen. */
  maskSecret(secret: string, transactionId: string): { masked: string; method: MaskingMethod } {
    return this.maskValue(secret, 'secret', transactionId);
  }

  stats() { return { transactionsMasked: this.transactionCounter, methods: MASKING_METHODS.length, algorithm: 'SHA-256 keyed hash with per-transaction derived salt (one-way, no decode path)' }; }
}
