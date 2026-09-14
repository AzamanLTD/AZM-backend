// services/escrowService.js
// =============================================================================
// AZAMAN — SMART ESCROW SERVICE (2026-06-14)
//
// The financial heart of the Smart Escrow Engine. Pure I/O service — no
// req/res. Every multi-step balance mutation is wrapped in prisma.$transaction
// for ACID safety, mirroring services/finance.service.js and
// services/p2p.service.js exactly.
//
// Ledger conventions (confirmed against finance.service.js / p2p.service.js):
//   • Balances move via { increment } / { decrement } inside $transaction.
//   • TransactionHistory rows store amountUsdc and feeUsdc as POSITIVE values;
//     the row `type` documents direction.
//   • AdminProfitLog uses { amountUsdc, source, relatedTxId } — there is NO
//     `notes` column on AdminProfitLog (the spec example was illustrative).
//   • runDoubleCheck(prisma, userId) is the pre-flight ledger audit run BEFORE
//     any debit, exactly as processFiatWithdrawal does.
//
// Funds flow (shares escrowLockedBalance/disputeEscrowBalance columns with the
// P2P flow, but is entirely separate code — the P2P trade flow is untouched):
//   FUND    payer.availableBalance    -> payer.escrowLockedBalance (+ fee -> SystemProfitFees)
//   RELEASE payer.escrowLockedBalance -> payee.availableBalance
//   DISPUTE payer.escrowLockedBalance -> payer.disputeEscrowBalance
//   REFUND  payer.{escrowLocked|disputeEscrow}Balance -> payer.availableBalance
// =============================================================================

const logger = require('../src/config/logger');
const { randomUUID } = require('crypto');
const { runDoubleCheck } = require('../utils/securityCheck');

// Socket.IO is wired once at bootstrap by src/sockets/socketServices.js.
// Refund convergence is emitted from this canonical financial mutation so all
// refund entry points share exactly one post-commit event producer.
let _socketIo = null;
const setSocketIO = (io) => {
    _socketIo = io || null;
};

// Lazy-require to avoid circular dependency: escrowService <-> businessOrderService.
// Do NOT change this to a top-level require().
let _bizOrderService = null;
const _getBizOrderService = () => {
    if (!_bizOrderService) _bizOrderService = require('./businessOrderService');
    return _bizOrderService;
};

// Owner-facing notification feed. Lazy-required for symmetry with the above and
// to keep the financial core free of optional dependencies at load time.
// notifyOrderEvent is a no-op for peer-to-peer (non-business) escrows.
let _bizNotificationService = null;
const _getBizNotificationService = () => {
    if (!_bizNotificationService) _bizNotificationService = require('./bizNotificationService');
    return _bizNotificationService;
};

// ── Module constants ─────────────────────────────────────────────────────────
const SMART_ESCROW_FEE_PCT_DEFAULT = 0.005; // 0.5% — fallback if GlobalSettings missing
const DRAFT_EXPIRY_HOURS = 24; // unfunded escrows expire after 24h
const FUNDED_EXPIRY_DAYS = 30; // funded but inactive escrows expire after 30d

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Lazy-upsert the SystemProfitFees singleton (id = 1). Mirrors finance.service. */
const _ensureProfitFeesSingleton = async (tx) =>
    tx.systemProfitFees.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, balance: 0.0 }
    });

/** Round to 6 dp using the same convention as the rest of the finance layer. */
const _round6 = (n) => parseFloat(Number(n).toFixed(6));

// =============================================================================
// 1. CREATE ESCROW — DRAFT state, no money moves.
//    Called by ticketController when an ESCROW-type ticket is created.
// =============================================================================
const createEscrow = async (prisma, { ticketId, payerId, payeeId, amountUsdc, deliveryTerms, dueDate }) => {
    if (!ticketId) throw new Error('ticketId is required.');
    if (!payerId || !payeeId) throw new Error('payerId and payeeId are required.');
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('amountUsdc must be a positive number.');
    }
    if (payerId === payeeId) throw new Error('Payer and payee cannot be the same user.');

    // 1. No SmartEscrow may already exist for this ticket (unique constraint).
    const existing = await prisma.smartEscrow.findUnique({ where: { ticketId } });
    if (existing) throw new Error('An escrow already exists for this ticket.');

    // 2. Resolve the fee pct from GlobalSettings (fallback to constant).
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const feePct = settings && settings.smartEscrowFeePct != null
        ? Number(settings.smartEscrowFeePct)
        : SMART_ESCROW_FEE_PCT_DEFAULT;
    const draftExpiryHours = settings && settings.escrowDraftExpiryHours != null
        ? Number(settings.escrowDraftExpiryHours)
        : DRAFT_EXPIRY_HOURS;

    // 3. Fee on the principal.
    const feeUsdc = _round6(amount * feePct);

    // 4. DRAFT expiry window.
    const expiresAt = new Date(Date.now() + draftExpiryHours * HOUR_MS);

    // 5. Create (no balance mutation → no $transaction needed).
    const escrow = await prisma.smartEscrow.create({
        data: {
            ticketId,
            payerId,
            payeeId,
            amountUsdc: amount,
            feeUsdc,
            status: 'DRAFT',
            deliveryTerms: deliveryTerms || null,
            dueDate: dueDate || null,
            expiresAt
        }
    });

    return escrow;
};

