const ADMIN_SPY_ROOM = 'admin_spy_room';

class TradeSocketService {
    constructor(io, prisma) {
        this.io = io;
        this.prisma = prisma;
    }

    emitToTradeAndSpy(tradeId, eventName, payload) {
        const tradeRoom = `trade_${tradeId}`;
        this.io.to(tradeRoom).emit(eventName, payload);
        this.io.to(ADMIN_SPY_ROOM).emit(eventName, { tradeId, ...payload });
    }

    proxyTradeEventToSpy(tradeId, eventName, payload) {
        this.io.to(ADMIN_SPY_ROOM).emit(eventName, { tradeId, ...payload });
    }

    registerHandlers(socket) {
        socket.on('join_admin_spy', (data) => {
            const { adminUserId } = data || {};
            if (!adminUserId) return;
            socket.join(ADMIN_SPY_ROOM);
            logger.info(`🕵️ Admin ${adminUserId} (${socket.id}) joined ${ADMIN_SPY_ROOM}`);
        });

        socket.on('extend_time', async (data) => {
            try {
                const tradeId = parseInt((data.tradeId || '').toString().replace(/^#/, ''));
                const addedMinutes = parseInt(data.addedMinutes, 10);

                if (isNaN(tradeId) || isNaN(addedMinutes) || addedMinutes <= 0) {
                    socket.emit('extend_time_error', { reason: 'invalid_payload' });
                    return;
                }

                const trade = await this.prisma.trade.findUnique({
                    where: { id: tradeId },
                    select: { expiresAt: true, status: true, userId: true, vendorId: true }
                });

                if (!trade) {
                    socket.emit('extend_time_error', { reason: 'trade_not_found' });
                    return;
                }

                const currentExpires = new Date(trade.expiresAt);
                const newExpires = new Date(currentExpires.getTime() + addedMinutes * 60 * 1000);

                await this.prisma.trade.update({
                    where: { id: tradeId },
                    data: { expiresAt: newExpires }
                });

                const logger = require('../src/config/logger');
                const NotificationService = require('./notificationService');
                const notifSvc = new NotificationService(this.prisma, this.io);

                const payload = {
                    tradeId,
                    addedMinutes,
                    newExpiresAt: newExpires,
                    message: `Trade timer extended by ${addedMinutes} minutes.`
                };

                this.emitToTradeAndSpy(tradeId, 'time_extended', payload);

                // Phase N2: route through notificationService for DB + socket + FCM
                await Promise.all([
                    notifSvc.sendNotification({
                        userId: trade.userId,
                        title: 'Timer Extended',
                        body: `Trade #${tradeId} has been extended by ${addedMinutes} minutes.`,
                        category: 'GENERAL',
                        actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
                    }),
                    notifSvc.sendNotification({
                        userId: trade.vendorId,
                        title: 'Timer Extended',
                        body: `Trade #${tradeId} has been extended by ${addedMinutes} minutes.`,
                        category: 'GENERAL',
                        actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
                    })
                ]);

                logger.info(`⏱️ Trade #${tradeId} extended by ${addedMinutes}min → ${newExpires.toISOString()}`);
            } catch (err) {
                logger.error({ err: err }, 'extend_time error');
                socket.emit('extend_time_error', { reason: 'server_error', detail: err.message });
            }
        });

        this._registerProxyInterceptors(socket);
    }

    _registerProxyInterceptors(socket) {
        const self = this;
        const originalEmit = socket.emit;
        const originalBroadcast = this.io.to.bind(this.io);

        const tradeRoomEvents = ['chat_message', 'time_extended', 'milestone_warning', 'trade_update', 'payment_confirmed', 'new_message'];

        for (const event of tradeRoomEvents) {
            socket.on(event, (data) => {
                const tradeId = self._extractTradeId(data);
                if (tradeId) {
                    self.proxyTradeEventToSpy(tradeId, event, data);
                }
            });
        }
    }

    _extractTradeId(data) {
        if (!data) return null;
        if (data.tradeId) {
            return parseInt(data.tradeId.toString().replace(/^#/, ''));
        }
        return null;
    }

    emitMilestoneWarning(tradeId, milestonePercent) {
        const payload = {
            tradeId,
            milestone: `${milestonePercent}%`,
            message: 'Time is running out! Please update the vendor or request an extension.',
            timestamp: new Date().toISOString()
        };
        this.emitToTradeAndSpy(tradeId, 'milestone_warning', payload);
        return payload;
    }
}

module.exports = TradeSocketService;
