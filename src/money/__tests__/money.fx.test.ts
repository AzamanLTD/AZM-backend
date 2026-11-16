/**
 * WP-MONEY — conversion is explicit, quoted and produces a VALUATION.
 *
 * The point of these cases is that a valuation can never be mistaken for
 * spendable money: it carries provenance, it requires a rounding policy, and it
 * is a different type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MoneyError,
  formatValuation,
  makeQuote,
  parseMoney,
  parseRate,
  valueWithQuote,
} from '../index';

const provenance = {
  source: 'pricing-service',
  reference: 'QUOTE-2026-11-16-0001',
  quotedAt: '2026-11-16T09:00:00.000Z',
};
const quote = makeQuote('USDC', 'GHS', '12.50', provenance);

test('a quote needs a positive rate and real provenance', () => {
  assert.throws(() => makeQuote('USDC', 'USDC', '1', provenance), (e: unknown) => e instanceof MoneyError);
  assert.throws(() => makeQuote('USDC', 'GHS', '0', provenance), (e: unknown) => e instanceof MoneyError && e.code === 'INVALID_RATE');
  assert.throws(() => makeQuote('USDC', 'GHS', '-12.5', provenance), (e: unknown) => e instanceof MoneyError);
  assert.throws(() => makeQuote('USDC', 'GHS', '1e3', provenance), (e: unknown) => e instanceof MoneyError);
  assert.throws(
    () => makeQuote('USDC', 'GHS', '12.50', { ...provenance, source: '  ' }),
    (e: unknown) => e instanceof MoneyError && e.code === 'INVALID_PROVENANCE',
  );
  assert.throws(
    () => makeQuote('USDC', 'GHS', '12.50', { ...provenance, quotedAt: 'not-a-date' }),
    (e: unknown) => e instanceof MoneyError && e.code === 'INVALID_PROVENANCE',
  );
  assert.deepEqual(parseRate('12.50'), { numerator: 1250n, denominator: 100n });
});

test('conversion is exact until the caller names a rounding mode', () => {
  const one = valueWithQuote(parseMoney('1.00000000', 'USDC'), quote, 'HALF_UP');
  assert.equal(formatValuation(one), '12.50');
  assert.equal(one.currency, 'GHS');
  assert.equal(one.kind, 'VALUATION');
  assert.deepEqual(one.provenance, provenance);

  const half = valueWithQuote(parseMoney('0.50000000', 'USDC'), quote, 'HALF_UP');
  assert.equal(formatValuation(half), '6.25');

  // One minor USDC unit is worth far less than a pesewa: the mode decides.
  const dust = parseMoney('0.00000001', 'USDC');
  assert.equal(formatValuation(valueWithQuote(dust, quote, 'DOWN')), '0.00');
  assert.equal(formatValuation(valueWithQuote(dust, quote, 'UP')), '0.01');
});

test('rounding modes disagree exactly where the rate is not round', () => {
  const awkward = makeQuote('USDC', 'GHS', '12.345', provenance);
  const one = parseMoney('1.00000000', 'USDC');
  assert.equal(formatValuation(valueWithQuote(one, awkward, 'DOWN')), '12.34');
  assert.equal(formatValuation(valueWithQuote(one, awkward, 'UP')), '12.35');
  assert.equal(formatValuation(valueWithQuote(one, awkward, 'HALF_UP')), '12.35');
  assert.equal(formatValuation(valueWithQuote(one, awkward, 'HALF_EVEN')), '12.34');

  const negative = parseMoney('-1.00000000', 'USDC');
  assert.equal(formatValuation(valueWithQuote(negative, awkward, 'DOWN')), '-12.34');
  assert.equal(formatValuation(valueWithQuote(negative, awkward, 'HALF_UP')), '-12.35');
});

test('a quote cannot be applied to the wrong currency', () => {
  const cedis = parseMoney('10.00', 'GHS');
  // The quote is USDC->GHS, so a GHS amount is not the base it converts.
  assert.throws(
    () => valueWithQuote(cedis as never, quote, 'HALF_UP'),
    (e: unknown) => e instanceof MoneyError && e.code === 'CURRENCY_MISMATCH',
  );
});