// =============================================================================
// 2. FUND ESCROW — payer locks USDC. The critical financial step.
// =============================================================================
const fundEscrow = async (prisma, { escrowId, payerId }) => {
    const escrow = await prisma.smartEscrow.findUnique({
        where: { id: escrowId },
        include: { ticket: true }
    });
    if (!escrow) throw new Error('Escrow not found.');
    if (escrow.status !== 'DRAFT') {
        throw new Error(`Escrow cannot be funded from status ${escrow.status}.`);
    }
    if (escrow.payerId !== payerId) {
        throw new Error('Only the payer can fund this escrow.');
    }

    // Pre-flight ledger audit (read-only, outside the tx) — same as withdrawal.
    await runDoubleCheck(prisma, payerId);

    const amount = Number(escrow.amountUsdc);
    const fee = Number(escrow.feeUsdc);
    const total = _round6(amount + fee);

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const fundedExpiryDays = settings && settings.escrowFundedExpiryDays != null
        ? Number(settings.escrowFundedExpiryDays)
        : FUNDED_EXPIRY_DAYS;

    const reference = randomUUID();

    const updatedEscrow = await prisma.$transaction(async (tx) => {
        const payer = await tx.user.findUnique({
            where: { id: payerId },
            select: { availableBalance: true }
        });
        if (!payer) throw new Error('Payer not found.');
        if (Number(payer.availableBalance) < total) {
            throw new Error(
                `Insufficient balance. Required: ${total} USDC (amount + fee), ` +
                `available: ${Number(payer.availableBalance).toFixed(6)} USDC.`
            );
        }

        // a. Debit payer available balance (principal + fee).
        await tx.user.update({
            where: { id: payerId },
            data: { availableBalance: { decrement: total } }
        });

        // b. Lock the principal (fee is NOT locked — it is platform revenue).
        await tx.user.update({
            where: { id: payerId },
            data: { escrowLockedBalance: { increment: amount } }
        });

        // c. Route the fee into SystemProfitFees.
        await _ensureProfitFeesSingleton(tx);
        await tx.systemProfitFees.update({
            where: { id: 1 },
            data: { balance: { increment: fee } }
        });

        // d. Flip escrow → FUNDED with the 30d inactivity window.
        const updated = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: {
                status: 'FUNDED',
                fundedAt: new Date(),
                expiresAt: new Date(Date.now() + fundedExpiryDays * DAY_MS),
                fundTxHash: reference
            }
        });

        // e. Canonical TransactionHistory row (payer debit).
        await tx.transactionHistory.create({
            data: {
                userId: payerId,
                type: 'TICKET_ESCROW_FUND',
                // amountUsdc is NEGATIVE: debit (OUT) convention per runDoubleCheck.
                // feeUsdc is always POSITIVE (a cost).
                amountUsdc: -amount,
                feeUsdc: fee,
                txHash: reference,
                status: 'COMPLETED'
            }
        });

        // f. AdminProfitLog audit row for the fee (relatedTxId, not notes).
        if (fee > 0) {
            await tx.adminProfitLog.create({
                data: {
                    amountUsdc: fee,
                    source: 'SMART_ESCROW_FEE',
                    relatedTxId: `escrow_fee_${escrow.ticketId}_${reference}`
                }
            });
        }

        return updated;
    });

    setImmediate(() => {
        _getBizOrderService()
            .updateOrderStatusFromEscrow(prisma, escrowId, 'FUNDED')
            .catch((err) => logger.error({ err: err }, '[escrowService.fundEscrow] order sync'));
    });

    // Owner-facing feed: the buyer has funded the escrow.
    setImmediate(() => {
        _getBizNotificationService().notifyOrderEvent(prisma, {
            escrowId,
            type: 'ORDER_FUNDED'
        }).catch((err) => logger.error({ err: err }, '[escrowService.fundEscrow] biz notif'));
    });


    // Realtime convergence: emit only after the $transaction commits.
    if (_socketIo) {
        const payload = {
            escrowId: updatedEscrow.id,
            ticketId: updatedEscrow.ticketId,
            status: updatedEscrow.status,
            amountUsdc: updatedEscrow.amountUsdc,
            payerId: updatedEscrow.payerId,
            payeeId: updatedEscrow.payeeId,
            fundedAt: updatedEscrow.fundedAt,
        };
        try {
            _socketIo.to(`user_${updatedEscrow.payerId}`).emit('escrow_funded', payload);
            _socketIo.to(`user_${updatedEscrow.payeeId}`).emit('escrow_funded', payload);
            _socketIo.to('admin_spy_room').emit('escrow_funded', payload);
        } catch (err) {
            logger.warn({ err, escrowId: updatedEscrow.id }, '[escrowService.fundEscrow] realtime emit failed');
        }
    }

    return { success: true, escrow: updatedEscrow, reference };
};

