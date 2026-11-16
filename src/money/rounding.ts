/**
 * WP-MONEY — the only place a value is allowed to lose precision.
 *
 * Rounding is never implicit. A caller that wants a rounded figure names the
 * mode, so a fee, a split and a statement can each pick the policy their
 * accounting actually wants — and the choice is visible in review.
 */
import { CURRENCIES, type CurrencyCode } from './currency';
import { MoneyError } from './errors';
import { makeMoney, type Money } from './money';

export type RoundingMode = 'DOWN' | 'UP' | 'HALF_UP' | 'HALF_EVEN';

/** Round a rational amount (numerator/denominator) of MAJOR units to minor units. */
export function applyRounding(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new MoneyError('DIVISOR_INVALID', 'cannot round with a zero denominator');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  let magnitude = quotient;

  if (remainder !== 0n) {
    switch (mode) {
      case 'DOWN':
        break;
      case 'UP':
        magnitude += 1n;
        break;
      case 'HALF_UP':
        if (remainder * 2n >= d) magnitude += 1n;
        break;
      case 'HALF_EVEN': {
        const twice = remainder * 2n;
        if (twice > d) magnitude += 1n;
        else if (twice === d && quotient % 2n !== 0n) magnitude += 1n;
        break;
      }
    }
  }
  return negative ? -magnitude : magnitude;
}

/**
 * Round an arbitrary minor-unit figure that is ALREADY in this currency (for
 * example the output of a proportional calculation) to whole minor units.
 */
export function roundMinorUnits<C extends CurrencyCode>(
  numerator: bigint,
  denominator: bigint,
  currency: C,
  mode: RoundingMode,
): Money<C> {
  return makeMoney(currency, applyRounding(numerator, denominator, mode), CURRENCIES[currency].decimals);
}
