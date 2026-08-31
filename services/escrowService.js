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
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    if (!['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
        throw new Error(`Cannot dispute an escrow in status ${escrow.status}.`);
    }
    if (escrow.payerId !== raisedById && escrow.payeeId !== raisedById) {
        throw new Error('Only a participant can dispute this escrow.');
    }

    const amount = Number(escrow.amountUsdc);

    const result = await prisma.$transaction(async (tx) => {
        // a. Move the locked principal into the dispute bucket on the payer.
        await tx.user.update({
            where: { id: escrow.payerId },
            data: {
                escrowLockedBalance: { decrement: amount },
                disputeEscrowBalance: { increment: amount }
            }
        });

        // b. Create the dispute record.
        const dispute = await tx.escrowDispute.create({
            data: {
                escrowId,
                raisedById,
                reason,
                evidenceUrls: evidenceUrls || []
            }
        });

        // c. Flip escrow → DISPUTED.
        const updated = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: { status: 'DISPUTED' }
        });

        return { escrow: updated, dispute };
    });

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
    const escrow = await prisma.smartEscrow.findUnique({
        where: { id: escrowId },
        include: { dispute: true }
    });
    if (!escrow) throw new Error('Escrow not found.');
    if (!['DISPUTED', 'ADMIN_REVIEW'].includes(escrow.status)) {
        throw new Error(`Escrow is not in a resolvable state (status ${escrow.status}).`);
    }
    if (!escrow.dispute) throw new Error('No dispute exists for this escrow.');
    if (!['FULL_RELEASE', 'FULL_REFUND', 'SPLIT'].includes(ruling)) {
        throw new Error('ruling must be FULL_RELEASE, FULL_REFUND, or SPLIT.');
    }

    // FULL_RELEASE → release to payee from the dispute bucket.
    if (ruling === 'FULL_RELEASE') {
        const released = await _releaseEscrow(prisma, escrowId, 'RELEASED');
        const dispute = await prisma.escrowDispute.update({
            where: { id: escrow.dispute.id },
            data: {
                ruling,
                rulingNotes: rulingNotes || null,
                resolvedAt: new Date(),
                status: 'RESOLVED',
                assignedToId: escrow.dispute.assignedToId || adminId
            }
        });
        return { escrow: released, dispute };
    }

    // FULL_REFUND → refund to payer from the dispute bucket.
    if (ruling === 'FULL_REFUND') {
        const refunded = await _refundEscrow(prisma, escrowId);
        const dispute = await prisma.escrowDispute.update({
            where: { id: escrow.dispute.id },
            data: {
                ruling,
                rulingNotes: rulingNotes || null,
                resolvedAt: new Date(),
                status: 'RESOLVED',
                assignedToId: escrow.dispute.assignedToId || adminId
            }
        });
        return { escrow: refunded, dispute };
    }

    // SPLIT → custom percentage split. payerPct + payeePct must equal 100.
    const pPct = Number(payerPct);
    const qPct = Number(payeePct);
    if (!Number.isFinite(pPct) || !Number.isFinite(qPct) || Math.abs(pPct + qPct - 100) > 0.001) {
        throw new Error('For SPLIT rulings, payerPct + payeePct must equal 100.');
    }

    const amount = Number(escrow.amountUsdc);
    const payerAmount = _round6(amount * (pPct / 100));
    // Give the payee the remainder so the two always sum to the principal
    // exactly (avoids a rounding dust leak in disputeEscrowBalance).
    const payeeAmount = _round6(amount - payerAmount);
    const releaseRef = randomUUID();
    const refundRef = randomUUID();

    const result = await prisma.$transaction(async (tx) => {
        // Drain the full principal out of the payer's dispute bucket.
        await tx.user.update({
            where: { id: escrow.payerId },
            data: { disputeEscrowBalance: { decrement: amount } }
        });

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

        const updatedEscrow = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: {
                status: 'RELEASED',
                settledAt: new Date(),
                releaseTxHash: releaseRef,
                refundTxHash: refundRef
            }
        });

        const updatedDispute = await tx.escrowDispute.update({
            where: { id: escrow.dispute.id },
            data: {
                ruling: 'SPLIT',
                rulingNotes: rulingNotes || null,
                payerPct: pPct,
                payeePct: qPct,
                resolvedAt: new Date(),
                status: 'RESOLVED',
                assignedToId: escrow.dispute.assignedToId || adminId
            }
        });

        return { escrow: updatedEscrow, dispute: updatedDispute };
    });

    return result;
};