// =============================================================================
// 3. MARK SATISFIED — a party signals completion. Both true → auto-settle.
// =============================================================================
const markSatisfied = async (prisma, { escrowId, userId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    if (escrow.status === 'SETTLED') {
        // Idempotent convergence: another request may have committed settlement
        // before this retry reached the service. Never run settlement again.
        return { settled: true, alreadySettled: true, escrow };
    }
    if (!['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
        throw new Error(`Cannot mark satisfied from status ${escrow.status}.`);
    }
    if (escrow.payerId !== userId && escrow.payeeId !== userId) {
        throw new Error('Only a participant can mark this escrow satisfied.');
    }

    const isPayer = escrow.payerId === userId;
    const data = isPayer ? { payerSatisfied: true } : { payeeSatisfied: true };

    // TOCTOU guard: claim this party's satisfaction flag with a conditional
    // update so two concurrent markSatisfied calls for the SAME party cannot
    // both "win" (the loser sees count=0 and bails). Combined with the
    // single-winner claim inside _releaseEscrow, this makes double-settlement
    // (and therefore double-payout) impossible even under concurrent calls
    // from both parties at once. Mirrors the completeTrade atomic-flip pattern.
    const guard = isPayer ? { payerSatisfied: false } : { payeeSatisfied: false };
    const claimed = await prisma.smartEscrow.updateMany({
        where: { id: escrowId, ...guard },
        data
    });
    if (claimed.count === 0) {
        const current = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        if (current && current.status === 'SETTLED') {
            return { settled: true, alreadySettled: true, escrow: current };
        }
        throw new Error('You have already marked this escrow as satisfied.');
    }
    const updated = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });

    // Both satisfied → release to payee (SETTLED). _releaseEscrow fires
    // ORDER_SETTLED itself, so we do NOT also fire ORDER_SATISFIED here.
    if (updated.payerSatisfied && updated.payeeSatisfied) {
        try {
            const settled = await _releaseEscrow(prisma, escrowId, 'SETTLED');
            return { settled: true, escrow: settled };
        } catch (err) {
            if (err && err.message === 'ESCROW_ALREADY_FINALIZED') {
                const current = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
                if (current && current.status === 'SETTLED') {
                    return { settled: true, alreadySettled: true, escrow: current };
                }
            }
            throw err;
        }
    }

    // Buyer (payer) signalled completion but the owner hasn't confirmed yet —
    // surface it on the owner-facing feed. (Owner marking their own side needs
    // no notification.)
    if (escrow.payerId === userId) {
        setImmediate(() => {
            _getBizNotificationService().notifyOrderEvent(prisma, {
                escrowId,
                type: 'ORDER_SATISFIED'
            }).catch((err) => logger.error({ err: err }, '[escrowService.markSatisfied] biz notif'));
        });
    }

    // Otherwise mark we are awaiting the other side.
    try {
        const pending = await prisma.smartEscrow.update({
            where: { id: escrowId },
            data: { status: 'PENDING_SETTLEMENT' }
        });
        // Realtime convergence: emit only after the PENDING_SETTLEMENT update commits.
        if (_socketIo) {
            const payload = {
                escrowId: pending.id,
                ticketId: pending.ticketId,
                status: pending.status,
                amountUsdc: pending.amountUsdc,
                payerId: pending.payerId,
                payeeId: pending.payeeId,
            };
            try {
                _socketIo.to(`user_${pending.payerId}`).emit('escrow_pending_settlement', payload);
                _socketIo.to(`user_${pending.payeeId}`).emit('escrow_pending_settlement', payload);
                _socketIo.to('admin_spy_room').emit('escrow_pending_settlement', payload);
            } catch (err) {
                logger.warn({ err, escrowId: pending.id }, '[escrowService.markSatisfied] realtime emit failed');
            }
        }

        return { settled: false, escrow: pending };
    } catch (err) {
        // A concurrent opposite-party request can settle between the read above
        // and this pending-state write. The database terminal-state guard must
        // remain intact; converge to the committed settlement instead of turning
        // a successful concurrent settlement into a misleading 500.
        const current = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        if (current && current.status === 'SETTLED') {
            return { settled: true, alreadySettled: true, escrow: current };
        }
        throw err;
    }
};

