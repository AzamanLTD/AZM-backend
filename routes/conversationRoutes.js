// routes/conversationRoutes.js
// =============================================================================
// AZAMAN — CONVERSATION ROUTES (Native Client API)
// Mounted at /api/conversations. Provides conversation-based endpoints for
// the native Android/KMP client (as opposed to the trade-based /api/chat routes).
//
// Endpoints:
//   GET  /:conversationId/messages                    — paginated message history
//   POST /:conversationId/messages                    — send message (TEXT, MONEY_SEND, MONEY_REQUEST, ESCROW_TICKET)
//   POST /:conversationId/messages/:messageId/accept-money
//   POST /:conversationId/messages/:messageId/decline-money
//   POST /:conversationId/messages/:messageId/fund-escrow
//   POST /:conversationId/messages/:messageId/release-escrow
//   POST /:conversationId/messages/:messageId/dispute-escrow
//
// r36/P0 — ALL financial behavior is delegated to the canonical
// ConversationMoneyService: amounts come from a durable structured ticket
// (never parsed from message text), the financial counterparty is derived
// from durable conversation membership, and every transition is an atomic
// conditional claim binding messageId to the URL conversationId. This file
// is a thin adapter: participant verification, envelope preservation, and
// broadcast wiring only.
// =============================================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const e2eeEnvelope = require('../services/e2eeMessageEnvelope');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { ConversationMoneyService } = require('../services/conversationMoneyService');

// ── Helpers ──────────────────────────────────────────────────────────────────

const _personalRoomHash = (uid1, uid2) => {
    const sorted = [String(uid1), String(uid2)].sort();
    return crypto.createHash('sha256').update(sorted.join('_')).digest('hex').slice(0, 32);
};

// Verify the user is a participant in the conversation
async function _verifyParticipant(prisma, conversationId, userId) {
    const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: { select: { id: true, username: true } } }
    });
    if (!conv) return { ok: false, status: 404, message: 'Conversation not found.' };
    const isParticipant = conv.participants.some(p => p.id === userId);
    if (!isParticipant) return { ok: false, status: 403, message: 'Not a participant in this conversation.' };
    return { ok: true, conv };
}

// Format a message for the API response. Financial messages are enriched with
// their durable structured ticket — the fields the client contract pretends
// existed are now backed by real data (additive: they were always null before).
function _formatMessage(msg, ticket) {
    // r40 E2EE: encrypted rows carry the ciphertext envelope, never message
    // text (the server does not hold it — content is empty by contract).
    if (msg.isEncrypted) {
        return {
            id: msg.id,
            conversationId: msg.conversationId,
            senderId: msg.sender?.id || msg.senderId,
            senderName: msg.sender?.username || 'Unknown',
            text: null,
            type: msg.messageType,
            status: msg.status || 'sent',
            createdAt: msg.createdAt,
            ...e2eeEnvelope.envelopeToWire(msg),
        };
    }
    return {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.sender?.id || msg.senderId,
        senderName: msg.sender?.username || 'Unknown',
        text: msg.content,
        type: msg.messageType,
        status: ticket?.status || msg.status || 'sent',
        createdAt: msg.createdAt,
        moneyAmount: ticket ? new Prisma.Decimal(ticket.amount).toFixed(2) : null, // display string (legacy envelope)
        moneyAmountExact: ticket ? new Prisma.Decimal(ticket.amount).toFixed(8) : null, // r38/P1 — exact machine value
        moneyDirection: null,
        moneyStatus: ticket ? ticket.status : null,
        escrowTicket: ticket && ticket.kind === 'ESCROW_TICKET'
            ? {
                amount: new Prisma.Decimal(ticket.amount).toFixed(2), // display
                amountExact: new Prisma.Decimal(ticket.amount).toFixed(8), // r38/P1 — exact machine value
                currency: ticket.currency,
                status: ticket.status,
            }
            : null,
    };
}

const _getService = (req) => new ConversationMoneyService({
    prisma: req.app.get('prisma'),
    io: req.app.get('socketio'),
    emitBalanceUpdate: req.app.get('emitBalanceUpdate'),
    pushIfOffline: req.app.get('pushIfOffline'),
});

// ── Routes ───────────────────────────────────────────────────────────────────

