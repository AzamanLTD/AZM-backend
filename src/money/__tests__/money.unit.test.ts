/**
 * WP-MONEY — runtime proofs for the money core.
 *
 * Run with:  npm run test:money
 * Every assertion is on minutes/units of exact integers; nothing here goes
 * through a float, which is also why the property-style block uses integer
 * arithmetic for its own bookkeeping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MoneyError,
  add,
  compare,
  divideIntoParts,
  formatMinor,
  makeMoney,
  multiplyByQuantity,
  parseMoney,
  subtract,
  applyRounding,
  moneyToDecimalString,
  moneyToJSONValue,
  moneyFromDecimalString,
  CURRENCIES,
  type Money,
} from '../index';

const ghs = (value: string): Money<'GHS'> => parseMoney(value, 'GHS');
const usdc = (value: string): Money<'USDC'> => parseMoney(value, 'USDC');

test('GHS holds exactly two decimals', () => {
  assert.equal(ghs('0.01').minorUnits, 1n);
  assert.equal(ghs('0.10').minorUnits, 10n);
  assert.equal(ghs('0.30').minorUnits, 30n);
  assert.equal(ghs('100').minorUnits, 10000n);
  assert.equal(ghs('100.5').minorUnits, 10050n);

  // The case that breaks binary floating point: 0.1 + 0.2 === 0.3 exactly.
  assert.equal(add(ghs('0.10'), ghs('0.20')).minorUnits, 30n);
  assert.equal(formatMinor(add(ghs('0.10'), ghs('0.20')).minorUnits, 2), '0.30');
});

test('large values stay exact because they are bigints, not doubles', () => {
  const large = ghs('999999999999999999.99');
  assert.equal(large.minorUnits, 99999999999999999999n);

  // Past Number.MAX_SAFE_INTEGER in minor units (2^53-1 = 9007199254740991).
  const huge = makeMoney('GHS', 9007199254740993n, 2);
  assert.equal(huge.minorUnits, 9007199254740993n);
  assert.equal(formatMinor(huge.minorUnits, 2), '90071992547409.93');

  assert.equal(add(large, ghs('0.01')).minorUnits, 100000000000000000000n);
});

test('USDC keeps its existing eight-decimal precision', () => {
  assert.equal(usdc('1.00000000').minorUnits, 100000000n);
  assert.equal(usdc('0.00000001').minorUnits, 1n);
  assert.equal(usdc('1234.56789012').minorUnits, 123456789012n);
  assert.equal(formatMinor(usdc('0.00000001').minorUnits, 8), '0.00000001');
});

test('negative amounts parse, compare and render exactly', () => {
  assert.equal(ghs('-0.01').minorUnits, -1n);
  assert.equal(formatMinor(ghs('-0.01').minorUnits, 2), '-0.01');
  assert.equal(compare(ghs('-0.01'), ghs('0.00')), -1);
  assert.equal(compare(ghs('0.30'), ghs('0.30')), 0);
  assert.equal(subtract(ghs('0.30'), ghs('0.10')).minorUnits, 20n);
  // A negative that nets to zero must not render as "-0.00".
  assert.equal(formatMinor(subtract(ghs('0.01'), ghs('0.01')).minorUnits, 2), '0.00');
});

test('precision boundaries are refused, never rounded implicitly', () => {
  assert.throws(() => ghs('1.234'), (e: unknown) => e instanceof MoneyError && e.code === 'EXCESS_PRECISION');
  assert.throws(
    () => usdc('1.000000001'),
    (e: unknown) => e instanceof MoneyError && e.code === 'EXCESS_PRECISION',
  );
  // Trailing zeros add nothing, so they are normalised rather than refused:
  // database DECIMAL columns routinely render values that way.
  assert.equal(ghs('1.230').minorUnits, 123n);
  assert.equal(ghs('1.2300').minorUnits, 123n);
  assert.equal(usdc('1.000000000').minorUnits, 100000000n);
});

test('malformed and lossy inputs are refused with typed codes', () => {
  const cases: Array<[string, string]> = [
    ['1e3', 'EXPONENT_NOT_ALLOWED'],
    ['1E3', 'EXPONENT_NOT_ALLOWED'],
    ['1,000.00', 'SEPARATOR_NOT_ALLOWED'],
    ['1_000.00', 'SEPARATOR_NOT_ALLOWED'],
    [' 1.00', 'MALFORMED_DECIMAL'],
    ['1.00 ', 'MALFORMED_DECIMAL'],
    ['+1.00', 'SIGN_PLACED_WRONG'],
    ['.5', 'MALFORMED_DECIMAL'],
    ['5.', 'MALFORMED_DECIMAL'],
    ['1.2.3', 'MALFORMED_DECIMAL'],
    ['abc', 'MALFORMED_DECIMAL'],
    ['0x10', 'MALFORMED_DECIMAL'],
    ['', 'EMPTY_INPUT'],
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => ghs(input),
      (e: unknown) => e instanceof MoneyError && e.code === code,
      `${JSON.stringify(input)} should be refused with ${code}`,
    );
  }
});

test('an unsupported currency code is a refusal, not a default', () => {
  assert.throws(
    () => moneyFromDecimalString('1.00', 'EUR'),
    (e: unknown) => e instanceof MoneyError && e.code === 'UNSUPPORTED_CURRENCY',
  );
  assert.equal(Object.keys(CURRENCIES).length, 2);
});

test('mixing currencies fails at runtime too, with a typed refusal', () => {
  // The type system stops this; when a value has crossed a JSON boundary its
  // type may have widened, so the runtime must also refuse.
  const widenedGhs = ghs('1.00') as Money<'GHS'>;
  const widenedUsdc = usdc('1.00000000') as unknown as Money<'GHS'>;
  assert.throws(
    () => add(widenedGhs, widenedUsdc),
    (e: unknown) => e instanceof MoneyError && e.code === 'CURRENCY_MISMATCH',
  );
});

test('multiplication is by whole quantities only', () => {
  assert.equal(multiplyByQuantity(ghs('0.30'), 3).minorUnits, 90n);
  assert.equal(formatMinor(multiplyByQuantity(ghs('0.30'), 3).minorUnits, 2), '0.90');
  assert.equal(multiplyByQuantity(ghs('0.30'), 3n).minorUnits, 90n);
  assert.equal(multiplyByQuantity(ghs('0.30'), -2).minorUnits, -60n);

  assert.throws(
    () => multiplyByQuantity(ghs('0.30'), 1.5),
    (e: unknown) => e instanceof MoneyError && e.code === 'QUANTITY_NOT_INTEGER',
  );
  assert.throws(
    () => multiplyByQuantity(ghs('0.30'), Number.MAX_SAFE_INTEGER + 2),
    (e: unknown) => e instanceof MoneyError && e.code === 'QUANTITY_UNSAFE',
  );
});

test('rounding happens only through the explicit function, and says which way', () => {
  // applyRounding takes a rational count of MINOR units: 1/2 is half a pesewa.
  assert.equal(applyRounding(1n, 2n, 'DOWN'), 0n);
  assert.equal(applyRounding(1n, 2n, 'UP'), 1n);
  assert.equal(applyRounding(1n, 2n, 'HALF_UP'), 1n);
  assert.equal(applyRounding(1n, 2n, 'HALF_EVEN'), 0n); // 0 is the even neighbour
  assert.equal(applyRounding(3n, 2n, 'HALF_EVEN'), 2n); // 2 is the even neighbour
  assert.equal(applyRounding(1n, 3n, 'HALF_UP'), 0n); // a third rounds down
  assert.equal(applyRounding(2n, 3n, 'HALF_UP'), 1n);

  // Negative amounts round away from or towards zero by the named mode.
  assert.equal(applyRounding(-3n, 2n, 'HALF_UP'), -2n);
  assert.equal(applyRounding(-3n, 2n, 'DOWN'), -1n);
  assert.equal(applyRounding(-1n, 3n, 'UP'), -1n);

  assert.throws(() => applyRounding(1n, 0n, 'HALF_UP'), (e: unknown) => e instanceof MoneyError);
});

test('splitting exposes the remainder instead of losing it', () => {
  const { quotient, remainderMinorUnits } = divideIntoParts(ghs('0.10'), 3n);
  assert.equal(quotient.minorUnits, 3n); // 0.03 each
  assert.equal(remainderMinorUnits, 1n); // and one pesewa that must be allocated
  assert.equal(quotient.minorUnits * 3n + remainderMinorUnits, ghs('0.10').minorUnits);
});

test('JSON serialisation never leaks a bigint and stays exact', () => {
  const amount = ghs('0.30');
  assert.equal(JSON.stringify({ amount }), '{"amount":"0.30"}');
  assert.equal(JSON.stringify({ amount: usdc('0.00000001') }), '{"amount":"0.00000001"}');
  assert.deepEqual(moneyToJSONValue(ghs('1234.50')), { currency: 'GHS', amount: '1234.50' });
  assert.equal(moneyToDecimalString(ghs('-0.01')), '-0.01');
  // Round trip through the boundary representation is lossless.
  const back = moneyFromDecimalString(moneyToDecimalString(ghs('999999999999999999.99')), 'GHS');
  assert.equal(back.minorUnits, ghs('999999999999999999.99').minorUnits);
});

test('property-style: integer arithmetic over a fixed pseudo-random sequence', () => {
  // A tiny deterministic LCG keeps the test reproducible in CI.
  let seed = 20261116n;
  const next = (): bigint => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 63n);
    return seed;
  };

  for (let i = 0; i < 200; i += 1) {
    const aMinor = (next() % 1000000000n) - 500000000n; // +/- 5,000,000.00 GHS
    const bMinor = (next() % 1000000000n) - 500000000n;
    const a = makeMoney('GHS', aMinor, 2);
    const b = makeMoney('GHS', bMinor, 2);

    // (a + b) - b === a
    assert.equal(subtract(add(a, b), b).minorUnits, a.minorUnits);
    // rendering then re-parsing is lossless for any amount that fits the scale
    assert.equal(parseMoney(formatMinor(a.minorUnits, 2), 'GHS').minorUnits, a.minorUnits);
    // multiplication distributes over addition
    assert.equal(
      multiplyByQuantity(add(a, b), 3).minorUnits,
      add(multiplyByQuantity(a, 3), multiplyByQuantity(b, 3)).minorUnits,
    );
    // comparison agrees with integer comparison
    assert.equal(compare(a, b), a.minorUnits < b.minorUnits ? -1 : a.minorUnits > b.minorUnits ? 1 : 0);
  }
});
