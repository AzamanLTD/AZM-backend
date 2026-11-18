'use strict';

// Native-GHS wallet service (FX-balance workstream).
//
// Real GHS owed to the customer — a genuine ledger-backed liability account
// (ghs:user:{id}:liability, asset GHS), SEPARATE from the USDC wallet
// (user:{id}:liability, asset USDC). It is never a display conversion of
// availableBalance and never a reclassification of USDC funds.
//
// Accounting design (mirror of the USDC wallet's established pattern):
//
//   FUNDING (customer hands the platform GHS — e.g. a Moolre/mobile-money
//   GHS deposit destined for the native GHS wallet):
//     DR fiat:momo:ghs            (GHS custody asset — real GHS received)
//     CR ghs:user:{id}:liability  (GHS owed to the customer)
//
//   WITHDRAWAL (customer takes native GHS out, e.g. mobile-money payout):
//     DR ghs:user:{id}:liability
//     CR fiat:momo:ghs
//
// The User.nativeGhsBalance column is the PROJECTION of the liability
// account, updated inside the SAME caller-owned transaction as the ledger
// posting, guarded by an exact compare-and-set so concurrent movements can
// never overdraw. All amounts are exact Prisma Decimals (Decimal(20,8)); JS
// floats are never an input to authoritative economics.
//
// INTEGRATION BOUNDARY (deliberate, for lead review): the established
// Moolre deposit/withdrawal flows convert GHS⇄USDC at the rail and settle
// into the USDC wallet. Their meaning is NOT silently changed by this PR.
// The routes that move REAL native GHS in/out of this wallet are a follow-up
// settlement wave (see docs/native-ghs-fx-audit.md §Moolre); these service
// primitives are the audited building blocks, exercised today by the demo
// seeder, tests, and the balance-valuation read model. No existing endpoint
// mutates nativeGhsBalance.

const { Prisma } = require('@prisma/client');
const logger = require('../config/logger');
const ledger = require('../../services/ledgerService');

const GHS_WALLET_CODE = (userId) => `ghs:user:${userId}:liability`;
const GHS_CUSTODY_ACCOUNT = 'fiat:momo:ghs';

class GhsWalletError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'GhsWalletError';
        this.code = code;
        this.details = details;
    }
}

function _toExactDecimal(value, label) {
    try {
        const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
        if (!d.isFinite() || !d.greaterThan(0)) {
            throw new Error('not positive finite');
        }
        return d;
    } catch (_) {
        throw new GhsWalletError(
            'GHS_INVALID_AMOUNT',
            `${label} must be a positive finite decimal (GHS), got: ${String(value)}`
        );
    }
}

function _commonPostFields({ userId, reference, relatedEntity, relatedEntityId, metadata }) {
    return {
        userId,
        ...(reference ? { reference } : {}),
        ...(relatedEntity ? { relatedEntity } : {}),
        ...(relatedEntityId ? { relatedEntityId } : {}),
        ...(metadata ? { metadata } : {}),
    };
}

/**
 * Credit the customer's native-GHS wallet (funding). MUST run inside a
 * CALLER-OWNED Prisma transaction — the ledger posting and the
 * User.nativeGhsBalance projection commit (or roll back) atomically.
 *
 * Idempotent: the ledger's idempotencyKey rejects a duplicate posting of the
 * same logical movement (the ledger raises LEDGER_IDEMPOTENCY_CONFLICT), so
 * a retried funding can never double-credit.
 */
async function creditNativeGhs({
    tx,
    userId,
    amountGhs,
    idempotencyKey,
    description,
    reference,
    relatedEntity,
    relatedEntityId,
    metadata,
}) {
    if (!tx) throw new GhsWalletError('GHS_TX_REQUIRED', 'creditNativeGhs requires the caller-owned transaction client');
    const exact = _toExactDecimal(amountGhs, 'amountGhs');

    // Balanced double entry: GHS custody asset ⇄ customer GHS liability.
    // On an EXACT idempotent replay the ledger converges (replayed: true)
    // and the projection MUST NOT be re-applied — the movement already
    // happened. Any other duplicate identity throws (no partial state).
    const posted = await ledger.post(tx, {
        idempotencyKey,
        entryType: 'DEPOSIT',
        description: description || 'Native GHS wallet funding',
        lines: [
            { account: GHS_CUSTODY_ACCOUNT, debit: exact },
            { account: GHS_WALLET_CODE(userId), credit: exact },
        ],
        ..._commonPostFields({ userId, reference, relatedEntity, relatedEntityId, metadata }),
    });
    const replayed = posted?.replayed === true;

    // Projection bump inside the same transaction — ONLY for a genuine new
    // commit. increment is safe for credits (no floor to guard), and a
    // rolled-back transaction restores both the posting and the projection
    // atomically.
    const user = await (replayed
        ? tx.user.findUnique({ where: { id: userId }, select: { nativeGhsBalance: true } })
        : tx.user.update({
            where: { id: userId },
            data: { nativeGhsBalance: { increment: exact } },
            select: { nativeGhsBalance: true },
        }));

    return {
        userId,
        amountGhsExact: exact,
        nativeGhsBalanceExact: new Prisma.Decimal(user.nativeGhsBalance),
        replayed,
    };
}

