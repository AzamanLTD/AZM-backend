// =============================================================================
// AZAMAN — PROVIDER SETTLEMENT ATTEMPT IDENTITY
//
// TransactionHistory.txHash is the platform's idempotency/correlation key.
// ProviderSettlementAttempt is the durable external identity layer: one
// provider + providerReference identifies one external attempt and links it
// directly to the canonical TransactionHistory row.
//
// Provider callbacks are not assumed to arrive in order. Once an attempt is
// terminal, a later contradictory callback may enrich its evidence but may not
// regress its terminal status. TransactionHistory remains the financial source
// of truth; this table is durable provider evidence and correlation metadata.
// =============================================================================

const PROVIDER_VALUES = new Set(['MTN_MOMO_DISBURSEMENT', 'MOOLRE']);
const ATTEMPT_STATUSES = new Set(['PENDING', 'COMPLETED', 'FAILED']);

const normalizeProvider = (provider) => {
    const value = String(provider || '').trim().toUpperCase();
    if (value === 'DISBURSEMENT') return 'MTN_MOMO_DISBURSEMENT';
    if (!PROVIDER_VALUES.has(value)) {
        const error = new Error(`[providerSettlementAttempt] unsupported provider: ${provider}`);
        error.code = 'UNSUPPORTED_PROVIDER';
        throw error;
    }
    return value;
};

const normalizeStatus = (status) => {
    const value = String(status || 'PENDING').trim().toUpperCase();
    if (!ATTEMPT_STATUSES.has(value)) {
        const error = new Error(`[providerSettlementAttempt] unsupported status: ${status}`);
        error.code = 'UNSUPPORTED_STATUS';
        throw error;
    }
    return value;
};

const terminalStatus = (status) => status === 'COMPLETED' || status === 'FAILED';

