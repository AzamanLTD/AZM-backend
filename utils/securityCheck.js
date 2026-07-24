// utils/securityCheck.js
// =============================================================================
// THE DOUBLE-CHECK UTILITY
// Mathematically proves: Sum(In) - Sum(Out) == user.availableBalance
// Any inconsistency throws a hard error and freezes the calling transaction.
// =============================================================================

const TOLERANCE = 0.000001; // Floating-point epsilon for USDC comparisons

/**
 * runDoubleCheck
 *
 * Scans the user's full TransactionHistory and recomputes their balance
 * from first principles. Positive amountUsdc = credit (IN), negative = debit (OUT).
 * feeUsdc is always a debit on top of the principal amount.
 *
 * Throws a descriptive error if the ledger is inconsistent so that any
 * enclosing prisma.$transaction block rolls back automatically.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @returns {Promise<true>} — resolves only when ledger is sound
 * @throws {Error}          — if user missing or balance does not reconcile
 */
const runDoubleCheck = async (prisma, userId) => {
    const parsedId = parseInt(userId, 10);
    if (isNaN(parsedId)) {
        throw new Error('[DoubleCheck] Invalid userId supplied to ledger audit.');
    }

    // Fetch user + full tx history in parallel for speed
    const [user, transactions] = await Promise.all([
        prisma.user.findUnique({
            where: { id: parsedId },
            select: { id: true, username: true, availableBalance: true }
        }),
        prisma.transactionHistory.findMany({
            where: { userId: parsedId },
            select: { id: true, amountUsdc: true, feeUsdc: true, type: true, status: true }
        })
    ]);

    if (!user) {
        throw new Error(`[DoubleCheck] User ${parsedId} not found — cannot audit ledger.`);
    }

    // Only count COMPLETED transactions in the audit. 
    // PENDING rows haven't settled; FROZEN_DISPUTE rows are quarantined.
    const settledTxs = transactions.filter(tx => tx.status === 'COMPLETED');

    // Recompute balance: principal + fees
    // amountUsdc is signed: positive for credits, negative for debits.
    // feeUsdc is always a non-negative cost deducted on top.
    const computedBalance = settledTxs.reduce((sum, tx) => {
        const principal = tx.amountUsdc   || 0;
        const fee       = tx.feeUsdc      || 0;
        return sum + principal - fee;
    }, 0);

    const storedBalance  = user.availableBalance || 0;
    const delta          = Math.abs(computedBalance - storedBalance);

    if (delta > TOLERANCE) {
        const msg = [
            `[DoubleCheck] LEDGER INCONSISTENCY DETECTED for user ${parsedId} (@${user.username}).`,
            `  Stored  availableBalance : ${storedBalance.toFixed(6)} USDC`,
            `  Computed from ${settledTxs.length} settled tx(s) : ${computedBalance.toFixed(6)} USDC`,
            `  Delta                    : ${delta.toFixed(6)} USDC  (tolerance: ${TOLERANCE})`,
            `  Total tx scanned         : ${transactions.length} (${transactions.length - settledTxs.length} non-settled excluded)`,
            `  Action                   : transaction FROZEN — flagged for manual review.`
        ].join('\n');

        logger.error(msg);
        throw new Error(msg);
    }

    return true; // ledger is sound
};

module.exports = { runDoubleCheck, TOLERANCE };