// =============================================================================
// 4. RAISE DISPUTE — moves principal into disputeEscrowBalance, opens dispute.
// =============================================================================
const raiseDispute = async (prisma, { escrowId, raisedById, reason, evidenceUrls }) => {
    const result = await prisma.$transaction(async (tx) => {
        // Authoritative read — INSIDE the transaction that claims the escrow,
        // so the authorization decision is made against the row this
        // transaction will mutate (no TOCTOU window between check and claim).
        const escrow = await tx.smartEscrow.findUnique({
            where: { id: escrowId },
            include: { dispute: true }
        });
        if (!escrow) throw new Error('Escrow not found.');
        if (escrow.dispute) throw new Error('ESCROW_ALREADY_DISPUTED');
        if (!['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
            throw new Error(`Cannot dispute an escrow in status ${escrow.status}.`);
        }
        if (escrow.payerId !== raisedById && escrow.payeeId !== raisedById) {
            throw new Error('Only a participant can dispute this escrow.');
        }

        const amount = Number(escrow.amountUsdc);

        /*
         * SINGLE-WINNER DISPUTE CLAIM.
         *
         * Two concurrent requests may both have read FUNDED above, but only
         * one can atomically transition FUNDED/IN_PROGRESS/PENDING_SETTLEMENT
         * -> DISPUTED. The loser fails before touching balances or inserting
         * a dispute row.
         */
        const claimed = await tx.smartEscrow.updateMany({
            where: {
                id: escrowId,
                status: { in: ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'] }
            },
            data: { status: 'DISPUTED' }
        });
        if (claimed.count === 0) {
            const current = await tx.smartEscrow.findUnique({
                where: { id: escrowId },
                include: { dispute: true }
            });
            if (current && current.dispute && ['DISPUTED', 'ADMIN_REVIEW'].includes(current.status)) {
                throw new Error('ESCROW_ALREADY_DISPUTED');
            }
            if (current) {
                throw new Error(`Cannot dispute an escrow in status ${current.status}.`);
            }
            throw new Error('Escrow not found.');
        }

        // Move the locked principal into the dispute bucket on the payer —
        // atomically guarded (escrowLockedBalance >= amount) so a bucket can
        // never go negative, even on a checkless database. The claim above
        // already guarantees single-winner for this escrow; the guard makes
        // the bucket invariant a database-level property of the statement.
        const moved = await tx.user.updateMany({
            where: {
                id: escrow.payerId,
                escrowLockedBalance: { gte: amount }
            },
            data: {
                escrowLockedBalance: { decrement: amount },
                disputeEscrowBalance: { increment: amount }
            }
        });
        if (moved.count === 0) {
            throw new Error(
                `ESCROW_BUCKET_INSUFFICIENT: payer escrowLockedBalance is short of the ${amount} USDC principal.`
            );
        }

        // EscrowDispute.escrowId is UNIQUE in Prisma/Postgres — the final
        // database-level one-dispute-per-escrow backstop. A collision here
        // (theoretically unreachable past the claim above) rolls the whole
        // transaction back, including the balance move and the DISPUTED flip.
        const dispute = await tx.escrowDispute.create({
            data: {
                escrowId,
                raisedById,
                reason,
                evidenceUrls: evidenceUrls || []
            }
        });

        const updated = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        return { escrow: updated, dispute };
    });

    // EVERYTHING BELOW IS POST-COMMIT.
    setImmediate(() => {
        _getBizOrderService()
            .updateOrderStatusFromEscrow(prisma, escrowId, 'DISPUTED')
            .catch((err) => logger.error({ err: err }, '[escrowService.raiseDispute] order sync'));
    });

    // Owner-facing feed: a dispute was opened on this order.
    setImmediate(() => {
        _getBizNotificationService().notifyOrderEvent(prisma, {
            escrowId,
            type: 'ORDER_DISPUTED',
            extraMetadata: { disputeId: result.dispute?.id, raisedById }
        }).catch((err) => logger.error({ err: err }, '[escrowService.raiseDispute] biz notif'));
    });

    return result;
};

// =============================================================================
// 5. RESOLVE DISPUTE — admin/worker ruling. Handles all three outcomes.
// =============================================================================
const resolveDispute = async (prisma, { escrowId, adminId, ruling, rulingNotes, payerPct, payeePct }) => {
    if (!['FULL_RELEASE', 'FULL_REFUND', 'SPLIT'].includes(ruling)) {
        throw new Error('ruling must be FULL_RELEASE, FULL_REFUND, or SPLIT.');
    }
    if (ruling === 'SPLIT') {
        const pPct = Number(payerPct);
        const qPct = Number(payeePct);
        if (!Number.isFinite(pPct) || !Number.isFinite(qPct) || Math.abs(pPct + qPct - 100) > 0.001) {
            throw new Error('For SPLIT rulings, payerPct + payeePct must equal 100.');
        }
        if (pPct < 0 || qPct < 0 || pPct > 100 || qPct > 100) {
            throw new Error('For SPLIT rulings, payerPct and payeePct must be between 0 and 100.');
        }
    }

    /*
     * The dispute transition and every financial mutation share ONE
     * transaction. Previously _releaseEscrow/_refundEscrow each opened their
     * OWN transaction and the dispute flip ran after that commit — a failure
     * in the dispute update left committed money movement with an unresolved
     * dispute, and two concurrent resolutions could both pay out. Now:
     * a failed dispute update rolls the money back, and the escrow status
     * claim inside the same transaction guarantees a single financial winner.
     */
    const result = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({
            where: { id: escrowId },
            include: { dispute: true }
        });
        if (!escrow) throw new Error('Escrow not found.');
        if (!escrow.dispute) throw new Error('No dispute exists for this escrow.');

        /*
         * IDEMPOTENT CONVERGENCE (sequential replay): a retry AFTER a
         * successfully committed resolution returns the already-committed
         * canonical state and never moves money again.
         */
        if (['RELEASED', 'REFUNDED'].includes(escrow.status) && escrow.dispute.status === 'RESOLVED') {
            return { escrow, dispute: escrow.dispute, alreadyResolved: true };
        }
        if (!['DISPUTED', 'ADMIN_REVIEW'].includes(escrow.status)) {
            throw new Error(`Escrow is not in a resolvable state (status ${escrow.status}).`);
        }

        const resolvedAt = new Date();

        if (ruling === 'FULL_RELEASE') {
            // _releaseEscrowTx performs the atomic escrow claim, the
            // disputeEscrowBalance debit, the payee credit and the
            // transaction-history row — ALL on this same tx client.
            const updatedEscrow = await _releaseEscrowTx(tx, escrow, 'RELEASED');
            const updatedDispute = await tx.escrowDispute.update({
                where: { id: escrow.dispute.id, status: { not: 'RESOLVED' } },
                data: {
                    ruling: 'FULL_RELEASE',
                    rulingNotes: rulingNotes || null,
                    resolvedAt,
                    status: 'RESOLVED',
                    assignedToId: escrow.dispute.assignedToId || adminId
                }
            });
            return { escrow: updatedEscrow, dispute: updatedDispute };
        }

        if (ruling === 'FULL_REFUND') {
            const updatedEscrow = await _refundEscrowTx(tx, escrow, 'REFUNDED');
            const updatedDispute = await tx.escrowDispute.update({
                where: { id: escrow.dispute.id, status: { not: 'RESOLVED' } },
                data: {
                    ruling: 'FULL_REFUND',
                    rulingNotes: rulingNotes || null,
                    resolvedAt,
                    status: 'RESOLVED',
                    assignedToId: escrow.dispute.assignedToId || adminId
                }
            });
            return { escrow: updatedEscrow, dispute: updatedDispute };
        }

        // SPLIT — claim RELEASED first, inside this same transaction, so a
        // concurrent resolver cannot interleave balance mutations with us.
        const pPct = Number(payerPct);
        const qPct = Number(payeePct);
        const amount = Number(escrow.amountUsdc);
        const payerAmount = _round6(amount * (pPct / 100));
        // Give the payee the remainder so the two always sum to the principal
        // exactly (no rounding dust left in disputeEscrowBalance).
        const payeeAmount = _round6(amount - payerAmount);
        const releaseRef = randomUUID();
        const refundRef = randomUUID();

        const updatedEscrow = await _claimEscrowStatusTx(
            tx,
            escrowId,
            ['DISPUTED', 'ADMIN_REVIEW'],
            {
                status: 'RELEASED',
                settledAt: resolvedAt,
                releaseTxHash: releaseRef,
                refundTxHash: refundRef
            }
        );

        // Drain the full principal out of the payer's dispute bucket —
        // atomically guarded against a short bucket.
        const drained = await tx.user.updateMany({
            where: {
                id: escrow.payerId,
                disputeEscrowBalance: { gte: amount }
            },
            data: { disputeEscrowBalance: { decrement: amount } }
        });
        if (drained.count === 0) {
            throw new Error(
                `ESCROW_BUCKET_INSUFFICIENT: payer disputeEscrowBalance is short of the ${amount} USDC principal.`
            );
        }

        // Payer's share back to their available balance.
        if (payerAmount > 0) {
            await tx.user.update({
                where: { id: escrow.payerId },
                data: { availableBalance: { increment: payerAmount } }
            });
            await tx.transactionHistory.create({
                data: {
                    userId: escrow.payerId,
                    type: 'TICKET_ESCROW_REFUND',
                    amountUsdc: payerAmount,
                    feeUsdc: 0,
                    txHash: refundRef,
                    status: 'COMPLETED'
                }
            });
        }

        // Payee's share to their available balance.
        if (payeeAmount > 0) {
            await tx.user.update({
                where: { id: escrow.payeeId },
                data: { availableBalance: { increment: payeeAmount } }
            });
            await tx.transactionHistory.create({
                data: {
                    userId: escrow.payeeId,
                    type: 'TICKET_ESCROW_RELEASE',
                    amountUsdc: payeeAmount,
                    feeUsdc: 0,
                    txHash: releaseRef,
                    status: 'COMPLETED'
                }
            });
        }

        const updatedDispute = await tx.escrowDispute.update({
            where: { id: escrow.dispute.id, status: { not: 'RESOLVED' } },
            data: {
                ruling: 'SPLIT',
                rulingNotes: rulingNotes || null,
                payerPct: pPct,
                payeePct: qPct,
                resolvedAt,
                status: 'RESOLVED',
                assignedToId: escrow.dispute.assignedToId || adminId
            }
        });

        return { escrow: updatedEscrow, dispute: updatedDispute };
    });

    /*
     * IMPORTANT: a resolver that loses the escrow claim to a concurrent winner
     * REJECTS with ESCROW_ALREADY_FINALIZED — it never performs or repeats any
     * financial mutation. Sequential retries against an already-committed
     * resolution converge earlier, at the authoritative read inside the
     * transaction (alreadyResolved), so they do not reach this point.
     */

    // Successful resolution side effects happen ONLY HERE, after the
    // authoritative money + dispute transaction has committed.
    if (!result.alreadyResolved) {
        if (ruling === 'FULL_RELEASE') {
            setImmediate(() => {
                _getBizOrderService()
                    .updateOrderStatusFromEscrow(prisma, escrowId, 'RELEASED')
                    .catch((err) => logger.error({ err: err }, '[escrowService.resolveDispute] release order sync'));
            });

            // Business stats — same post-commit semantics as _releaseEscrow.
            setImmediate(async () => {
                try {
                    const order = await prisma.businessOrder.findFirst({
                        where: { escrowId },
                        select: { businessProfileId: true, amountUsdc: true, productId: true }
                    });
                    if (!order) return;
                    await prisma.businessProfile.update({
                        where: { id: order.businessProfileId },
                        data: {
                            completedEscrows: { increment: 1 },
                            totalVolume: { increment: Number(result.escrow.amountUsdc) }
                        }
                    });
                    if (order.productId) {
                        await prisma.businessProduct.update({
                            where: { id: order.productId },
                            data: {
                                totalOrders: { increment: 1 },
                                totalRevenue: { increment: Number(result.escrow.amountUsdc) }
                            }
                        });
                    }
                } catch (err) {
                    logger.error({ err: err }, '[escrowService.resolveDispute] release profile stat sync');
                }
            });

            setImmediate(() => {
                _getBizNotificationService().notifyOrderEvent(prisma, {
                    escrowId,
                    type: 'ORDER_SETTLED'
                }).catch((err) => logger.error({ err: err }, '[escrowService.resolveDispute] release biz notif'));
            });
        }

        if (ruling === 'FULL_REFUND') {
            setImmediate(() => {
                _getBizOrderService()
                    .updateOrderStatusFromEscrow(prisma, escrowId, 'REFUNDED')
                    .catch((err) => logger.error({ err: err }, '[escrowService.resolveDispute] refund order sync'));
            });

            if (_socketIo) {
                const payload = {
                    escrowId: result.escrow.id,
                    ticketId: result.escrow.ticketId,
                    status: result.escrow.status,
                    amountUsdc: result.escrow.amountUsdc,
                    payerId: result.escrow.payerId,
                    payeeId: result.escrow.payeeId,
                    reason: 'REFUND'
                };
                try {
                    _socketIo.to(`user_${result.escrow.payerId}`).emit('escrow_refunded', payload);
                    _socketIo.to(`user_${result.escrow.payeeId}`).emit('escrow_refunded', payload);
                    _socketIo.to('admin_spy_room').emit('escrow_refunded', payload);
                } catch (err) {
                    logger.warn(
                        { err: err, escrowId: result.escrow.id },
                        '[escrowService.resolveDispute] refund realtime emit failed'
                    );
                }
            }

            setImmediate(() => {
                _getBizNotificationService().notifyOrderEvent(prisma, {
                    escrowId,
                    type: 'ORDER_REFUNDED'
                }).catch((err) => logger.error({ err: err }, '[escrowService.resolveDispute] refund biz notif'));
            });
        }

        // SPLIT deliberately introduces no new event type. Keep the existing
        // API/event vocabulary; at minimum, synchronize the canonical order
        // state after commit.
        if (ruling === 'SPLIT') {
            setImmediate(() => {
                _getBizOrderService()
                    .updateOrderStatusFromEscrow(prisma, escrowId, 'RELEASED')
                    .catch((err) => logger.error({ err: err }, '[escrowService.resolveDispute] split order sync'));
            });
        }
    }

    return result;
};

