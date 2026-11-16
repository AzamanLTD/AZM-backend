/**
 * WP-MONEY — strict money core (foundation slice).
 *
 * Integer minor units in bigint, currency-branded types, exact parsing and
 * rendering, explicit rounding, and conversion only through a quoted valuation.
 * Nothing here touches the database, the ledger or the existing services: this
 * module is the type-safe footing those migrations will adopt next.
 */
export { MoneyError, type MoneyErrorCode } from './errors';
export {
  CURRENCIES,
  GHS,
  USDC,
  currencySpec,
  isCurrencyCode,
  type CurrencyCode,
  type CurrencySpec,
} from './currency';
// Public surface rule: only constructors whose contract is safe for application
// callers are exported. `moneyFromMinorUnits` takes no precision argument (the
// currency registry owns it) and `formatMoney` renders at that same precision, so
// neither can be used to invent a 3-decimal cedi. The raw `formatMinor(minor,
// decimals)` primitive stays internal for the same reason.
export { moneyFromMinorUnits, formatMoney, assertSameCurrency, type Money } from './money';
export { parseMoney, parseOptionalMoney } from './parse';
export {
  abs,
  add,
  compare,
  divideIntoParts,
  equals,
  isNegative,
  isZero,
  max,
  min,
  multiplyByQuantity,
  negate,
  subtract,
  sum,
  type Ordering,
  type Quantity,
} from './arithmetic';
export {
  ROUNDING_MODES,
  applyRounding,
  assertRoundingMode,
  isRoundingMode,
  roundMinorUnits,
  type RoundingMode,
} from './rounding';
export {
  formatValuation,
  valuationToJSONValue,
  isIso8601Timestamp,
  makeQuote,
  parseRate,
  valueWithQuote,
  type FxQuote,
  type MoneyValuation,
  type QuoteProvenance,
  type SerialisedValuation,
} from './fx';
export {
  moneyFromDecimalString,
  moneyToDecimalString,
  moneyToJSONValue,
  type SerialisedMoney,
} from './serialise';
