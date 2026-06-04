// services/susu/errors.js
// =============================================================================
// Typed error classes for the private Susu ecosystem. Controllers use the
// `code` + `httpStatus` to emit the canonical envelope shape. The error
// codes line up 1:1 with the catalogue in design.md > Error Handling.
// =============================================================================

class SusuError extends Error {
  constructor(code, message, httpStatus = 400, fields = undefined) {
    super(message);
    this.name = 'SusuError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (fields) this.fields = fields;
  }
}

const ErrorCodes = Object.freeze({
  KYC_REQUIRED: 'KYC_REQUIRED',
  RESIDENCY_REQUIRED: 'RESIDENCY_REQUIRED',
  RESIDENCY_INVALID_FILE: 'RESIDENCY_INVALID_FILE',
  RESIDENCY_UPLOAD_FAILED: 'RESIDENCY_UPLOAD_FAILED',
  RESIDENCY_REASON_INVALID: 'RESIDENCY_REASON_INVALID',
  RESIDENCY_ALREADY_SUBMITTED: 'RESIDENCY_ALREADY_SUBMITTED',
  CONTRACT_NOT_AGREED: 'CONTRACT_NOT_AGREED',
  CONTRACT_VERSION_MISMATCH: 'CONTRACT_VERSION_MISMATCH',
  CONTRACT_VERSION_DUPLICATE: 'CONTRACT_VERSION_DUPLICATE',
  KYC_OR_RESIDENCY_PENDING: 'KYC_OR_RESIDENCY_PENDING',
  SUSU_NOT_READY: 'SUSU_NOT_READY',
  SUSU_CANCEL_FORBIDDEN: 'SUSU_CANCEL_FORBIDDEN',
  SUSU_ALREADY_ACTIVE: 'SUSU_ALREADY_ACTIVE',
  SUSU_FROZEN: 'SUSU_FROZEN',
  SUSU_NOT_FOUND: 'SUSU_NOT_FOUND',
  SUSU_VALIDATION_FAILED: 'SUSU_VALIDATION_FAILED',
  INVITE_EXPIRED_OR_USED: 'INVITE_EXPIRED_OR_USED',
  INVITE_INVALID: 'INVITE_INVALID',
});

// Privacy 404: a uniform envelope returned for both non-existent and
// non-visible Susus (Property 14 / Req 5.6). Service layer raises this
// from any read path that fails the visibility gate, AND from any read
// path that genuinely 404s — controllers map both to the same body.
const susuNotFound = () =>
  new SusuError(ErrorCodes.SUSU_NOT_FOUND, 'Not found', 404);

module.exports = { SusuError, ErrorCodes, susuNotFound };
