// src/services/unresolvedEvidenceCaseService.js
// =============================================================================
// §WP-I — the Case B writer: durable unresolved-provider-evidence cases.
//
// A Case B is a completed deposit whose provider evidence is tied to it but for
// which NO canonical observation key can be established (typically: the
// deposit's persisted providerRef and its settlement providerRef disagree, so no
// agreed wallet exists and inventing one is forbidden). The evidence is real, it
// is not free money, and it must remain visible to an operator until it is
// explicitly resolved.
//
// THIS IS THE PRODUCTION WRITER. The release-chain backfill calls it, and the
// concurrency proof drives it directly — there is no test-only duplicate of this
// logic. That matters: a test that re-implemented the write in raw SQL would
// prove that SQL blocks, not that the product's writer blocks.
//
// THREE PROPERTIES ARE LOAD-BEARING:
//   1. ARBITRATION BEFORE EVIDENCE. The transaction-scoped coordination lock is
//      taken FIRST, on a wallet-INDEPENDENT key (provider + reference), because a
//      Case B has no trustworthy wallet by definition and must still contend with
//      a witness that does. Taking it before the case row is read or written is
//      what serializes this writer against the settlement-witness writer instead
//      of letting both read "nothing yet" and both commit.
//   2. EVIDENCE IS ACCUMULATED, NEVER REPLACED. A later run observes new events,
//      owners and contradictions. Identifiers union without duplicates, first-seen
//      scalar values stay, and distinct contradictory references are retained.
//   3. THE CASE IS NOT A CLAIM. No ProviderObservationClaim row is created and no
//      economic owner is chosen here. Creating either would hand spendable
//      authority to evidence that is explicitly unresolved.
// =============================================================================
'use strict';

const { acquireObservationArbitration } = require('./observationArbitration');

/** Fields whose values are SETS: merged by union, deduplicated, sorted. */
const MERGE_UNION_KEYS = Object.freeze(['ties', 'evidenceIds', 'owners', 'contradictoryReferences']);

const CASE_ENTITY_TYPE = 'DEPOSIT_FIAT';
const CASE_STATUS_OPEN = 'OPEN';

/**
 * Deterministic merge of accumulated case details.
 *
 * Exported so the backfill and the tests read the SAME rule. Union keys keep
 * every distinct value (sorted, deduplicated) so a repeated run is stable; scalar
 * keys are first-seen-wins, so a later run can never rewrite what the first run
 * proved.
 */
function mergeCaseDetails(existing, incoming) {
    const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
    const next = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) ? incoming : {};
    const out = { ...base };

    for (const key of MERGE_UNION_KEYS) {
        const a = Array.isArray(base[key]) ? base[key] : [];
        const b = Array.isArray(next[key]) ? next[key] : [];
        if (a.length === 0 && b.length === 0) continue;
        out[key] = [...new Set([...a.map(String), ...b.map(String)])].sort();
    }

    for (const [key, value] of Object.entries(next)) {
        if (MERGE_UNION_KEYS.includes(key)) continue;
        const current = out[key];
        const empty = current === undefined || current === null || current === '';
        if (empty && value !== undefined && value !== null && value !== '') out[key] = value;
    }

    out.lastMergedAt = new Date().toISOString();
    return out;
}

/** The wallet-independent coordination identity a Case B contends on. */
function caseCoordinationReference({ providerRef = null, txHash = null } = {}) {
    return providerRef || txHash || null;
}

/**
 * Record (or accumulate into) ONE unresolved-evidence case, inside the caller's
 * transaction.
 *
 * @param tx        caller-owned transaction client (the caller owns the boundary)
 * @param caseInput { depositId, reason, ties, providerRef, txHash, evidenceIds,
 *                    note, contradictoryReferences? }
 * @returns { outcome: 'inserted'|'merged', depositId, reason, details }
 */
async function recordUnresolvedEvidenceCase(tx, caseInput = {}) {
    if (!tx || typeof tx.$executeRawUnsafe !== 'function') {
        throw new Error('[wp-i] recordUnresolvedEvidenceCase requires a transaction client');
    }
    const depositId = String(caseInput.depositId || '').trim();
    const reason = String(caseInput.reason || '').trim();
    if (!depositId || !reason) {
        throw new Error('[wp-i] an unresolved-evidence case needs a depositId and a reason');
    }

    // 1. ARBITRATION BEFORE EVIDENCE — same mechanism, same key shape as the
    //    settlement-witness writer. Wallet-independent on purpose.
    await acquireObservationArbitration(tx, {
        provider: 'moolre',
        reference: caseCoordinationReference(caseInput),
    });

    const incoming = {
        ties: Array.isArray(caseInput.ties) ? caseInput.ties : [],
        providerRef: caseInput.providerRef ?? null,
        txHash: caseInput.txHash ?? null,
        evidenceIds: Array.isArray(caseInput.evidenceIds) ? caseInput.evidenceIds : [],
        note: caseInput.note
            || 'Moolre evidence is tied to this completed deposit but no canonical observation key can be established. '
            + 'No claim was created and no owner was chosen; resolve with independent evidence.',
    };
    if (Array.isArray(caseInput.contradictoryReferences)) {
        incoming.contradictoryReferences = caseInput.contradictoryReferences;
    }

    // 2. Read under FOR UPDATE: we already hold the arbitration lock, so this
    //    row cannot be changed between the read and the write below.
    const existingRows = await tx.$queryRawUnsafe(
        `SELECT "details" FROM "ReconciliationException"
          WHERE "entityType" = $1 AND "entityId" = $2
            AND "reason" = $3 AND "status" = $4
          FOR UPDATE`,
        CASE_ENTITY_TYPE, depositId, reason, CASE_STATUS_OPEN,
    );
    const existing = Array.isArray(existingRows) && existingRows[0]
        ? existingRows[0].details : null;

    if (!existing) {
        await tx.$executeRawUnsafe(
            `INSERT INTO "ReconciliationException" ("entityType","entityId","reference","reason","status","details")
             VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
            CASE_ENTITY_TYPE, depositId, incoming.providerRef, reason, CASE_STATUS_OPEN,
            JSON.stringify(incoming),
        );
        return { outcome: 'inserted', depositId, reason, details: incoming };
    }

    // 3. ACCUMULATE — never replace.
    const merged = mergeCaseDetails(existing, incoming);
    await tx.$executeRawUnsafe(
        `UPDATE "ReconciliationException"
            SET "details" = $4::jsonb, "lastSeenAt" = now()
          WHERE "entityType" = $1 AND "entityId" = $2
            AND "reason" = $3 AND "status" = 'OPEN'`,
        CASE_ENTITY_TYPE, depositId, reason, JSON.stringify(merged),
    );
    return { outcome: 'merged', depositId, reason, details: merged };
}

/** Read the OPEN case for a deposit, or null. */
async function readOpenUnresolvedCase(client, depositId, reason) {
    const rows = await client.$queryRawUnsafe(
        `SELECT "id","reference","reason","status","details"
           FROM "ReconciliationException"
          WHERE "entityType" = $1 AND "entityId" = $2
            AND "reason" = $3 AND "status" = $4
          LIMIT 1`,
        CASE_ENTITY_TYPE, String(depositId), String(reason), CASE_STATUS_OPEN,
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

module.exports = {
    MERGE_UNION_KEYS,
    CASE_ENTITY_TYPE,
    CASE_STATUS_OPEN,
    mergeCaseDetails,
    caseCoordinationReference,
    recordUnresolvedEvidenceCase,
    readOpenUnresolvedCase,
};
