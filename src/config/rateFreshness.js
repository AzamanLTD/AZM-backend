'use strict';

// Canonical rate-freshness configuration (issue #271 / PR 271C).
//
// A new fiat deposit quote is permitted ONLY when the most recent EXTERNAL
// market-rate observation (GlobalSettings.lastExternalSync) is at most
// RATE_FRESHNESS_MAX_AGE_SECONDS old. The gate is fail-closed: NULL, future,
// or invalid external timestamps are stale/untrusted, and neither a manual
// admin override (lastAdminSetAt) nor a MOCK gateway echo (lastEchoAt) can
// refresh freshness.
//
// Configuration contract:
//   variable name : RATE_FRESHNESS_MAX_AGE_SECONDS
//   default       : 1800 seconds (30 minutes)
//   minimum       : 600 seconds
//   maximum       : 1800 seconds
//
// The value is bounded for operational safety: if the environment variable is
// absent, malformed, non-finite, below the minimum, or above the maximum, the
// safe default (1800) is used and a clear warning is emitted. There is
// deliberately NO "off" value — the gate cannot be disabled via configuration.
//
// The threshold is NOT admin-editable through GlobalSettings and has no
// database column: it is an operational guardrail, not a business setting.
// Changing this value NEVER affects already-issued quotes — existing
// TransactionQuote rows keep the rate and TTL they were created with; only
// NEW quote creation is affected.
//
// This module is the ONE place the threshold is resolved. Nothing else in
// the repository should read process.env.RATE_FRESHNESS_MAX_AGE_SECONDS.

const logger = require('./logger');

const RATE_FRESHNESS_ENV_VAR = 'RATE_FRESHNESS_MAX_AGE_SECONDS';
const DEFAULT_RATE_FRESHNESS_MAX_AGE_SECONDS = 1800;
const MIN_RATE_FRESHNESS_MAX_AGE_SECONDS = 600;
const MAX_RATE_FRESHNESS_MAX_AGE_SECONDS = 1800;

// Tiny allowance for benign clock skew between the application instance and
// the database host when evaluating a lastExternalSync timestamp that is
// marginally in the future. Deliberately small (5 seconds): an external
// observation further in the future than this window is untrusted, never
// treated as "infinitely fresh".
const RATE_FRESHNESS_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

function resolveRateFreshnessMaxAgeSeconds(env = process.env) {
    const raw = env[RATE_FRESHNESS_ENV_VAR];

    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const parsed = Number(raw);
        const inRange =
            Number.isFinite(parsed) &&
            parsed >= MIN_RATE_FRESHNESS_MAX_AGE_SECONDS &&
            parsed <= MAX_RATE_FRESHNESS_MAX_AGE_SECONDS;
        if (inRange) return parsed;
        logger.warn(
            `[rateFreshness] ${RATE_FRESHNESS_ENV_VAR}="${raw}" is malformed, non-finite, or outside the ` +
            `bounded operational range [${MIN_RATE_FRESHNESS_MAX_AGE_SECONDS}, ${MAX_RATE_FRESHNESS_MAX_AGE_SECONDS}] seconds. ` +
            `Falling back to the safe default of ${DEFAULT_RATE_FRESHNESS_MAX_AGE_SECONDS} seconds. ` +
            'The stale-rate gate cannot be disabled.'
        );
    }

    return DEFAULT_RATE_FRESHNESS_MAX_AGE_SECONDS;
}

// Resolved once per process. Tests that need a controlled threshold inject
// `maxAgeSeconds` directly into the gate helper instead of mutating this.
const RATE_FRESHNESS_MAX_AGE_SECONDS = resolveRateFreshnessMaxAgeSeconds();

module.exports = {
    RATE_FRESHNESS_ENV_VAR,
    DEFAULT_RATE_FRESHNESS_MAX_AGE_SECONDS,
    MIN_RATE_FRESHNESS_MAX_AGE_SECONDS,
    MAX_RATE_FRESHNESS_MAX_AGE_SECONDS,
    RATE_FRESHNESS_CLOCK_SKEW_ALLOWANCE_MS,
    RATE_FRESHNESS_MAX_AGE_SECONDS,
    resolveRateFreshnessMaxAgeSeconds,
};
