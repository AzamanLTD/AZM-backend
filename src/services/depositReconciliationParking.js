'use strict';

// =============================================================================
// §WP-I §6 — DURABLE PARKING AND BACKOFF FOR STUCK MOOLRE DEPOSITS
//
// THE DEFECT THIS CLOSES
// workers/depositReconciliationWorker.js scanned every stale PENDING deposit on
// a 60-second tick and retried it forever. A deposit whose evidence is
// contradictory, or which is blocked by an observation claim owned by another
// economic path, was re-queried every minute for as long as it stayed PENDING,
// and nothing recorded that a human needed to look at it.
//
// WHY RECONCILIATIONEXCEPTION AND NOT A NEW TABLE
// The durable record already exists, is created by the release chain before this
// code runs, and already carries an OPEN/RESOLVED lifecycle with a partial unique
// index on (entityType, entityId, reason). A second retry table would be a second
// authority over the same question.
//
// WHAT IS STORED, AND WHY IT IS NOT A STATUS
// TransactionHistory.status stays PENDING throughout. Backoff state lives in
// details (attempts, nextAttemptAt, lastOutcome, lastReason); the financial
// outcome is never rewritten to reflect an operational retry.
// =============================================================================

const BLOCKING_REASONS = Object.freeze([
    'DEPOSIT_RECONCILIATION_BACKOFF',
    'DEPOSIT_RECONCILIATION_PARKED',
    'PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE',
    'PROVIDER_EVIDENCE_CONFLICTS_WITH_WITNESS',
]);

// Minutes to wait before the next attempt, by attempt number (1-based).
// Deliberately gentle: the provider has no incentive to answer faster because we
// ask more often, and every extra call is another chance to misread a timeout.
const BACKOFF_MINUTES = Object.freeze([2, 5, 15, 60, 240]);
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** Outcomes that mean "the provider has not told us anything conclusive". */
const TRANSIENT_OUTCOMES = Object.freeze(['STATUS_UNAVAILABLE', 'STILL_PENDING', 'NOT_MOOLRE_SURFACE']);

/** Outcomes that mean "a human must adjudicate; stop asking the provider". */
const CONTRADICTORY_OUTCOMES = Object.freeze(['CONTRADICTORY_EVIDENCE', 'OBSERVATION_CLAIM_CONFLICT']);

function nextAttemptAtFor(attempts, now = new Date()) {
    const idx = Math.min(Math.max(attempts, 1), MAX_ATTEMPTS) - 1;
    return new Date(now.getTime() + BACKOFF_MINUTES[idx] * 60_000);
}


async function tablePresent(prisma) {
    const rows = await prisma.$queryRawUnsafe(`SELECT to_regclass('"ReconciliationException"')::text AS t`);
    return !!(Array.isArray(rows) && rows[0] && rows[0].t);
}

/**
 * Reads the durable parking state for one deposit.
 * A missing case table is treated as "not parked" here, but callers that WRITE
 * a required case must treat its absence as fatal (see recordAttempt).
 */
