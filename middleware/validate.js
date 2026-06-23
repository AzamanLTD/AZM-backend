// middleware/validate.js
// =============================================================================
// Generic Zod validation middleware factory.
//
// Usage:
//   const { validate } = require('../middleware/validate');
//   router.post('/endpoint', protect, validate(mySchema), ctrl.myMethod);
//
// On failure: 400 { success: false, errors: { fieldName: ["message"] } }
// On success: Zod's coerced values are MERGED over req.body, then next().
//
// IMPORTANT — why merge, not replace:
//   The naive `req.body = result.data` REPLACES the body with only the keys the
//   schema declares, silently dropping every other field. Several AZM
//   controllers read fields beyond the validated set (e.g. withdrawal's
//   `feeDiscountTierId`, peer-transfer's `clientRequestId`). Replacing would
//   break them. Merging applies Zod's coercions/normalisations to the known
//   fields while leaving everything else untouched.
// =============================================================================

function _collectIssues(result) {
  const errors = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_root';
    if (!errors[field]) errors[field] = [];
    errors[field].push(issue.message);
  }
  return errors;
}

// =============================================================================
// Error-shape formatters.
//
// The DEFAULT 400 body is { success:false, errors:{ field:[msg] } } — the shape
// the original 9 financial callers rely on. But the auth/security surface
// already speaks DIFFERENT error envelopes that the live Flutter client parses:
//
//   • auth (register/login):  { success:false, message:"Validation failed",
//                               errors:[ "msg", ... ] }   (flat string array)
//   • security (pwd/2FA/PIN/OTP): { success:false, message:"<first message>" }
//
// Hardening these endpoints additively means the middleware must reproduce
// their EXACT envelope, so a rejection from validate() is byte-identical to the
// controller's own (retained) fallback rejection. We therefore let a route
// opt into a formatter; omitting it keeps the legacy field-map shape untouched.
//
// A formatter maps the Zod result → { status?, body }. Order of issues is
// preserved by Zod, so `issues[0]` is the first failing check — matching the
// controllers, which `return` on the first failed branch.
// =============================================================================
const formatters = {
  // Legacy default — unchanged behaviour for the original callers.
  fieldMap(result) {
    return { status: 400, body: { success: false, errors: _collectIssues(result) } };
  },

  // authController.register / login: "Validation failed" + flat errors[] of
  // messages, de-duplicated in first-seen order (the controllers push at most
  // one message per field, so dedup keeps parity even if a schema adds two).
  authList(result) {
    const seen = new Set();
    const errors = [];
    for (const issue of result.error.issues) {
      if (seen.has(issue.message)) continue;
      seen.add(issue.message);
      errors.push(issue.message);
    }
    return { status: 400, body: { success: false, message: 'Validation failed', errors } };
  },

  // securityController.*: a single { message } echoing the first failed check,
  // exactly as each endpoint's inline `return res.status(400)` does today.
  singleMessage(result) {
    const first = result.error.issues[0];
    return { status: 400, body: { success: false, message: first ? first.message : 'Validation failed' } };
  },
};

// validate(schema)                 → default field-map error shape (legacy).
// validate(schema, 'authList')     → named built-in formatter.
// validate(schema, fn)             → custom (result) => { status?, body } formatter.
function _resolveFormatter(formatter) {
  if (typeof formatter === 'function') return formatter;
  if (typeof formatter === 'string' && formatters[formatter]) return formatters[formatter];
  return formatters.fieldMap;
}

function validate(schema, formatter) {
  const format = _resolveFormatter(formatter);
  return function zodValidate(req, res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const { status = 400, body } = format(result);
      return res.status(status).json(body);
    }
    req.body = { ...req.body, ...result.data }; // merge coerced values; keep extras
    return next();
  };
}

function validateParams(schema) {
  return function zodValidateParams(req, res, next) {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({ success: false, errors: _collectIssues(result) });
    }
    req.params = { ...req.params, ...result.data };
    return next();
  };
}

module.exports = { validate, validateParams, formatters };
