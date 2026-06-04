class AnalyticsWorker {
    constructor(prisma) {
        this.prisma = prisma;
        this.cronJob = null;
    }

    start() {
        const cron = require('node-cron');
        this.cronJob = cron.schedule('0 * * * *', () => {
            console.log('📈 Analytics cron triggered — aggregating daily metrics...');
            this.aggregateDailySnapshot();
        });
        console.log('📈 Analytics cron scheduled (every hour)');
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            console.log('📈 Analytics cron stopped');
        }
    }

    async aggregateDailySnapshot() {
        try {
            const now = new Date();
            const startOfDay = new Date(now);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(now);
            endOfDay.setHours(23, 59, 59, 999);

            const totalVolumeResult = await this.prisma.transactionHistory.aggregate({
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

            const profitBySourceRaw = await this.prisma.adminProfitLog.groupBy({
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

            const activeUsers = await this.prisma.user.count({
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

            console.log(
                `📈 DailySnapshot upserted for ${startOfDay.toISOString().split('T')[0]} | ` +
                `Volume: ${totalVolumeUsdc} USDC | Profit: ${totalProfitUsdc} USDC | Active Users: ${activeUsers}`
            );
        } catch (error) {
            console.error('📈 Analytics cron error:', error.message);
        }
    }
}

module.exports = AnalyticsWorker;
