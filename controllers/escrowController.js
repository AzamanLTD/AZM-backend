// controllers/escrowController.js
// =============================================================================
// AZAMAN — SMART ESCROW CONTROLLER (2026-06-14)
//
// HTTP layer for the Smart Escrow Engine. Mirrors ticketController.js exactly:
//   • prisma  = req.app.get('prisma')
//   • io      = req.app.get('socketio')
//   • userId  = req.user.id
//   • success: res.status(2xx).json({ success: true, ... })
//   • error:   res.status(4xx/5xx).json({ success: false, message })
//
// All financial logic lives in services/escrowService.js. This file validates
// input, authorizes the caller, calls the service, emits sockets, and injects
// SYSTEM TicketMessages into the parent ticket workspace.
// =============================================================================

const logger = require('../src/config/logger');
const escrowService = require('../services/escrowService');
const bizNotificationService = require('../services/bizNotificationService');
const { audit } = require('../utils/audit');

// ── helpers ─────────────────────────────────────────────────────────────────

/** Load an escrow + its ticket, asserting the caller participates. */
async function _loadEscrowForParticipant(prisma, escrowId, userId) {
    const escrow = await prisma.smartEscrow.findUnique({
        where: { id: escrowId },
        include: { ticket: true }
    });
    if (!escrow) return { ok: false, code: 404, message: 'Escrow not found.' };
    if (escrow.payerId !== userId && escrow.payeeId !== userId) {
        return { ok: false, code: 403, message: 'Not a participant in this escrow.' };
    }
    return { ok: true, escrow };
}

/** Inject a SYSTEM TicketMessage and fan it out on the ticket room. */
async function _injectSystemMessage(prisma, io, ticket, content, metadata = {}) {
    try {
        const message = await prisma.ticketMessage.create({
            data: {
                ticketId: ticket.id,
                senderId: ticket.creatorId, // system messages attributed to ticket creator
                type: 'SYSTEM',
                content,
                metadata: { system: true, ...metadata }
            }
        });
        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { lastActivityAt: new Date() }
        });
        if (io) {
            const payload = { ...message, ticketId: ticket.id };
            io.to(`ticket_${ticket.id}`).emit('ticket_message', payload);
            io.to(`user_${ticket.creatorId}`).emit('ticket_message', payload);
            io.to(`user_${ticket.counterpartyId}`).emit('ticket_message', payload);
        }
        return message;
    } catch (err) {
        // Non-fatal: the financial action already committed.
        logger.error({ err: err }, '[escrow._injectSystemMessage] error');
        return null;
    }
}

function _emitToParties(io, escrow, event, payload) {
    if (!io) return;
    io.to(`user_${escrow.payerId}`).emit(event, payload);
    io.to(`user_${escrow.payeeId}`).emit(event, payload);
}

