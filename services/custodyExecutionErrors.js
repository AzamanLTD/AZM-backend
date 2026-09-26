// services/custodyExecutionErrors.js
// =============================================================================
// AZAMAN — CUSTODY EXECUTION ERROR CLASSIFICATION (financial architecture §P.2,
// 2026-09-17).
//
// One canonical vocabulary for every external custody execution outcome. The
// classification decides whether an outcome is definitive (safe to refund /
// fail) or ambiguous (must NOT trigger an automatic refund or retry — that is
// the same principle used elsewhere in the financial architecture for provider
// unknown outcomes).
//
//   CONFIGURATION_ERROR        signer/gate/identity configuration missing or
//                              inconsistent (fail-closed; never a provider call)
//   KMS_UNAVAILABLE            KMS signing identity not configured/registered
//   SIGNER_MISMATCH            configured signer does not control the address
//   INVALID_ASSET              non-canonical asset/contract (USDC.e etc.)
//   INVALID_DESTINATION        malformed/forbidden recipient
//   INSUFFICIENT_ONCHAIN_FUNDS on-chain balance too small for the transfer
//   PROVIDER_REJECTED          DEFINITIVE synchronous rejection pre-broadcast
//   SIGNING_PENDING            accepted by KMS, not yet signed/broadcast
//   BROADCAST_PENDING          accepted, no tx hash yet
//   CONFIRMATION_PENDING       tx hash known, chain evidence not yet conclusive
//   CHAIN_REVERTED             chain receipt shows failure
//   CHAIN_MISMATCH             chain evidence does not match the intended
//                              transfer semantics (wrong contract/sender/etc.)
//   UNKNOWN_OUTCOME            timeout/network/5xx — a timeout is NOT
//                              equivalent to "broadcast failed"
//   RECONCILIATION_REQUIRED    ambiguous; a human/reconciliation pass must
//                              prove what happened before any refund or retry
// =============================================================================

const ERROR_CLASSES = Object.freeze({
    CONFIGURATION_ERROR:        'CONFIGURATION_ERROR',
    KMS_UNAVAILABLE:            'KMS_UNAVAILABLE',
    SIGNER_MISMATCH:           'SIGNER_MISMATCH',
    INVALID_ASSET:              'INVALID_ASSET',
    INVALID_DESTINATION:        'INVALID_DESTINATION',
    INSUFFICIENT_ONCHAIN_FUNDS: 'INSUFFICIENT_ONCHAIN_FUNDS',
    PROVIDER_REJECTED:          'PROVIDER_REJECTED',
    SIGNING_PENDING:            'SIGNING_PENDING',
    BROADCAST_PENDING:          'BROADCAST_PENDING',
    CONFIRMATION_PENDING:       'CONFIRMATION_PENDING',
    CHAIN_REVERTED:             'CHAIN_REVERTED',
    CHAIN_MISMATCH:             'CHAIN_MISMATCH',
    UNKNOWN_OUTCOME:            'UNKNOWN_OUTCOME',
    RECONCILIATION_REQUIRED:    'RECONCILIATION_REQUIRED',
});

// Outcome is definitive (no transfer happened) — safe to fail + refund.
const DEFINITIVE_PRE_BROADCAST = new Set([
    ERROR_CLASSES.CONFIGURATION_ERROR,
    ERROR_CLASSES.KMS_UNAVAILABLE,
    ERROR_CLASSES.SIGNER_MISMATCH,
    ERROR_CLASSES.INVALID_ASSET,
    ERROR_CLASSES.INVALID_DESTINATION,
    ERROR_CLASSES.INSUFFICIENT_ONCHAIN_FUNDS,
    ERROR_CLASSES.PROVIDER_REJECTED,
]);

// Outcome is pending (expected async continuation, not a failure).
const PENDING_CLASSES = new Set([
    ERROR_CLASSES.SIGNING_PENDING,
    ERROR_CLASSES.BROADCAST_PENDING,
    ERROR_CLASSES.CONFIRMATION_PENDING,
]);

class CustodyExecutionError extends Error {
    constructor(errorClass, message, { retryable = false, cause = null } = {}) {
        super(message);
        this.name = 'CustodyExecutionError';
        this.errorClass = errorClass;
        this.retryable = retryable;
        if (cause) this.cause = cause;
    }
    get definitivePreBroadcast() {
        return DEFINITIVE_PRE_BROADCAST.has(this.errorClass);
    }
    get pending() {
        return PENDING_CLASSES.has(this.errorClass);
    }
}

// Secrets that must NEVER appear in a persisted/logged provider error message.
const SECRET_KEY_RE = /(x-api-key|apikey|api[_-]?key|signature|private[_-]?key|secret|authorization|password|token)["'\s:=]+[^,\s}"']+/gi;
const redact = (text) => String(text || '')
    .replace(SECRET_KEY_RE, '$1=[REDACTED]')
    .slice(0, 480);

/**
 * Map a low-level provider (axios-style) error into the classification.
 *
 * Rules:
 *  • 4xx with a validation/response payload  -> PROVIDER_REJECTED (definitive)
 *  • timeout / network error / connection reset / 5xx -> UNKNOWN_OUTCOME
 *    (an HTTP timeout is NOT equivalent to "broadcast failed" — the request
 *    may have reached the chain after the socket died)
 */
function classifyProviderError(err, context = 'provider call') {
    if (err instanceof CustodyExecutionError) return err;
    const detail = redact(err?.response?.data ? JSON.stringify(err.response.data) : err?.message || String(err));

    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET'
        || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
        return new CustodyExecutionError(
            ERROR_CLASSES.UNKNOWN_OUTCOME,
            `Unknown outcome during ${context}: network/timeout (${err.code}). NOT treated as failure — reconciliation required.`,
            { cause: err }
        );
    }
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
        // Auth failure is definitive — the provider rejected the call itself.
        return new CustodyExecutionError(
            ERROR_CLASSES.CONFIGURATION_ERROR,
            `Provider rejected ${context}: credentials refused (${status}).`,
            { cause: err }
        );
    }
    if (status === 400 || status === 404 || status === 422) {
        return new CustodyExecutionError(
            ERROR_CLASSES.PROVIDER_REJECTED,
            `Provider rejected ${context}: ${detail}`,
            { cause: err }
        );
    }
    if (status !== undefined && status >= 400) {
        return new CustodyExecutionError(
            ERROR_CLASSES.UNKNOWN_OUTCOME,
            `Unknown outcome during ${context}: provider HTTP ${status}. NOT treated as failure — reconciliation required.`,
            { cause: err }
        );
    }
    return new CustodyExecutionError(
        ERROR_CLASSES.UNKNOWN_OUTCOME,
        `Unknown outcome during ${context}: ${detail}`,
        { cause: err }
    );
}

module.exports = {
    ERROR_CLASSES,
    DEFINITIVE_PRE_BROADCAST,
    PENDING_CLASSES,
    CustodyExecutionError,
    classifyProviderError,
    redact,
};
