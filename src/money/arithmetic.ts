/**
 * WP-MONEY — exact arithmetic.
 *
 * Everything here is integer addition on bigints. There is no division except
 * where a caller asks for it explicitly, and no rounding except through
 * `./rounding.js`. Quantities are integers: a "half a unit" multiplier is a
 * refusal, not a floating point multiplication.
 */
import type { CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { assertSameCurrency, moneyFromMinorUnits, type Money } from './money';

export type Ordering = -1 | 0 | 1;

// NoInfer pins C to the FIRST argument, so `add(cedis, dollars)` fails instead of
// inferring C = 'GHS' | 'USDC' and happily accepting both. Without it the type
// system widens to a union and the whole brand becomes decorative.

export function add<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(a, b);
  return moneyFromMinorUnits(a.currency, a.minorUnits + b.minorUnits);
}

export function subtract<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(a, b);
  return moneyFromMinorUnits(a.currency, a.minorUnits - b.minorUnits);
}

export function negate<C extends CurrencyCode>(a: Money<C>): Money<C> {
  return moneyFromMinorUnits(a.currency, -a.minorUnits);
}

export function abs<C extends CurrencyCode>(a: Money<C>): Money<C> {
  return moneyFromMinorUnits(a.currency, a.minorUnits < 0n ? -a.minorUnits : a.minorUnits);
}

export function isZero<C extends CurrencyCode>(a: Money<C>): boolean {
  return a.minorUnits === 0n;
}

export function isNegative<C extends CurrencyCode>(a: Money<C>): boolean {
  return a.minorUnits < 0n;
}

export function compare<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): Ordering {
  assertSameCurrency(a, b);
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}

export function equals<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): boolean {
  return compare(a, b) === 0;
}

export function min<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  return compare(a, b) <= 0 ? a : b;
}

export function max<C extends CurrencyCode>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  return compare(a, b) >= 0 ? a : b;
}

/** Sum an empty-safe list; an empty list needs an explicit zero to type. */
export function sum<C extends CurrencyCode>(amounts: readonly Money<NoInfer<C>>[], zero: Money<C>): Money<C> {
  let total = zero;
  for (const amount of amounts) total = add(total, amount);
  return total;
}

export type Quantity = bigint | number;

/**
 * Multiply by a whole number of units: 3 invoices at 0.30 is 0.90 exactly.
 * A fractional or unsafe quantity is refused — that is where floats usually get
 * in, and the caller has to say what rounding they meant.
 */
export function multiplyByQuantity<C extends CurrencyCode>(amount: Money<C>, quantity: Quantity): Money<C> {
  let units: bigint;
  if (typeof quantity === 'bigint') {
    units = quantity;
  } else {
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity)) {
      throw new MoneyError('QUANTITY_NOT_INTEGER', `quantity must be a whole number, received ${String(quantity)}`);
    }
    if (!Number.isSafeInteger(quantity)) {
      throw new MoneyError('QUANTITY_UNSAFE', `quantity ${String(quantity)} exceeds safe integer range`);
    }
    units = BigInt(quantity);
  }
  return moneyFromMinorUnits(amount.currency, amount.minorUnits * units);
}

/**
 * Split into `divisor` equal parts, returning the exact quotient AND the
 * remainder so a caller can allocate the leftover minor units deliberately
 * instead of losing them to invisible rounding.
 */
export function divideIntoParts<C extends CurrencyCode>(
  amount: Money<C>,
  divisor: bigint,
): { readonly quotient: Money<C>; readonly remainderMinorUnits: bigint } {
  if (divisor === 0n) {
    throw new MoneyError('DIVISOR_INVALID', 'cannot divide money by zero');
  }
  const quotient = amount.minorUnits / divisor;
  const remainder = amount.minorUnits % divisor;
  return {
    quotient: moneyFromMinorUnits(amount.currency, quotient),
    remainderMinorUnits: remainder,
  };
}
