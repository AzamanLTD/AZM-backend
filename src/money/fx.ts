/**
 * WP-MONEY — cross-currency conversion as an EXPLICIT, quote-bound operation.
 *
 * Three rules make this safe:
 *
 *  1. A conversion needs a validated quote: a positive decimal rate plus
 *     provenance (source, reference, quoted time). A bare number is not a rate.
 *  2. The result is a `MoneyValuation`, NOT a `Money`. A valuation is a
 *     statement about worth; a balance is money you can spend. There is
 *     deliberately no function that turns one into the other here, so a
 *     valuation cannot be added to a wallet even by accident.
 *  3. A valuation serialises as an object that still says `kind: "VALUATION"`
 *     and still carries its provenance. `JSON.stringify` used to throw on it
 *     because `minorUnits` is a bigint; the `toJSON` method below renders the
 *     exact decimal string instead, and the shape that comes back out cannot be
 *     mistaken for money.
 *
 * WHAT THIS MODULE DOES NOT DO — said plainly, because the opposite is easy to
 * assume from the word "provenance":
 *   • it does not authenticate the provider that supplied a rate;
 *   • it does not verify a signature, an API session or that a quote really came
 *     from the named source;
 *   • it does not decide whether a quote is fresh or stale, or compare it with
 *     another quote.
 * It validates the STRUCTURE and the PROVENANCE FIELDS (`source`, `reference`,
 * `quotedAt`) and refuses malformed input. Whether a given source is trusted and
 * whether a quote is recent enough to act on are decisions for the caller, made
 * against evidence this module never sees.
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { formatMinor } from './format';
import type { Money } from './money';
import { applyRounding, type RoundingMode } from './rounding';

export interface QuoteProvenance {
  /** Where the rate came from, e.g. a pricing service identifier. */
  readonly source: string;
  /** The provider's reference for this quote, so it can be re-checked. */
  readonly reference: string;
  /** ISO-8601 timestamp WITH an explicit zone. A zone-less stamp is refused. */
  readonly quotedAt: string;
}

export interface FxQuote<B extends CurrencyCode, Q extends CurrencyCode> {
  readonly base: B;
  readonly quote: Q;
  /** Exact decimal string, e.g. "12.50" GHS per 1 USDC. */
  readonly rate: string;
  readonly provenance: QuoteProvenance;
}

declare const valuationBrand: unique symbol;

/** The JSON shape of a valuation: still a valuation, never a spendable amount. */
export interface SerialisedValuation<C extends CurrencyCode = CurrencyCode> {
  readonly kind: 'VALUATION';
  readonly currency: C;
  /** Exact decimal string in the quote currency. */
  readonly amount: string;
  readonly provenance: QuoteProvenance;
}

export interface MoneyValuation<C extends CurrencyCode> {
  readonly kind: 'VALUATION';
  readonly currency: C;
  readonly minorUnits: bigint;
  readonly provenance: QuoteProvenance;
  readonly [valuationBrand]: C;
  /** Makes JSON.stringify work without ever exposing the bigint. */
  toJSON(): SerialisedValuation<C>;
}

const RATE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

// Date-time only, seconds required, zone required. Date-only ("2026-11-16") and
// zone-less stamps ("2026-11-16T09:00:00") are refused: JavaScript would read the
// latter as LOCAL time, which silently moves a quote by hours.
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Strict ISO-8601 date-time check: shape AND calendar validity.
 *
 * `Date.parse` alone is too permissive for provenance — it accepts zone-less
 * stamps (interpreted as local time) and platform-dependent formats. This
 * requires the canonical `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` form, real
 * calendar values (no 31 February), and a real offset.
 */
export function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_8601_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  // Calendar check: the same Y/M/D must survive a round trip through UTC, which
  // is what rejects 31 February and other overflow dates.
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year
    || asUtc.getUTCMonth() !== month - 1
    || asUtc.getUTCDate() !== day
  ) {
    return false;
  }

  const zone = match[7];
  if (zone !== 'Z') {
    const offsetHours = Number(match[9]);
    const offsetMinutes = Number(match[10]);
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }

  return !Number.isNaN(Date.parse(value));
}