// =============================================================================
// PRIVATE TX PRIMITIVES — the canonical escrow financial mutation path.
//   These operate on a tx client passed IN (they never open their own
//   transaction) so callers can compose the money movement with the dispute
//   transition in ONE atomic unit. Do not create another escrow-finance
//   service; extend or reuse these.
// =============================================================================

// Atomically claim an escrow's status. Returns the refreshed escrow row.
// Throws ESCROW_ALREADY_FINALIZED when another transaction claimed it first —
// the single-winner guard for every financial mutation below.
const _claimEscrowStatusTx = async (tx, escrowId, claimableStatuses, data) => {
    const claim = await tx.smartEscrow.updateMany({
        where: {
            id: escrowId,
            status: { in: claimableStatuses }
        },
        data
    });
    if (claim.count === 0) {
        throw new Error('ESCROW_ALREADY_FINALIZED');
    }
    return tx.smartEscrow.findUnique({ where: { id: escrowId } });
};

// Release (pay the payee) on the caller's transaction.
const _releaseEscrowTx = async (tx, escrow, finalStatus = 'SETTLED') => {
    const amount = Number(escrow.amountUsdc);
    const fromDispute =
        escrow.status === 'DISPUTED' || escrow.status === 'ADMIN_REVIEW';
    const sourceColumn = fromDispute
        ? 'disputeEscrowBalance'
        : 'escrowLockedBalance';
    const claimableStatuses = fromDispute
        ? ['DISPUTED', 'ADMIN_REVIEW']
        : ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updatedEscrow = await _claimEscrowStatusTx(tx, escrow.id, claimableStatuses, {
        status: finalStatus,
        settledAt: new Date(),
        releaseTxHash: reference
    });

    // Release the locked principal from the payer's holding bucket. The
    // decrement is ATOMICALLY GUARDED (bucket >= amount in the same UPDATE),
    // so a bucket can never go negative — no check-then-act window, and the
    // same invariant holds on databases without CHECK constraints.
    const drained = await tx.user.updateMany({
        where: {
            id: escrow.payerId,
            [sourceColumn]: { gte: amount }
        },
        data: { [sourceColumn]: { decrement: amount } }
    });
    if (drained.count === 0) {
        throw new Error(
            `ESCROW_BUCKET_INSUFFICIENT: payer ${sourceColumn} is short of the ${amount} USDC principal.`
        );
    }

    // Credit the payee.
    await tx.user.update({
        where: { id: escrow.payeeId },
        data: { availableBalance: { increment: amount } }
    });

    await tx.transactionHistory.create({
        data: {
            userId: escrow.payeeId,
            type: 'TICKET_ESCROW_RELEASE',
            amountUsdc: amount,
            feeUsdc: 0,
            txHash: reference,
            status: 'COMPLETED'
        }
    });

    return tx.smartEscrow.findUnique({ where: { id: escrow.id } });
};

