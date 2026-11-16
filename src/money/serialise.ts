/**
 * WP-MONEY — the boundary representation.
 *
 * Two shapes only:
 *   - `moneyToJSONValue` for anything that leaves the process as JSON:
 *     { currency, amount } with the amount as an EXACT decimal string.
 *   - `moneyToDecimalString` for Prisma/DECIMAL columns.
 *
 * A bigint never reaches JSON: `JSON.stringify` throws on it, and a string is
 * the only representation that survives every consumer unchanged.
 */
import { CURRENCIES, currencySpec, type CurrencyCode } from './currency';
import { formatMinor } from './format';
import type { Money } from './money';
import { parseMoney } from './parse';

export interface SerialisedMoney<C extends CurrencyCode = CurrencyCode> {
  readonly currency: C;
  readonly amount: string;
}

export function moneyToJSONValue<C extends CurrencyCode>(money: Money<C>): SerialisedMoney<C> {
  return { currency: money.currency, amount: formatMinor(money.minorUnits, CURRENCIES[money.currency].decimals) };
}

/** Prisma DECIMAL column value: a string, never a float. */
export function moneyToDecimalString<C extends CurrencyCode>(money: Money<C>): string {
  return formatMinor(money.minorUnits, CURRENCIES[money.currency].decimals);
}

/** Rehydrate from a database or API value, refusing anything that is not exact. */
export function moneyFromDecimalString(value: string, currencyCode: string): Money<CurrencyCode> {
  const spec = currencySpec(currencyCode);
  return parseMoney(value, spec.code);
}