// =============================================================================
// PRIVATE: _releaseEscrow — principal → payee.availableBalance.
//   finalStatus 'SETTLED' (auto, source escrowLockedBalance) or
//   'RELEASED' (admin from a dispute, source disputeEscrowBalance).
// =============================================================================
const _releaseEscrow = async (prisma, escrowId, finalStatus = 'SETTLED') => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');

    const amount = Number(escrow.amountUsdc);
    // Funds sit in the dispute bucket only once a dispute moved them there.
    const fromDispute = escrow.status === 'DISPUTED' || escrow.status === 'ADMIN_REVIEW';
    const sourceColumn = fromDispute ? 'disputeEscrowBalance' : 'escrowLockedBalance';
    // The set of statuses we are allowed to release FROM. Used as the atomic
    // claim precondition below so the same escrow can never be released twice.
    const claimableStatuses = fromDispute
        ? ['DISPUTED', 'ADMIN_REVIEW']
        : ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        // SINGLE-WINNER CLAIM (TOCTOU guard): flip the escrow to its final
        // status if and only if it is still in a releasable state. A second
        // concurrent release sees count=0 and aborts BEFORE any balance moves,
        // exactly like the completeTrade PAID->COMPLETED atomic flip. Without
        // this, two settlements racing (e.g. both parties marking satisfied at
        // once) would each pay the payee — real money loss.
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimableStatuses } },
            data: {
                status: finalStatus,
                settledAt: new Date(),
                releaseTxHash: reference
            }
        });
        if (claim.count === 0) {
            throw new Error('ESCROW_ALREADY_FINALIZED');
        }

        // Release the locked principal from the payer's holding bucket.
        await tx.user.update({
            where: { id: escrow.payerId },
            data: { [sourceColumn]: { decrement: amount } }
        });

        // Credit the payee.
        await tx.user.update({
            where: { id: escrow.payeeId },
            data: { availableBalance: { increment: amount } }
        });

        const result = await tx.smartEscrow.findUnique({ where: { id: escrowId } });

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

        return result;
    });

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
                        totalVolume:      { increment: Number(escrow.amountUsdc) }
                    }
                });
                if (order.productId) {
                    await prisma.businessProduct.update({
                        where: { id: order.productId },
                        data: {
                            totalOrders:  { increment: 1 },
                            totalRevenue: { increment: Number(escrow.amountUsdc) }
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
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');

    const amount = Number(escrow.amountUsdc);
    const fromDispute = escrow.status === 'DISPUTED' || escrow.status === 'ADMIN_REVIEW';
    const sourceColumn = fromDispute ? 'disputeEscrowBalance' : 'escrowLockedBalance';
    // Statuses we are allowed to refund FROM — the atomic claim precondition.
    const claimableStatuses = fromDispute
        ? ['DISPUTED', 'ADMIN_REVIEW']
        : ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        // SINGLE-WINNER CLAIM (TOCTOU guard): mirror _releaseEscrow so a refund
        // can never run twice (e.g. the expiry worker and an admin refund both
        // firing on the same escrow). The loser aborts before any balance moves.
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimableStatuses } },
            data: {
                status: finalStatus,
                refundedAt: new Date(),
                refundTxHash: reference
            }
        });
        if (claim.count === 0) {
            throw new Error('ESCROW_ALREADY_FINALIZED');
        }

        await tx.user.update({
            where: { id: escrow.payerId },
            data: {
                [sourceColumn]: { decrement: amount },
                availableBalance: { increment: amount }
            }
        });

        const result = await tx.smartEscrow.findUnique({ where: { id: escrowId } });

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

        return result;
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
            logger.warn({ err, escrowId: updated.id }, '[escrowService._refundEscrow] realtime emit failed');
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
    // Constants for reuse/testing.
    SMART_ESCROW_FEE_PCT_DEFAULT,
    DRAFT_EXPIRY_HOURS,
    FUNDED_EXPIRY_DAYS
};
