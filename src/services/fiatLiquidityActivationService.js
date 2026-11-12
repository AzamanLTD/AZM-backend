// src/services/fiatLiquidityActivationService.js
// =============================================================================
// §P.5-D ACTIVATION LATCH — one-way regime contract.
//
// WHY THIS EXISTS
// `GlobalSettings.fiatLiquidityAuthorityEnabled` is a Boolean that an operator
// can flip in either direction. That is not a safemode contract, because the
// authority WRITES a GHS projection into `SystemFiatPool` (§4 of the design:
// balance := availableGhs inside every liquidity transaction). Turning the
// Boolean back off therefore does not restore the legacy USDC pool — it
// reinterprets GHS pesewas as USDC dollars, a ~13x error on a payout gate.
//
// The regime is therefore latched, never toggled:
//   • activation writes `FiatLiquidityState.authorityActivatedAt` ONCE and is
//     never cleared;
//   • `isAuthorityModeActive()` is true when EITHER the Boolean is on OR the
//     latch is set, so clearing the Boolean can never return a latched database
//     to legacy meaning;
//   • deactivation after activation is refused (asserted), and the operator
//     procedure is documented in docs/p5d-ghs-liquidity-authority.md.
//
// ACTIVATION PREFLIGHT
// Activation is refused while any dispatch-eligible legacy fiat withdrawal —
// a row with no FiatLiquidityReservation for its canonical reference — is
// still unresolved. Those are exactly the rows whose USDC value would
// otherwise be compared against the new GHS projection by the auto-payout
// worker. Rows already parked for manual review are reported but do not block:
// the worker refuses them under the authority regime anyway (see
// `LEGACY_ROW_UNDER_AUTHORITY_REGIME`).
// =============================================================================

const { Prisma } = require('@prisma/client');
const ACTIVATION_LOCK_KEY = 'azm.p5d.authority.activation';

// Dispatch-eligible: the auto-payout worker's own candidate set.
const DISPATCH_ELIGIBLE_STATUSES = ['PENDING', 'APPROVED'];
// In flight or with an unknown provider outcome: the cash position is not yet
// resolved, so the row is still "unresolved" for this purpose.
const IN_FLIGHT_STATUSES = ['PROCESSING', 'IN_TRANSIT', 'UNKNOWN', 'AWAITING_PROVIDER', 'PENDING_PROVIDER'];
// Already parked for a human: reported, not blocking (the worker will not
// dispatch it under the authority regime).
const PARKED_STATUSES = ['NEEDS_MANUAL_REVIEW'];

const BLOCKING_STATUSES = [...DISPATCH_ELIGIBLE_STATUSES, ...IN_FLIGHT_STATUSES];

class AuthorityActivationRefused extends Error {
    constructor(preflight) {
        super('[P5-D] activation refused: unresolved legacy fiat withdrawals without a GHS reservation remain');
        this.name = 'AuthorityActivationRefused';
        this.code = 'P5D_ACTIVATION_BLOCKED';
        this.preflight = preflight;
    }
}

class AuthorityDeactivationRefused extends Error {
    constructor(mode) {
        super('[P5-D] deactivation refused: this database has already been activated into authority mode');
        this.name = 'AuthorityDeactivationRefused';
        this.code = 'P5D_DEACTIVATION_REFUSED';
        this.mode = mode;
    }
}

class AuthorityModeUnknownError extends Error {
    constructor(cause) {
        super('[P5-D] the liquidity regime could not be read, so the unit of SystemFiatPool is unknown. '
            + 'Refusing rather than assuming legacy USDC.');
        this.name = 'AuthorityModeUnknownError';
        this.code = 'AUTHORITY_MODE_UNKNOWN';
        this.cause = cause || null;
    }
}

function _dec(v) {
    if (v === null || v === undefined) return null;
    return typeof v.toString === 'function' ? Number(v.toString()) : Number(v);
}

/**
 * The current regime. `active` is the LATCHED answer: once true, always true.
 * @returns {Promise<{active:boolean, flagged:boolean, latched:boolean,
 *                    activatedAt:Date|null, authorityUnit:'GHS'|'USDC'}>}
 */
