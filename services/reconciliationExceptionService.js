// =============================================================================
// AZAMAN — RECONCILIATION EXCEPTION QUEUE
//
// This is an operational work queue, not a financial ledger. It records cases
// where automatic reconciliation cannot safely determine the canonical record
// or complete a recovery operation. Upserts are idempotent by entity/reason
// while the exception remains OPEN.
// =============================================================================

// §P.5-D liquidity-authority entities use their own prefixed types so
// exception rows are distinguishable from withdrawal/transaction entities.
const logger = require('../src/config/logger');

const VALID_ENTITY_TYPES = new Set([
    'WITHDRAWAL', 'TRANSACTION', 'PROVIDER_ATTEMPT',
    'FIAT_LIQUIDITY_RESERVATION', 'FIAT_LIQUIDITY_RECEIPT',
    'FIAT_PROVIDER_EVENT', 'FIAT_LIQUIDITY_STATE',
]);

const recordReconciliationException = async (prisma, {
    entityType,
    entityId,
    reference = null,
    reason,
    details = null
}) => {
    if (!VALID_ENTITY_TYPES.has(String(entityType))) {
        throw new Error(`[reconciliationException] unsupported entityType: ${entityType}`);
    }
    if (!entityId) throw new Error('[reconciliationException] entityId is required.');
    if (!reason) throw new Error('[reconciliationException] reason is required.');

    const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO "ReconciliationException"
            ("entityType", "entityId", "reference", "reason", "status", "details")
         VALUES ($1, $2, $3, $4, 'OPEN', $5::jsonb)
         ON CONFLICT ("entityType", "entityId", "reason") WHERE "status" = 'OPEN'
         DO UPDATE SET
            "reference" = COALESCE(EXCLUDED."reference", "ReconciliationException"."reference"),
            "details" = COALESCE(EXCLUDED."details", "ReconciliationException"."details"),
            "lastSeenAt" = CURRENT_TIMESTAMP
         RETURNING "id", "entityType", "entityId", "reference", "reason", "status", "firstSeenAt", "lastSeenAt"`,
        String(entityType),
        String(entityId),
        reference == null ? null : String(reference),
        String(reason),
        details == null ? null : JSON.stringify(details)
    );

    return rows[0] || null;
};

// ── r15 R15-F: honest evidence writes ─────────────────────────────────────
// The exception record is the durable breadcrumb for the recon team. The
// historical call sites swallowed evidence-write failures with
// .catch(() => null) INSIDE already-failing paths — when the write itself
// failed, the financial anomaly it was flagging left NO durable record at
// all. This wrapper NEVER throws (the user-facing response must still be
// honest and calm), but it ALWAYS escalates the evidence failure loudly
// and optionally through the caller's admin channel.
//
// ── r15 follow-up (audit P0): transaction safety of the swallow ──────────
// Several call sites pass an INTERACTIVE-TRANSACTION client (tx). A failed
// SQL statement does not merely throw in JavaScript — PostgreSQL puts the
// WHOLE transaction into the aborted state, and every subsequent statement
// fails with 25P02 until rollback. Catching the JS error while the caller's
// transaction is poisoned would corrupt the financial path that is still
// running. The evidence write is therefore wrapped in a SAVEPOINT when (and
// only when) the client is inside a transaction: a failed insert rolls back
// to the savepoint, restoring the transaction to a usable state, and the
// financial path continues to its own commit/rollback decision. Outside a
// transaction (root client, autocommit) each statement is its own implicit
// transaction — SAVEPOINT would error with 25P01, so we detect that and
// fall back to a direct attempt whose failure is safe to swallow.
const EVIDENCE_SAVEPOINT = 'r15_evidence_write';
const _savepointState = async (prisma) => {
    // Returns true when a SAVEPOINT was established (client is inside a
    // transaction); false when the client is autocommit (statement-local).
    try {
        await prisma.$executeRawUnsafe(`SAVEPOINT "${EVIDENCE_SAVEPOINT}"`);
        return true;
    } catch (_) {
        // 25P01 "SAVEPOINT can only be used in transaction blocks" — the
        // root client runs each statement in its own implicit transaction.
        return false;
    }
};
const recordReconciliationExceptionLoud = async (prisma, args, { escalate = null } = {}) => {
    const inTransaction = await _savepointState(prisma);
    try {
        const result = await recordReconciliationException(prisma, args);
        if (inTransaction) {
            await prisma.$executeRawUnsafe(`RELEASE SAVEPOINT "${EVIDENCE_SAVEPOINT}"`);
        }
        return result;
    } catch (err) {
        if (inTransaction) {
            // Roll the transaction back to the savepoint so the caller's
            // (possibly still-in-progress) financial transaction is usable.
            // The savepoint is then released: the surrounding transaction
            // continues WITHOUT the aborted evidence write.
            try {
                await prisma.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${EVIDENCE_SAVEPOINT}"`);
                await prisma.$executeRawUnsafe(`RELEASE SAVEPOINT "${EVIDENCE_SAVEPOINT}"`);
            } catch (rollbackErr) {
                // The surrounding transaction is unusable for reasons beyond
                // the evidence write (e.g. it was ALREADY aborted upstream).
                // Escalate the rollback failure too — the caller will fail
                // on its next statement and its own error path takes over.
                logger.error({
                    err: rollbackErr,
                    marker: 'RECONCILIATION_EVIDENCE_SAVEPOINT_ROLLBACK_FAILED',
                }, '[reconciliationException] CRITICAL: the evidence-write savepoint rollback failed — the surrounding transaction may be aborted');
            }
        }
        logger.error({
            err,
            entityType: args?.entityType ?? null,
            entityId: args?.entityId ?? null,
            reason: args?.reason ?? null,
            marker: 'RECONCILIATION_EVIDENCE_WRITE_FAILED',
        }, '[reconciliationException] CRITICAL: the evidence write itself failed — the anomaly being flagged has NO durable record');
        if (typeof escalate === 'function') {
            try {
                await escalate(err);
            } catch (_) {
                // Escalation is best-effort; the error log above is the floor.
            }
        }
        return null;
    }
};

module.exports = { recordReconciliationException, recordReconciliationExceptionLoud };
