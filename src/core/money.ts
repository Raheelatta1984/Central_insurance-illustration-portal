/**
 * Money: exact decimal arithmetic on integer minor units.
 *
 * Rule 1 of this codebase: money is never a float. Every amount is an integer count of
 * minor units (fils, cents, sen, halala...) in a known currency, and every division or
 * percentage carries an explicit rounding mode.
 */

export const CURRENCY_SCALE: Record<string, number> = {
  AED: 2, SAR: 2, QAR: 2, USD: 2, EUR: 2, GBP: 2, MYR: 2, INR: 2, PKR: 2,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3,
  IDR: 0, JPY: 0, KRW: 0,
  /* The regional master may name any of these as the local currency of a tenant's book, so the
     scale table has to hold them all: an amount in a currency we cannot scale is an amount we
     cannot print, and "unknown currency" is not an answer a console should give an operator. */
  AUD: 2, BDT: 2, BRL: 2, CAD: 2, CHF: 2, CNY: 2, CZK: 2, DKK: 2, EGP: 2, GHS: 2, HKD: 2,
  HUF: 2, KES: 2, LBP: 2, LKR: 2, MAD: 2, MXN: 2, NGN: 2, NOK: 2, NPR: 2, NZD: 2, PHP: 2,
  PLN: 2, RSD: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2, VND: 0, ZAR: 2, IQD: 3, AFN: 2,
};

export type Currency = string;

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil' | 'toward-zero';

export class MoneyError extends Error {}

export function scaleOf(currency: Currency): number {
  const s = CURRENCY_SCALE[currency];
  if (s === undefined) throw new MoneyError(`unknown currency ${currency}`);
  return s;
}

export function money(minor: bigint | number, currency: Currency): Money {
  return { minor: typeof minor === 'bigint' ? minor : BigInt(minor), currency };
}

export function zero(currency: Currency): Money {
  return { minor: 0n, currency };
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

/** Round a rational value (numerator/denominator) to an integer, by mode. */
export function roundRational(num: bigint, den: bigint, mode: RoundingMode = 'half-up'): bigint {
  if (den === 0n) throw new MoneyError('division by zero');
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return neg ? -q : q;
  switch (mode) {
    case 'floor': return neg ? -(q + 1n) : q;
    case 'ceil': return neg ? -q : q + 1n;
    case 'toward-zero': return neg ? -q : q;
    case 'half-even': {
      const twice = r * 2n;
      if (twice > d) return neg ? -(q + 1n) : q + 1n;
      if (twice < d) return neg ? -q : q;
      return q % 2n === 0n ? (neg ? -q : q) : (neg ? -(q + 1n) : q + 1n);
    }
    case 'half-up':
    default:
      return r * 2n >= d ? (neg ? -(q + 1n) : q + 1n) : neg ? -q : q;
  }
}

export function add(a: Money, b: Money): Money { assertSame(a, b); return { minor: a.minor + b.minor, currency: a.currency }; }
export function sub(a: Money, b: Money): Money { assertSame(a, b); return { minor: a.minor - b.minor, currency: a.currency }; }
export function neg(a: Money): Money { return { minor: -a.minor, currency: a.currency }; }
export function abs(a: Money): Money { return { minor: a.minor < 0n ? -a.minor : a.minor, currency: a.currency }; }
export function isZero(a: Money): boolean { return a.minor === 0n; }
export function isNegative(a: Money): boolean { return a.minor < 0n; }
export function compare(a: Money, b: Money): -1 | 0 | 1 { assertSame(a, b); return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0; }
export function equal(a: Money, b: Money): boolean { return a.currency === b.currency && a.minor === b.minor; }
export function gte(a: Money, b: Money): boolean { return compare(a, b) >= 0; }
export function lte(a: Money, b: Money): boolean { return compare(a, b) <= 0; }
export function min(a: Money, b: Money): Money { return compare(a, b) <= 0 ? a : b; }
export function max(a: Money, b: Money): Money { return compare(a, b) >= 0 ? a : b; }
export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}
export function multiply(a: Money, factor: bigint | number, mode: RoundingMode = 'half-up'): Money {
  const f = typeof factor === 'bigint' ? factor : BigInt(factor);
  return { minor: a.minor * f, currency: a.currency };
}
export function divide(a: Money, divisor: bigint | number, mode: RoundingMode = 'half-up'): Money {
  const d = typeof divisor === 'bigint' ? divisor : BigInt(divisor);
  return { minor: roundRational(a.minor, d, mode), currency: a.currency };
}
/**
 * Apply a rate expressed in basis points (1 bp = 0.01%) — the only way we do percentages.
 * Fractional basis points are supported exactly to six decimal places, so a daily accrual such
 * as 150 bps / 365 does not silently truncate to zero.
 */
