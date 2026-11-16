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
export { makeMoney, assertSameCurrency, type Money } from './money';
export { formatMinor } from './format';
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
export { applyRounding, roundMinorUnits, type RoundingMode } from './rounding';
export {
  formatValuation,
  makeQuote,
  parseRate,
  valueWithQuote,
  type FxQuote,
  type MoneyValuation,
  type QuoteProvenance,
} from './fx';
export {
  moneyFromDecimalString,
  moneyToDecimalString,
  moneyToJSONValue,
  type SerialisedMoney,
} from './serialise';
