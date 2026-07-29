// instrument.js
// =============================================================================
// AZAMAN — SENTRY ERROR MONITORING (bootstrap)
//
// Sentry must be initialized BEFORE any instrumented module (http, express,
// pg, ...) is required, so its auto-instrumentation can patch them. This file
// is therefore loaded as the very first line of server.js:
//
//     require('./instrument');
//
// It is a no-op (with a one-line warning) when SENTRY_DSN is unset, so local
// dev and test runs are unaffected. Production crashes become visible in the
// Sentry dashboard. Set SENTRY_DSN in the Render environment to enable.
// =============================================================================

// dotenv is optional — on Render/PaaS, env vars are injected by the platform.
// In local dev, dotenv loads them from .env. Wrap in try/catch so a missing
// module never crashes the server.
try {
    require('dotenv').config();
} catch (_e) {
    // dotenv not installed (shouldn't happen, but be safe)
}

const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
    const tracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE
        ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
        : 0.1; // 10% of transactions for performance monitoring

    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        tracesSampleRate,
    });
    console.log('[Sentry] Initialized for environment:', process.env.NODE_ENV || 'production');
} else {
    console.warn('[Sentry] SENTRY_DSN not set — error monitoring disabled');
}

module.exports = Sentry;