async function readParking(prisma, transactionHistoryId) {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT "reason", "status", "details"
           FROM "ReconciliationException"
          WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1
            AND "reason" = ANY($2::text[])
          ORDER BY "firstSeenAt" ASC`,
        String(transactionHistoryId), [...BLOCKING_REASONS],
    );
    const open = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'OPEN');
    const parked = open.find((r) => r.reason === 'DEPOSIT_RECONCILIATION_PARKED'
        || r.reason === 'PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE'
        || r.reason === 'PROVIDER_EVIDENCE_CONFLICTS_WITH_WITNESS');
    const backoff = open.find((r) => r.reason === 'DEPOSIT_RECONCILIATION_BACKOFF');
    const nextAttemptAt = backoff && backoff.details && backoff.details.nextAttemptAt
        ? new Date(backoff.details.nextAttemptAt) : null;
    return {
        parked: !!parked,
        parkedReason: parked ? parked.reason : null,
        attempts: (backoff && backoff.details && Number(backoff.details.attempts)) || 0,
        nextAttemptAt,
        blocked: !!parked || (nextAttemptAt ? nextAttemptAt.getTime() > Date.now() : false),
    };
}

/**
 * Records one attempt durably. Merges details rather than replacing them, so a
 * later discovery never erases the earlier evidence.
 *
 * A required write that cannot be committed throws: a parking state we failed to
 * persist must never look like a successful park.
 */
async function recordAttempt(prisma, {
    transactionHistoryId, outcome, reason = null, park = false,
}) {
    if (!(await tablePresent(prisma))) {
        const err = new Error('[wp-i] the reconciliation case table is absent, so this deposit cannot be parked');
        err.code = 'DEPOSIT_PARKING_CASE_TABLE_MISSING';
        throw err;
    }
    const previous = await readParking(prisma, transactionHistoryId);
    const attempts = previous.attempts + 1;
    const shouldPark = park || attempts >= MAX_ATTEMPTS;
    const caseReason = shouldPark ? 'DEPOSIT_RECONCILIATION_PARKED' : 'DEPOSIT_RECONCILIATION_BACKOFF';
    const nextAttemptAt = shouldPark ? null : nextAttemptAtFor(attempts);
    const details = {
        attempts,
        lastOutcome: outcome,
        lastReason: reason,
        nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
        parkedAt: shouldPark ? new Date().toISOString() : null,
        firstAttemptAt: (previous.attempts === 0) ? new Date().toISOString() : undefined,
    };
    const inserted = await prisma.$executeRawUnsafe(
        `INSERT INTO "ReconciliationException" ("id","entityType","entityId","reference","reason","status","details","firstSeenAt","lastSeenAt")
         VALUES (gen_random_uuid(), 'DEPOSIT_FIAT', $1, NULL, $2, 'OPEN', $3::jsonb, now(), now())
         ON CONFLICT DO NOTHING`,
        String(transactionHistoryId), caseReason, JSON.stringify(details),
    );
    if (!inserted) {
        // Merge, never replace: a partial unique index covers the open case, so a
        // second attempt updates it in place and keeps the earlier evidence.
        await prisma.$executeRawUnsafe(
            `UPDATE "ReconciliationException"
                SET "details" = COALESCE("details", '{}'::jsonb) || $2::jsonb,
                    "lastSeenAt" = now()
              WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1
                AND "reason" = $3 AND "status" = 'OPEN'`,
            String(transactionHistoryId), JSON.stringify(details), caseReason,
        );
    }
    if (shouldPark) {
        // Backoff ENDS when parking begins. Leaving the backoff case open would
        // report a next attempt that will never happen, and would leave two open
        // cases answering the same question.
        await prisma.$executeRawUnsafe(
            `UPDATE "ReconciliationException"
                SET "status" = 'RESOLVED', "resolvedAt" = now(),
                    "details" = COALESCE("details", '{}'::jsonb) || '{"resolvedBySystem":"parked"}'::jsonb
              WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1
                AND "reason" = 'DEPOSIT_RECONCILIATION_BACKOFF' AND "status" = 'OPEN'`,
            String(transactionHistoryId),
        );
    }
    return { attempts, parked: shouldPark, caseReason, nextAttemptAt };
}



/** Closes the operational parking case when the deposit reaches a real outcome. */
async function resolveParking(prisma, transactionHistoryId, systemNote = 'resolved') {
    if (!(await tablePresent(prisma))) return 0;
    return prisma.$executeRawUnsafe(
        `UPDATE "ReconciliationException"
            SET "status" = 'RESOLVED', "resolvedAt" = now(),
                "details" = COALESCE("details", '{}'::jsonb) || jsonb_build_object('resolvedBySystem', $2)
          WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1
            AND "reason" = ANY($3::text[]) AND "status" = 'OPEN'`,
        String(transactionHistoryId), systemNote, [...BLOCKING_REASONS],
    );
}

module.exports = {
    BLOCKING_REASONS,
    BACKOFF_MINUTES,
    MAX_ATTEMPTS,
    TRANSIENT_OUTCOMES,
    CONTRADICTORY_OUTCOMES,
    nextAttemptAtFor,
    readParking,
    recordAttempt,
    resolveParking,
    tablePresent,
};