async function readMode(db) {
    // §WP-H: under the tri-state regime the answer comes from the protected
    // record and a positive enforcement inspection, and an unprovable state
    // REFUSES (typed AUTHORITY_STATE_UNAVAILABLE) instead of collapsing to
    // "legacy USDC". The default regime is unchanged; see docs/wp-h.
    if (require('./authorityState').enforcementMode() === 'tri_state') {
        const st = await require('./authorityState').requireAuthorityState(db);
        return {
            active: st.state === 'ENFORCED_ACTIVE',
            flagged: st.legacy ? st.legacy.flagged === true : false,
            latched: st.activation != null,
            activatedAt: st.activation ? st.activation.activatedAt : null,
            authorityUnit: st.unit,
            authorityState: st.state,
        };
    }
    // FAIL CLOSED. A failed read is an UNKNOWN regime, never "legacy USDC".
    // Swallowing the error here would silently reinterpret the GHS projection
    // as USDC — the exact defect this service exists to prevent. A MISSING row
    // is different from an UNREADABLE one: no singleton means default-off.
    let settings;
    let state;
    try {
        [settings, state] = await Promise.all([
            db.globalSettings.findUnique({ where: { id: 1 }, select: { fiatLiquidityAuthorityEnabled: true } }),
            db.fiatLiquidityState.findUnique({ where: { id: 1 }, select: { authorityActivatedAt: true } }),
        ]);
    } catch (err) {
        throw new AuthorityModeUnknownError(err);
    }
    const flagged = settings?.fiatLiquidityAuthorityEnabled === true;
    const activatedAt = state?.authorityActivatedAt || null;
    const latched = activatedAt != null;
    return {
        active: flagged || latched,
        flagged,
        latched,
        activatedAt,
        // The unit SystemFiatPool.balance is expressed in RIGHT NOW.
        authorityUnit: (flagged || latched) ? 'GHS' : 'USDC',
    };
}


/**
 * Mode AND pool balance from ONE statement, i.e. ONE MVCC snapshot.
 *
 * Every reader that publishes a balance must publish the unit it is counted in.
 * Reading the mode and the pool in two round trips lets an activation land in
 * between, which publishes a GHS projection labelled USDC (or the reverse).
 * While the authority is active the authoritative number is
 * FiatLiquidityState.availableGhs, not the SystemFiatPool projection.
 *
 * A failed read throws (fail closed) - it never degrades to "legacy USDC".
 *
 * @returns {Promise<{active:boolean, flagged:boolean, latched:boolean,
 *                    activatedAt:Date|null, currency:'GHS'|'USDC',
 *                    balance:Prisma.Decimal, source:string}>}
 */
async function readModeAndPool(db) {
    const rows = await db.$queryRawUnsafe(`
        SELECT
            COALESCE(g."fiatLiquidityAuthorityEnabled", false) AS flagged,
            s."authorityActivatedAt" AS "activatedAt",
            s."availableGhs"::text AS "availableGhs",
            p."balance"::text AS "projectionBalance"
          FROM (SELECT 1 AS "id") AS anchor
          LEFT JOIN "GlobalSettings" g ON g."id" = 1
          LEFT JOIN "FiatLiquidityState" s ON s."id" = 1
          LEFT JOIN "SystemFiatPool" p ON p."id" = 1`);
    const row = rows[0] || {};
    const flagged = row.flagged === true;
    const activatedAt = row.activatedAt || null;
    const latched = activatedAt != null;
    const active = flagged || latched;
    const balance = active
        ? new Prisma.Decimal(row.availableGhs ?? 0)
        : new Prisma.Decimal(row.projectionBalance ?? 0);
    return {
        active, flagged, latched, activatedAt,
        currency: active ? 'GHS' : 'USDC',
        authorityUnit: active ? 'GHS' : 'USDC',
        balance,
        source: active ? 'FiatLiquidityState.availableGhs' : 'SystemFiatPool.balance',
    };
}

/** Convenience predicate used by the money paths. */
async function isAuthorityModeActive(prisma) {
    // Under the tri-state regime this NEVER answers a bare false for an
    // unprovable state: it throws AUTHORITY_STATE_UNAVAILABLE, because `false`
    // downstream means "book as legacy USDC".
    return (await readMode(prisma)).active;
}

