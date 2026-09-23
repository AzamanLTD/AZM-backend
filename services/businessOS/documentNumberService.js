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
    PURCHASE_ORDER: { prefix: 'PO', pad: 5 },
    STOCK_COUNT: { prefix: 'SC', pad: 5 },
};

const fail = (status, code, message) => {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
};

/**
 * Atomically reserve the next document number for (businessProfileId, docType).
 * MUST be called inside the same transaction as the document creation so the
 * reservation and the document commit (or roll back) together.
 */
async function nextDocumentNumber(tx, businessProfileId, docType) {
    const spec = DOC_TYPES[docType];
    if (!spec) throw fail(400, 'UNKNOWN_DOC_TYPE', `Unknown document type: ${docType}`);

    const rows = await tx.$queryRawUnsafe(
        `INSERT INTO "DocumentNumberSequence" ("id", "businessProfileId", "docType", "lastNumber")
         VALUES (gen_random_uuid()::text, $1, $2, 1)
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

module.exports = { nextDocumentNumber, DOC_TYPES };
