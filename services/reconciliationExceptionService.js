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
const recordReconciliationExceptionLoud = async (prisma, args, { escalate = null } = {}) => {
    try {
        return await recordReconciliationException(prisma, args);
    } catch (err) {
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