// 1. GET message history (paginated)
router.get('/:conversationId/messages', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { conversationId } = req.params;
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const skip = (page - 1) * limit;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const [messages, total] = await Promise.all([
            prisma.message.findMany({
                where: { conversationId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: { sender: { select: { id: true, username: true } } }
            }),
            prisma.message.count({ where: { conversationId } })
        ]);

        // Enrich financial messages with their durable structured tickets.
        const tickets = await prisma.conversationMoneyTicket.findMany({
            where: { messageId: { in: messages.map(m => m.id) } },
        });
        const ticketByMessage = new Map(tickets.map(t => [t.messageId, t]));

        res.json({
            success: true,
            data: messages.map(m => _formatMessage(m, ticketByMessage.get(m.id))),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] GET messages error');
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// 2. POST send message (supports TEXT, MONEY_SEND, MONEY_REQUEST, ESCROW_TICKET)
router.post('/:conversationId/messages', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { conversationId } = req.params;
        const userId = req.user.id;
        const { type, text, replyTo } = req.body;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });
        const { conv } = check;

        // ── TEXT message ──
        if (type === 'TEXT' || type === undefined) {
            const e2eePayload = req.body.e2ee;

            // r40 E2EE envelope path: the server persists ONLY the ciphertext
            // envelope — never plaintext (docs/e2ee/PROTOCOL.md §6–§7).
            if (e2eePayload) {
                const envelope = await e2eeEnvelope.validateEnvelope(e2eePayload);
                // Replay anchor: a retried send reuses the envelopeId and gets
                // the original row back — never a duplicate delivery.
                const replayed = await e2eeEnvelope.findExistingByEnvelopeId(prisma, envelope.envelopeId);
                if (replayed) {
                    return res.json({ success: true, replayed: true, data: _formatMessage(replayed) });
                }
                const message = await prisma.message.create({
                    data: e2eeEnvelope.buildEncryptedMessageData({
                        conversationId, senderId: userId, envelope,
                        extras: { replyToId: replyTo || null },
                    }),
                    include: { sender: { select: { id: true, username: true } } }
                });
                const io = req.app.get('socketio');
                if (io) {
                    if (conv.type === 'PERSONAL') {
                        const other = conv.participants.find(p => p.id !== userId);
                        if (other) {
                            const hash = _personalRoomHash(userId, other.id);
                            io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                        }
                    }
                }
                return res.status(201).json({ success: true, data: _formatMessage(message) });
            }

            // Fail-closed (r40): once BOTH participants of a personal
            // conversation have registered E2EE bundles, plaintext TEXT is
            // refused — the client MUST send the ciphertext envelope.
            if (await e2eeEnvelope.personalConversationIsEncrypted(prisma, conv)) {
                return res.status(409).json({
                    success: false, code: 'E2EE_REQUIRED',
                    message: 'Both participants have E2EE registered — send the e2ee ciphertext envelope.',
                });
            }

            if (!text || !text.trim()) {
                return res.status(400).json({ success: false, message: 'Message text is required.' });
            }
            const message = await prisma.message.create({
                data: {
                    conversationId,
                    senderId: userId,
                    messageType: 'TEXT',
                    content: text.trim(),
                    replyToId: replyTo || null,
                },
                include: { sender: { select: { id: true, username: true } } }
            });

            const io = req.app.get('socketio');
            if (io) {
                if (conv.type === 'PERSONAL') {
                    const other = conv.participants.find(p => p.id !== userId);
                    if (other) {
                        const hash = _personalRoomHash(userId, other.id);
                        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                    }
                } else if (conv.type === 'GROUP') {
                    io.to(`group_${conversationId}`).emit('new_group_message', _formatMessage(message));
                }
            }
            return res.status(201).json({ success: true, data: _formatMessage(message) });
        }

        // ── MONEY flows — canonical service authority ──
        const service = _getService(req);
        const result = await service.sendMoney({
            user: req.user,
            conv,
            type,
            moneyAmount: req.body.moneyAmount,
            amount: req.body.amount,
            recipientId: req.body.recipientId,
            fromUserId: req.body.fromUserId,
            currency: req.body.currency,
            note: req.body.note,
            itemName: req.body.itemName,
            counterpartyId: req.body.counterpartyId,
            clientRequestId: req.body.clientRequestId,
        });

        res.status(201).json({ success: true, data: _formatMessage(result.message, result.ticket) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] POST message error');
        const status = Number.isInteger(err.status) ? err.status : 400;
        res.status(status).json({ success: false, ...(err.code ? { code: err.code } : {}), message: err.message || 'Server error.' });
    }
});

// ── Financial actions — thin adapters over ConversationMoneyService ─────────
// Every handler re-verifies participation, then delegates; the service binds
// messageId to the URL conversationId in the claim predicate itself.

const _action = (fn) => async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const service = _getService(req);
        const result = await fn(service, {
            user: req.user,
            conversationId,
            messageId,
            reason: req.body?.reason,
        });

        res.json({ success: true, data: _formatMessage(result.message, result.ticket) });
    } catch (err) {
        logger.error({ err }, `[conversationRoutes] ${fn.name} error`);
        const status = Number.isInteger(err.status) ? err.status : 400;
        res.status(status).json({ success: false, message: err.message || 'Server error.' });
    }
};

// 3. Accept a money request
router.post('/:conversationId/messages/:messageId/accept-money', protectActive,
    _action((s, a) => s.acceptMoney(a)));

// 4. Decline a money request
router.post('/:conversationId/messages/:messageId/decline-money', protectActive,
    _action((s, a) => s.declineMoney(a)));

// 5. Fund an escrow ticket
router.post('/:conversationId/messages/:messageId/fund-escrow', protectActive,
    _action((s, a) => s.fundEscrow(a)));

// 6. Release escrow funds
router.post('/:conversationId/messages/:messageId/release-escrow', protectActive,
    _action((s, a) => s.releaseEscrow(a)));

// 7. Dispute an escrow ticket
router.post('/:conversationId/messages/:messageId/dispute-escrow', protectActive,
    _action((s, a) => s.disputeEscrow(a)));

module.exports = router;
