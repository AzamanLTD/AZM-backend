/**
 * WP-MONEY — the value type.
 *
 * `Money<C>` is an exact integer count of MINOR units plus its currency. It is
 * branded by currency, so `Money<'GHS'>` and `Money<'USDC'>` are different types
 * and adding one to the other does not compile. That is the whole point of the
 * module: the units cannot be confused at runtime because they cannot be
 * confused at all.
 *
 * No JavaScript `Number` ever touches an amount. The single numeric field is a
 * bigint of minor units, and it is not enumerable by JSON on purpose.
 */
import type { CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { formatMinor } from './format';

/** Brand keeps structurally-identical money of different currencies apart. */
declare const moneyBrand: unique symbol;

export interface Money<C extends CurrencyCode> {
  readonly currency: C;
  readonly minorUnits: bigint;
  readonly [moneyBrand]: C;
  /** Exact decimal string. JSON.stringify uses this, never the bigint. */
  toJSON(): string;
  toString(): string;
}

export function makeMoney<C extends CurrencyCode>(
  currency: C,
  minorUnits: bigint,
  decimals: number,
): Money<C> {
  const value: Money<C> = {
    currency,
    minorUnits,
    toJSON(): string {
      return formatMinor(minorUnits, decimals);
    },
    toString(): string {
      return `${formatMinor(minorUnits, decimals)} ${currency}`;
    },
  } as Money<C>;
  return Object.freeze(value);
}

/**
 * Same-currency assertion with a typed refusal. TypeScript stops the mistake at
 * compile time; this stops it when a value crossed a JSON boundary and the type
 * was widened to `Money<CurrencyCode>`.
 */
export function assertSameCurrency<A extends CurrencyCode, B extends CurrencyCode>(
  a: Money<A>,
  b: Money<B>,
): asserts b is Money<B & A> {
  // Cast to string: A and B are distinct type parameters, so the compiler sees
  // these as non-overlapping even when the runtime values are comparable.
  if ((a.currency as string) !== (b.currency as string)) {
    throw new MoneyError(
      'CURRENCY_MISMATCH',
      `cannot combine ${a.currency} with ${b.currency} without an explicit FX valuation`,
    );
  }
}
