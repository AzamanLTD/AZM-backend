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
// =============================================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../src/config/logger');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

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

// Format a message for the API response
function _formatMessage(msg) {
    return {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.sender?.id || msg.senderId,
        senderName: msg.sender?.username || 'Unknown',
        text: msg.content,
        type: msg.messageType,
        status: msg.status || 'sent',
        createdAt: msg.createdAt,
        moneyAmount: msg.moneyAmount || null,
        moneyDirection: msg.moneyDirection || null,
        moneyStatus: msg.moneyStatus || null,
        escrowTicket: msg.escrowTicket || null,
    };
}

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

        res.json({
            success: true,
            data: messages.map(_formatMessage),
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
        const io = req.app.get('socketio');
        const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
        const pushIfOffline = req.app.get('pushIfOffline');
        const { conversationId } = req.params;
        const userId = req.user.id;
        const { type, text, moneyAmount, recipientId, fromUserId, currency, note, itemName, amount, counterpartyId, replyTo } = req.body;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });
        const { conv } = check;

        let message;

        switch (type) {
            // ── TEXT message ──
            case 'TEXT':
            case undefined: {
                if (!text || !text.trim()) {
                    return res.status(400).json({ success: false, message: 'Message text is required.' });
                }
                message = await prisma.message.create({
                    data: {
                        conversationId,
                        senderId: userId,
                        messageType: 'TEXT',
                        content: text.trim(),
                        replyToId: replyTo || null,
                    },
                    include: { sender: { select: { id: true, username: true } } }
                });

                // Broadcast via Socket.IO
                if (conv.type === 'PERSONAL') {
                    const other = conv.participants.find(p => p.id !== userId);
                    if (other) {
                        const hash = _personalRoomHash(userId, other.id);
                        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                    }
                } else if (conv.type === 'GROUP') {
                    io.to(`group_${conversationId}`).emit('new_group_message', _formatMessage(message));
                }
                break;
            }

            // ── MONEY_SEND ──
            case 'MONEY_SEND': {
                const receiverId = parseInt(recipientId);
                const amt = parseFloat(moneyAmount);
                if (!receiverId || isNaN(amt) || amt <= 0) {
                    return res.status(400).json({ success: false, message: 'Valid recipientId and moneyAmount required.' });
                }
                if (userId === receiverId) {
                    return res.status(400).json({ success: false, message: 'Cannot send money to yourself.' });
                }

                // Atomic transfer
                const result = await prisma.$transaction(async (tx) => {
                    const sender = await tx.user.findUnique({ where: { id: userId } });
                    if (!sender) throw new Error('Sender not found.');
                    if (sender.availableBalance < amt) {
                        throw new Error(`Insufficient balance. Required: ${amt}, available: ${sender.availableBalance.toFixed(6)}.`);
                    }
                    const receiver = await tx.user.findUnique({ where: { id: receiverId } });
                    if (!receiver) throw new Error('Receiver not found.');

                    await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: amt } } });
                    await tx.user.update({ where: { id: receiverId }, data: { availableBalance: { increment: amt } } });

                    // Upsert contacts
                    await tx.contact.upsert({
                        where: { userId_savedUserId: { userId, savedUserId: receiverId } },
                        update: {}, create: { userId, savedUserId: receiverId }
                    });
                    await tx.contact.upsert({
                        where: { userId_savedUserId: { userId: receiverId, savedUserId: userId } },
                        update: {}, create: { userId: receiverId, savedUserId: userId }
                    });

                    const content = note ? `💸 Sent ${amt} ${currency || 'GHS'} — "${note}"` : `💸 Sent ${amt} ${currency || 'GHS'}`;
                    const msg = await tx.message.create({
                        data: {
                            conversationId,
                            senderId: userId,
                            messageType: 'PAYMENT_TRANSFER',
                            content,
                        },
                        include: { sender: { select: { id: true, username: true } } }
                    });

                    await tx.transactionHistory.create({
                        data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: -amt, feeUsdc: 0, status: 'COMPLETED' }
                    });
                    await tx.transactionHistory.create({
                        data: { userId: receiverId, type: 'INTERNAL_TRANSFER', amountUsdc: amt, feeUsdc: 0, status: 'COMPLETED' }
                    });

                    return { msg, sender, receiver };
                });

                message = result.msg;

                // Post-commit: balance + socket + push
                await emitBalanceUpdate(userId);
                await emitBalanceUpdate(receiverId);
                const hash = _personalRoomHash(userId, receiverId);
                io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                io.to(`user_${receiverId}`).emit('payment_received', {
                    from: userId, amountUsdc: amt, conversationId, messageId: message.id
                });
                await pushIfOffline(receiverId, `💸 ${result.sender.username} sent you ${amt}`, note || `${amt} transferred to your account.`, {
                    type: 'PAYMENT_TRANSFER', conversationId, route: `/chat/${conversationId}`
                });
                break;
            }

            // ── MONEY_REQUEST ──
            case 'MONEY_REQUEST': {
                const requesterId = userId;
                const fromId = parseInt(fromUserId);
                const amt = parseFloat(moneyAmount);
                if (!fromId || isNaN(amt) || amt <= 0) {
                    return res.status(400).json({ success: false, message: 'Valid fromUserId and moneyAmount required.' });
                }

                const content = `🤑 Requested ${amt} ${currency || 'GHS'}${note ? ` — "${note}"` : ''}`;
                message = await prisma.message.create({
                    data: {
                        conversationId,
                        senderId: requesterId,
                        messageType: 'MONEY_REQUEST',
                        content,
                    },
                    include: { sender: { select: { id: true, username: true } } }
                });

                // Broadcast
                const other = conv.participants.find(p => p.id !== userId);
                if (other) {
                    const hash = _personalRoomHash(userId, other.id);
                    io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                    await pushIfOffline(other.id, `🤑 ${message.sender.username} requested ${amt}`, note || '', {
                        type: 'MONEY_REQUEST', conversationId, messageId: message.id
                    });
                }
                break;
            }

            // ── ESCROW_TICKET ──
            case 'ESCROW_TICKET': {
                const itemNameStr = itemName || 'Item';
                const amt = parseFloat(amount);
                if (!counterpartyId || isNaN(amt) || amt <= 0) {
                    return res.status(400).json({ success: false, message: 'Valid itemName, amount, and counterpartyId required.' });
                }

                const content = `🛡️ Escrow: ${itemNameStr} — ${amt} ${currency || 'GHS'}`;
                message = await prisma.message.create({
                    data: {
                        conversationId,
                        senderId: userId,
                        messageType: 'ESCROW_TICKET',
                        content,
                    },
                    include: { sender: { select: { id: true, username: true } } }
                });

                // Broadcast
                if (conv.type === 'PERSONAL') {
                    const other = conv.participants.find(p => p.id !== userId);
                    if (other) {
                        const hash = _personalRoomHash(userId, other.id);
                        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(message));
                    }
                }
                break;
            }

            default:
                return res.status(400).json({ success: false, message: `Unknown message type: ${type}` });
        }

        res.status(201).json({ success: true, data: _formatMessage(message) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] POST message error');
        res.status(400).json({ success: false, message: err.message || 'Server error.' });
    }
});

