// src/middleware/appMiddleware.js
// =============================================================================
// Extracted from server.js — all Express middleware configuration in one
// testable function. This includes: request tracing, HTTP access logging,
// security headers (helmet-equivalent), CORS, HTTPS redirect (production),
// body parser with raw body capture, static file serving.
//
// Exposed: configureMiddleware(app, { IS_PRODUCTION })
//
// The function is intentionally side-effectful (mutates the app by calling
// app.use) — this matches the original inline pattern and keeps the call
// site in server.js clean.
// ============================================================================

const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const logger = require('../config/logger');

/**
 * Configures all Express middleware on the given app instance.
 *
 * @param {import('express').Express} app
 * @param {{ IS_PRODUCTION: boolean }} opts
 * @returns {{ corsOrigins: string[] }} — the resolved CORS origins (needed by
 *   the Socket.IO server which reuses the same origin list).
 */
function configureMiddleware(app, { IS_PRODUCTION }) {
  // ── Request Tracing ──────────────────────────────────────────────────────
  // Assigns req.id / res.locals.requestId and the X-Request-Id response
  // header. Must precede morgan so the access log carries the id.
  app.use(require('../../middleware/requestId'));

  // ── HTTP Access Logging (morgan) ─────────────────────────────────────────
  // "combined" format + request id. Skipped under NODE_ENV=test to keep test
  // output clean.
  morgan.token('req-id', (req) => req.id || '-');
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(':remote-addr :method :url :status :response-time ms - :req-id'));
  }

  // ── HIGH-1: Security Headers ─────────────────────────────────────────────
  // Helmet-equivalent manual headers (no extra dependency).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.removeHeader('X-Powered-By');
    next();
  });

  // ── HIGH-2: CORS locked to configured origins ────────────────────────────
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['*']; // Dev fallback — override in production!

  // In production, explicitly reject any browser origin not on the allow-list.
  // In development (or when CORS_ORIGINS is the '*' wildcard), CORS stays open.
  // Requests without an Origin header (curl, mobile apps, server-to-server) are
  // always permitted since the browser same-origin policy does not apply to
  // them.
  const corsOriginValidator = (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!IS_PRODUCTION || corsOrigins.includes('*')) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} is not allowed`));
  };

  app.use(cors({
    origin: corsOriginValidator,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  }));

  // Surface the CORS posture at boot so misconfigured deploys are obvious.
  if (IS_PRODUCTION) {
    logger.info({ origins: corsOrigins }, 'CORS locked');
  } else {
    logger.info('CORS open (development mode)');
  }

  // ── C-10: Force HTTPS in production (Render provides HTTPS proxy) ─────────
  if (IS_PRODUCTION) {
    app.use((req, res, next) => {
      if (req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
      }
      next();
    });
  }

  // ── Body Parser with size limit (M-1 fix) + raw body for HMAC ────────────
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  // ── Request Logging (non-production or LOG_REQUESTS=true) ────────────────
  if (!IS_PRODUCTION || process.env.LOG_REQUESTS === 'true') {
    app.use((req, res, next) => {
      logger.debug({ method: req.method, url: req.url }, 'Request');
      next();
    });
  }

  // ── Static Files ─────────────────────────────────────────────────────────
  app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));

  return { corsOrigins };
}

// Re-export express.json for server.js convenience (it needs express for other
// things too, but having json here avoids a separate import in some callers).
const express = require('express');
module.exports = { configureMiddleware };
