// services/chatSocketService.js
// =============================================================================
// AZAMAN V2 — DUAL-ENVIRONMENT CHAT SOCKET SERVICE
// Phase 2.3: Strict room segregation + in-chat crypto transfer
//
// Room naming contract (never changes):
//   Trade chat  : trade_${tradeId}
//   Personal    : personal_${sha256(sorted_user_ids)[:32]}
//   User inbox  : user_${userId}
//   Admin spy   : admin_spy_room
//   Balance     : balance_room_${userId}
// =============================================================================

const crypto = require('crypto');
const ADMIN_SPY_ROOM = 'admin_spy_room';

class ChatSocketService {
    constructor(io, prisma) {
        this.io     = io;
        this.prisma = prisma;
    }

    // ── Room helpers ──────────────────────────────────────────────────────────

    /**
     * Deterministic personal room hash — same result regardless of who calls first.
     * Sorts the two IDs so hash(A, B) === hash(B, A).
     */
    generatePersonalRoomHash(userId1, userId2) {
        const sorted = [String(userId1), String(userId2)].sort();
        return crypto
            .createHash('sha256')
            .update(sorted.join('_'))
            .digest('hex')
            .slice(0, 32);
    }

    getPersonalRoomHashFromIds(userId1, userId2) {
        return { roomHash: this.generatePersonalRoomHash(userId1, userId2) };
    }

    // ── Conversation factories ─────────────────────────────────────────────────

    async getOrCreatePersonalConversation(userId1, userId2) {
        const hash = this.generatePersonalRoomHash(userId1, userId2);

        let conversation = await this.prisma.conversation.findFirst({
            where: {
                type: 'PERSONAL',
                participants: {
                    every: { id: { in: [parseInt(userId1), parseInt(userId2)] } }
                }
            },
            include: { participants: true }
        });

        if (!conversation) {
            conversation = await this.prisma.conversation.create({
                data: {
                    type: 'PERSONAL',
                    participants: {
                        connect: [
                            { id: parseInt(userId1) },
                            { id: parseInt(userId2) }
                        ]
                    }
                },
                include: { participants: true }
            });
        }

        return { conversation, roomHash: hash };
    }

    async getOrCreateTradeConversation(tradeId) {
        let conversation = await this.prisma.conversation.findUnique({
            where: { tradeId: String(tradeId) },
            include: { participants: true }
        });

        if (!conversation) {
            const trade = await this.prisma.trade.findUnique({
                where:  { id: parseInt(tradeId) },
                select: { userId: true, vendorId: true }
            });
            if (!trade) return null;

            conversation = await this.prisma.conversation.create({
                data: {
                    type:    'TRADE',
                    tradeId: String(tradeId),
                    participants: {
                        connect: [{ id: trade.userId }, { id: trade.vendorId }]
                    }
                },
                include: { participants: true }
            });
        }

        return conversation;
    }

    // ── Broadcast helpers ─────────────────────────────────────────────────────

    /** Emit to room AND mirror to admin spy room. */
    emitToRoomAndSpy(roomId, eventName, payload) {
        this.io.to(roomId).emit(eventName, payload);
        this.io.to(ADMIN_SPY_ROOM).emit(eventName, { roomId, ...payload });
    }

    // ── Socket event handlers ─────────────────────────────────────────────────

