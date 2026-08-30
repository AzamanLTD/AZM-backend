// =============================================================================
// AZAMAN — PROVIDER SETTLEMENT ATTEMPT IDENTITY
//
// TransactionHistory.txHash is the platform's idempotency/correlation key.
// ProviderSettlementAttempt is the durable external identity layer: one
// provider + providerReference identifies one external attempt and links it
// directly to the canonical TransactionHistory row.
//
// This module deliberately uses parameterized raw SQL because the repository's
// Prisma schema/client is generated from a very large legacy schema. The SQL
// migration is the source of truth for this additive table; no financial state
// is trusted from the attempt row itself.
// =============================================================================

const PROVIDER_VALUES = new Set(['MTN_MOMO_DISBURSEMENT', 'MOOLRE']);

const normalizeProvider = (provider) => {
    const value = String(provider || '').trim().toUpperCase();
    if (!PROVIDER_VALUES.has(value)) {
        const error = new Error(`[providerSettlementAttempt] unsupported provider: ${provider}`);
        error.code = 'UNSUPPORTED_PROVIDER';
        throw error;
    }
    return value;
};

const recordProviderSettlementAttempt = async (prisma, {
    reference,
    provider,
    providerReference = reference,
    providerTransactionId = null,
    status = 'PENDING',
    failureReason = null,
    metadata = null
}) => {
    if (!reference) throw new Error('[providerSettlementAttempt] reference is required.');
    if (!providerReference) throw new Error('[providerSettlementAttempt] providerReference is required.');

    const normalizedProvider = normalizeProvider(provider);
    const existingRows = await prisma.$queryRawUnsafe(
        `SELECT psa."id", psa."transactionHistoryId", psa."provider", psa."providerReference",
                psa."providerTransactionId", psa."status", psa."firstSeenAt", psa."lastSeenAt",
                psa."settledAt", psa."failureReason", psa."metadata"
           FROM "ProviderSettlementAttempt" psa
           JOIN "TransactionHistory" th ON th."id" = psa."transactionHistoryId"
          WHERE psa."provider" = $1 AND psa."providerReference" = $2
          LIMIT 1`,
        normalizedProvider,
        String(providerReference)
    );

    if (existingRows[0]) {
        const row = existingRows[0];
        await prisma.$executeRawUnsafe(
            `UPDATE "ProviderSettlementAttempt"
                SET "providerTransactionId" = COALESCE($1, "providerTransactionId"),
                    "status" = $2,
                    "lastSeenAt" = CURRENT_TIMESTAMP,
                    "settledAt" = CASE WHEN $2 IN ('COMPLETED','FAILED') THEN COALESCE("settledAt", CURRENT_TIMESTAMP) ELSE "settledAt" END,
                    "failureReason" = COALESCE($3, "failureReason"),
                    "metadata" = COALESCE($4::jsonb, "metadata")
              WHERE "id" = $5`,
            providerTransactionId ? String(providerTransactionId) : null,
            String(status),
            failureReason || null,
            metadata == null ? null : JSON.stringify(metadata),
            row.id
        );
        return { ...row, changed: false, id: row.id };
    }

    const txRows = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "TransactionHistory" WHERE "txHash" = $1 LIMIT 1`,
        String(reference)
    );
    const transaction = txRows[0];
    if (!transaction) {
        const error = new Error(`[providerSettlementAttempt] unknown TransactionHistory reference: ${reference}`);
        error.code = 'UNKNOWN_REFERENCE';
        throw error;
    }

    const insertedRows = await prisma.$queryRawUnsafe(
        `INSERT INTO "ProviderSettlementAttempt"
            ("transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "settledAt", "failureReason", "metadata")
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $5 IN ('COMPLETED','FAILED') THEN CURRENT_TIMESTAMP ELSE NULL END,
                 $6, $7::jsonb)
         ON CONFLICT ("provider", "providerReference") DO UPDATE
            SET "providerTransactionId" = COALESCE(EXCLUDED."providerTransactionId", "ProviderSettlementAttempt"."providerTransactionId"),
                "status" = EXCLUDED."status",
                "lastSeenAt" = CURRENT_TIMESTAMP,
                "settledAt" = CASE WHEN EXCLUDED."status" IN ('COMPLETED','FAILED') THEN COALESCE("ProviderSettlementAttempt"."settledAt", CURRENT_TIMESTAMP) ELSE "ProviderSettlementAttempt"."settledAt" END,
                "failureReason" = COALESCE(EXCLUDED."failureReason", "ProviderSettlementAttempt"."failureReason"),
                "metadata" = COALESCE(EXCLUDED."metadata", "ProviderSettlementAttempt"."metadata")
         RETURNING "id", "transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "firstSeenAt", "lastSeenAt", "settledAt", "failureReason", "metadata"`,
        transaction.id,
        normalizedProvider,
        String(providerReference),
        providerTransactionId ? String(providerTransactionId) : null,
        String(status),
        failureReason || null,
        metadata == null ? null : JSON.stringify(metadata)
    );

    return { ...(insertedRows[0] || {}), changed: true };
};

const getProviderSettlementAttempt = async (prisma, { provider, providerReference }) => {
    const normalizedProvider = normalizeProvider(provider);
    const rows = await prisma.$queryRawUnsafe(
        `SELECT * FROM "ProviderSettlementAttempt"
          WHERE "provider" = $1 AND "providerReference" = $2
          LIMIT 1`,
        normalizedProvider,
        String(providerReference)
    );
    return rows[0] || null;
};

module.exports = {
    normalizeProvider,
    recordProviderSettlementAttempt,
    getProviderSettlementAttempt
};