// 3. Accept a money request
router.post('/:conversationId/messages/:messageId/accept-money', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        // Find the money request message
        const reqMsg = await prisma.message.findUnique({
            where: { id: messageId },
            include: { sender: { select: { id: true, username: true } } }
        });
        if (!reqMsg || reqMsg.messageType !== 'MONEY_REQUEST') {
            return res.status(404).json({ success: false, message: 'Money request not found.' });
        }
        if (reqMsg.senderId === userId) {
            return res.status(400).json({ success: false, message: 'Cannot accept your own request.' });
        }

        // Parse amount from content
        const amountMatch = reqMsg.content.match(/(\d+(?:\.\d+)?)/);
        if (!amountMatch) return res.status(400).json({ success: false, message: 'Could not parse request amount.' });
        const amount = parseFloat(amountMatch[1]);

        // Execute the transfer (accepter pays the requester)
        const result = await prisma.$transaction(async (tx) => {
            const payer = await tx.user.findUnique({ where: { id: userId } });
            if (!payer) throw new Error('Payer not found.');
            if (payer.availableBalance < amount) {
                throw new Error(`Insufficient balance. Required: ${amount}, available: ${payer.availableBalance.toFixed(6)}.`);
            }
            const payee = await tx.user.findUnique({ where: { id: reqMsg.senderId } });
            if (!payee) throw new Error('Requester not found.');

            await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: amount } } });
            await tx.user.update({ where: { id: reqMsg.senderId }, data: { availableBalance: { increment: amount } } });

            // Update the request message to accepted
            await tx.message.update({
                where: { id: messageId },
                data: { status: 'ACCEPTED' }
            });

            // Create acceptance message
            const content = `✅ Accepted: ${amount} sent to ${reqMsg.sender.username}`;
            const msg = await tx.message.create({
                data: {
                    conversationId,
                    senderId: userId,
                    messageType: 'PAYMENT_TRANSFER',
                    content,
                },
                include: { sender: { select: { id: true, username: true } } }
            });

            await tx.transactionHistory.create({
                data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: -amount, feeUsdc: 0, status: 'COMPLETED' }
            });
            await tx.transactionHistory.create({
                data: { userId: reqMsg.senderId, type: 'INTERNAL_TRANSFER', amountUsdc: amount, feeUsdc: 0, status: 'COMPLETED' }
            });

            return { msg, payer, payee };
        });

        await emitBalanceUpdate(userId);
        await emitBalanceUpdate(reqMsg.senderId);

        const hash = _personalRoomHash(userId, reqMsg.senderId);
        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(result.msg));
        io.to(`user_${reqMsg.senderId}`).emit('payment_received', {
            from: userId, amountUsdc: amount, conversationId, messageId: result.msg.id
        });

        res.json({ success: true, data: _formatMessage(result.msg) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] accept-money error');
        res.status(400).json({ success: false, message: err.message });
    }
});

