/**
 * Socket.IO Connection Handler
 *
 * Extracted from server.js as part of Phase 1 modularization.
 * Handles all real-time socket events: room management, trade execution,
 * chat, friend presence, balance updates, etc.
 *
 * @param {object} io            - Socket.IO server instance
 * @param {object} deps           - Dependency bag
 * @param {object} deps.prisma    - Prisma client
 * @param {object} deps.socketRateLimiter
 * @param {object} deps.logger
 * @param {object} deps.tradeSocketService
 * @param {object} deps.chatSocketService
 * @param {object} deps.groupChatSocketService
 * @param {object} deps.friendSocketService
 * @param {object} deps.ticketSocketService
 * @param {object} deps.notificationService
 * @param {function} deps.pushIfOffline
 * @param {function} deps.emitBalanceUpdate
 */
const logger = require('../config/logger');

function setupSocketHandlers(io, deps) {
    const {
        prisma,
        socketRateLimiter,
        tradeSocketService,
        chatSocketService,
        groupChatSocketService,
        friendSocketService,
        ticketSocketService,
        notificationService,
        webrtcSocketService,
        pushIfOffline,
        emitBalanceUpdate,
    } = deps;

    io.on('connection', (socket) => {
        const userId = socket.user.id;

        // Attach BEFORE any event handlers below run so it guards every one.
        socketRateLimiter.attach(socket);

        // Auto-join user's own rooms (safe — verified by JWT)
        socket.join(`user_${userId}`);
        socket.join(`balance_room_${userId}`);

        // Emit current balance immediately on connection
        emitBalanceUpdate(userId).catch(err => {
            logger.error({ err }, 'Socket connect: initial balance emit error');
        });

        // ── B-7: Online / Offline / Last-Seen tracking ────────────────────────
        prisma.user.update({
            where: { id: userId },
            data: { isOnline: true, lastSeenAt: new Date() },
        }).catch(() => {});

        socket.broadcast.emit('user_online', { userId, lastSeenAt: new Date().toISOString() });

        socket.on('user_heartbeat', () => {
            prisma.user.update({
                where: { id: userId },
                data: { lastSeenAt: new Date() },
            }).catch(() => {});
        });

        // 1. Room Management — VALIDATED against socket.user
        socket.on('join_balance_room', (requestedUserId) => {
            if (parseInt(requestedUserId) === userId) {
                socket.join(`balance_room_${userId}`);
            }
        });

        socket.on('join_user_room', (data) => {
            let requestedId;
            if (typeof data === 'object' && data !== null) {
                requestedId = data.userId || data.id;
            } else {
                requestedId = data;
            }
            if (parseInt(requestedId) === userId) {
                socket.join(`user_${userId}`);
            }
        });

        // Master Sprint: Group chat & Susu rooms
        socket.on('join_group', async (groupId) => {
            if (!groupId) return;
            try {
                const member = await prisma.groupMember.findUnique({
                    where: { groupId_userId: { groupId, userId } },
                });
                if (member && !member.removedAt) {
                    socket.join(`group_${groupId}`);
                }
            } catch (_) { /* swallow */ }
        });
        socket.on('leave_group', (groupId) => {
            if (groupId) socket.leave(`group_${groupId}`);
        });

        socket.on('join_susu', async (susuGroupId) => {
            if (!susuGroupId) return;
            try {
                const m = await prisma.susuMember.findUnique({
                    where: { susuGroupId_userId: { susuGroupId, userId } },
                });
                if (m) socket.join(`susu_${susuGroupId}`);
            } catch (_) { /* swallow */ }
        });
        socket.on('leave_susu', (susuGroupId) => {
            if (susuGroupId) socket.leave(`susu_${susuGroupId}`);
        });

        socket.on('join_trade', async (tradeId) => {
            if (!tradeId) return;
            const cleanId = tradeId.toString().replace(/^#/, '');
            try {
                const trade = await prisma.trade.findUnique({
                    where: { id: parseInt(cleanId) },
                    select: { userId: true, vendorId: true }
                });
                if (trade && (trade.userId === userId || trade.vendorId === userId)) {
                    socket.join(`trade_${cleanId}`);
                }
            } catch (err) { /* Silently reject invalid trade IDs */ }
        });

        // Order tracking room — customer or business owner can join
        socket.on('join_order', async (data) => {
            const orderId = typeof data === 'object' ? data?.orderId : data;
            if (!orderId) return;
            try {
                const order = await prisma.businessOrder.findUnique({
                    where: { id: orderId.toString() },
                    select: { customerId: true, businessProfileId: true }
                });
                if (order) {
                    // Check if user is the customer or the business owner
                    const bizProfile = await prisma.businessProfile.findUnique({
                        where: { id: order.businessProfileId },
                        select: { userId: true }
                    });
                    if (order.customerId === userId || bizProfile?.userId === userId) {
                        socket.join(`order_${orderId}`);
                    }
                }
            } catch (err) { /* Silently reject invalid order IDs */ }
        });
        socket.on('leave_order', (data) => {
            const orderId = typeof data === 'object' ? data?.orderId : data;
            if (orderId) socket.leave(`order_${orderId}`);
        });

        // --- Socket Service Handlers ---
        tradeSocketService.registerHandlers(socket);
        chatSocketService.registerHandlers(socket);
        groupChatSocketService.registerHandlers(socket);
        friendSocketService.registerHandlers(socket);
        ticketSocketService.registerHandlers(socket);

        // 2. LIVE CHAT
        socket.on('typing', (data) => {
            if (data && data.tradeId) {
                socket.to(`trade_${data.tradeId}`).emit('vendor_typing', { isTyping: data.isTyping });
            }
        });

        socket.on('mark_messages_read', async (data) => {
            try {
                const rawTradeId = (data.tradeId || '').toString().replace(/^#/, '');
                const tradeId = parseInt(rawTradeId);
                if (isNaN(tradeId)) return;

                const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
                if (!trade) return;
                if (trade.userId !== userId && trade.vendorId !== userId) return;

                socket.to(`trade_${tradeId}`).emit('messages_read_update', {
                    readerId: userId === trade.userId ? 'buyer' : 'vendor',
                    tradeId: tradeId,
                    readAt: new Date().toISOString()
                });
            } catch (err) {
                logger.error({ err }, "mark_messages_read error");
            }
        });

        // 3. TRADE EXECUTION — CRITICAL-5: Authorization check
        socket.on('vendor_accept', async (data) => {
            try {
                const tradeId = parseInt((data.tradeId || '').toString().replace(/^#/, ''));
                if (isNaN(tradeId)) return;

                const trade = await prisma.trade.findUnique({
                    where: { id: tradeId },
                    select: { vendorId: true, userId: true, status: true }
                });

                if (!trade) {
                    socket.emit('trade_error', { message: 'Trade not found.', tradeId });
                    return;
                }
                if (trade.vendorId !== userId) {
                    socket.emit('trade_error', { message: 'Not authorized: You are not the vendor on this trade.', tradeId });
                    return;
                }
                if (trade.status !== 'PENDING' && trade.status !== 'PENDING_PAYMENT') {
                    socket.emit('trade_error', { message: `Cannot accept: trade is already ${trade.status}.`, tradeId });
                    return;
                }

                const claimed = await prisma.trade.updateMany({
                    where: { id: tradeId, status: { in: ['PENDING', 'PENDING_PAYMENT'] } },
                    data:  { status: 'PENDING_PAYMENT' }
                });
                if (claimed.count === 0) return;

                const updatedTrade = await prisma.trade.findUnique({ where: { id: tradeId } });
                io.to(`trade_${tradeId}`).emit('trade_update', {
                    status: 'PENDING_PAYMENT',
                    vendorPaymentDetails: updatedTrade.vendorPaymentDetails
                });

                await notificationService.sendNotification({
                    userId:        trade.userId,
                    title:         'Trade Accepted',
                    body:          `Vendor accepted your order #${tradeId}. Complete payment to continue.`,
                    category:      'TRADE',
                    actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
                });
                pushIfOffline(
                    trade.userId,
                    'Trade Accepted',
                    `Vendor accepted your order #${tradeId}. Complete payment to continue.`,
                    { type: 'TRADE_UPDATE', tradeId: tradeId }
                );
            } catch (e) {
                logger.error({ err: e }, "vendor_accept error");
            }
        });

        // HIGH-10: Admin spy room
        socket.on('join_admin_spy', () => {
            if (socket.user.role === 'ADMIN') {
                socket.join('admin_spy_room');
            } else {
                socket.emit('error', { message: 'Access denied: Admin role required.' });
            }
        });

        // ── WebRTC CALL SIGNALING ────────────────────────────────────────────
        if (webrtcSocketService) {
            webrtcSocketService.register(socket, userId);
        }

        socket.on('disconnect', () => {
            const now = new Date();
            prisma.user.update({
                where: { id: userId },
                data: { isOnline: false, lastSeenAt: now },
            }).catch(() => {});
            socket.broadcast.emit('user_offline', { userId, lastSeenAt: now.toISOString() });
        });
    });
}

module.exports = { setupSocketHandlers };
