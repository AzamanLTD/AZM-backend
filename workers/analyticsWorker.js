const logger = require('../src/config/logger');
const { getReadPrisma } = require('../src/config/readReplica');

class AnalyticsWorker {
    constructor(prisma, app = null) {
        this.prisma = prisma;
        this.app = app;
        this.cronJob = null;
    }

    /** Use the read replica for analytics queries when available. */
    get readPrisma() {
        return this.app ? getReadPrisma(this.app) : this.prisma;
    }

    start() {
        const cron = require('node-cron');
        this.cronJob = cron.schedule('0 * * * *', () => {
            logger.info('📈 Analytics cron triggered — aggregating daily metrics...');
            this.aggregateDailySnapshot();
        });
        logger.info('📈 Analytics cron scheduled (every hour)');
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            logger.info('📈 Analytics cron stopped');
        }
    }

    async aggregateDailySnapshot() {
        try {
            const now = new Date();
            const startOfDay = new Date(now);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(now);
            endOfDay.setHours(23, 59, 59, 999);

            const totalVolumeResult = await this.readPrisma.transactionHistory.aggregate({
                where: {
                    createdAt: {
                        gte: startOfDay,
                        lte: endOfDay,
                    },
                    status: 'COMPLETED',
                },
                _sum: {
                    amountUsdc: true,
                },
            });

            const totalVolumeUsdc = totalVolumeResult._sum.amountUsdc || 0;

            const profitBySourceRaw = await this.readPrisma.adminProfitLog.groupBy({
                by: ['source'],
                where: {
                    createdAt: {
                        gte: startOfDay,
                        lte: endOfDay,
                    },
                },
                _sum: {
                    amountUsdc: true,
                },
            });

            const profitBySource = {};
            let totalProfitUsdc = 0;
            for (const entry of profitBySourceRaw) {
                const sum = entry._sum.amountUsdc || 0;
                profitBySource[entry.source] = sum;
                totalProfitUsdc += sum;
            }

            const activeUsers = await this.readPrisma.user.count({
                where: {
                    transactions: {
                        some: {
                            createdAt: {
                                gte: startOfDay,
                                lte: endOfDay,
                            },
                        },
                    },
                },
            });

            await this.prisma.dailySnapshot.upsert({
                where: { date: startOfDay },
                create: {
                    date: startOfDay,
                    totalProfitUsdc,
                    activeUsers,
                    totalVolumeUsdc,
                    profitBySource,
                },
                update: {
                    totalProfitUsdc,
                    activeUsers,
                    totalVolumeUsdc,
                    profitBySource,
                },
            });

            logger.info(
                `📈 DailySnapshot upserted for ${startOfDay.toISOString().split('T')[0]} | ` +
                `Volume: ${totalVolumeUsdc} USDC | Profit: ${totalProfitUsdc} USDC | Active Users: ${activeUsers}`
            );
        } catch (error) {
            logger.error({ err: error }, '📈 Analytics cron error');
        }
    }
}

module.exports = AnalyticsWorker;
