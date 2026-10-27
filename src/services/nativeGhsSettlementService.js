/**
 * Native-GHS settlement authority (collections leg).
 * =========================================================================
 * OWNER INTENT (#369, 2026-10-27): Moolre collections are paid in GHS by
 * the customer. Today the settled GHS is CONVERTED at the transaction
 * quote and credited as USDC to `user.availableBalance` — the native-GHS
 * wallet (`user.nativeGhsBalance`) is never touched. This module is the
 * INTENDED native-GHS settlement integration: when (and only when) the
 * authority flag is enabled, a settled collection credits the customer's
 * native-GHS wallet in EXACT pesewas — GHS stays GHS, no conversion, no
 * quote repricing.
 *
 * AUTHORITY FLAG: `GlobalSettings.nativeGhsSettlementEnabled` (Boolean,
 * default FALSE). Installed by infra/install-native-ghs-settlement-overlay.js.
 *
 * HONEST NON-GOALS (owner constraints):
 *   • Existing USDC balances are NEVER reinterpreted: with the flag OFF
 *     the settlement path is byte-identical to the legacy behaviour
 *     (pinned by the existing r15/p5e/r271d suites).
 *   • Live provider behaviour NEVER changes: the provider rails, callbacks
 *     and evidence chain are untouched — only the destination of the
 *     customer credit differs when the flag is on.
 *   • The flag is MUTUALLY EXCLUSIVE with Model B USDC inventory
 *     settlement: a configuration enabling both fails CLOSED (the deposit
 *     stays PENDING and retryable rather than guessing which economics
 *     applies).
 *
 * DURABILITY PRIMITIVES (all proven by regression tests):
 *   • Idempotency — the settlement leg runs inside the caller's financial
 *     transaction; its ledger posting carries a unique idempotency key
 *     (`ledger:deposit:fiat-ghs:{ref}`) so a replay can never double-post.
 *     The deposit-level ONCE guarantee stays with the PENDING→COMPLETED
 *     CAS claim in moolreDepositSettlement.
 *   • Failure/reversal — `reverseNativeGhsSettlement` is a compensating
 *     entry with its OWN idempotency stamp (a conditional CAS on the
 *     settlement row's reversal marker): a reversal can never apply twice,
 *     never applies to a row that did not settle as GHS-native, and never
 *     touches USDC.
 *   • Reconciliation — `reconcileNativeGhsSettlements` detects COMPLETED
 *     GHS-native settlements whose authoritative ledger entry is missing
 *     and records a reconciliation exception (idempotently) for human
 *     resolution; it never mutates balances itself.
 */
'use strict';

const { Prisma } = require('@prisma/client');
const logger = require('../../src/config/logger');
const ledger = require('../../services/ledgerService');
const { recordReconciliationException } = require('../../services/reconciliationExceptionService');

const SETTLEMENT_CURRENCY = 'GHS_NATIVE';
const GHS_LEDGER_KEY_PREFIX = 'ledger:deposit:fiat-ghs:';
const REVERSAL_LEDGER_KEY_PREFIX = 'ledger:reversal:fiat-ghs:';

class NativeGhsSettlementError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'NativeGhsSettlementError';
        this.code = code || 'NATIVE_GHS_SETTLEMENT_ERROR';
    }
}

/**
 * The authority flag. Fail closed: any read error settles as DISABLED.
 */
async function isNativeGhsSettlementEnabled(db) {
    try {
        const settings = await db.globalSettings.findUnique({ where: { id: 1 } });
        return settings?.nativeGhsSettlementEnabled === true;
    } catch (err) {
        logger.error({ err: err && err.message }, '[nativeGhsSettlement] flag read failed — treating as disabled (fail closed)');
        return false;
    }
}

const _toExactGhsDecimal = (value, label) => {
    let d;
    try {
        d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    } catch {
        throw new NativeGhsSettlementError(`${label}: not a decimal value`, 'NATIVE_GHS_INVALID_AMOUNT');
    }
    if (!d.isFinite() || d.lte(0)) {
        throw new NativeGhsSettlementError(`${label}: must be a positive finite decimal`, 'NATIVE_GHS_INVALID_AMOUNT');
    }
    // EXACT pesewa authority: the native wallet is denominated at 2dp; a
    // sub-pesewa tail is never silently truncated into the credit.
    if (!d.equals(d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP))) {
        throw new NativeGhsSettlementError(`${label}: must be exact to the pesewa (2 decimal places)`, 'NATIVE_GHS_SUB_PESEWA');
    }
    return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
};