// 4. Decline a money request
router.post('/:conversationId/messages/:messageId/decline-money', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const reqMsg = await prisma.message.findUnique({ where: { id: messageId } });
        if (!reqMsg || reqMsg.messageType !== 'MONEY_REQUEST') {
            return res.status(404).json({ success: false, message: 'Money request not found.' });
        }
        if (reqMsg.senderId === userId) {
            return res.status(400).json({ success: false, message: 'Cannot decline your own request.' });
        }

        await prisma.message.update({
            where: { id: messageId },
            data: { status: 'DECLINED' }
        });

        const content = '❌ Money request declined';
        const msg = await prisma.message.create({
            data: { conversationId, senderId: userId, messageType: 'TEXT', content },
            include: { sender: { select: { id: true, username: true } } }
        });

        const hash = _personalRoomHash(userId, reqMsg.senderId);
        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(msg));

        res.json({ success: true, data: _formatMessage(msg) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] decline-money error');
        res.status(400).json({ success: false, message: err.message });
    }
});

// 5. Fund an escrow ticket
router.post('/:conversationId/messages/:messageId/fund-escrow', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const escrowMsg = await prisma.message.findUnique({ where: { id: messageId } });
        if (!escrowMsg || escrowMsg.messageType !== 'ESCROW_TICKET') {
            return res.status(404).json({ success: false, message: 'Escrow ticket not found.' });
        }

        // Parse amount from the escrow message
        const amountMatch = escrowMsg.content.match(/(\d+(?:\.\d+)?)/);
        if (!amountMatch) return res.status(400).json({ success: false, message: 'Could not parse escrow amount.' });
        const amount = parseFloat(amountMatch[1]);

        // Deduct from funder's balance and lock in escrow
        const result = await prisma.$transaction(async (tx) => {
            const funder = await tx.user.findUnique({ where: { id: userId } });
            if (!funder) throw new Error('Funder not found.');
            if (funder.availableBalance < amount) {
                throw new Error(`Insufficient balance. Required: ${amount}, available: ${funder.availableBalance.toFixed(6)}.`);
            }

            await tx.user.update({
                where: { id: userId },
                data: { availableBalance: { decrement: amount } }
            });

            await tx.message.update({
                where: { id: messageId },
                data: { status: 'ESCROW_FUNDED' }
            });

            await tx.transactionHistory.create({
                data: { userId, type: 'ESCROW_FUNDING', amountUsdc: -amount, feeUsdc: 0, status: 'PENDING' }
            });

            return { funder };
        });

        await emitBalanceUpdate(userId);

        const content = `🔒 Escrow funded: ${amount}`;
        const msg = await prisma.message.create({
            data: { conversationId, senderId: userId, messageType: 'TEXT', content },
            include: { sender: { select: { id: true, username: true } } }
        });

        const other = check.conv.participants.find(p => p.id !== userId);
        if (other) {
            const hash = _personalRoomHash(userId, other.id);
            io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(msg));
        }

        res.json({ success: true, data: _formatMessage(msg) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] fund-escrow error');
        res.status(400).json({ success: false, message: err.message });
    }
});

