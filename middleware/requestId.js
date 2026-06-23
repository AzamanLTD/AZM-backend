// middleware/requestId.js
// =============================================================================
// Request tracing — assigns a stable id to every request for correlation across
// logs, error reports (Sentry) and (optionally) client bug reports.
//
// Behaviour:
//   • If the caller sends an `X-Request-Id` header, we trust and reuse it so a
//     single id can span the Flutter client → backend → worker hop. We bound
//     its length/charset to avoid log-injection or header-bloat from hostile
//     input; anything unacceptable is replaced with a fresh uuid.
//   • Otherwise we mint a uuid v4.
//
// The id is exposed three ways:
//   • req.id          — for downstream middleware/controllers and morgan.
//   • res.locals.requestId — for the response-envelope helpers (meta.requestId).
//   • `X-Request-Id` response header — so clients/proxies can log it too.
//
// This is purely additive: it sets fields and one header, and never alters a
// response body. Mounted as early as possible (before morgan) so the access log
// line carries the id.
// =============================================================================
const { randomUUID } = require('crypto');

// Conservative: printable ascii, dashes/underscores, 8–128 chars. A typical
// uuid (36 chars) or a client trace id passes; junk does not.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming)
    ? incoming
    : randomUUID();

  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
