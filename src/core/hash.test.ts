/**
 * The hash module is load-bearing: snapshot seals, the outbox chain, PII masking and customer
 * tokens all ride on it. Hand-rolled crypto earns its place only with known-answer tests —
 * including the padding boundaries where implementations usually break.
 */
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, randomTokenHex, sha256Hex, timingSafeEqualHex } from './hash.js';

describe('sha256Hex (FIPS 180-4 known answers)', () => {
  it('hashes the empty string and a single block', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 56-byte padding-boundary message (two blocks)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes a long multi-block message', () => {
    expect(sha256Hex('a'.repeat(1_000_000)))
      .toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});

describe('hmacSha256Hex', () => {
  it('matches the published HMAC-SHA-256 example', () => {
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('differs by key, so a seal cannot be recomputed without the secret', () => {
    expect(hmacSha256Hex('k1', 'payload')).not.toBe(hmacSha256Hex('k2', 'payload'));
  });
});

describe('randomTokenHex / timingSafeEqualHex', () => {
  it('mints unique hex tokens of the requested entropy', () => {
    const a = randomTokenHex(16);
    const b = randomTokenHex(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('compares tokens without length or content shortcuts', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abcx')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abcde')).toBe(false);
  });
});
