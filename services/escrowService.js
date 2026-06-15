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

const { randomUUID } = require('crypto');
const { runDoubleCheck } = require('../utils/securityCheck');

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

    return { success: true, escrow: updatedEscrow, reference };
};

// =============================================================================
// 3. MARK SATISFIED — a party signals completion. Both true → auto-settle.
// =============================================================================
const markSatisfied = async (prisma, { escrowId, userId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    if (!['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
        throw new Error(`Cannot mark satisfied from status ${escrow.status}.`);
    }
    if (escrow.payerId !== userId && escrow.payeeId !== userId) {
        throw new Error('Only a participant can mark this escrow satisfied.');
    }

    const isPayer = escrow.payerId === userId;
    const data = isPayer ? { payerSatisfied: true } : { payeeSatisfied: true };

    const updated = await prisma.smartEscrow.update({
        where: { id: escrowId },
        data
    });

    // Both satisfied → release to payee (SETTLED).
    if (updated.payerSatisfied && updated.payeeSatisfied) {
        const settled = await _releaseEscrow(prisma, escrowId, 'SETTLED');
        return { settled: true, escrow: settled };
    }

    // Otherwise mark we are awaiting the other side.
    const pending = await prisma.smartEscrow.update({
        where: { id: escrowId },
        data: { status: 'PENDING_SETTLEMENT' }
    });
    return { settled: false, escrow: pending };
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
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
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

        const result = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: {
                status: finalStatus,
                settledAt: new Date(),
                releaseTxHash: reference
            }
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

        return result;
    });

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
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        await tx.user.update({
            where: { id: escrow.payerId },
            data: {
                [sourceColumn]: { decrement: amount },
                availableBalance: { increment: amount }
            }
        });

        const result = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: {
                status: finalStatus,
                refundedAt: new Date(),
                refundTxHash: reference
            }
        });

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

module.exports = {
    createEscrow,
    fundEscrow,
    markSatisfied,
    raiseDispute,
    resolveDispute,
    assignDisputeToAdmin,
    getEscrowForTicket,
    // Exposed for the expiry worker (Work Item 9).
    _refundEscrow,
    _releaseEscrow,
    // Constants for reuse/testing.
    SMART_ESCROW_FEE_PCT_DEFAULT,
    DRAFT_EXPIRY_HOURS,
    FUNDED_EXPIRY_DAYS
};
