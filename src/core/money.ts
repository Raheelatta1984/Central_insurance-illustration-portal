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
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new MoneyError('allocate: negative weight');
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) throw new MoneyError('allocate: weights sum to zero');
  const raw = weights.map((w) => (a.minor * BigInt(Math.round(w * 1e6))) / BigInt(Math.round(total * 1e6)));
  const allocated = raw.reduce((s, r) => s + r, 0n);
  let remainder = a.minor - allocated;
  const order = raw
    .map((r, i) => ({ i, frac: (a.minor * BigInt(Math.round(weights[i]! * 1e6))) % BigInt(Math.round(total * 1e6)) }))
    .sort((x, y) => (y.frac === x.frac ? x.i - y.i : y.frac > x.frac ? 1 : -1));
  const out = raw.slice();
  const step = remainder < 0n ? -1n : 1n;
  let k = 0;
  while (remainder !== 0n && k < order.length * 2) {
    const idx = order[k % order.length]!.i;
    out[idx] = out[idx]! + step;
    remainder -= step;
    k++;
  }
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
