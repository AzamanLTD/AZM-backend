// middleware/requestId.js
// =============================================================================
// Request tracing — assigns a stable id to every request for correlation across
// logs, error reports (Sentry) and (optionally) client bug reports.
//
// Behaviour:
//   • If the caller sends an `X-Request-Id` header, reuse it when it passes the
//     bounded allow-list. Otherwise mint a fresh uuid.
//   • The id is exposed as req.id, res.locals.requestId and the response header.
//   • AsyncLocalStorage keeps the id available to downstream service code so
//     structured logs and financial domain events can correlate without
//     threading Express req objects through domain APIs.
//
// This is mounted before morgan in src/middleware/appMiddleware.js.
// =============================================================================
'use strict';

const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;
const storage = new AsyncLocalStorage();

const getRequestId = () => storage.getStore()?.requestId || null;

const withRequestId = (payload) => {
  const requestId = getRequestId();
  if (!requestId || payload === null || typeof payload !== 'object') return payload;
  return { ...payload, requestId };
};

module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming)
    ? incoming
    : randomUUID();

  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  storage.run({ requestId: id }, next);
};

module.exports.getRequestId = getRequestId;
module.exports.withRequestId = withRequestId;
