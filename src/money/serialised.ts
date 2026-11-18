/**
 * WP-MONEY — the one wire shape for an amount.
 *
 * WHY THIS FILE EXISTS ON ITS OWN
 * `Money.toJSON()` and the explicit serialisers must return the SAME shape, but
 * `money.ts` cannot import `serialise.ts` (which needs `Money`) without a cycle.
 * This module depends only on the currency registry and the decimal formatter, so
 * both sides can import it and there is exactly one definition of "what an amount
 * looks like on the wire".
 *
 * WHY THE CURRENCY IS IN THE SHAPE
 * GHS and USDC are separate liability buckets. A serialised amount that renders as
 * a bare "1.50" loses which bucket it belongs to, and a consumer that guesses is
 * the beginning of a mis-settlement. Every automatic serialisation therefore
 * carries its currency tag, and the amount stays an EXACT decimal string — never a
 * number, so no floating point enters on the way out.
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { formatMinor } from './format';

export interface SerialisedMoney<C extends CurrencyCode = CurrencyCode> {
  readonly currency: C;
  /** Exact decimal string at the currency's precision. */
  readonly amount: string;
}

/** Build the wire shape from an exact count of minor units. */
export function serialiseMoney<C extends CurrencyCode>(
  currency: C,
  minorUnits: bigint,
): SerialisedMoney<C> {
  return {
    currency,
    amount: formatMinor(minorUnits, CURRENCIES[currency].decimals),
  };
}
