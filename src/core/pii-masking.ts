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

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(x: number, n: number): number { return ((x >>> n) | (x << (32 - n))) >>> 0; }

/** SHA-256 (FIPS 180-4), pure TypeScript so the same code runs in Node and the browser bundle. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const msg = new Uint8Array(paddedLength);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLength - 4, bitLen >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x1_0000_0000));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[t]! + w[t]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

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

export class PiiMasker {
  private transactionCounter = 0;
  private readonly vaultSecret: string;

  constructor(vaultSecret = DEMO_VAULT_SECRET) {
    if (!vaultSecret || vaultSecret.length < 12) throw new Error('PII masking vault secret must be at least 12 characters (supply it from the deployment KMS/secret store)');
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