// Refund (return the principal to the payer) on the caller's transaction.
const _refundEscrowTx = async (tx, escrow, finalStatus = 'REFUNDED') => {
    const amount = Number(escrow.amountUsdc);
    const fromDispute =
        escrow.status === 'DISPUTED' || escrow.status === 'ADMIN_REVIEW';
    const sourceColumn = fromDispute
        ? 'disputeEscrowBalance'
        : 'escrowLockedBalance';
    const claimableStatuses = fromDispute
        ? ['DISPUTED', 'ADMIN_REVIEW']
        : ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    await _claimEscrowStatusTx(tx, escrow.id, claimableStatuses, {
        status: finalStatus,
        refundedAt: new Date(),
        refundTxHash: reference
    });

    // Guarded, atomic bucket drain + payer credit in ONE statement — the
    // refund can never take the bucket negative or credit the payer when the
    // bucket is short. If no row matches, the whole transaction rolls back.
    const refunded = await tx.user.updateMany({
        where: {
            id: escrow.payerId,
            [sourceColumn]: { gte: amount }
        },
        data: {
            [sourceColumn]: { decrement: amount },
            availableBalance: { increment: amount }
        }
    });
    if (refunded.count === 0) {
        throw new Error(
            `ESCROW_BUCKET_INSUFFICIENT: payer ${sourceColumn} is short of the ${amount} USDC principal.`
        );
    }

    await tx.transactionHistory.create({
        data: {
            userId: escrow.payerId,
            type: 'TICKET_ESCROW_REFUND',
            amountUsdc: amount,
            feeUsdc: 0,
            txHash: reference,
            status: 'COMPLETED'
        }
    });

    return tx.smartEscrow.findUnique({ where: { id: escrow.id } });
};

