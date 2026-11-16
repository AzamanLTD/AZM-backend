/**
 * WP-MONEY — COMPILE-TIME negative tests.
 *
 * This file is included in `tsconfig.money.json` and is never executed. Each
 * `@ts-expect-error` asserts that the line below it MUST NOT compile: if the
 * type safety regresses (for example someone widens `Money` to accept any
 * currency, or makes a valuation assignable to money), `tsc` reports an unused
 * `@ts-expect-error` and `npm run typecheck:money` fails.
 */
import {
  add,
  makeQuote,
  moneyFromMinorUnits,
  parseMoney,
  valuationToJSONValue,
  valueWithQuote,
  type Money,
  type SerialisedValuation,
} from '../index';

const cedis = parseMoney('10.00', 'GHS');
const dollars = parseMoney('10.00000000', 'USDC');
const quote = makeQuote('USDC', 'GHS', '12.50', {
  source: 'pricing-service',
  reference: 'QUOTE-NEGATIVE-TEST',
  quotedAt: '2026-11-16T09:00:00.000Z',
});

// GHS must not be addable to USDC.
// @ts-expect-error different currencies do not add
add(cedis, dollars);

// @ts-expect-error an unsupported currency code is not a CurrencyCode
parseMoney('1.00', 'EUR');

// A valuation is a statement of worth, not a balance, so it cannot be spent.
const valuation = valueWithQuote(dollars, quote, 'HALF_UP');
// @ts-expect-error a valuation is not Money
add(cedis, valuation);

// The brand means a widened holder cannot be passed off as spendable money.
// @ts-expect-error a valuation cannot be assigned to Money<'GHS'>
const notMoney: Money<'GHS'> = valuation;
void notMoney;

// Precision is not a caller decision: there is no third argument to pass.
// @ts-expect-error the constructor takes only a currency and minor units
moneyFromMinorUnits('GHS', 100n, 2);

// A serialised valuation keeps saying it is a valuation, and is still not money.
const serialised: SerialisedValuation<'GHS'> = valuationToJSONValue(valuation);
// @ts-expect-error a serialised valuation is not spendable money
const spendable: Money<'GHS'> = serialised;
void spendable;

// The raw decimal primitive left the public surface with the same reasoning.
// @ts-expect-error formatMinor is not exported publicly
import { formatMinor } from '../index';
void formatMinor;

export {};