const providerReferenceConflict = (provider, providerReference, transactionHistoryId, existingTransactionHistoryId) => {
    const error = new Error(
        `[providerSettlementAttempt] provider reference ${provider}/${providerReference} is already linked to transaction ${existingTransactionHistoryId}, not ${transactionHistoryId}`,
    );
    error.code = 'PROVIDER_REFERENCE_CONFLICT';
    return error;
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
    const normalizedStatus = normalizeStatus(status);

    // Resolve the canonical financial owner before touching the provider identity
    // row. This lets both the normal lookup path and the concurrent INSERT/ON
    // CONFLICT path enforce the same provider-reference -> transaction binding.
    const transactionRows = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "TransactionHistory" WHERE "txHash" = $1 LIMIT 1`,
        String(reference)
    );
    const transaction = transactionRows[0];
    if (!transaction) {
        const error = new Error(`[providerSettlementAttempt] unknown TransactionHistory reference: ${reference}`);
        error.code = 'UNKNOWN_REFERENCE';
        throw error;
    }

    const existingRows = await prisma.$queryRawUnsafe(
        `SELECT psa."id", psa."transactionHistoryId", psa."provider", psa."providerReference",
                psa."providerTransactionId", psa."status", psa."firstSeenAt", psa."lastSeenAt",
                psa."settledAt", psa."failureReason", psa."metadata"
           FROM "ProviderSettlementAttempt" psa
          WHERE psa."provider" = $1 AND psa."providerReference" = $2
          LIMIT 1`,
        normalizedProvider,
        String(providerReference)
    );

    if (existingRows[0]) {
        const row = existingRows[0];
        if (String(row.transactionHistoryId) !== String(transaction.id)) {
            throw providerReferenceConflict(
                normalizedProvider,
                String(providerReference),
                transaction.id,
                row.transactionHistoryId,
            );
        }

        const updatedRows = await prisma.$queryRawUnsafe(
            `UPDATE "ProviderSettlementAttempt"
                SET "providerTransactionId" = COALESCE($1, "providerTransactionId"),
                    "status" = CASE
                        WHEN "status" IN ('COMPLETED', 'FAILED') THEN "status"
                        ELSE $2
                    END,
                    "lastSeenAt" = CURRENT_TIMESTAMP,
                    "settledAt" = CASE
                        WHEN "status" IN ('COMPLETED', 'FAILED') THEN COALESCE("settledAt", CURRENT_TIMESTAMP)
                        WHEN $2 IN ('COMPLETED', 'FAILED') THEN CURRENT_TIMESTAMP
                        ELSE "settledAt"
                    END,
                    "failureReason" = CASE
                        WHEN "status" = 'COMPLETED' THEN "failureReason"
                        WHEN $2 = 'FAILED' THEN COALESCE($3, "failureReason")
                        ELSE "failureReason"
                    END,
                    "metadata" = COALESCE($4::jsonb, "metadata")
              WHERE "id" = $5
              RETURNING "id", "transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "firstSeenAt", "lastSeenAt", "settledAt", "failureReason", "metadata"`,
            providerTransactionId ? String(providerTransactionId) : null,
            normalizedStatus,
            failureReason || null,
            metadata == null ? null : JSON.stringify(metadata),
            row.id
        );
        const effective = updatedRows[0] || row;
        return {
            ...effective,
            changed: row.status !== effective.status,
            id: row.id
        };
    }

    const insertedRows = await prisma.$queryRawUnsafe(
        `INSERT INTO "ProviderSettlementAttempt"
            ("transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "settledAt", "failureReason", "metadata")
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $5 IN ('COMPLETED','FAILED') THEN CURRENT_TIMESTAMP ELSE NULL END,
                 $6, $7::jsonb)
         ON CONFLICT ("provider", "providerReference") DO UPDATE
            SET "providerTransactionId" = COALESCE(EXCLUDED."providerTransactionId", "ProviderSettlementAttempt"."providerTransactionId"),
                "status" = CASE
                    WHEN "ProviderSettlementAttempt"."status" IN ('COMPLETED', 'FAILED') THEN "ProviderSettlementAttempt"."status"
                    ELSE EXCLUDED."status"
                END,
                "lastSeenAt" = CURRENT_TIMESTAMP,
                "settledAt" = CASE
                    WHEN "ProviderSettlementAttempt"."status" IN ('COMPLETED', 'FAILED') THEN COALESCE("ProviderSettlementAttempt"."settledAt", CURRENT_TIMESTAMP)
                    WHEN EXCLUDED."status" IN ('COMPLETED','FAILED') THEN CURRENT_TIMESTAMP
                    ELSE "ProviderSettlementAttempt"."settledAt"
                END,
                "failureReason" = CASE
                    WHEN "ProviderSettlementAttempt"."status" = 'COMPLETED' THEN "ProviderSettlementAttempt"."failureReason"
                    WHEN EXCLUDED."status" = 'FAILED' THEN COALESCE(EXCLUDED."failureReason", "ProviderSettlementAttempt"."failureReason")
                    ELSE "ProviderSettlementAttempt"."failureReason"
                END,
                "metadata" = COALESCE(EXCLUDED."metadata", "ProviderSettlementAttempt"."metadata")
          WHERE "ProviderSettlementAttempt"."transactionHistoryId" = EXCLUDED."transactionHistoryId"
         RETURNING "id", "transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "firstSeenAt", "lastSeenAt", "settledAt", "failureReason", "metadata"`,
        transaction.id,
        normalizedProvider,
        String(providerReference),
        providerTransactionId ? String(providerTransactionId) : null,
        normalizedStatus,
        failureReason || null,
        metadata == null ? null : JSON.stringify(metadata)
    );

    if (insertedRows[0]) {
        return { ...(insertedRows[0] || {}), changed: true };
    }

    // A concurrent callback inserted the same provider identity between our
    // initial SELECT and INSERT. Re-read and verify the winner's canonical
    // transaction binding instead of silently returning a cross-transaction row.
    const winnerRows = await prisma.$queryRawUnsafe(
        `SELECT "id", "transactionHistoryId", "provider", "providerReference", "providerTransactionId", "status", "firstSeenAt", "lastSeenAt", "settledAt", "failureReason", "metadata"
           FROM "ProviderSettlementAttempt"
          WHERE "provider" = $1 AND "providerReference" = $2
          LIMIT 1`,
        normalizedProvider,
        String(providerReference)
    );
    const winner = winnerRows[0];
    if (!winner) {
        throw new Error('[providerSettlementAttempt] provider attempt disappeared during concurrent write.');
    }
    if (String(winner.transactionHistoryId) !== String(transaction.id)) {
        throw providerReferenceConflict(
            normalizedProvider,
            String(providerReference),
            transaction.id,
            winner.transactionHistoryId,
        );
    }

    return { ...winner, changed: false };
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
    normalizeStatus,
    recordProviderSettlementAttempt,
    getProviderSettlementAttempt
};
