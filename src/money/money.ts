/**
 * WP-MONEY — the value type.
 *
 * `Money<C>` is an exact integer count of MINOR units plus its currency. It is
 * branded by currency, so `Money<'GHS'>` and `Money<'USDC'>` are different types
 * and adding one to the other does not compile.
 *
 * PRECISION IS NOT A PARAMETER. The only constructor takes a currency and a
 * count of minor units; the number of decimals always comes from the currency
 * registry. An earlier version accepted a `decimals` argument, which let a
 * caller build 3-decimal cedis or 2-decimal USDC and silently misrender every
 * later amount. There is no longer a public door to that mistake.
 *
 * No JavaScript `Number` ever touches an amount: the single numeric field is a
 * bigint of minor units, and JSON never sees it (`toJSON` renders an exact
 * decimal string).
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { formatMinor } from './format';

declare const moneyBrand: unique symbol;

export interface Money<C extends CurrencyCode> {
  readonly currency: C;
  readonly minorUnits: bigint;
  readonly [moneyBrand]: C;
  /** Exact decimal string. JSON.stringify uses this, never the bigint. */
  toJSON(): string;
  toString(): string;
}

/**
 * The only way to build money from an integer count of minor units.
 *
 * Its contract is safe for application callers precisely because `decimals`
 * cannot be supplied: the currency registry is the single source of precision.
 */
export function moneyFromMinorUnits<C extends CurrencyCode>(currency: C, minorUnits: bigint): Money<C> {
  const { decimals } = CURRENCIES[currency];
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

/** Exact decimal rendering of a value, at the precision its currency holds. */
export function formatMoney<C extends CurrencyCode>(money: Money<C>): string {
  return formatMinor(money.minorUnits, CURRENCIES[money.currency].decimals);
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
