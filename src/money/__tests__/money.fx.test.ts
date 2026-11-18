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
  isIso8601Timestamp,
  makeQuote,
  parseMoney,
  parseRate,
  valuationToJSONValue,
  valueWithQuote,
  type RoundingMode,
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

// ── Correction 2: a valuation serialises as a valuation ──────────────────────

test('JSON.stringify works on a valuation and keeps it a valuation', () => {
  const valuation = valueWithQuote(parseMoney('1.00000000', 'USDC'), quote, 'HALF_UP');

  // Before this change this call threw: bigint has no JSON representation.
  const json = JSON.stringify(valuation);
  const parsed = JSON.parse(json) as Record<string, unknown>;

  assert.equal(parsed['kind'], 'VALUATION');
  assert.equal(parsed['currency'], 'GHS');
  assert.equal(parsed['amount'], '12.50');
  assert.deepEqual(parsed['provenance'], provenance);

  // No raw bigint and no integer minor units leak into the wire shape.
  assert.equal('minorUnits' in parsed, false);
  assert.equal(typeof parsed['amount'], 'string');

  // The explicit helper produces exactly the same object.
  assert.deepEqual(valuationToJSONValue(valuation), parsed);
});

test('a serialised valuation keeps its precision and provenance for re-checking', () => {
  const small = valueWithQuote(parseMoney('0.00000001', 'USDC'), quote, 'UP');
  const parsed = JSON.parse(JSON.stringify(small)) as Record<string, unknown>;
  assert.equal(parsed['amount'], '0.01');
  assert.equal((parsed['provenance'] as Record<string, unknown>)['reference'], provenance.reference);
});

// ── Correction 3: quotedAt is a real ISO-8601 timestamp, not a Date.parse guess

test('quotedAt must be ISO-8601 with an explicit zone', () => {
  const accepted = [
    '2026-11-16T09:00:00Z',
    '2026-11-16T09:00:00.000Z',
    '2026-11-16T09:00:00.123456Z',
    '2026-11-16T09:00:00+00:00',
    '2026-11-16T09:00:00-05:30',
    '2026-02-28T23:59:59Z',
    '2028-02-29T00:00:00Z', // a real leap day
  ];
  for (const value of accepted) {
    assert.equal(isIso8601Timestamp(value), true, `${value} should be accepted`);
    assert.doesNotThrow(() => makeQuote('USDC', 'GHS', '12.50', { ...provenance, quotedAt: value }));
  }

  const rejected = [
    '2026-11-16',                 // date only, no time
    '2026-11-16T09:00:00',        // no zone: Date.parse would read it as LOCAL time
    '2026-11-16 09:00:00Z',       // space instead of T
    '2026-11-16T09:00Z',          // no seconds
    '2026-13-01T00:00:00Z',       // month 13
    '2026-02-30T00:00:00Z',       // 30 February
    '2026-11-16T24:00:00Z',       // hour 24
    '2026-11-16T09:00:00+24:00',  // impossible offset
    '16/11/2026T09:00:00Z',       // not ISO ordering
    'not-a-date',
    '',
  ];
  for (const value of rejected) {
    assert.equal(isIso8601Timestamp(value), false, `${value} should be rejected`);
    assert.throws(
      () => makeQuote('USDC', 'GHS', '12.50', { ...provenance, quotedAt: value }),
      (e: unknown) => e instanceof MoneyError && e.code === 'INVALID_PROVENANCE',
      `${value} should be refused as provenance`,
    );
  }
});

test('a conversion refuses an unsupported rounding mode before converting', () => {
  const one = parseMoney('1.00000000', 'USDC');
  for (const mode of ['NEAREST', 'down', '', null, 1]) {
    assert.throws(
      () => valueWithQuote(one, quote, mode as unknown as RoundingMode),
      (e: unknown) => e instanceof MoneyError && e.code === 'INVALID_ROUNDING_MODE',
      `mode ${JSON.stringify(mode)} must be refused`,
    );
  }
  // And the valid policy still applies exactly as before, including negatives.
  assert.equal(formatValuation(valueWithQuote(one, quote, 'DOWN')), '12.50');
  assert.equal(
    formatValuation(valueWithQuote(parseMoney('-1.00000000', 'USDC'), quote, 'HALF_UP')),
    '-12.50',
  );
});
