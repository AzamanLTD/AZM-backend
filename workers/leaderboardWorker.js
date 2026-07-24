// workers/leaderboardWorker.js
// =============================================================================
// AZAMAN V2 — LEADERBOARD WORKER  (Phase 2.4 Upgrade)
//
// Schedule: every Sunday at midnight  ('0 0 * * 0')
//
// Pipeline:
//   1. Aggregate TransactionHistory volume per user for the current week
//   2. Save/replace up to 50 LeaderboardRecord rows in one $transaction
//   3. Award the "High Volume" badge to the top-5 users (idempotent)
//   4. For top-10 users:
//        a) Emit a 'leaderboard_update' socket event to each user
//        b) Write a personal GENERAL notification (deep-linked to /leaderboard)
//        c) Write an ADMIN_SYSTEM notification flagging each for discount review
// =============================================================================

const logger = require('../src/config/logger');
const NotificationService = require('../services/notificationService');

class LeaderboardWorker {
    /**
     * @param {import('@prisma/client').PrismaClient} prisma
     * @param {import('socket.io').Server} [io]
     */
    constructor(prisma, io = null) {
        this.prisma  = prisma;
        this.io      = io;
        this.cronJob = null;
    }

    /** Allow server.js to inject io after construction. */
    setIo(io) {
        this.io = io;
    }

    start() {
        const cron   = require('node-cron');
        // Every Sunday at 00:00
        this.cronJob = cron.schedule('0 0 * * 0', () => {
            logger.info('📊 Leaderboard cron triggered — computing weekly rankings...');
            this.computeWeeklyLeaderboard();
        });
        logger.info('📊 Leaderboard cron scheduled (every Sunday at midnight)');
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            logger.info('📊 Leaderboard cron stopped');
        }
    }

    async computeWeeklyLeaderboard() {
        try {
            const now           = new Date();
            const daysSinceSun  = now.getDay();
            const weekStartDate = new Date(now);
            weekStartDate.setDate(now.getDate() - daysSinceSun);
            weekStartDate.setHours(0, 0, 0, 0);

            const weekEndDate = new Date(weekStartDate);
            weekEndDate.setDate(weekStartDate.getDate() + 7);

            // ── 1. Aggregate weekly volume per user ────────────────────────
            const volumeAggregation = await this.prisma.transactionHistory.groupBy({
                by:      ['userId'],
                where: {
                    createdAt: { gte: weekStartDate, lt: weekEndDate },
                    status:    'COMPLETED'
                },
                _sum:    { amountUsdc: true },
                orderBy: { _sum: { amountUsdc: 'desc' } }
            });

            const top50 = volumeAggregation.slice(0, 50);

            if (top50.length === 0) {
                logger.info('📊 No transaction volume found for this week. Skipping leaderboard.');
                return;
            }

            const notifSvc = new NotificationService(this.prisma, this.io);

            // ── 2 + 3. Save records & award badge ($transaction) ───────────
            await this.prisma.$transaction(async (tx) => {

                // Replace this week's records
                await tx.leaderboardRecord.deleteMany({
                    where: { weekStartDate: { equals: weekStartDate } }
                });

                const records = top50.map((entry, index) => ({
                    userId:       entry.userId,
                    weekStartDate,
                    totalVolume:  entry._sum.amountUsdc || 0,
                    rank:         index + 1
                }));

                await tx.leaderboardRecord.createMany({ data: records });

                // Award "High Volume" badge to top-5 (idempotent)
                let highVolumeBadge = await tx.badge.findFirst({
                    where: { name: 'High Volume' }
                });

                if (!highVolumeBadge) {
                    highVolumeBadge = await tx.badge.create({
                        data: {
                            name:           'High Volume',
                            iconUrl:        '/badges/high-volume.png',
                            description:    'Awarded to top 5 traders by weekly USDC volume',
                            requiredVolume: 0
                        }
                    });
                }

                const top5UserIds = top50
                    .slice(0, 5)
                    .map(e => parseInt(e.userId, 10));

                const existingConnections = await tx.user.findMany({
                    where: {
                        id:          { in: top5UserIds },
                        earnedBadges: { some: { id: highVolumeBadge.id } }
                    },
                    select: { id: true }
                });

                const alreadyBadged = new Set(existingConnections.map(u => u.id));

                for (const uid of top5UserIds) {
                    if (!alreadyBadged.has(uid)) {
                        await tx.user.update({
                            where: { id: uid },
                            data:  { earnedBadges: { connect: { id: highVolumeBadge.id } } }
                        });
                    }
                }
            });

            // ── 4. Notify top-10 users + admin discount flags ──────────────
            const top10 = top50.slice(0, 10);

            for (const entry of top10) {
                const userId     = parseInt(entry.userId, 10);
                const rank       = top50.indexOf(entry) + 1;
                const totalVolume = entry._sum.amountUsdc || 0;

                // 4a. Real-time socket event to the user's personal room
                if (this.io) {
                    this.io.to(`user_${userId}`).emit('leaderboard_update', {
                        rank,
                        totalVolume,
                        weekStartDate: weekStartDate.toISOString(),
                        message: `You are #${rank} on the leaderboard this week!`
                    });
                }

                // 4b. Personal deep-link notification → /leaderboard
                try {
                    await notifSvc.sendNotification({
                        userId,
                        ...notifSvc.formatLeaderboardTopUser(rank, totalVolume)
                    });
                } catch (e) {
                    logger.error(`[Leaderboard] User ${userId} notification error:`, e.message);
                }

                // 4c. Admin discount-approval flag (only for top-3)
                if (rank <= 3) {
                    try {
                        await notifSvc.sendNotification({
                            userId: 1, // admin
                            ...notifSvc.formatAdminDiscountApprovalRequest(userId, rank, totalVolume)
                        });
                    } catch (e) {
                        logger.error(`[Leaderboard] Admin flag error for user ${userId}:`, e.message);
                    }
                }
            }

            logger.info(
                `📊 Leaderboard saved: ${top50.length} users ranked. ` +
                `Top 5 awarded "High Volume" badge. Top 10 notified.`
            );

        } catch (error) {
            logger.error({ err: error }, '📊 Leaderboard cron error');
        }
    }
}

module.exports = LeaderboardWorker;