/**
 * Debit the customer's native-GHS wallet (withdrawal/payout). MUST run
 * inside a CALLER-OWNED transaction. Compare-and-set guarded: the debit only
 * applies when the persisted projection still covers the exact amount; a
 * concurrent conflicting movement makes the update match ZERO rows and the
 * whole caller transaction must roll back (no partial debit, no ledger
 * residue — both live in the same transaction).
 */
async function debitNativeGhs({
    tx,
    userId,
    amountGhs,
    idempotencyKey,
    description,
    reference,
    relatedEntity,
    relatedEntityId,
    metadata,
}) {
    if (!tx) throw new GhsWalletError('GHS_TX_REQUIRED', 'debitNativeGhs requires the caller-owned transaction client');
    const exact = _toExactDecimal(amountGhs, 'amountGhs');

    // EXACT idempotent replay FIRST: the ledger is the movement authority,
    // and a replayed posting must not re-debit the projection either. The
    // replay check needs the same posting hash the ledger computes, so we
    // look for the already-committed identity before touching any money —
    // a cheaper pre-read that is authoritative ONLY because the ledger's
    // own findUnique(+hash compare) inside post() remains the gate the new
    // path flows through.
    const prior = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } });
    if (prior) {
        // Let the ledger validate the posting hash matches (a conflicting
        // reuse throws LEDGER_IDEMPOTENCY_CONFLICT); on convergence the
        // projection is untouched.
        const replayedPost = await ledger.post(tx, {
            idempotencyKey,
            entryType: 'WITHDRAWAL',
            description: description || 'Native GHS wallet withdrawal',
            lines: [
                { account: GHS_WALLET_CODE(userId), debit: exact },
                { account: GHS_CUSTODY_ACCOUNT, credit: exact },
            ],
            ..._commonPostFields({ userId, reference, relatedEntity, relatedEntityId, metadata }),
        });
        const userRow = await tx.user.findUnique({
            where: { id: userId },
            select: { nativeGhsBalance: true },
        });
        return {
            userId,
            amountGhsExact: exact,
            nativeGhsBalanceExact: new Prisma.Decimal(userRow.nativeGhsBalance),
            replayed: replayedPost?.replayed === true,
        };
    }

    // CAS floor guard on the projection FIRST (inside the same tx): the
    // where-clause enforces nativeGhsBalance >= exact at UPDATE time, so a
    // racing movement between read and update can never overdraw.
    const debited = await tx.user.updateMany({
        where: { id: userId, nativeGhsBalance: { gte: exact } },
        data: { nativeGhsBalance: { decrement: exact } },
    });
    if (debited.count !== 1) {
        throw new GhsWalletError(
            'GHS_INSUFFICIENT_BALANCE',
            'Insufficient native GHS balance — the withdrawal was not applied and no ledger posting was made'
        );
    }

    await ledger.post(tx, {
        idempotencyKey,
        entryType: 'WITHDRAWAL',
        description: description || 'Native GHS wallet withdrawal',
        lines: [
            { account: GHS_WALLET_CODE(userId), debit: exact },
            { account: GHS_CUSTODY_ACCOUNT, credit: exact },
        ],
        ..._commonPostFields({ userId, reference, relatedEntity, relatedEntityId, metadata }),
    });

    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { nativeGhsBalance: true },
    });

    return {
        userId,
        amountGhsExact: exact,
        nativeGhsBalanceExact: new Prisma.Decimal(user.nativeGhsBalance),
        replayed: false,
    };
}

/**
 * Read-side reconciliation: the persisted projection must equal the ledger
 * liability account balance. Returns both sides + exact residual; a
 * non-zero residual is a bookkeeping defect to alert on, never something to
 * silently patch.
 */
async function ghsWalletReconciliation({ db, userId }) {
    if (!db) throw new GhsWalletError('GHS_DB_REQUIRED', 'ghsWalletReconciliation requires a Prisma client');
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { nativeGhsBalance: true },
    });
    if (!user) throw new GhsWalletError('GHS_USER_NOT_FOUND', `user ${userId} not found`);

    const liability = await ledger.accountBalance(db, GHS_WALLET_CODE(userId));
    const projection = new Prisma.Decimal(user.nativeGhsBalance);
    const residual = new Prisma.Decimal(liability.balance).minus(projection);

    return {
        userId,
        projectionExact: projection,
        ledgerLiabilityExact: new Prisma.Decimal(liability.balance),
        residualExact: residual,
        reconciled: residual.isZero(),
    };
}

module.exports = {
    GhsWalletError,
    creditNativeGhs,
    debitNativeGhs,
    ghsWalletReconciliation,
    GHS_WALLET_CODE,
    GHS_CUSTODY_ACCOUNT,
};
