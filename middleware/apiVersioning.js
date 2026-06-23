// middleware/apiVersioning.js
// =============================================================================
// Lightweight API versioning.
//
// AZM currently exposes a single, stable surface under `/api/*`. The Flutter
// client is live against those exact paths, so we do NOT fork controllers or
// duplicate routers. Instead we:
//
//   1. Alias every existing router under `/api/v1/*` IN ADDITION to `/api/*`
//      (see `mountVersioned` in server.js). Both resolve to the same handlers,
//      so new clients can pin `/api/v1` and old clients keep working verbatim.
//
//   2. Expose the negotiated version on `req.apiVersion` (number) and
//      `res.locals.apiVersion` (string, e.g. "v1") so the response-envelope
//      meta and per-controller logic can branch later without re-parsing paths.
//
// Version resolution order:
//   • Path segment `/api/v{N}/...`              → N
//   • `Accept-Version` / `X-API-Version` header → N (e.g. "2" or "v2")
//   • Default                                   → DEFAULT_VERSION
//
// This is additive and side-effect free: it only reads the request and sets
// two fields. It never rewrites the URL or a response body.
// =============================================================================

const DEFAULT_VERSION = 1;
// Bump as new versions ship so unknown-but-numeric versions can be rejected by
// callers that care. We intentionally do NOT 404 here — unknown versions still
// fall through to the default handlers, preserving backward compatibility.
const SUPPORTED_VERSIONS = [1];

function parseVersion(value) {
  if (value == null) return null;
  const m = String(value).trim().match(/^v?(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = function apiVersioning(req, res, next) {
  // Path wins: /api/v2/foo → 2. We read req.originalUrl (never mount-stripped)
  // and look for the `v{N}` segment immediately after `/api`, so this works
  // regardless of whether the middleware is mounted at app level or under
  // app.use('/api', …) (which would strip the prefix from req.path/req.url).
  const pathOnly = req.originalUrl.split('?')[0];
  const pathMatch = pathOnly.match(/^\/api\/v(\d+)(?=\/|$)/);
  let version = pathMatch ? parseVersion(pathMatch[1]) : null;

  // Fall back to an explicit header negotiation.
  if (version == null) {
    version = parseVersion(req.headers['accept-version'])
           ?? parseVersion(req.headers['x-api-version']);
  }

  if (version == null) version = DEFAULT_VERSION;

  req.apiVersion = version;
  res.locals.apiVersion = `v${version}`;
  res.setHeader('X-API-Version', `v${version}`);
  next();
};

module.exports.DEFAULT_VERSION = DEFAULT_VERSION;
module.exports.SUPPORTED_VERSIONS = SUPPORTED_VERSIONS;
