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

function validate(schema) {
  return function zodValidate(req, res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ success: false, errors: _collectIssues(result) });
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

module.exports = { validate, validateParams };