// 6. Release escrow funds
router.post('/:conversationId/messages/:messageId/release-escrow', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const escrowMsg = await prisma.message.findUnique({ where: { id: messageId } });
        if (!escrowMsg || escrowMsg.messageType !== 'ESCROW_TICKET') {
            return res.status(404).json({ success: false, message: 'Escrow ticket not found.' });
        }
        if (escrowMsg.status !== 'ESCROW_FUNDED') {
            return res.status(400).json({ success: false, message: 'Escrow is not funded.' });
        }

        // The original escrow creator's counterparty receives the funds
        const amountMatch = escrowMsg.content.match(/(\d+(?:\.\d+)?)/);
        if (!amountMatch) return res.status(400).json({ success: false, message: 'Could not parse escrow amount.' });
        const amount = parseFloat(amountMatch[1]);

        const recipient = check.conv.participants.find(p => p.id !== escrowMsg.senderId);
        if (!recipient) return res.status(400).json({ success: false, message: 'Cannot determine recipient.' });

        await prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: recipient.id },
                data: { availableBalance: { increment: amount } }
            });
            await tx.message.update({
                where: { id: messageId },
                data: { status: 'ESCROW_RELEASED' }
            });
            await tx.transactionHistory.create({
                data: { userId: recipient.id, type: 'ESCROW_RELEASE', amountUsdc: amount, feeUsdc: 0, status: 'COMPLETED' }
            });
        });

        await emitBalanceUpdate(recipient.id);

        const content = `✅ Escrow released: ${amount} sent to ${recipient.username}`;
        const msg = await prisma.message.create({
            data: { conversationId, senderId: userId, messageType: 'TEXT', content },
            include: { sender: { select: { id: true, username: true } } }
        });

        const hash = _personalRoomHash(userId, recipient.id);
        io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(msg));

        res.json({ success: true, data: _formatMessage(msg) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] release-escrow error');
        res.status(400).json({ success: false, message: err.message });
    }
});

// 7. Dispute an escrow ticket
router.post('/:conversationId/messages/:messageId/dispute-escrow', protectActive, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const { conversationId, messageId } = req.params;
        const userId = req.user.id;
        const { reason } = req.body;

        const check = await _verifyParticipant(prisma, conversationId, userId);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

        const escrowMsg = await prisma.message.findUnique({ where: { id: messageId } });
        if (!escrowMsg || escrowMsg.messageType !== 'ESCROW_TICKET') {
            return res.status(404).json({ success: false, message: 'Escrow ticket not found.' });
        }

        await prisma.message.update({
            where: { id: messageId },
            data: { status: 'ESCROW_DISPUTED' }
        });

        const content = `⚠️ Escrow disputed: ${reason || 'No reason provided'}`;
        const msg = await prisma.message.create({
            data: { conversationId, senderId: userId, messageType: 'TEXT', content },
            include: { sender: { select: { id: true, username: true } } }
        });

        const other = check.conv.participants.find(p => p.id !== userId);
        if (other) {
            const hash = _personalRoomHash(userId, other.id);
            io.to(`personal_${hash}`).emit('new_personal_message', _formatMessage(msg));
        }

        // Notify admins
        io.to('admin_spy_room').emit('escrow_disputed', {
            conversationId, messageId, userId, reason: reason || 'No reason provided'
        });

        res.json({ success: true, data: _formatMessage(msg) });
    } catch (err) {
        logger.error({ err }, '[conversationRoutes] dispute-escrow error');
        res.status(400).json({ success: false, message: err.message });
    }
});

module.exports = router;
