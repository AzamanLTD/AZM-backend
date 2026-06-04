const NotificationService = require('../services/notificationService');

class AdminChatController {
    constructor(prisma, io) {
        this.prisma = prisma;
        this.io = io;
        this.notificationService = new NotificationService(prisma, io);
    }

    async intervene(req, res) {
        const { tradeId } = req.params;
        const { content } = req.body;
        const adminId = req.user.id;

        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }

        const cleanId = String(tradeId).replace(/^#/, '');
        const tradeIdInt = parseInt(cleanId);

        if (isNaN(tradeIdInt)) {
            return res.status(400).json({ success: false, message: 'Invalid tradeId.' });
        }

        try {
            const trade = await this.prisma.trade.findUnique({
                where: { id: tradeIdInt },
                select: { id: true, userId: true, vendorId: true }
            });

            if (!trade) {
                return res.status(404).json({ success: false, message: 'Trade not found.' });
            }

            let conversation = await this.prisma.conversation.findUnique({
                where: { tradeId: cleanId }
            });

            if (!conversation) {
                conversation = await this.prisma.conversation.create({
                    data: {
                        type: 'TRADE',
                        tradeId: cleanId,
                        participants: {
                            connect: [{ id: trade.userId }, { id: trade.vendorId }]
                        }
                    }
                });
            }

            const message = await this.prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    senderId: parseInt(adminId),
                    messageType: 'ADMIN_INTERVENTION',
                    content: content.trim()
                },
                include: { sender: { select: { id: true, username: true, role: true } } }
            });

            const room = `trade_${cleanId}`;
            const payload = {
                id: message.id,
                conversationId: conversation.id,
                tradeId: cleanId,
                sender: message.sender,
                messageType: 'ADMIN_INTERVENTION',
                content: message.content,
                createdAt: message.createdAt
            };

            this.io.to(room).emit('new_trade_message', payload);
            this.io.to('admin_spy_room').emit('new_trade_message', { roomId: room, ...payload });

            // Phase N2: route through notificationService (DB + socket + FCM)
            const notifBody = content.trim().substring(0, 200);
            const notifPayload = { action: 'OPEN_TRADE', tradeId: cleanId };
            await Promise.all([
                this.notificationService.sendNotification({
                    userId: trade.userId,
                    title: 'Admin Intervention',
                    body: notifBody,
                    category: 'ADMIN_SYSTEM',
                    actionPayload: notifPayload
                }),
                this.notificationService.sendNotification({
                    userId: trade.vendorId,
                    title: 'Admin Intervention',
                    body: notifBody,
                    category: 'ADMIN_SYSTEM',
                    actionPayload: notifPayload
                })
            ]);

            res.status(201).json({
                success: true,
                message: 'Admin intervention message sent.',
                data: {
                    messageId: message.id,
                    conversationId: conversation.id,
                    tradeId: cleanId
                }
            });
        } catch (error) {
            console.error('Admin chat intervention error:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    }
}

module.exports = AdminChatController;