/** Parse a rate into an exact rational: value = numerator / denominator. */
export function parseRate(rate: string): { numerator: bigint; denominator: bigint } {
  if (typeof rate !== 'string' || !RATE_PATTERN.test(rate)) {
    throw new MoneyError('INVALID_RATE', `not a plain positive decimal rate: ${JSON.stringify(rate)}`);
  }
  const [whole, fraction = ''] = rate.split('.');
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator <= 0n) {
    throw new MoneyError('INVALID_RATE', 'an FX rate must be strictly positive');
  }
  return { numerator, denominator };
}

/**
 * Build a quote from a rate and its provenance.
 *
 * This validates that the rate is a positive exact decimal and that the
 * provenance fields are present and well-formed — including a real ISO-8601
 * `quotedAt` with an explicit zone. It does NOT prove the rate is true, current,
 * or that the named source said it (see the module header).
 */
export function makeQuote<B extends CurrencyCode, Q extends CurrencyCode>(
  base: B,
  quote: Q,
  rate: string,
  provenance: QuoteProvenance,
): FxQuote<B, Q> {
  // Compared as strings: B and Q are distinct type parameters, so the compiler
  // cannot see that they overlap even when both are the same runtime value.
  if ((base as string) === (quote as string)) {
    throw new MoneyError('INVALID_RATE', `a ${base} to ${base} quote is not a conversion`);
  }
  parseRate(rate);
  if (typeof provenance?.source !== 'string' || provenance.source.trim() === '') {
    throw new MoneyError('INVALID_PROVENANCE', 'a quote must name its source');
  }
  if (typeof provenance.reference !== 'string' || provenance.reference.trim() === '') {
    throw new MoneyError('INVALID_PROVENANCE', 'a quote must carry the provider reference');
  }
  if (!isIso8601Timestamp(provenance.quotedAt)) {
    throw new MoneyError(
      'INVALID_PROVENANCE',
      `quotedAt must be ISO-8601 with an explicit zone (YYYY-MM-DDTHH:MM:SS[.sss]Z or ±HH:MM), received ${JSON.stringify(provenance.quotedAt)}`,
    );
  }
  return Object.freeze({ base, quote, rate, provenance: Object.freeze({ ...provenance }) });
}

/** The serialisable shape of a valuation: JSON-safe and still not money. */
export function valuationToJSONValue<C extends CurrencyCode>(
  valuation: MoneyValuation<C>,
): SerialisedValuation<C> {
  return {
    kind: 'VALUATION',
    currency: valuation.currency,
    amount: formatMinor(valuation.minorUnits, CURRENCIES[valuation.currency].decimals),
    provenance: valuation.provenance,
  };
}

/**
 * Value `amount` in the quote's currency. Rounding mode is REQUIRED: the caller
 * states the policy rather than inheriting a silent one.
 */
export function valueWithQuote<B extends CurrencyCode, Q extends CurrencyCode>(
  amount: Money<B>,
  quote: FxQuote<B, Q>,
  mode: RoundingMode,
): MoneyValuation<Q> {
  if (amount.currency !== quote.base) {
    throw new MoneyError(
      'CURRENCY_MISMATCH',
      `the quote converts from ${quote.base}, the amount is ${amount.currency}`,
    );
  }
  const { numerator, denominator } = parseRate(quote.rate);
  const baseScale = CURRENCIES[quote.base].scale;
  const quoteScale = CURRENCIES[quote.quote].scale;
  // minorB/scaleB * rate * scaleQ, as one exact rational in quote minor units.
  const scaled = applyRounding(amount.minorUnits * numerator * quoteScale, baseScale * denominator, mode);

  const valuation = {
    kind: 'VALUATION' as const,
    currency: quote.quote,
    minorUnits: scaled,
    provenance: quote.provenance,
    toJSON(): SerialisedValuation<Q> {
      return valuationToJSONValue(this as MoneyValuation<Q>);
    },
  } as MoneyValuation<Q>;
  return Object.freeze(valuation);
}

/** Render a valuation exactly; it still is not spendable money. */
export function formatValuation<C extends CurrencyCode>(valuation: MoneyValuation<C>): string {
  return formatMinor(valuation.minorUnits, CURRENCIES[valuation.currency].decimals);
}
