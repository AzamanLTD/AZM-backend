// services/groups/errors.js
// =============================================================================
// Typed errors for the Phase 6 group membership & vouching surface. The
// `code` + `httpStatus` line up 1:1 with the catalogue in design.md >
// Error Handling, so controllers can emit the canonical envelope
// { success:false, message, errorCode } with the right status.
// =============================================================================

class GroupError extends Error {
  constructor(code, message, httpStatus = 400, fields = undefined) {
    super(message);
    this.name = 'GroupError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (fields) this.fields = fields;
  }
}

const GroupErrorCodes = Object.freeze({
  JOIN_REQUEST_DUPLICATE: 'JOIN_REQUEST_DUPLICATE',         // 409
  JOIN_REQUEST_TARGET_INVALID: 'JOIN_REQUEST_TARGET_INVALID', // 400
  JOIN_REQUEST_NOT_FOUND: 'JOIN_REQUEST_NOT_FOUND',         // 404
  JOIN_REQUEST_FORBIDDEN: 'JOIN_REQUEST_FORBIDDEN',         // 403
  ADD_QUOTA_EXCEEDED: 'ADD_QUOTA_EXCEEDED',                 // 409
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',                       // 404
  NOT_A_MEMBER: 'NOT_A_MEMBER',                             // 403
});

module.exports = { GroupError, GroupErrorCodes };