// =============================================================================
// PRIVATE: _releaseEscrow — principal → payee.availableBalance.
//   finalStatus 'SETTLED' (auto, source escrowLockedBalance) or
//   'RELEASED' (admin from a dispute, source disputeEscrowBalance).
// =============================================================================
const _releaseEscrow = async (prisma, escrowId, finalStatus = 'SETTLED') => {
    // The authoritative escrow row is read INSIDE the transaction that claims
    // it — closing the helper's own TOCTOU window (a status change between the
    // old outer read and the claim no longer misdirects the balance mutation).
    const updated = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');
        return _releaseEscrowTx(tx, escrow, finalStatus);
    });

    // Realtime convergence: emit only after the $transaction commits.
    if (_socketIo && finalStatus === 'SETTLED') {
        const payload = {
            escrowId: updated.id,
            ticketId: updated.ticketId,
            status: updated.status,
            amountUsdc: updated.amountUsdc,
            payerId: updated.payerId,
            payeeId: updated.payeeId,
            settledAt: updated.settledAt,
        };
        try {
            _socketIo.to(`user_${updated.payerId}`).emit('escrow_settled', payload);
            _socketIo.to(`user_${updated.payeeId}`).emit('escrow_settled', payload);
            _socketIo.to('admin_spy_room').emit('escrow_settled', payload);
        } catch (err) {
            logger.warn({ err: err, escrowId: updated.id }, '[escrowService._releaseEscrow] realtime emit failed');
        }
    }

    setImmediate(() => {
        _getBizOrderService()
            .updateOrderStatusFromEscrow(prisma, escrowId, finalStatus)
            .catch((err) => logger.error({ err: err }, '[escrowService._releaseEscrow] order sync'));
    });

    if (finalStatus === 'SETTLED' || finalStatus === 'RELEASED') {
        setImmediate(async () => {
            try {
                const order = await prisma.businessOrder.findFirst({
                    where: { escrowId },
                    select: { businessProfileId: true, amountUsdc: true, productId: true }
                });
                if (!order) return;
                await prisma.businessProfile.update({
                    where: { id: order.businessProfileId },
                    data: {
                        completedEscrows: { increment: 1 },
                        totalVolume:      { increment: Number(updated.amountUsdc) }
                    }
                });
                if (order.productId) {
                    await prisma.businessProduct.update({
                        where: { id: order.productId },
                        data: {
                            totalOrders:  { increment: 1 },
                            totalRevenue: { increment: Number(updated.amountUsdc) }
                        }
                    });
                }
            } catch (err) {
                logger.error({ err: err }, '[escrowService._releaseEscrow] profile stat sync');
            }
        });

        // Owner-facing feed: funds delivered to the business.
        setImmediate(() => {
            _getBizNotificationService().notifyOrderEvent(prisma, {
                escrowId,
                type: 'ORDER_SETTLED'
            }).catch((err) => logger.error({ err: err }, '[escrowService._releaseEscrow] biz notif'));
        });
    }

    return updated;
};

// =============================================================================
// PRIVATE: _refundEscrow — principal → payer.availableBalance.
//   Source bucket depends on whether the escrow passed through a dispute.
//   finalStatus 'REFUNDED' (admin/auto refund) or 'EXPIRED' (worker sweep).
// =============================================================================
const _refundEscrow = async (prisma, escrowId, finalStatus = 'REFUNDED') => {
    // Authoritative read inside the claiming transaction (TOCTOU-safe).
    const updated = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');
        return _refundEscrowTx(tx, escrow, finalStatus);
    });

    // The transaction callback has completed, so the financial claim is
    // committed before this convergence signal is emitted. All refund callers
    // (expiry worker, Admin/manual resolution, and payer cancellation) therefore
    // share one event producer and cannot drift into duplicate transports.
    if (_socketIo) {
        const payload = {
            escrowId: updated.id,
            ticketId: updated.ticketId,
            status: updated.status,
            amountUsdc: updated.amountUsdc,
            payerId: updated.payerId,
            payeeId: updated.payeeId,
            reason: finalStatus === 'EXPIRED' ? 'EXPIRY' : 'REFUND'
        };
        try {
            _socketIo.to(`user_${updated.payerId}`).emit('escrow_refunded', payload);
            _socketIo.to(`user_${updated.payeeId}`).emit('escrow_refunded', payload);
            _socketIo.to('admin_spy_room').emit('escrow_refunded', payload);
        } catch (err) {
            logger.warn({ err: err, escrowId: updated.id }, '[escrowService._refundEscrow] realtime emit failed');
        }
    }

    // finalStatus is either 'REFUNDED' (admin/manual) or 'EXPIRED' (worker sweep).
    // Both map to BusinessOrderStatus.REFUNDED in updateOrderStatusFromEscrow.
    setImmediate(() => {
        _getBizOrderService()
            .updateOrderStatusFromEscrow(prisma, escrowId, finalStatus)
            .catch((err) => logger.error({ err: err }, '[escrowService._refundEscrow] order sync'));
    });

    // Owner-facing feed: principal returned to the buyer (manual or worker sweep).
    setImmediate(() => {
        _getBizNotificationService().notifyOrderEvent(prisma, {
            escrowId,
            type: 'ORDER_REFUNDED'
        }).catch((err) => logger.error({ err: err }, '[escrowService._refundEscrow] biz notif'));
    });

    return updated;
};

