/**
 * WP-MONEY — cross-currency conversion as an EXPLICIT, quote-bound operation.
 *
 * Two rules make this safe:
 *
 *  1. A conversion needs a validated quote: a positive decimal rate plus
 *     provenance (source, reference, quoted time). A bare number is not a rate.
 *  2. The result is a `MoneyValuation`, NOT a `Money`. A valuation is a
 *     statement about worth; a balance is money you can spend. Converting a
 *     valuation back into a balance requires a different, deliberate act
 *     elsewhere, so no accidental `add` of a valuation into a wallet is even
 *     type-checkable here.
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { MoneyError } from './errors';
import type { Money } from './money';
import { applyRounding, type RoundingMode } from './rounding';

export interface QuoteProvenance {
  /** Where the rate came from, e.g. a pricing service identifier. */
  readonly source: string;
  /** The provider's reference for this quote, so it can be re-checked. */
  readonly reference: string;
  /** ISO-8601 timestamp of the quote; a stale quote is the caller's judgement. */
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

export interface MoneyValuation<C extends CurrencyCode> {
  readonly kind: 'VALUATION';
  readonly currency: C;
  readonly minorUnits: bigint;
  readonly provenance: QuoteProvenance;
  readonly [valuationBrand]: C;
}

const RATE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

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

export function makeQuote<B extends CurrencyCode, Q extends CurrencyCode>(
  base: B,
  quote: Q,
  rate: string,
  provenance: QuoteProvenance,
): FxQuote<B, Q> {
  // Compared as strings: B and Q are distinct type parameters, so the compiler
  // cannot see that they overlap even when both are the same runtime code.
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
  if (typeof provenance.quotedAt !== 'string' || Number.isNaN(Date.parse(provenance.quotedAt))) {
    throw new MoneyError('INVALID_PROVENANCE', 'a quote must carry an ISO-8601 quotedAt');
  }
  return Object.freeze({ base, quote, rate, provenance: Object.freeze({ ...provenance }) });
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
  } as MoneyValuation<Q>;
  return Object.freeze(valuation);
}

/** Render a valuation exactly; it still is not spendable money. */
export function formatValuation<C extends CurrencyCode>(valuation: MoneyValuation<C>): string {
  const { decimals } = CURRENCIES[valuation.currency];
  const negative = valuation.minorUnits < 0n;
  const magnitude = (negative ? -valuation.minorUnits : valuation.minorUnits).toString();
  const padded = magnitude.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  return `${negative && magnitude !== '0' ? '-' : ''}${whole}.${fraction}`;
}