/**
 * Take the regime lock for the rest of this transaction. Money paths and the
 * activation sequence share it so a withdrawal can never commit under the old
 * mode while activation's preflight has already decided the old mode is safe.
 */
async function lockRegime(tx) {
    // §WP-H: the SAME key the tri-state module uses for its shared economic
    // lock. Activation is the exclusive side of one protocol, not a separate
    // lock universe; __tests__/wp-h-tristate-authority.pg.test.js asserts the
    // two constants stay identical.
    const { AUTHORITY_LOCK_KEY } = require('./authorityState');
    if (AUTHORITY_LOCK_KEY !== ACTIVATION_LOCK_KEY) {
        throw new Error('[WP-H] regime lock identity drift: activation and economic paths disagree');
    }
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', ACTIVATION_LOCK_KEY);
}

/** The shared side of the same protocol, for economic transactions. */
async function lockRegimeShared(tx) {
    const { lockAuthorityShared } = require('./authorityState');
    await lockAuthorityShared(tx);
}

/**
 * Audit of the rows whose regime would change meaning at activation.
 * Never mutates. Safe to call from an operator script or a test.
 */
async function activationPreflight(prisma) {
    const candidates = await prisma.$queryRawUnsafe(
        `SELECT w."id", w."status", w."payoutMethod", w."amount"::text AS "amountUsdc",
                w."transactionHistoryId"
           FROM "Withdrawal" w
          WHERE w."status" = ANY($1::text[])
            AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" <> 'GHS')
            AND (w."payoutMethod" ILIKE '%MOMO%'
                 OR w."payoutMethod" IN ('FIAT', 'MOBILE_MONEY', 'MTN_MOMO'))
            AND NOT EXISTS (
                SELECT 1
                  FROM "FiatLiquidityReservation" r
                  LEFT JOIN "TransactionHistory" t ON t."id" = w."transactionHistoryId"
                 WHERE (t."txHash" IS NOT NULL AND r."reference" = t."txHash")
                    OR (w."transactionHistoryId" IS NOT NULL AND r."relatedTransactionId" = w."transactionHistoryId")
            )
          ORDER BY w."id"`,
        BLOCKING_STATUSES
    );

    const parked = await prisma.$queryRawUnsafe(
        `SELECT w."id", w."status", w."payoutMethod", w."amount"::text AS "amountUsdc"
           FROM "Withdrawal" w
          WHERE w."status" = ANY($1::text[])
            AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" = 'USDC')
            AND (w."payoutMethod" ILIKE '%MOMO%'
                 OR w."payoutMethod" IN ('FIAT', 'MOBILE_MONEY', 'MTN_MOMO'))
          ORDER BY w."id"`,
        PARKED_STATUSES
    );

    // Canonical rows with a withdrawal transaction but no Withdrawal record and
    // no reservation: a PENDING canonical row is genuinely unresolved money.
    const orphanCanonical = await prisma.$queryRawUnsafe(
        `SELECT t."id", t."txHash", t."status"
           FROM "TransactionHistory" t
          WHERE t."type" = 'WITHDRAWAL_FIAT'
            AND t."status" NOT IN ('COMPLETED', 'FAILED')
            AND NOT EXISTS (SELECT 1 FROM "FiatLiquidityReservation" r WHERE r."reference" = t."txHash")
            AND NOT EXISTS (SELECT 1 FROM "Withdrawal" w WHERE w."transactionHistoryId" = t."id")
          ORDER BY t."id"`
    );

    const blockers = [];
    for (const row of candidates) {
        blockers.push({
            kind: 'LEGACY_WITHDRAWAL_UNRESERVED',
            withdrawalId: row.id,
            status: row.status,
            payoutMethod: row.payoutMethod,
            amountUsdc: _dec(row.amountUsdc),
        });
    }
    for (const row of orphanCanonical) {
        blockers.push({
            kind: 'CANONICAL_WITHDRAWAL_WITHOUT_RECORD',
            transactionId: row.id,
            txHash: row.txHash,
            status: row.status,
        });
    }

    return {
        ok: blockers.length === 0,
        blockers,
        advisories: parked.map((row) => ({
            kind: 'LEGACY_WITHDRAWAL_PARKED',
            withdrawalId: row.id,
            status: row.status,
            payoutMethod: row.payoutMethod,
            amountUsdc: _dec(row.amountUsdc),
        })),
        checked: {
            blockingStatuses: BLOCKING_STATUSES,
            parkedStatuses: PARKED_STATUSES,
            canonicalType: 'WITHDRAWAL_FIAT',
        },
    };
}

