const logger = require('../src/config/logger');
const NotificationService = require('../services/notificationService');

const checkMilestones = async (userId, tradeId) => {
    const prisma = global.prismaInstance;
    const io = global.socketIoInstance;

    try {
        const totalVolumeResult = await prisma.transactionHistory.aggregate({
            where: {
                userId: String(userId),
                status: 'COMPLETED',
            },
            _sum: {
                amountUsdc: true,
            },
        });

        const totalVolume = totalVolumeResult._sum.amountUsdc || 0;

        const allBadges = await prisma.badge.findMany({
            orderBy: { requiredVolume: 'asc' },
        });

        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId) },
            include: {
                earnedBadges: true,
            },
        });

        if (!user) return;

        const earnedBadgeIds = user.earnedBadges.map(b => b.id);

        for (const badge of allBadges) {
            if (earnedBadgeIds.includes(badge.id)) continue;

            if (totalVolume >= badge.requiredVolume && badge.requiredVolume > 0) {
                await prisma.$transaction(async (tx) => {
                    await tx.user.update({
                        where: { id: parseInt(userId) },
                        data: {
                            earnedBadges: {
                                connect: { id: badge.id },
                            },
                        },
                    });
                });

                // Phase N2: fire badge notifications post-commit via notificationService
                const notifSvc = new NotificationService(prisma, io);
                setImmediate(() => {
                    Promise.all([
                        notifSvc.sendNotification({
                            userId: parseInt(userId),
                            title: 'Badge Unlocked!',
                            body: `You earned the "${badge.name}" badge! Required volume: ${badge.requiredVolume} USDC.`,
                            category: 'GENERAL',
                            actionPayload: { action: 'VIEW_BADGE', badgeId: badge.id }
                        }),
                        notifSvc.sendNotification({
                            userId: 1,
                            title: 'Discount Approval Request',
                            body: `User #${userId} unlocked "${badge.name}" badge with ${totalVolume.toFixed(2)} USDC total volume. Approve a discount credit?`,
                            category: 'ADMIN_SYSTEM',
                            actionPayload: {
                                action: 'APPROVE_DISCOUNT',
                                userId: parseInt(userId),
                                badgeId: badge.id,
                                badgeName: badge.name,
                                totalVolume,
                                tradeId: tradeId ? parseInt(tradeId) : null
                            }
                        })
                    ]).catch(err => logger.error({ err: err }, '[Milestones] post-commit notif error'));
                });

                if (io) {
                    io.to(`user_${userId}`).emit('badge_unlocked', {
                        badgeId: badge.id,
                        badgeName: badge.name,
                        badgeIcon: badge.iconUrl,
                        totalVolume,
                    });

                    io.emit('admin_alert', {
                        type: 'DISCOUNT_APPROVAL_REQUEST',
                        userId: parseInt(userId),
                        badgeId: badge.id,
                        badgeName: badge.name,
                        totalVolume,
                        tradeId: tradeId ? parseInt(tradeId) : null,
                    });
                }

                logger.info(`[Milestones] User #${userId} unlocked badge "${badge.name}" at volume ${totalVolume} USDC. Discount approval sent to Admin.`);
            }
        }
    } catch (error) {
        logger.error({ err: error }, '[Milestones] checkMilestones error');
    }
};

const checkMilestonesMiddleware = (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (body) => {
        if (body && body.success && req.user && req.user.id) {
            const tradeId = body.trade?.id || body.data?.trade?.id || null;
            checkMilestones(req.user.id, tradeId);
        }
        return originalJson(body);
    };

    next();
};

module.exports = { checkMilestones, checkMilestonesMiddleware };
