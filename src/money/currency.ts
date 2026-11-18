/**
 * WP-MONEY — the currency register.
 *
 * Precision is a property of the CURRENCY, not of the call site: GHS is held in
 * pesewas (2 decimals) and USDC in its existing 8-decimal internal precision.
 * Nothing in this module ever guesses a precision, and nothing widens it.
 */
import { MoneyError } from './errors';

export type CurrencyCode = 'GHS' | 'USDC';

export interface CurrencySpec<C extends CurrencyCode = CurrencyCode> {
  readonly code: C;
  /** Exact number of decimal places this currency is held to. */
  readonly decimals: number;
  /** 10 ** decimals, as an exact bigint scale factor. */
  readonly scale: bigint;
  /** Human label, never used for arithmetic. */
  readonly label: string;
}

function spec<C extends CurrencyCode>(code: C, decimals: number, label: string): CurrencySpec<C> {
  return Object.freeze({ code, decimals, scale: 10n ** BigInt(decimals), label });
}

export const GHS: CurrencySpec<'GHS'> = spec('GHS', 2, 'Ghana cedi');
export const USDC: CurrencySpec<'USDC'> = spec('USDC', 8, 'USD Coin');

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencySpec>> = Object.freeze({
  GHS: GHS as CurrencySpec,
  USDC: USDC as CurrencySpec,
});

/**
 * Resolve a currency from untrusted input (an API body, a database column).
 * An unknown code is a refusal, never a default: defaulting is how a USDC
 * figure gets spent as cedis.
 */
export function currencySpec(value: string): CurrencySpec {
  if (value === 'GHS' || value === 'USDC') return CURRENCIES[value];
  throw new MoneyError('UNSUPPORTED_CURRENCY', `unsupported currency ${JSON.stringify(value)}`);
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return value === 'GHS' || value === 'USDC';
}