/**
 * The GHS-native collection settlement leg. Runs INSIDE the caller's
 * financial transaction, immediately after the PENDING→COMPLETED CAS claim
 * won — the same atomicity envelope as the legacy USDC credit it replaces.
 *
 * Credits the customer's native-GHS wallet in EXACT pesewas and posts the
 * §P.4 authoritative GHS entry (D fiat:momo:ghs asset, C ghs:user:{id}
 * liability). Never touches `availableBalance` (USDC).
 */
async function settleCollectionToNativeGhs(tx, {
    userId,
    amountGhs,
    reference,
    transactionHistoryId,
    quoteId,
    providerRef,
}) {
    if (!tx) throw new NativeGhsSettlementError('a transaction client is required');
    if (!Number.isInteger(userId)) throw new NativeGhsSettlementError('userId must be an integer');
    const settledGhs = _toExactGhsDecimal(amountGhs, 'amountGhs');
    if (!reference) throw new NativeGhsSettlementError('reference is required for the idempotent ledger posting');

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NativeGhsSettlementError(`user ${userId} not found`, 'NATIVE_GHS_USER_MISSING');

    // Native-GHS credit: EXACT pesewas, never a float.
    const updated = await tx.user.update({
        where: { id: userId },
        data: { nativeGhsBalance: { increment: settledGhs } },
    });

    // §P.4 authoritative accounting, same caller transaction: the collected
    // GHS is a MoMo float asset and a customer liability, in GHS units.
    await ledger.post(tx, {
        idempotencyKey: `${GHS_LEDGER_KEY_PREFIX}${reference}`,
        entryType: 'DEPOSIT',
        description: 'Fiat-settled native-GHS collection credited to the GHS wallet (Moolre settlement)',
        reference,
        userId,
        relatedEntity: 'transactionHistory',
        relatedEntityId: transactionHistoryId,
        metadata: {
            source: 'moolre',
            settlementCurrency: SETTLEMENT_CURRENCY,
            quoteId,
            providerRef: providerRef ?? null,
            amountGhs: settledGhs.toFixed(2),
        },
        lines: [
            { account: 'fiat:momo:ghs', debit: settledGhs },
            { account: `ghs:user:${userId}:liability`, credit: settledGhs },
        ],
    });

    return { settledGhs, newNativeGhsBalance: updated.nativeGhsBalance };
}

/**
 * Failure/reversal for a GHS-native settlement: a COMPENSATING entry that
 * returns the exact credited GHS. Once-only by construction:
 *   1. A conditional CAS stamp on the settlement row's reversal marker —
 *      a second reversal attempt (concurrent or replayed) matches ZERO
 *      rows and is refused.
 *   2. The reversal ledger posting carries its own idempotency key.
 * The reversal NEVER touches USDC (`availableBalance`) and NEVER applies to
 * a row that did not settle as GHS-native.
 */
