// services/businessOS/documentNumberService.js
// =============================================================================
// r36/P1 — Durable, concurrency-safe, business-local document numbers.
//
// The legacy generation (`count + 1` per business) collided twice: two
// businesses both generated PO-00001 against a GLOBAL unique index, and two
// concurrent creations inside one business both read the same count. This
// service replaces it with a durable per-(business, docType) sequence:
//
//   • ONE atomic INSERT .. ON CONFLICT DO UPDATE .. RETURNING statement —
//     concurrent creators serialize on the row; every caller gets a distinct,
//     monotonically increasing number.
//   • The sequence NEVER decreases: deleting a document does not free its
//     number, so identifiers are never reused (audit-friendly).
//   • The composite unique index (businessProfileId, docNumber) is the
//     database backstop; a collision (which can no longer happen through this
//     path) fails the creation transaction rather than silently overwriting.
// =============================================================================

'use strict';

const DOC_TYPES = {
    PURCHASE_ORDER: {
        prefix: 'PO', pad: 5,
        table: 'PurchaseOrder', column: 'poNumber',
        // Canonical anchored form of a document number. Rows that do NOT
        // match are ignored by the backfill MAX (a non-canonical identifier
        // cannot collide with a canonically generated one) and surfaced
        // separately via countMalformedLegacyNumbers.
        canonical: '^PO-(\\d+)$',
    },
    STOCK_COUNT: {
        prefix: 'SC', pad: 5,
        table: 'StockCount', column: 'countNumber',
        canonical: '^SC-(\\d+)$',
    },
};

const fail = (status, code, message) => {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
};

/**
 * Number of existing documents for a business whose number does NOT match the
 * canonical `PREFIX-<digits>` form. Malformed legacy identifiers never break
 * the sequence (the backfill MAX ignores them — they cannot collide with a
 * canonical number), but they are surfaced explicitly instead of silently
 * guessed at. Callers (tests/deployment checks) use this to report drift.
 */
async function countMalformedLegacyNumbers(prisma, businessProfileId, docType) {
    const spec = DOC_TYPES[docType];
    if (!spec) throw fail(400, 'UNKNOWN_DOC_TYPE', `Unknown document type: ${docType}`);
    const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n
         FROM "${spec.table}"
         WHERE "businessProfileId" = $1
           AND "${spec.column}" !~ $2`,
        businessProfileId,
        spec.canonical
    );
    return rows[0]?.n || 0;
}

/**
 * Atomically reserve the next document number for (businessProfileId, docType).
 * MUST be called inside the same transaction as the document creation so the
 * reservation and the document commit (or roll back) together.
 *
 * r37/P1 — PRODUCTION BACKFILL: production already contains PurchaseOrder and
 * StockCount rows created before this sequence existed. A fresh sequence row
 * must therefore INITIALIZE FROM THE EXISTING MAXIMUM, not from 0 — otherwise
 * the first post-deployment document can attempt to reuse a live PO-00001 /
 * SC-00001. The backfill runs inside the same atomic upsert: the MAX is
 * computed on the INSERT branch only (the first reservation for that
 * business/type); concurrent first-creators serialize through the ON CONFLICT
 * row lock, so exactly one backfills and the other increments. Repeated
 * execution is naturally idempotent — once the sequence row exists, the INSERT
 * branch never runs again and the sequence stays monotonic. Deleted documents
 * never free a number (the sequence never decreases, and the existing max is
 * only a FLOOR for initialization).
 */
async function nextDocumentNumber(tx, businessProfileId, docType) {
    const spec = DOC_TYPES[docType];
    if (!spec) throw fail(400, 'UNKNOWN_DOC_TYPE', `Unknown document type: ${docType}`);

    // Single atomic statement — no NOT EXISTS guard (it would suppress the
    // ON CONFLICT increment on every call after the first):
    //   • sequence row ABSENT  → INSERT branch runs once with the backfilled
    //     max+1 (COALESCE handles a business with no existing documents);
    //   • sequence row PRESENT → ON CONFLICT takes the increment branch;
    //   • concurrent first calls serialize on the unique row: exactly one
    //     backfills, the loser increments the winner's row.
    // The anchored regexp means only CANONICAL numbers count toward the MAX
    // floor; regexp_match yields NULL for anything else and MAX skips it.
    const rows = await tx.$queryRawUnsafe(
        `INSERT INTO "DocumentNumberSequence" ("id", "businessProfileId", "docType", "lastNumber")
         SELECT gen_random_uuid()::text, $1, $2,
                COALESCE((
                    SELECT MAX((regexp_match("${spec.column}", '${spec.canonical}'))[1])::int
                    FROM "${spec.table}"
                    WHERE "businessProfileId" = $1
                ), 0) + 1
         ON CONFLICT ("businessProfileId", "docType")
         DO UPDATE SET "lastNumber" = "DocumentNumberSequence"."lastNumber" + 1
         RETURNING "lastNumber"`,
        businessProfileId,
        docType
    );
    const n = rows[0]?.lastNumber;
    if (!Number.isInteger(n) || n < 1) {
        throw fail(500, 'SEQUENCE_FAILURE', 'Failed to reserve a document number.');
    }
    return `${spec.prefix}-${String(n).padStart(spec.pad, '0')}`;
}

module.exports = { nextDocumentNumber, countMalformedLegacyNumbers, DOC_TYPES };