    registerHandlers(socket) {

        // ── 1. JOIN TRADE CHAT ──────────────────────────────────────────────
        socket.on('join_trade_chat', async (data) => {
            try {
                const { tradeId, userId } = data;
                if (!tradeId || !userId) return;

                const cleanId = String(tradeId).replace(/^#/, '');
                const trade   = await this.prisma.trade.findUnique({
                    where: { id: parseInt(cleanId) }
                });

                if (!trade) {
                    socket.emit('chat_error', { reason: 'trade_not_found' });
                    return;
                }

                const isParticipant =
                    trade.userId   === parseInt(userId) ||
                    trade.vendorId === parseInt(userId);

                if (!isParticipant) {
                    socket.emit('chat_error', { reason: 'not_participant' });
                    return;
                }

                const room = `trade_${cleanId}`;
                socket.join(room);
                socket.join(`user_${userId}`);

                await this.getOrCreateTradeConversation(cleanId);
                console.log(`💬 ${socket.id} → trade room ${room}`);
            } catch (err) {
                console.error('join_trade_chat error:', err.message);
                socket.emit('chat_error', { reason: 'server_error' });
            }
        });

        // ── 2. JOIN PERSONAL CHAT ───────────────────────────────────────────
        socket.on('join_personal_chat', async (data) => {
            try {
                const { otherUserId, userId } = data;
                if (!otherUserId || !userId) return;

                const { conversation, roomHash } =
                    await this.getOrCreatePersonalConversation(userId, otherUserId);

                const room = `personal_${roomHash}`;
                socket.join(room);
                socket.join(`user_${userId}`);

                console.log(`💬 ${socket.id} → personal room ${room}`);
                socket.emit('personal_chat_joined', {
                    conversationId: conversation.id,
                    roomHash,
                    participants: conversation.participants.map(p => ({
                        id: p.id, username: p.username
                    }))
                });
            } catch (err) {
                console.error('join_personal_chat error:', err.message);
                socket.emit('chat_error', { reason: 'server_error' });
            }
        });

        // ── 3. SEND PERSONAL MESSAGE ────────────────────────────────────────
        socket.on('send_personal_message', async (data) => {
            try {
                const { senderId, content, otherUserId, messageType } = data;
                if (!senderId || !otherUserId || !content) return;

                const { conversation, roomHash } =
                    await this.getOrCreatePersonalConversation(senderId, otherUserId);

                const room = `personal_${roomHash}`;

                const message = await this.prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        senderId:       parseInt(senderId),
                        messageType:    messageType || 'TEXT',
                        content
                    },
                    include: { sender: { select: { id: true, username: true } } }
                });

                const payload = {
                    id:             message.id,
                    conversationId: conversation.id,
                    sender:         message.sender,
                    messageType:    message.messageType,
                    content:        message.content,
                    createdAt:      message.createdAt
                };

                this.emitToRoomAndSpy(room, 'new_personal_message', payload);

                // Offline FCM push
                const otherUserIdNum   = parseInt(otherUserId);
                const otherRoomSockets = await this.io.in(`user_${otherUserIdNum}`).allSockets();
                if (otherRoomSockets.size === 0) {
                    const otherUser = await this.prisma.user.findUnique({
                        where:  { id: otherUserIdNum },
                        select: { fcmToken: true }
                    });
                    if (otherUser?.fcmToken) {
                        const { sendPushNotification } = require('../utils/firebaseService');
                        await sendPushNotification(
                            otherUser.fcmToken,
                            'New Message',
                            content.substring(0, 100),
                            {
                                type:           'PERSONAL_CHAT',
                                conversationId: conversation.id,
                                route:          `/chat/${conversation.id}`
                            }
                        );
                    }
                }
            } catch (err) {
                console.error('send_personal_message error:', err.message);
                socket.emit('chat_error', { reason: 'server_error' });
            }
        });

        // ── 4. SEND TRADE MESSAGE ───────────────────────────────────────────
        socket.on('send_trade_message', async (data) => {
            try {
                const { senderId, content, tradeId, messageType } = data;
                if (!senderId || !tradeId || !content) return;

                const cleanId      = String(tradeId).replace(/^#/, '');
                const conversation = await this.getOrCreateTradeConversation(cleanId);
                if (!conversation) {
                    socket.emit('chat_error', { reason: 'trade_not_found' });
                    return;
                }

                const room = `trade_${cleanId}`;

                const message = await this.prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        senderId:       parseInt(senderId),
                        messageType:    messageType || 'TEXT',
                        content
                    },
                    include: { sender: { select: { id: true, username: true } } }
                });

                // Broadcast payload — includes `text` alias for Flutter clients
                // and `tempId` for dedup on the receiving end.
                const payload = {
                    id:             message.id,
                    conversationId: conversation.id,
                    tradeId:        cleanId,
                    sender:         message.sender,
                    senderId:       message.sender?.id,
                    messageType:    message.messageType,
                    content:        message.content,
                    text:           message.content,
                    createdAt:      message.createdAt,
                    tempId:         data.tempId || null
                };

                // Broadcast to room (other party receives via 'new_trade_message')
                this.emitToRoomAndSpy(room, 'new_trade_message', payload);

                // Sender acknowledgment — transitions optimistic bubble from
                // 'sending' (clock) → 'sent' (single tick) via tempId match.
                socket.emit('message_saved', {
                    id:        message.id,
                    tempId:    data.tempId || null,
                    tradeId:   cleanId,
                    createdAt: message.createdAt
                });

                // Delivery receipt — transitions to 'delivered' (double tick).
                socket.emit('message_delivered', {
                    id:        message.id,
                    tempId:    data.tempId || null,
                    tradeId:   cleanId,
                    status:    'delivered'
                });

                console.log(`✅ [ChatService] Message #${message.id} saved & ack'd → trade_${cleanId}`);

                // ── NOTIFICATION + OFFLINE PUSH ──────────────────────────────
                // Create a DB notification for the recipient, emit real-time
                // socket event to their user room, and fire FCM if offline.
                try {
                    const trade = await this.prisma.trade.findUnique({
                        where:  { id: parseInt(cleanId) },
                        select: { userId: true, vendorId: true }
                    });

                    if (trade) {
                        const numericSenderId = parseInt(senderId);
                        const recipientId = (trade.userId === numericSenderId)
                            ? trade.vendorId
                            : trade.userId;

                        const snippet = content.substring(0, 100);
                        const notifPayload = {
                            route:   `/trade/${cleanId}`,
                            action:  'OPEN_TRADE',
                            tradeId: cleanId
                        };

                        // 1. Persist notification to DB (shows in notification hub)
                        const notifRecord = await this.prisma.notification.create({
                            data: {
                                userId:        recipientId,
                                title:         `💬 Trade #${cleanId}`,
                                body:          snippet,
                                category:      'GENERAL',
                                actionPayload: notifPayload
                            }
                        });

                        // 2. Emit real-time socket event (updates bell icon live)
                        this.io.to(`user_${recipientId}`).emit('new_notification', {
                            id:            notifRecord.id,
                            title:         notifRecord.title,
                            body:          notifRecord.body,
                            category:      notifRecord.category,
                            actionPayload: notifPayload,
                            createdAt:     notifRecord.createdAt,
                            isRead:        false
                        });

                        // 3. FCM push if recipient is offline
                        const recipientRoom = `user_${recipientId}`;
                        const recipientSockets = await this.io.in(recipientRoom).allSockets();

                        if (recipientSockets.size === 0) {
                            const recipientUser = await this.prisma.user.findUnique({
                                where:  { id: recipientId },
                                select: { fcmToken: true }
                            });

                            if (recipientUser?.fcmToken) {
                                const { sendPushNotification } = require('../utils/firebaseService');
                                await sendPushNotification(
                                    recipientUser.fcmToken,
                                    `💬 Trade #${cleanId}`,
                                    snippet,
                                    { type: 'TRADE_CHAT', ...notifPayload }
                                );
                                console.log(`📲 [ChatService] FCM push sent to user ${recipientId} (offline)`);
                            }
                        }
                    }
                } catch (pushErr) {
                    // Notification is non-fatal — log and continue
                    console.error('[ChatService] Notification error (non-fatal):', pushErr.message);
                }
            } catch (err) {
                console.error('send_trade_message error:', err.message);
                socket.emit('message_error', {
                    reason: 'server_error',
                    detail: err.message,
                    tempId: data.tempId || null
                });
            }
        });

        // ── 5. IN-CHAT CRYPTO TRANSFER (socket event path) ──────────────────
        // The authoritative ACID path is POST /api/chat/transfer.
        // This handler is a real-time complement: clients that want immediate
        // socket confirmation before the HTTP response can also fire this event.
        // The service layer handles the $transaction — this just routes the call.
        socket.on('send_crypto_transfer', async (data) => {
            try {
                const { senderId, receiverId, amountUsdc, conversationId } = data;
                if (!senderId || !receiverId || !amountUsdc) return;

                // Signal both users to refresh via REST — the actual debit/credit
                // is handled by POST /api/chat/transfer to guarantee ACID safety.
                this.io.to(`user_${senderId}`).emit('transfer_pending', {
                    conversationId, amountUsdc
                });
                this.io.to(`user_${receiverId}`).emit('transfer_incoming', {
                    conversationId, amountUsdc, fromUserId: senderId
                });
            } catch (err) {
                console.error('send_crypto_transfer socket error:', err.message);
            }
        });

        // ── 6. ADMIN SPY JOIN ───────────────────────────────────────────────
        socket.on('join_admin_spy', (data) => {
            const { adminUserId } = data || {};
            if (!adminUserId) return;
            socket.join(ADMIN_SPY_ROOM);
            console.log(`🕵️ Admin ${adminUserId} (${socket.id}) → ${ADMIN_SPY_ROOM}`);
        });

        // ── 7. TYPING INDICATORS ────────────────────────────────────────────
        socket.on('typing_personal', (data) => {
            const { userId, otherUserId } = data;
            if (!userId || !otherUserId) return;
            const roomHash = this.generatePersonalRoomHash(userId, otherUserId);
            socket
                .to(`personal_${roomHash}`)
                .emit('user_typing_personal', { userId, isTyping: data.isTyping });
        });

        socket.on('typing_trade', (data) => {
            const { tradeId, userId } = data;
            if (!tradeId || !userId) return;
            const cleanId = String(tradeId).replace(/^#/, '');
            socket
                .to(`trade_${cleanId}`)
                .emit('user_typing_trade', { userId, isTyping: data.isTyping });
        });
    }
}

module.exports = ChatSocketService;