async function reverseNativeGhsSettlement(tx, {
    userId,
    amountGhs,
    reference,
    transactionHistoryId,
    reversalReason,
}) {
    if (!tx) throw new NativeGhsSettlementError('a transaction client is required');
    const reversedGhs = _toExactGhsDecimal(amountGhs, 'amountGhs');
    if (!reference) throw new NativeGhsSettlementError('reference is required for the idempotent reversal');

    const row = await tx.transactionHistory.findUnique({
        where: { id: transactionHistoryId },
        select: { id: true, status: true, metadata: true },
    });
    if (!row) throw new NativeGhsSettlementError('settlement row not found', 'NATIVE_GHS_SETTLEMENT_MISSING');
    if (row.status !== 'COMPLETED') {
        throw new NativeGhsSettlementError('only a COMPLETED settlement can be reversed', 'NATIVE_GHS_NOT_SETTLED');
    }
    if (!row.metadata || row.metadata.settlementCurrency !== SETTLEMENT_CURRENCY) {
        throw new NativeGhsSettlementError('row did not settle as native GHS — refusing reversal', 'NATIVE_GHS_NOT_GHS_NATIVE');
    }
    if (row.metadata.nativeGhsReversal) {
        throw new NativeGhsSettlementError('settlement was already reversed', 'NATIVE_GHS_ALREADY_REVERSED');
    }

    // Once-only CAS stamp. Raw jsonb CAS because the guard must cover BOTH
    // a missing key and an explicit JSON null — Prisma's JSON `equals: null`
    // filter does not match absent keys, and a reversal authority must.
    // A concurrent or replayed reversal matches ZERO rows and is refused.
    const reversalMarker = {
        reversedGhs: reversedGhs.toFixed(2),
        reason: reversalReason || null,
        reversedAt: new Date().toISOString(),
        ledgerIdempotencyKey: `${REVERSAL_LEDGER_KEY_PREFIX}${reference}`,
    };
    const stamped = await tx.$executeRaw`
        UPDATE "TransactionHistory"
        SET "metadata" = jsonb_set("metadata"::jsonb, '{nativeGhsReversal}', ${JSON.stringify(reversalMarker)}::jsonb, true)
        WHERE "id" = ${transactionHistoryId}
          AND "status" = 'COMPLETED'
          AND ("metadata"::jsonb -> 'nativeGhsReversal') IS NULL`;
    if (stamped !== 1) {
        throw new NativeGhsSettlementError('settlement was already reversed (CAS lost)', 'NATIVE_GHS_ALREADY_REVERSED');
    }

    const updated = await tx.user.update({
        where: { id: userId },
        data: { nativeGhsBalance: { decrement: reversedGhs } },
    });

    // Compensating §P.4 entry: the customer liability and the float asset
    // both return the GHS.
    await ledger.post(tx, {
        idempotencyKey: `${REVERSAL_LEDGER_KEY_PREFIX}${reference}`,
        entryType: 'DEPOSIT',
        description: 'Native-GHS collection settlement reversed (compensating entry)',
        reference,
        userId,
        relatedEntity: 'transactionHistory',
        relatedEntityId: transactionHistoryId,
        metadata: {
            source: 'moolre',
            settlementCurrency: SETTLEMENT_CURRENCY,
            reversal: true,
            reason: reversalReason || null,
            amountGhs: reversedGhs.toFixed(2),
        },
        lines: [
            { account: `ghs:user:${userId}:liability`, debit: reversedGhs },
            { account: 'fiat:momo:ghs', credit: reversedGhs },
        ],
    });

    return { reversedGhs, newNativeGhsBalance: updated.nativeGhsBalance };
}

/**
 * Reconciliation sweep for GHS-native settlements. A COMPLETED settlement
 * row marked GHS-native whose authoritative ledger entry is missing is a
 * stranded settlement (a torn transaction that must not exist by
 * construction — this sweep is the honest detector). Records a
 * reconciliation exception PER ROW, idempotently, and NEVER mutates a
 * balance: a human resolves the exception; money is never auto-corrected.
 */
async function reconcileNativeGhsSettlements(prisma, { since } = {}) {
    const stranded = await prisma.transactionHistory.findMany({
        where: {
            status: 'COMPLETED',
            type: 'DEPOSIT_FIAT',
            metadata: { path: ['settlementCurrency'], equals: SETTLEMENT_CURRENCY },
            ...(since ? { createdAt: { gte: since } } : {}),
        },
        select: { id: true, txHash: true, userId: true, metadata: true },
        take: 500,
    });

    const flagged = [];
    for (const row of stranded) {
        // The exact identity the settlement leg built its ledger key from
        // (settlementExternalRef ≠ txHash when the provider carries its own
        // relatedReference). Legacy rows without the stamp fall back to
        // txHash — the Moolre default external reference.
        const settlementRef = row.metadata?.settlementExternalRef ?? row.txHash;
        const ledgerKey = `${GHS_LEDGER_KEY_PREFIX}${settlementRef}`;
        const posted = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: ledgerKey } });
        if (posted) continue;
        await recordReconciliationException(prisma, {
            entityType: 'TRANSACTION',
            entityId: settlementRef,
            reference: settlementRef,
            reason: 'NATIVE_GHS_SETTLEMENT_LEDGER_MISSING',
            details: {
                settlementCurrency: SETTLEMENT_CURRENCY,
                expectedLedgerIdempotencyKey: ledgerKey,
                settledAmountGhs: row.metadata?.settledAmountGhs ?? null,
                transactionHistoryId: row.id,
            },
        });
        flagged.push({ id: row.id, reference: settlementRef });
    }
    return { scanned: stranded.length, flagged: flagged.length, flaggedRows: flagged };
}

module.exports = {
    isNativeGhsSettlementEnabled,
    settleCollectionToNativeGhs,
    reverseNativeGhsSettlement,
    reconcileNativeGhsSettlements,
    NativeGhsSettlementError,
    SETTLEMENT_CURRENCY,
};
