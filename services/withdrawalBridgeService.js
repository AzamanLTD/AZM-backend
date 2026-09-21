// services/withdrawalBridgeService.js
// =============================================================================
// r17 follow-up (r18): DURABLE OWNERSHIP CLAIMS on the
// Withdrawal.transactionHistoryId bridge.
//
// The r17 guards confined the guessed amount±5s fallback to GENUINELY ORPHAN
// canonical rows, but the fallback still had a race: two concurrent
// mirror-only withdrawals could both observe the same orphan canonical
// before either bridge claim committed — one caller would win the durable
// bridge while the loser kept using the canonical it had selected (the
// payout worker could even proceed toward provider dispatch under a
// canonical another mirror had just durably claimed).
//
// Adoption is now a real ownership claim, built ONLY on the existing
// unique partial index ("Withdrawal_transactionHistoryId_key" ON
// "Withdrawal"("transactionHistoryId") WHERE NOT NULL) and the existing
// bridge backfill statement — no second identity mechanism:
//
//   1. attempt the atomic claim:
//        UPDATE "Withdrawal" SET "transactionHistoryId" = $canonical
//        WHERE "id" = $withdrawal AND "transactionHistoryId" IS NULL
//   2. exactly one concurrent caller can commit that statement per
//      canonical: the unique partial index refuses everyone else;
//   3. a caller that lost the race NEVER receives the canonical row — the
//      caller's existing missing/ambiguous/manual-review path takes over.
//
// The claim is a single autocommitted statement: it is durable before the
// caller acts on the canonical. A loss is reported with the durable owner
// so callers can log/queue it for operator attention.
// =============================================================================

/**
 * Read the Withdrawal id that durably owns the given canonical
 * TransactionHistory id via the bridge (null when unowned).
 */
async function readCanonicalOwner(db, canonicalId) {
    if (!db || typeof db.$queryRawUnsafe !== 'function') return null;
    try {
        const rows = await db.$queryRawUnsafe(
            'SELECT "id" FROM "Withdrawal" WHERE "transactionHistoryId" = $1 LIMIT 1',
            canonicalId
        );
        const id = rows?.[0]?.id;
        return id == null ? null : String(id);
    } catch {
        return null;
    }
}

/**
 * Atomically claim an orphan canonical for this Withdrawal mirror row.
 *
 * Returns:
 *   { won: true,  reason }                        — this withdrawal is now the
 *      durable bridge owner of the canonical (or its own row already owns it
 *      through a concurrent same-row caller); the caller may use the row.
 *   { won: false, reason, owner }                 — another withdrawal (or an
 *      unavailable claim mechanism) owns the canonical; the caller must NOT
 *      use the row. `owner` is the winning Withdrawal id when known.
 *
 * Never throws for a lost race (unique violation is the expected loss);
 * rethrows genuine infrastructure errors.
 */
async function claimOrphanCanonical(db, withdrawalId, canonicalId) {
    if (withdrawalId == null || canonicalId == null) {
        return { won: false, reason: 'CLAIM_INVALID_IDENTITY', owner: null };
    }
    if (!db || typeof db.$executeRawUnsafe !== 'function') {
        // Without the bridge claim statement this caller CANNOT establish
        // durable ownership. A real Prisma client always has the method —
        // its absence means the claim cannot be made, so the canonical is
        // never handed out on a guess.
        return { won: false, reason: 'CLAIM_MECHANISM_UNAVAILABLE', owner: null };
    }

    let claimed;
    try {
        claimed = await db.$executeRawUnsafe(
            'UPDATE "Withdrawal" SET "transactionHistoryId" = $1 WHERE "id" = $2 AND "transactionHistoryId" IS NULL',
            canonicalId,
            withdrawalId
        );
    } catch (err) {
        const message = String((err && err.message) || err);
        // Unique partial index Withdrawal_transactionHistoryId_key: another
        // Withdrawal row committed a claim on this canonical first. This is
        // the expected loss of the adoption race — never a caller failure.
        if (err && (err.code === 'P2002' || /23505|unique/i.test(message))) {
            const owner = await readCanonicalOwner(db, canonicalId);
            return { won: false, reason: 'CLAIM_LOST_OTHER_WITHDRAWAL', owner };
        }
        throw err;
    }

    if (Number(claimed) === 1) {
        return { won: true, reason: 'CLAIM_WON' };
    }

    // Zero affected rows: this withdrawal's own bridge moved while we ran
    // (a concurrent caller on the SAME mirror row). The durable bridge is
    // authoritative — re-read it.
    let ownLink = null;
    if (typeof db.$queryRawUnsafe === 'function') {
        const rows = await db.$queryRawUnsafe(
            'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "id" = $1 LIMIT 1',
            withdrawalId
        );
        ownLink = rows?.[0]?.transactionHistoryId != null
            ? String(rows[0].transactionHistoryId)
            : null;
    }
    if (ownLink === String(canonicalId)) {
        // A concurrent caller on THIS SAME row won the claim first — this
        // row IS the durable owner. The caller still proceeds through its
        // own state machine (mirror claim / idempotency guards) to act.
        return { won: true, reason: 'CLAIM_WON_SAME_ROW' };
    }
    const owner = await readCanonicalOwner(db, canonicalId);
    return { won: false, reason: 'CLAIM_LOST_OTHER_WITHDRAWAL', owner };
}

module.exports = { claimOrphanCanonical, readCanonicalOwner };