// =============================================================================
// 6. ASSIGN DISPUTE TO ADMIN — escalate to a specific admin/worker.
// =============================================================================
const assignDisputeToAdmin = async (prisma, { escrowId, assignedToId, requestingAdminId }) => {
    const escrow = await prisma.smartEscrow.findUnique({
        where: { id: escrowId },
        include: { dispute: true }
    });
    if (!escrow) throw new Error('Escrow not found.');
    if (escrow.status !== 'DISPUTED' && escrow.status !== 'ADMIN_REVIEW') {
        throw new Error(`Escrow is not disputed (status ${escrow.status}).`);
    }
    if (!escrow.dispute) throw new Error('No dispute exists for this escrow.');

    const assignee = await prisma.user.findUnique({
        where: { id: assignedToId },
        select: { id: true, role: true }
    });
    if (!assignee || assignee.role !== 'ADMIN') {
        throw new Error('assignedToId must reference a user with the ADMIN role.');
    }

    const result = await prisma.$transaction(async (tx) => {
        const dispute = await tx.escrowDispute.update({
            where: { id: escrow.dispute.id },
            data: { assignedToId, status: 'ASSIGNED' }
        });
        const updated = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: { status: 'ADMIN_REVIEW' }
        });
        return { escrow: updated, dispute };
    });

    return result;
};

// =============================================================================
// 7. GET ESCROW FOR TICKET — read helper with participant projections.
// =============================================================================
const getEscrowForTicket = async (prisma, ticketId) =>
    prisma.smartEscrow.findUnique({
        where: { ticketId },
        include: {
            dispute: true,
            payer: { select: { id: true, username: true, profilePictureUrl: true } },
            payee: { select: { id: true, username: true, profilePictureUrl: true } }
        }
    });

// =============================================================================
// 8. CANCEL ESCROW — payer aborts the escrow.
//   • DRAFT  → no money ever moved → mark EXPIRED.
//   • FUNDED/IN_PROGRESS/PENDING_SETTLEMENT → refund the locked principal to
//     the payer (via _refundEscrow) and mark REFUNDED.
//   Only the payer may cancel. Mirrors controllers/escrowController.cancelEscrow
//   (DRAFT-only) but adds the funded-refund path; the controller may adopt this
//   service function later. The DRAFT flip is an atomic conditional update so a
//   concurrent fund cannot race a cancel.
// =============================================================================
const cancelEscrow = async (prisma, { escrowId, userId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    if (escrow.payerId !== userId) {
        throw new Error('Only the payer can cancel this escrow.');
    }

    if (escrow.status === 'DRAFT') {
        const claim = await prisma.smartEscrow.updateMany({
            where: { id: escrowId, status: 'DRAFT' },
            data: { status: 'EXPIRED' }
        });
        if (claim.count === 0) {
            throw new Error(`Escrow cannot be cancelled from status ${escrow.status}.`);
        }
        return prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    }

    if (['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
        // _refundEscrow performs the atomic claim + balance move + history row.
        return _refundEscrow(prisma, escrowId, 'REFUNDED');
    }

    throw new Error(`Escrow cannot be cancelled from status ${escrow.status}.`);
};

// Transaction-scoped financial primitives for OTHER authoritative services.
// bookingEscrowService.processBusinessNoShow reuses _refundEscrowTx on its
// own caller transaction so the refund, the business-stake penalty, the
// booking terminal transition and the audit row commit as ONE unit.
const refundEscrowInTransaction = _refundEscrowTx;

module.exports = {
    createEscrow,
    fundEscrow,
    markSatisfied,
    raiseDispute,
    resolveDispute,
    assignDisputeToAdmin,
    getEscrowForTicket,
    cancelEscrow,
    setSocketIO,
    // Exposed for the expiry worker (Work Item 9).
    _refundEscrow,
    _releaseEscrow,
    // Transaction-scoped canonical financial primitives — reuse these, never
    // reimplement escrow money movement in another service.
    _claimEscrowStatusTx,
    _releaseEscrowTx,
    _refundEscrowTx,
    refundEscrowInTransaction,
    // Constants for reuse/testing.
    SMART_ESCROW_FEE_PCT_DEFAULT,
    DRAFT_EXPIRY_HOURS,
    FUNDED_EXPIRY_DAYS
};