export function applyBps(a: Money, bps: number, mode: RoundingMode = 'half-up'): Money {
  const microBps = BigInt(Math.round(bps * 1_000_000));
  return { minor: roundRational(a.minor * microBps, 10_000n * 1_000_000n, mode), currency: a.currency };
}
/** Apply an exact rational rate, e.g. 3/8 of a premium. */
export function applyRatio(a: Money, numerator: bigint, denominator: bigint, mode: RoundingMode = 'half-up'): Money {
  return { minor: roundRational(a.minor * numerator, denominator, mode), currency: a.currency };
}

/**
 * Split an amount into parts by weights with zero loss and zero gain (largest remainder method).
 * Used for allocations, surplus distribution, commission splits — anywhere money divides.
 */
export function allocate(a: Money, weights: number[]): Money[] {
  if (weights.length === 0) {
    if (a.minor !== 0n) throw new MoneyError('allocate: nonzero amount needs weights');
    return [];
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('allocate: weights must be finite and nonnegative');
  }
  // Interpret each number's decimal representation exactly, including scientific notation.
  // The denominator MUST be the sum of these same integer weights, not a separately rounded total.
  const decimals = weights.map((w) => {
    const [mantissa = '0', exponent = '0'] = String(w).split('e');
    const [whole = '0', fraction = ''] = mantissa.split('.');
    return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  });
  const scale = Math.max(...decimals.map((w) => w.scale));
  const integers = decimals.map((w) => w.digits * 10n ** BigInt(scale - w.scale));
  const total = integers.reduce((s, w) => s + w, 0n);
  if (total === 0n) throw new MoneyError('allocate: weights sum to zero');
  const magnitude = a.minor < 0n ? -a.minor : a.minor;
  const raw = integers.map((w) => magnitude * w / total);
  let remainder = magnitude - raw.reduce((s, r) => s + r, 0n);
  const order = integers.map((w, i) => ({ i, frac: magnitude * w % total }))
    .sort((x, y) => x.frac === y.frac ? x.i - y.i : x.frac > y.frac ? -1 : 1);
  const out = raw.slice();
  for (const { i } of order) {
    if (remainder === 0n) break;
    out[i] = out[i]! + 1n;
    remainder--;
  }
  if (remainder !== 0n) throw new MoneyError('allocate: conservation invariant failed');
  if (a.minor < 0n) for (let i = 0; i < out.length; i++) out[i] = -out[i]!;
  return out.map((m) => ({ minor: m, currency: a.currency }));
}

export interface FxRate { readonly from: Currency; readonly to: Currency; readonly numerator: bigint; readonly denominator: bigint; readonly asOf: string; }

export function convert(a: Money, rate: FxRate, mode: RoundingMode = 'half-up'): Money {
  assertSame(a, { minor: 0n, currency: rate.from });
  return { minor: roundRational(a.minor * rate.numerator, rate.denominator, mode), currency: rate.to };
}

export function parseAmount(input: string, currency: Currency): Money {
  const clean = input.trim().replace(/,/g, '').replace(/\u00a0/g, '');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(clean);
  if (!m) throw new MoneyError(`cannot parse amount "${input}"`);
  const sign = m[1] ? -1n : 1n;
  const int = BigInt(m[2]!);
  const fracRaw = m[3] ?? '';
  const scale = scaleOf(currency);
  const frac = BigInt((fracRaw + '0'.repeat(scale)).slice(0, scale) || '0');
  const beyond = fracRaw.slice(scale);
  const extra = beyond.length > 0 ? roundRational(BigInt(beyond), 10n ** BigInt(beyond.length)) : 0n;
  return { minor: sign * (int * 10n ** BigInt(scale) + frac + extra), currency };
}

export function formatAmount(a: Money, locale = 'en-AE'): string {
  const scale = scaleOf(a.currency);
  const neg = a.minor < 0n;
  const v = neg ? -a.minor : a.minor;
  const unit = 10n ** BigInt(scale);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(scale, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${scale > 0 ? '.' + frac : ''} ${a.currency}`;
}

export function toDecimalString(a: Money): string {
  const scale = scaleOf(a.currency);
  const neg = a.minor < 0n;
  const v = neg ? -a.minor : a.minor;
  const unit = 10n ** BigInt(scale);
  return `${neg ? '-' : ''}${v / unit}${scale > 0 ? '.' + (v % unit).toString().padStart(scale, '0') : ''}`;
}

export function toNumber(a: Money): number {
  return Number(toDecimalString(a));
}
