/**
 * Units and prices for unit-linked business.
 *
 * Units are notional (the insurer owns the underlying assets); they exist to value the policy.
 * Units are held to 6 decimal places, prices to 6 decimal places of the currency minor unit.
 * Everything is exact integer arithmetic — no accumulating float error in a 30-year policy.
 */
import { Money, RoundingMode, roundRational, money, zero, scaleOf } from './money.js';

export const UNITS_SCALE = 1_000_000n;      // 6 dp of units
export const PRICE_SCALE = 1_000_000n;      // price = minor units * 1e6

export interface Price { readonly micro: bigint; readonly currency: string }

export function priceFromDecimal(input: string | number, currency: string): Price {
  const s = typeof input === 'number' ? input.toFixed(8) : input.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`cannot parse price "${input}"`);
  const neg = m[1] ? -1n : 1n;
  const int = BigInt(m[2]!);
  const frac = (m[3] ?? '').padEnd(6, '0').slice(0, 6);
  const minorMultiplier = 10n ** BigInt(scaleOf(currency));
  return { micro: neg * (int * minorMultiplier * PRICE_SCALE + BigInt(frac) * minorMultiplier), currency };
}

export function priceToDecimal(p: Price): string {
  const scale = scaleOf(p.currency);
  const neg = p.micro < 0n;
  const v = neg ? -p.micro : p.micro;
  const wholeMinor = v / PRICE_SCALE;            // in minor units
  const fracMinor = v % PRICE_SCALE;
  const unit = 10n ** BigInt(scale);
  const whole = wholeMinor / unit;
  const minorFrac = (wholeMinor % unit).toString().padStart(scale, '0');
  const microFrac = fracMinor.toString().padStart(6, '0').replace(/0+$/, '');
  const dec = `${minorFrac}${microFrac}`.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${dec ? '.' + dec : ''}`;
}

export function unitsFromDecimal(input: string | number): bigint {
  const s = typeof input === 'number' ? input.toString() : input.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`cannot parse units "${input}"`);
  const neg = m[1] ? -1n : 1n;
  return neg * (BigInt(m[2]!) * UNITS_SCALE + BigInt((m[3] ?? '').padEnd(6, '0').slice(0, 6)));
}

export function unitsToDecimal(u: bigint): string {
  const neg = u < 0n;
  const v = neg ? -u : u;
  const whole = v / UNITS_SCALE;
  const frac = (v % UNITS_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Value a unit holding at a price. money = units * price, rounded to currency minor units. */
export function valueOfUnits(units: bigint, price: Price, mode: RoundingMode = 'half-up'): Money {
  return money(roundRational(units * price.micro, UNITS_SCALE * PRICE_SCALE, mode), price.currency);
}

/** Units purchasable with an amount at a price. */
export function unitsForAmount(amount: Money, price: Price, mode: RoundingMode = 'half-up'): bigint {
  if (amount.currency !== price.currency) throw new Error(`currency mismatch ${amount.currency}/${price.currency}`);
  return roundRational(amount.minor * UNITS_SCALE * PRICE_SCALE, price.micro, mode);
}

/** Units to cancel to realise an amount (the inverse, so the cash raised is never short). */
export function unitsToRealise(amount: Money, price: Price): bigint {
  return roundRational(amount.minor * UNITS_SCALE * PRICE_SCALE, price.micro, 'ceil');
}

export const UNITS_ZERO = 0n;
export function unitsAdd(a: bigint, b: bigint): bigint { return a + b; }
export function unitsSub(a: bigint, b: bigint): bigint { return a - b; }
export function unitsIsZero(a: bigint): boolean { return a === 0n; }
export function unitsGte(a: bigint, b: bigint): boolean { return a >= b; }
export function unitsMin(a: bigint, b: bigint): bigint { return a < b ? a : b; }
