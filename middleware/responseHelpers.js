// middleware/responseHelpers.js
// =============================================================================
// Additive response envelope — OPT-IN, non-breaking.
//
// The live Flutter client reads response data from heterogeneous top-level keys
// (`response.user`, `response.trade`, `response.withdrawal`, …). A global
// res.json rewrite — as the design doc proposed — would relocate all of that
// under `data` and break every existing screen. We refuse to do that.
//
// Instead this middleware ADDS two helpers that NEW endpoints can opt into,
// while every existing `res.json(...)` call is left completely untouched:
//
//   res.ok(data, { status, pagination, meta })
//     → { success: true,  data, errors: null, meta: { … } }
//
//   res.fail(errors, { status, meta })
//     → { success: false, data: null, errors: [{ field?, message }], meta: { … } }
//
// `meta` always carries: timestamp, requestId (from middleware/requestId), and
// version (from middleware/apiVersioning). Pagination, when supplied, is nested
// under meta.pagination in the shape the doc standardised
// ({ page, limit, total, hasMore }).
//
// Order requirement: mount AFTER requestId and apiVersioning so res.locals is
// populated. Safe if they're absent (falls back to nulls / "v1").
// =============================================================================

function buildMeta(res, extra = {}) {
  const meta = {
    timestamp: new Date().toISOString(),
    version: res.locals.apiVersion || 'v1',
    requestId: res.locals.requestId || null,
  };
  if (extra.pagination) {
    const p = extra.pagination;
    const page = Number(p.page) || 1;
    const limit = Number(p.limit) || 0;
    const total = Number(p.total) || 0;
    meta.pagination = {
      page,
      limit,
      total,
      hasMore: typeof p.hasMore === 'boolean'
        ? p.hasMore
        : limit > 0 && page * limit < total,
    };
  }
  if (extra.meta && typeof extra.meta === 'object') Object.assign(meta, extra.meta);
  return meta;
}

// Normalise an error argument into the doc's array-of-objects shape.
//   "msg"                       → [{ message: "msg" }]
//   { field, message }          → [{ field, message }]
//   [ … ]                       → passed through, each coerced to {message}
//   Zod fieldErrors object      → [{ field, message }, …]
function normaliseErrors(errors) {
  if (errors == null) return [{ message: 'Unknown error' }];
  if (typeof errors === 'string') return [{ message: errors }];
  if (Array.isArray(errors)) {
    return errors.map((e) =>
      typeof e === 'string' ? { message: e } : e
    );
  }
  if (typeof errors === 'object') {
    // { field: ["m1","m2"], … }  (our validate.js _collectIssues shape)
    if (!('message' in errors)) {
      const out = [];
      for (const [field, msgs] of Object.entries(errors)) {
        for (const message of [].concat(msgs)) out.push({ field, message });
      }
      if (out.length) return out;
    }
    return [errors];
  }
  return [{ message: String(errors) }];
}

module.exports = function responseHelpers(req, res, next) {
  res.ok = function ok(data = null, opts = {}) {
    const status = opts.status || res.statusCode || 200;
    return res.status(status).json({
      success: true,
      data: data ?? null,
      errors: null,
      meta: buildMeta(res, opts),
    });
  };

  res.fail = function fail(errors, opts = {}) {
    const status = opts.status || (res.statusCode >= 400 ? res.statusCode : 400);
    return res.status(status).json({
      success: false,
      data: null,
      errors: normaliseErrors(errors),
      meta: buildMeta(res, opts),
    });
  };

  next();
};

// Exported for unit testing the pure transforms.
module.exports._buildMeta = buildMeta;
module.exports._normaliseErrors = normaliseErrors;
