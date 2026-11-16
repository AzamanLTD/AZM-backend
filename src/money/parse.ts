/**
 * WP-MONEY — strict decimal parsing.
 *
 * The grammar is deliberately narrow, because every extra character accepted
 * here is a way for a float to enter the system later:
 *
 *   -?(0|[1-9][0-9]*)(\.[0-9]{1,decimals})?
 *
 * Rejected on purpose: exponents ("1e3"), thousands separators ("1,000.00"),
 * signs anywhere but the front, a leading "+", surrounding whitespace, a bare
 * ".5", a trailing "5.", underscores, hex, and any fraction carrying a non-zero
 * digit beyond the currency's precision. Purely trailing zeros ("1.230") are
 * normalised, because they change no value.
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { makeMoney, type Money } from './money';

const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function parseMoney<C extends CurrencyCode>(
  input: string,
  currency: C,
): Money<C> {
  if (typeof input !== 'string') {
    throw new MoneyError('NOT_A_DECIMAL_STRING', `expected a decimal string, received ${typeof input}`);
  }
  if (input.length === 0) {
    throw new MoneyError('EMPTY_INPUT', 'expected a decimal string, received an empty string');
  }
  if (input !== input.trim()) {
    throw new MoneyError('MALFORMED_DECIMAL', 'surrounding whitespace is not part of an amount');
  }
  if (/[eE]/.test(input)) {
    throw new MoneyError('EXPONENT_NOT_ALLOWED', `exponents are not money: ${JSON.stringify(input)}`);
  }
  if (input.includes(',')) {
    throw new MoneyError('SEPARATOR_NOT_ALLOWED', `thousands separators are not money: ${JSON.stringify(input)}`);
  }
  if (input.includes('_') || input.includes(' ')) {
    throw new MoneyError('SEPARATOR_NOT_ALLOWED', `separators are not money: ${JSON.stringify(input)}`);
  }
  if (input.startsWith('+')) {
    throw new MoneyError('SIGN_PLACED_WRONG', 'a leading + is refused; a negative amount needs an explicit -');
  }
  if (!DECIMAL_PATTERN.test(input)) {
    throw new MoneyError('MALFORMED_DECIMAL', `not a plain decimal amount: ${JSON.stringify(input)}`);
  }

  const negative = input.startsWith('-');
  const unsigned = negative ? input.slice(1) : input;
  const dot = unsigned.indexOf('.');
  const wholePart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fractionPart = dot === -1 ? '' : unsigned.slice(dot + 1);

  const spec = CURRENCIES[currency];
  if (fractionPart.length > spec.decimals) {
    // Excess digits that are ALL ZERO add nothing: "1.230" is exactly 1.23, so
    // it is normalised rather than refused. Anything else is a value this
    // currency cannot hold, and refusing is the only honest answer (rounding it
    // here would silently change money).
    const excess = fractionPart.slice(spec.decimals);
    if (!/^0+$/.test(excess)) {
      throw new MoneyError(
        'EXCESS_PRECISION',
        `${currency} holds ${spec.decimals} decimals; ${JSON.stringify(input)} carries a non-zero digit beyond them`,
      );
    }
  }

  const fractionPadded = fractionPart.slice(0, spec.decimals).padEnd(spec.decimals, '0');
  const minorUnits = BigInt(`${wholePart}${fractionPadded}`);
  return makeMoney(currency, negative ? -minorUnits : minorUnits, spec.decimals);
}

/** Parse only when the value is present; `undefined` stays `undefined`. */
export function parseOptionalMoney<C extends CurrencyCode>(
  input: string | null | undefined,
  currency: C,
): Money<C> | undefined {
  if (input === null || input === undefined) return undefined;
  return parseMoney(input, currency);
}
