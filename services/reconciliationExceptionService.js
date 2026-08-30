// =============================================================================
// AZAMAN — RECONCILIATION EXCEPTION QUEUE
//
// This is an operational work queue, not a financial ledger. It records cases
// where automatic reconciliation cannot safely determine the canonical record
// or complete a recovery operation. Upserts are idempotent by entity/reason
// while the exception remains OPEN.
// =============================================================================

const VALID_ENTITY_TYPES = new Set(['WITHDRAWAL', 'TRANSACTION', 'PROVIDER_ATTEMPT']);

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

module.exports = { recordReconciliationException };
