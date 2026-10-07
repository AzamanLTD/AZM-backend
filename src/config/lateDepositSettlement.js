'use strict';

// Canonical late-deposit-settlement grace configuration (issue #271).
//
// PROBLEM BEING BOUNDED: a provider webhook (or status-confirmation
// settlement) can arrive AFTER the deposit's TransactionQuote has expired.
// The user may already have paid the provider the exact quoted GHS amount.
// The pre-271 contract turned that event into an infinite 409: the deposit
// row stayed PENDING forever, retries kept failing, and ops had no durable
// record — the paid money sat stranded with only a bare 409 explaining why.
//
// POLICY (fixed-price, never repricing — issue #271 §9):
//   1. Late but WITHIN the grace window:
//        the quote's own economics remain the binding contract. The
//        settlement consumes the quote (exactly-once claim unchanged) and
//        credits the ORIGINAL quoted USDC amount. Nothing is recomputed at
//        the current oracle rate. The settlement is durably marked
//        late (metadata lateSettlement=true) for observability.
//   2. Late BEYOND the grace window:
//        still NO repricing and NO silent PENDING trap. The settlement
//        fails closed, a ReconciliationException (reason
//        LATE_DEPOSIT_SETTLEMENT_BEYOND_GRACE) is durably recorded with the
//        reference, and the surface answers with a deterministic 409
//        carrying the code LATE_DEPOSIT_SETTLEMENT_REQUIRES_RECONCILIATION
//        (instead of a bare generic 409). Ops reconcile the paid deposit at
//        the SAME original quoted terms — the grace bounds only how long
//        the platform AUTO-honors the quote, never the economics.
//
// THRESHOLD SOURCE (documented per the issue-#271 review requirement):
//   The quote TTL (600 s) bounds the intended payment window; the provider's
//   own callback/retry cadence is what can legitimately outlive it. There is
//   no earlier product contract for a late-settlement bound, so this module
//   IS the contract: a conservative default of 24 hours (covers a full
//   provider-side retry day-cycle) bounded to an operational range
//   [1 hour, 168 hours] and overridable via
//   LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS. Malformed/out-of-range values fall
//   back to the safe default. There is deliberately NO "off" value: the
//   pre-271 behavior (grace 0, bare 409 forever) is not selectable, because
//   it is exactly the stranded-paid-deposit trap this policy exists to close.
//
// Changing this value NEVER affects the economics of any settlement — the
// quote always settles at its own persisted terms; the value only moves the
// auto-settle / ops-handoff boundary.

const logger = require('./logger');

const LATE_DEPOSIT_SETTLEMENT_GRACE_ENV_VAR = 'LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS';
const DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS = 24;
const MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS = 1;
const MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS = 168;

function resolveLateDepositSettlementGraceHours(env = process.env) {
    const raw = env[LATE_DEPOSIT_SETTLEMENT_GRACE_ENV_VAR];

    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const parsed = Number(raw);
        const inRange =
            Number.isFinite(parsed) &&
            parsed >= MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS &&
            parsed <= MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS;
        if (inRange) return parsed;
        logger.warn(
            `[lateDepositSettlement] ${LATE_DEPOSIT_SETTLEMENT_GRACE_ENV_VAR}="${raw}" is malformed or outside the ` +
            `bounded operational range [${MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS}, ${MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS}] hours. ` +
            `Falling back to the safe default of ${DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS} hours.`
        );
    }

    return DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS;
}

// Resolved once per process.
const LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS = resolveLateDepositSettlementGraceHours();
const LATE_DEPOSIT_SETTLEMENT_GRACE_MS = LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS * 60 * 60 * 1000;

module.exports = {
    LATE_DEPOSIT_SETTLEMENT_GRACE_ENV_VAR,
    DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
    MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
    MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
    LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
    LATE_DEPOSIT_SETTLEMENT_GRACE_MS,
    resolveLateDepositSettlementGraceHours,
};