/**
 * Explicit activation. Refuses (and changes nothing) while the preflight finds
 * an unresolved legacy row. Sets the Boolean AND the one-way latch, so a later
 * Boolean change cannot reinterpret the GHS projection as USDC.
 */
async function activateAuthority(prisma, { actor = 'operator', reason = null } = {}) {
    return prisma.$transaction(async (tx) => {
        // Serialize concurrent activations: two operators must not race the
        // preflight-then-write sequence.
        await lockRegime(tx);

        const preflight = await activationPreflight(tx);
        if (!preflight.ok) throw new AuthorityActivationRefused(preflight);

        const existing = await tx.fiatLiquidityState.upsert({
            where: { id: 1 }, update: {}, create: { id: 1 },
        });
        if (!existing.authorityActivatedAt) {
            await tx.fiatLiquidityState.update({
                where: { id: 1 }, data: { authorityActivatedAt: new Date() },
            });
        }
        await tx.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: true },
            create: { id: 1, fiatLiquidityAuthorityEnabled: true },
        });

        // SYNCHRONIZE THE PROJECTION IN THE SAME TRANSACTION. Before activation
        // SystemFiatPool holds a legacy USDC figure; after it, readers treat the
        // value as GHS. Leaving the stale USDC number in place would publish a
        // USDC balance under a GHS label until the next liquidity operation
        // happened to rewrite it.
        const syncedState = await tx.fiatLiquidityState.findUnique({ where: { id: 1 } });
        const previousPool = await tx.systemFiatPool.findUnique({ where: { id: 1 } });
        await tx.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: new Prisma.Decimal(syncedState.availableGhs ?? 0) },
            create: { id: 1, balance: new Prisma.Decimal(syncedState.availableGhs ?? 0) },
        });

        // DURABLE ACTIVATION AUDIT EVIDENCE: who activated, why, and the
        // projection rewrite it caused.
        await tx.adminSettingsAuditLog.create({
            data: {
                adminId: Number.isInteger(actor) ? actor : 0,
                adminName: Number.isInteger(actor) ? null : String(actor || 'operator'),
                action: 'P5D_AUTHORITY_ACTIVATED',
                targetType: 'FIAT_LIQUIDITY_AUTHORITY',
                targetId: '1',
                changes: {
                    reason: reason == null ? null : String(reason),
                    latch: { old: existing.authorityActivatedAt || null, new: syncedState.authorityActivatedAt || null },
                    projection: {
                        unit: 'GHS',
                        previousBalance: previousPool ? String(previousPool.balance) : null,
                        projectedBalance: String(syncedState.availableGhs ?? 0),
                    },
                    preflight: { blockers: preflight.blockers.length, advisories: preflight.advisories.length },
                },
            },
        });

        const mode = await readMode(tx);
        return {
            ...mode,
            actor,
            reason,
            preflight,
            projection: {
                unit: 'GHS',
                balance: String(syncedState.availableGhs ?? 0),
                previousBalance: previousPool ? String(previousPool.balance) : null,
            },
        };
    });
}

/**
 * Deactivation is NOT a supported procedure once the latch is set: the
 * projection has been written in GHS and no code path can restore USDC
 * meaning. Throws rather than silently returning to a mixed regime.
 */
async function assertDeactivationAllowed(prisma) {
    const mode = await readMode(prisma);
    if (mode.latched) throw new AuthorityDeactivationRefused(mode);
    return mode;
}

module.exports = {
    ACTIVATION_LOCK_KEY,
    DISPATCH_ELIGIBLE_STATUSES,
    IN_FLIGHT_STATUSES,
    PARKED_STATUSES,
    BLOCKING_STATUSES,
    AuthorityActivationRefused,
    AuthorityDeactivationRefused,
    AuthorityModeUnknownError,
    readMode,
    readModeAndPool,
    isAuthorityModeActive,
    lockRegime,
    lockRegimeShared,
    activationPreflight,
    activateAuthority,
    assertDeactivationAllowed,
};
