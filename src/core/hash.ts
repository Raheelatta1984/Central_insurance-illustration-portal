/**
 * Cryptographic hashing for the whole core — one implementation, shared by the PII masker, the
 * persistence seals, the outbox hash chain and customer-facing tokens.
 *
 * This module exists because tamper-evidence used to ride on a 64-bit FNV checksum (`fingerprint`
 * in persistence.ts): anyone could edit a sealed snapshot and recompute a valid "fingerprint".
 * SHA-256 (FIPS 180-4) is implemented in pure TypeScript so the identical code runs in Node and
 * in the browser bundle; correctness is pinned by NIST known-answer tests in `hash.test.ts`
 * (empty, single-block, 56-byte padding boundary and multi-block inputs).
 *
 * Random tokens come from the platform CSPRNG (`crypto.getRandomValues`, present in Node 20+
 * and every browser) — never from a hash of guessable identifiers.
 */
export class HashError extends Error {}

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

/** SHA-256 (FIPS 180-4) of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return sha256BytesHex(new TextEncoder().encode(input));
}

/** SHA-256 (FIPS 180-4), pure TypeScript so the same code runs in Node and the browser bundle. */
export function sha256BytesHex(bytes: Uint8Array): string {
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


function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA-256 (RFC 2104) over UTF-8 text, hex-encoded. Use for seals/tokens keyed by a secret. */
export function hmacSha256Hex(key: string, message: string): string {
  const blockSize = 64;
  let keyBytes: Uint8Array = new TextEncoder().encode(key);
  if (keyBytes.length > blockSize) keyBytes = hexToBytes(sha256Hex(key));
  const padded = new Uint8Array(blockSize);
  padded.set(keyBytes);
  const ipad = Uint8Array.from(padded, (b) => b ^ 0x36);
  const opad = Uint8Array.from(padded, (b) => b ^ 0x5c);
  // The inner hash is over raw ipad bytes + UTF-8 message bytes.
  const msgBytes = new TextEncoder().encode(message);
  const innerInput = new Uint8Array(blockSize + msgBytes.length);
  innerInput.set(ipad); innerInput.set(msgBytes, blockSize);
  const innerDigest = hexToBytes(sha256BytesHex(innerInput));
  const outerInput = new Uint8Array(blockSize + innerDigest.length);
  outerInput.set(opad); outerInput.set(innerDigest, blockSize);
  return sha256BytesHex(outerInput);
}

/** A CSPRNG token, hex-encoded. Throws rather than falling back to a predictable generator. */
export function randomTokenHex(bytes = 16): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new HashError('no CSPRNG available (crypto.getRandomValues) — refusing to mint a predictable token');
  return bytesToHex(c.getRandomValues(new Uint8Array(bytes)));
}

/** Length-safe constant-work comparison for tokens/fingerprints (avoids early-exit timing leaks). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
