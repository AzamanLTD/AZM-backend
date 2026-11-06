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

function _dec(v) {
    if (v === null || v === undefined) return null;
    return typeof v.toString === 'function' ? Number(v.toString()) : Number(v);
}

/**
 * The current regime. `active` is the LATCHED answer: once true, always true.
 * @returns {Promise<{active:boolean, flagged:boolean, latched:boolean,
 *                    activatedAt:Date|null, authorityUnit:'GHS'|'USDC'}>}
 */
async function readMode(prisma) {
    const [settings, state] = await Promise.all([
        prisma.globalSettings.findUnique({ where: { id: 1 }, select: { fiatLiquidityAuthorityEnabled: true } }).catch(() => null),
        prisma.fiatLiquidityState.findUnique({ where: { id: 1 }, select: { authorityActivatedAt: true } }).catch(() => null),
    ]);
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

/** Convenience predicate used by the money paths. */
async function isAuthorityModeActive(prisma) {
    return (await readMode(prisma)).active;
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
            AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" = 'USDC')
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
            AND t."status" = 'PENDING'
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
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', ACTIVATION_LOCK_KEY);

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

        const mode = await readMode(tx);
        return { ...mode, actor, reason, preflight };
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
    readMode,
    isAuthorityModeActive,
    activationPreflight,
    activateAuthority,
    assertDeactivationAllowed,
};
