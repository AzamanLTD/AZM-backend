// src/config/providerModeGuard.js
// =============================================================================
// MOCK PROVIDERS NEVER ANSWER IN PRODUCTION.
//
// Several provider adapters (Moolre collection and disbursement, Tatum, KYC)
// fall back to an in-process MOCK whenever their LIVE configuration is
// incomplete. That is useful in development and tests, and dangerous in
// production, because a MOCK answers success:
//   - a mock collection status reports every initiated deposit as settled, so
//     the reconciliation worker credits money that never arrived;
//   - a mock disbursement reports a MoMo payout as sent when nothing left;
//   - a mock KYC webhook accepts a fixed signature and verifies anyone;
//   - a mock Tatum address is a deterministic fake that nobody controls.
//
// With NODE_ENV=production every MOCK branch refuses instead. Callers receive
// their adapter's own typed outcome (NOT_DISPATCHED where a real request would
// have been sent, UNKNOWN_OUTCOME where a status was asked for) so existing
// recovery logic treats the refusal correctly: nothing is credited, nothing is
// reported as paid, and pending rows stay pending for an operator.
//
// There is deliberately no override flag. A staging environment that needs a
// provider uses the provider's own sandbox in LIVE mode.
// =============================================================================
'use strict';

const logger = require('./logger');

const MOCK_REFUSED_CODE = 'MOCK_PROVIDER_REFUSED_IN_PRODUCTION';

function isProductionRuntime() {
    return process.env.NODE_ENV === 'production';
}

/** True when a MOCK provider branch must refuse rather than answer. */
function mockRefused() {
    return isProductionRuntime();
}

/** One loud, secret-free line at construction so the misconfiguration is visible. */
function warnIfMockInProduction(providerName, providerMode) {
    if (providerMode === 'MOCK' && isProductionRuntime()) {
        logger.error(
            `[${providerName}] MOCK mode in production: every provider call will be refused ` +
            `(${MOCK_REFUSED_CODE}). Configure the LIVE provider to enable it.`
        );
    }
}

/** A plain refusal error for adapters without their own typed outcome errors. */
function mockRefusedError(providerName, operation) {
    const err = new Error(
        `[${providerName}] ${operation} refused: the provider is in MOCK mode in production. Nothing was sent.`
    );
    err.code = MOCK_REFUSED_CODE;
    err.statusCode = 503;
    return err;
}

module.exports = {
    MOCK_REFUSED_CODE,
    isProductionRuntime,
    mockRefused,
    warnIfMockInProduction,
    mockRefusedError,
};