// =============================================================================
// 1. GET /api/escrow/ticket/:ticketId — fetch escrow for a ticket.
// =============================================================================
exports.getEscrowForTicket = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { ticketId } = req.params;

        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId },
            select: { id: true, creatorId: true, counterpartyId: true }
        });
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found.' });
        }
        if (ticket.creatorId !== userId && ticket.counterpartyId !== userId) {
            return res.status(403).json({ success: false, message: 'Not a participant in this ticket.' });
        }

        const escrow = await escrowService.getEscrowForTicket(prisma, ticketId);
        if (!escrow) {
            return res.status(404).json({ success: false, message: 'No escrow for this ticket.' });
        }
        return res.status(200).json({ success: true, escrow });
    } catch (err) {
        logger.error({ err: err }, '[getEscrowForTicket] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. POST /api/escrow/fund — payer locks USDC.
// =============================================================================
exports.fundEscrow = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { escrowId } = req.body;
        if (!escrowId) {
            return res.status(400).json({ success: false, message: 'escrowId is required.' });
        }

        const loaded = await _loadEscrowForParticipant(prisma, escrowId, userId);
        if (!loaded.ok) return res.status(loaded.code).json({ success: false, message: loaded.message });
        if (loaded.escrow.payerId !== userId) {
            return res.status(403).json({ success: false, message: 'Only the payer can fund this escrow.' });
        }

        const result = await escrowService.fundEscrow(prisma, { escrowId, payerId: userId });
        const escrow = result.escrow;

        _emitToParties(io, escrow, 'escrow_funded', {
            escrowId: escrow.id,
            ticketId: escrow.ticketId,
            status: escrow.status,
            amountUsdc: escrow.amountUsdc,
            payerId: escrow.payerId
        });

        await _injectSystemMessage(
            prisma, io, loaded.escrow.ticket,
            `💰 Escrow funded — ${Number(escrow.amountUsdc).toFixed(2)} USDC is now locked. Deal is live.`,
            { event: 'ESCROW_FUNDED', escrowId: escrow.id }
        );

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: 'ESCROW_FUNDED', targetType: 'SMARTESCROW', targetId: String(escrow.id),
            metadata: { amountUsdc: escrow.amountUsdc }, ipAddress: req.ip,
        });

        return res.status(200).json({ success: true, escrow });
    } catch (err) {
        logger.error({ err: err }, '[fundEscrow] error');
        const code = /insufficient/i.test(err.message) ? 400 : 500;
        return res.status(code).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. POST /api/escrow/satisfy — a party marks satisfaction; both → settle.
// =============================================================================
exports.markSatisfied = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { escrowId } = req.body;
        if (!escrowId) {
            return res.status(400).json({ success: false, message: 'escrowId is required.' });
        }

        const loaded = await _loadEscrowForParticipant(prisma, escrowId, userId);
        if (!loaded.ok) return res.status(loaded.code).json({ success: false, message: loaded.message });

        const result = await escrowService.markSatisfied(prisma, { escrowId, userId });
        const escrow = result.escrow;

        const actor = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true }
        });
        const actorName = actor ? actor.username : 'A participant';

        if (result.settled) {
            const payee = await prisma.user.findUnique({
                where: { id: escrow.payeeId },
                select: { username: true }
            });
            _emitToParties(io, escrow, 'escrow_settled', {
                escrowId: escrow.id,
                ticketId: escrow.ticketId,
                status: escrow.status,
                amountUsdc: escrow.amountUsdc
            });
            await _injectSystemMessage(
                prisma, io, loaded.escrow.ticket,
                `✅ Both parties satisfied — funds released to ${payee ? payee.username : 'the payee'}.`,
                { event: 'ESCROW_SETTLED', escrowId: escrow.id }
            );
        } else {
            _emitToParties(io, escrow, 'escrow_pending_settlement', {
                escrowId: escrow.id,
                ticketId: escrow.ticketId,
                status: escrow.status
            });
            await _injectSystemMessage(
                prisma, io, loaded.escrow.ticket,
                `${actorName} has marked the deal as complete. Awaiting the other party.`,
                { event: 'ESCROW_PENDING_SETTLEMENT', escrowId: escrow.id }
            );
        }

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: 'ESCROW_SATISFIED', targetType: 'SMARTESCROW', targetId: String(escrow.id),
            metadata: { settled: result?.settled }, ipAddress: req.ip,
        });

        return res.status(200).json({ success: true, settled: result.settled, escrow });
    } catch (err) {
        logger.error({ err: err }, '[markSatisfied] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. POST /api/escrow/dispute — raise a formal dispute.
// =============================================================================
exports.raiseDispute = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    const adminAlertService = req.app.get('adminAlertService');
    try {
        const userId = req.user.id;
        const { escrowId, reason, evidenceUrls } = req.body;

        if (!escrowId) {
            return res.status(400).json({ success: false, message: 'escrowId is required.' });
        }
        const cleanReason = String(reason || '').trim();
        if (!cleanReason) {
            return res.status(400).json({ success: false, message: 'reason is required.' });
        }
        if (cleanReason.length > 1000) {
            return res.status(400).json({ success: false, message: 'reason must be max 1000 chars.' });
        }
        let urls = [];
        if (evidenceUrls != null) {
            if (!Array.isArray(evidenceUrls) || !evidenceUrls.every((u) => typeof u === 'string')) {
                return res.status(400).json({ success: false, message: 'evidenceUrls must be an array of strings.' });
            }
            if (evidenceUrls.length > 5) {
                return res.status(400).json({ success: false, message: 'evidenceUrls max 5 items.' });
            }
            urls = evidenceUrls;
        }

        const loaded = await _loadEscrowForParticipant(prisma, escrowId, userId);
        if (!loaded.ok) return res.status(loaded.code).json({ success: false, message: loaded.message });

        const result = await escrowService.raiseDispute(prisma, {
            escrowId, raisedById: userId, reason: cleanReason, evidenceUrls: urls
        });
        const escrow = result.escrow;

        const raiser = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true }
        });
        const raiserName = raiser ? raiser.username : 'A participant';

        // Socket: both parties + admin spy room.
        _emitToParties(io, escrow, 'escrow_disputed', {
            escrowId: escrow.id,
            ticketId: escrow.ticketId,
            status: escrow.status,
            disputeId: result.dispute.id,
            raisedById: userId
        });
        if (io) {
            io.to('admin_spy_room').emit('escrow_disputed', {
                escrowId: escrow.id,
                ticketId: escrow.ticketId,
                disputeId: result.dispute.id,
                amountUsdc: escrow.amountUsdc,
                raisedById: userId
            });
        }

        // Admin alert (existing infrastructure only).
        if (adminAlertService) {
            setImmediate(() => adminAlertService.emit('ESCROW_DISPUTE', {
                escrowId: escrow.id,
                ticketId: escrow.ticketId,
                disputeId: result.dispute.id,
                raisedByUsername: raiserName,
                amount: Number(escrow.amountUsdc)
            }));
        }

        await _injectSystemMessage(
            prisma, io, loaded.escrow.ticket,
            `⚠️ Dispute raised by ${raiserName}. An Azaman admin will review and rule within 48 hours.`,
            { event: 'ESCROW_DISPUTED', escrowId: escrow.id, disputeId: result.dispute.id }
        );

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: 'ESCROW_DISPUTED', targetType: 'SMARTESCROW', targetId: String(escrow.id),
            metadata: { reason: cleanReason }, ipAddress: req.ip,
        });

        return res.status(200).json({ success: true, escrow, dispute: result.dispute });
    } catch (err) {
        logger.error({ err: err }, '[raiseDispute] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. POST /api/escrow/update-terms — either party edits delivery terms.
// =============================================================================
exports.updateTerms = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { escrowId, deliveryTerms } = req.body;

        if (!escrowId) {
            return res.status(400).json({ success: false, message: 'escrowId is required.' });
        }
        const terms = deliveryTerms == null ? null : String(deliveryTerms);
        if (terms && terms.length > 1000) {
            return res.status(400).json({ success: false, message: 'deliveryTerms must be max 1000 chars.' });
        }

        const loaded = await _loadEscrowForParticipant(prisma, escrowId, userId);
        if (!loaded.ok) return res.status(loaded.code).json({ success: false, message: loaded.message });
        if (!['DRAFT', 'FUNDED'].includes(loaded.escrow.status)) {
            return res.status(409).json({
                success: false,
                message: `Terms can only be updated while DRAFT or FUNDED (current: ${loaded.escrow.status}).`
            });
        }

        const escrow = await prisma.smartEscrow.update({
            where: { id: escrowId },
            data: { deliveryTerms: terms }
        });

        _emitToParties(io, escrow, 'escrow_terms_updated', {
            escrowId: escrow.id,
            ticketId: escrow.ticketId,
            deliveryTerms: escrow.deliveryTerms
        });

        return res.status(200).json({ success: true, escrow });
    } catch (err) {
        logger.error({ err: err }, '[updateTerms] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 6. POST /api/escrow/cancel — payer cancels a DRAFT (no funds moved yet).
// =============================================================================
exports.cancelEscrow = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { escrowId } = req.body;
        if (!escrowId) {
            return res.status(400).json({ success: false, message: 'escrowId is required.' });
        }

        const loaded = await _loadEscrowForParticipant(prisma, escrowId, userId);
        if (!loaded.ok) return res.status(loaded.code).json({ success: false, message: loaded.message });
        if (loaded.escrow.payerId !== userId) {
            return res.status(403).json({ success: false, message: 'Only the payer can cancel this escrow.' });
        }
        if (loaded.escrow.status !== 'DRAFT') {
            return res.status(409).json({
                success: false,
                message: `Only a DRAFT escrow can be cancelled (current: ${loaded.escrow.status}).`
            });
        }

        const result = await prisma.$transaction(async (tx) => {
            const escrow = await tx.smartEscrow.update({
                where: { id: escrowId },
                data: { status: 'EXPIRED' }
            });
            // Close the parent ticket (CANCELLED) — standard ticket status flow.
            await tx.ticket.update({
                where: { id: loaded.escrow.ticketId },
                data: { status: 'CANCELLED', cancelledAt: new Date(), lastActivityAt: new Date() }
            });
            // Sync the linked business order, if any. A never-funded DRAFT cancellation
            // is CANCELLED — NOT REFUNDED (no money ever moved). updateOrderStatusFromEscrow
            // is deliberately bypassed here because it maps EXPIRED → REFUNDED, which is
            // only correct for the worker's funded-escrow sweep. updateMany is a no-op for
            // peer-to-peer escrows with no order.
            await tx.businessOrder.updateMany({
                where: { escrowId },
                data: { status: 'CANCELLED' }
            });
            return escrow;
        });

        _emitToParties(io, result, 'escrow_cancelled', {
            escrowId: result.id,
            ticketId: result.ticketId,
            status: result.status
        });

        // Owner-facing feed: a DRAFT order was cancelled before funding.
        setImmediate(() => {
            bizNotificationService.notifyOrderEvent(prisma, {
                escrowId,
                type: 'ORDER_CANCELLED'
            }).then((res) => {
                if (res && io) io.to(`user_${res.order.businessProfile.userId}`).emit('biz_notification', { type: 'ORDER_CANCELLED' });
            }).catch((err) => logger.error({ err: err }, '[cancelEscrow] biz notif'));
        });

        await audit(prisma, {
            actorId: req.user.id, actorName: req.user.username,
            action: 'ESCROW_CANCELLED', targetType: 'SMARTESCROW', targetId: String(result.id),
            metadata: {}, ipAddress: req.ip,
        });

        return res.status(200).json({ success: true, escrow: result });
    } catch (err) {
        logger.error({ err: err }, '[cancelEscrow] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};
