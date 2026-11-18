/**
 * WP-MONEY — typed failures.
 *
 * A money function never returns a silently wrong number: every refusal is a
 * typed error with a stable code, so a caller can branch on the code instead of
 * matching prose, and a test can pin the exact refusal.
 */
export type MoneyErrorCode =
  | 'NOT_A_DECIMAL_STRING'
  | 'EMPTY_INPUT'
  | 'SIGN_PLACED_WRONG'
  | 'EXPONENT_NOT_ALLOWED'
  | 'SEPARATOR_NOT_ALLOWED'
  | 'MALFORMED_DECIMAL'
  | 'EXCESS_PRECISION'
  | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'QUANTITY_NOT_INTEGER'
  | 'QUANTITY_UNSAFE'
  | 'INVALID_RATE'
  | 'INVALID_PROVENANCE'
  | 'INVALID_ROUNDING_MODE'
  | 'DIVISOR_INVALID';

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}
