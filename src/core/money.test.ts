import { describe, expect, it } from 'vitest';
import { add, allocate, applyBps, applyRatio, compare, convert, divide, equal, formatAmount, money, multiply, parseAmount, roundRational, sub, sum, toDecimalString, zero } from './money.js';

describe('money — exact decimal arithmetic', () => {
  it('parses and formats amounts without floating point drift', () => {
    const a = parseAmount('1,234.567', 'AED');
    expect(a.minor).toBe(123457n); // .567 rounds up to .57
    expect(formatAmount(a)).toBe('1,234.57 AED');
    expect(parseAmount('0.005', 'BHD').minor).toBe(5n);
    expect(parseAmount('-12.5', 'IDR').minor).toBe(-13n); // 0-dp currency, half-up
    expect(toDecimalString(money(123456n, 'AED'))).toBe('1234.56');
    expect(parseAmount('1,234.564', 'AED').minor).toBe(123456n);
  });

  it('applies every rounding mode predictably', () => {
    expect(roundRational(5n, 2n, 'half-up')).toBe(3n);
    expect(roundRational(5n, 2n, 'half-even')).toBe(2n);
    expect(roundRational(5n, 2n, 'floor')).toBe(2n);
    expect(roundRational(5n, 2n, 'ceil')).toBe(3n);
    expect(roundRational(-5n, 2n, 'half-up')).toBe(-3n);
    expect(roundRational(-5n, 2n, 'floor')).toBe(-3n);
    expect(roundRational(-5n, 2n, 'toward-zero')).toBe(-2n);
  });

  it('never loses or gains a minor unit when splitting money', () => {
    const amount = money(10000n, 'AED');
    const parts = allocate(amount, [1, 1, 1]);
    expect(sum(parts, 'AED').minor).toBe(10000n);
    expect(parts.map((p) => p.minor)).toEqual([3334n, 3333n, 3333n]);
    const uneven = allocate(money(1n, 'AED'), [1, 1, 1]);
    expect(sum(uneven, 'AED').minor).toBe(1n);
    const weights = allocate(money(9_999_999n, 'AED'), [3, 5, 7, 11]);
    expect(sum(weights, 'AED').minor).toBe(9_999_999n);
  });

  it('conserves money for tiny decimal weights and very large amounts', () => {
    expect(allocate(money(100n, 'AED'), [0.0000006, 0.0000006]).map(p => p.minor)).toEqual([50n, 50n]);
    for (const weights of [[1e-300, 2e-300], [0, 0.1, 0.2], [1e300, 1e-300], [0.0000001, 0.0000002]]) {
      for (const amount of [0n, 1n, 100n, 10n ** 40n]) {
        const parts = allocate(money(amount, 'AED'), weights);
        expect(sum(parts, 'AED').minor).toBe(amount);
        expect(parts.every(p => p.minor >= 0n)).toBe(true);
        expect(allocate(money(-amount, 'AED'), weights).map(p => p.minor)).toEqual(parts.map(p => -p.minor));
      }
    }
    expect(allocate(money(-10n, 'AED'), [1, 2]).map(p => p.minor)).toEqual([-3n, -7n]);
  });

  it('refuses invalid weights rather than losing money or accepting non-finite arithmetic', () => {
    for (const weights of [[NaN], [Infinity], [-1, 2], [0, 0], []]) {
      expect(() => allocate(money(100n, 'AED'), weights)).toThrow();
    }
    expect(allocate(zero('AED'), [])).toEqual([]);
  });

  it('treats every percentage as basis points', () => {
    expect(applyBps(money(12345n, 'AED'), 500).minor).toBe(617n);    // 5% of 123.45 -> 6.17 (half-up)
    expect(applyBps(money(10_000n, 'AED'), 1).minor).toBe(1n);       // 0.01% of 100.00 = 0.01
    expect(applyBps(money(1_000_000n, 'AED'), 150 / 365).minor).toBe(41n); // daily accrual keeps fraction precision
    expect(applyRatio(money(1000n, 'AED'), 3n, 8n).minor).toBe(375n);
  });

  it('converts currency with an exact rational rate', () => {
    const usd = money(10000n, 'USD');
    const aed = convert(usd, { from: 'USD', to: 'AED', numerator: 367n, denominator: 100n, asOf: '2026-09-01' });
    expect(aed.currency).toBe('AED');
    expect(aed.minor).toBe(36700n);
    expect(aed.minor).toBe(10000n * 367n / 100n);
  });

  it('is associative and distributive to the minor unit (property check)', () => {
    for (let i = 0; i < 200; i++) {
      const a = money(BigInt(Math.floor(Math.random() * 1_000_000)), 'AED');
      const b = money(BigInt(Math.floor(Math.random() * 1_000_000)), 'AED');
      const c = money(BigInt(Math.floor(Math.random() * 1_000_000)), 'AED');
      expect(add(add(a, b), c).minor).toBe(add(a, add(b, c)).minor);
      expect(sub(add(a, b), b).minor).toBe(a.minor);
      expect(multiply(divide(a, 7), 7).minor - a.minor <= 6n).toBe(true);
      expect(equal(a, a)).toBe(true);
      expect(compare(a, zero('AED')) >= 0 || a.minor < 0n).toBe(true);
    }
  });
});
