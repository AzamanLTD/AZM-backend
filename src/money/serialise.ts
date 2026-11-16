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
import { serialiseMoney, type SerialisedMoney } from './serialised';

export type { SerialisedMoney } from './serialised';

/**
 * The same tagged shape `JSON.stringify` produces through `Money.toJSON`.
 * Kept as an explicit helper for code that cannot rely on method dispatch.
 */
export function moneyToJSONValue<C extends CurrencyCode>(money: Money<C>): SerialisedMoney<C> {
  return serialiseMoney(money.currency, money.minorUnits);
}

/**
 * Prisma DECIMAL column value: a bare decimal string, never a float and never
 * tagged, because the column itself determines the currency.
 */
export function moneyToDecimalString<C extends CurrencyCode>(money: Money<C>): string {
  return formatMinor(money.minorUnits, CURRENCIES[money.currency].decimals);
}

/** Rehydrate from a database or API value, refusing anything that is not exact. */
export function moneyFromDecimalString(value: string, currencyCode: string): Money<CurrencyCode> {
  const spec = currencySpec(currencyCode);
  return parseMoney(value, spec.code);
}
