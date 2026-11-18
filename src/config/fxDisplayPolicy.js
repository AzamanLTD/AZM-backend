'use strict';

// Saved-rate DISPLAY-fallback policy (FX-balance workstream).
//
// Separation of concerns — two DIFFERENT rate policies with DIFFERENT
// authorities:
//
//   1. TRANSACTION authority: src/services/transactionQuoteService.js
//      getFreshServerRateGhsPerUsdc (271C gate). Freshness max age is
//      bounded to [600, 1800] seconds. A saved/demo rate can NEVER satisfy
//      it. Nothing in this module may ever be read as transaction
//      authorization.
//
//   2. DISPLAY authority (this module): how old the LAST SUCCESSFULLY
//      VALIDATED external observation (FxSavedRate) may be while it is still
//      presented to the user as an honest, clearly-labelled indicative
//      fallback ("Using saved rate"). Indefinite staleness is forbidden: a
//      three-week-old rate is not an indicative display, it is a fabrication.
//
// Configuration contract:
//   variable name : FX_SAVED_RATE_MAX_AGE_MS
//   default       : 7 days (604_800_000 ms)
//   minimum       : 1 hour
//   maximum       : 30 days
//
// The window is wider than the 271C transaction window by design: a saved
// observation remains a reasonable *indicative* display long after it is no
// longer safe to *execute* against, but not forever. Environment values
// outside the bounded range fall back to the default with a warning — the
// policy cannot be switched off via configuration.
//
// Eligibility is evaluated SERVER-SIDE from the persisted `observedAt`
// (external observation time, UTC). It is recomputed on every read: a client
// cannot extend eligibility by repeated requests or client clock games,
// because the client never supplies either endpoint of the comparison.

const logger = require('./logger');

const FX_SAVED_RATE_MAX_AGE_ENV_VAR = 'FX_SAVED_RATE_MAX_AGE_MS';
const DEFAULT_FX_SAVED_RATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_FX_SAVED_RATE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const MAX_FX_SAVED_RATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function resolveFxSavedRateMaxAgeMs(env = process.env) {
    const raw = env[FX_SAVED_RATE_MAX_AGE_ENV_VAR];

    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const parsed = Number(raw);
        const inRange =
            Number.isFinite(parsed) &&
            parsed >= MIN_FX_SAVED_RATE_MAX_AGE_MS &&
            parsed <= MAX_FX_SAVED_RATE_MAX_AGE_MS;
        if (inRange) return parsed;
        logger.warn(
            `[fxDisplayPolicy] ${FX_SAVED_RATE_MAX_AGE_ENV_VAR}="${raw}" is malformed or outside the ` +
            `bounded range [${MIN_FX_SAVED_RATE_MAX_AGE_MS}, ${MAX_FX_SAVED_RATE_MAX_AGE_MS}] ms. ` +
            `Falling back to the safe default of ${DEFAULT_FX_SAVED_RATE_MAX_AGE_MS} ms. ` +
            'The saved-rate display fallback cannot be disabled here.'
        );
    }

    return DEFAULT_FX_SAVED_RATE_MAX_AGE_MS;
}

// Resolved once per process. Tests inject `now` / `maxAgeMs` directly into
// the eligibility helper instead of mutating this.
const FX_SAVED_RATE_MAX_AGE_MS = resolveFxSavedRateMaxAgeMs();

const FX_SAVED_RATE_PAIR = 'USDC/GHS'; // GHS per 1 USDC

module.exports = {
    FX_SAVED_RATE_MAX_AGE_ENV_VAR,
    DEFAULT_FX_SAVED_RATE_MAX_AGE_MS,
    MIN_FX_SAVED_RATE_MAX_AGE_MS,
    MAX_FX_SAVED_RATE_MAX_AGE_MS,
    FX_SAVED_RATE_MAX_AGE_MS,
    FX_SAVED_RATE_PAIR,
    resolveFxSavedRateMaxAgeMs,
};
