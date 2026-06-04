// workers/cfoWorker.js
// =============================================================================
// AZAMAN V2 — AI CFO WORKER  (Phase 2.4 Upgrade)
//
// Schedule: hourly  ('0 * * * *')
//
// Responsibilities:
//   1. Fetch OperationalExpense records from the last 7 days
//   2. Read the real SystemHotWallet balance from the DB (not an env var)
//   3. If balance < MATIC_ALERT_THRESHOLD:
//        - Emit 'admin_alert' socket event to all connected admins
//        - Write an ADMIN_SYSTEM notification for userId=1
//   4. Generate an AI CFO analysis report via the LLM provider
//   5. Persist the report as an ADMIN_SYSTEM notification for userId=1
// =============================================================================

const { generateText } = require('../utils/llmProvider');
const NotificationService = require('../services/notificationService');

const MATIC_ALERT_THRESHOLD = parseFloat(process.env.MATIC_ALERT_THRESHOLD || '50.00');
const HOT_WALLET_USDC_LOW   = parseFloat(process.env.HOT_WALLET_USDC_LOW   || '500.00');

class CfoWorker {
    /**
     * @param {import('@prisma/client').PrismaClient} prisma
     * @param {import('socket.io').Server} [io]  — optional; injected after startup
     */
    constructor(prisma, io = null) {
        this.prisma   = prisma;
        this.io       = io;
        this.cronJob  = null;
    }

    /** Allow server.js to inject the io instance after construction. */
    setIo(io) {
        this.io = io;
    }

    start() {
        const cron   = require('node-cron');
        // Run every hour on the hour
        this.cronJob = cron.schedule('0 * * * *', () => {
            console.log('[CFO Worker] Hourly cron triggered — analysing system health...');
            this.analyzeExpenses();
        });
        console.log('[CFO Worker] Cron scheduled (every hour)');
    }

    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            console.log('[CFO Worker] Cron stopped');
        }
    }

    async analyzeExpenses() {
        try {
            const now         = new Date();
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            // ── 1. Operational expenses (last 7 days) ──────────────────────
            const expenses = await this.prisma.operationalExpense.findMany({
                where:   { timestamp: { gte: sevenDaysAgo } },
                orderBy: { timestamp: 'desc' }
            });

            const totalExpense = expenses.reduce((sum, e) => sum + e.costUsdc, 0);

            const expenseByService = {};
            for (const expense of expenses) {
                expenseByService[expense.serviceName] =
                    (expenseByService[expense.serviceName] || 0) + expense.costUsdc;
            }

            // ── 2. Read SystemHotWallet from the DB (V2 singleton) ─────────
            let hotWalletBalance = 0;
            try {
                const hotWallet = await this.prisma.systemHotWallet.findUnique({
                    where: { id: 1 }
                });
                hotWalletBalance = hotWallet?.balance ?? 0;
            } catch {
                // Singleton hasn't been seeded yet — treat as zero
                hotWalletBalance = 0;
            }

            const isBalanceCritical = hotWalletBalance < MATIC_ALERT_THRESHOLD;

            // ── 3. Low-balance socket alert + DB notification ──────────────
            if (isBalanceCritical) {
                console.warn(
                    `[CFO Worker] ⚠️  SystemHotWallet balance (${hotWalletBalance}) ` +
                    `is below threshold (${MATIC_ALERT_THRESHOLD})`
                );

                // Broadcast to all connected admin clients in real time
                if (this.io) {
                    this.io.emit('admin_alert', {
                        type:            'HOT_WALLET_LOW',
                        hotWalletBalance,
                        threshold:       MATIC_ALERT_THRESHOLD,
                        timestamp:       now.toISOString()
                    });
                }

                // Persist as a high-priority ADMIN_SYSTEM notification
                const notifSvc = new NotificationService(this.prisma, this.io);
                await notifSvc.sendAiMaticLowWarning(
                    1, // admin userId
                    hotWalletBalance,
                    MATIC_ALERT_THRESHOLD
                );
            }

            // ── 4. AI narrative analysis ───────────────────────────────────
            const expenseSummary = Object.entries(expenseByService)
                .map(([svc, cost]) => `  - ${svc}: ${cost.toFixed(2)} USDC`)
                .join('\n') || '  No expenses recorded.';

            const prompt = `You are the Operational CFO for Azaman, a P2P crypto remittance platform.

Current financial snapshot:
- Total operational expenses (last 7 days): ${totalExpense.toFixed(2)} USDC
- Expense breakdown by service:
${expenseSummary}
- SystemHotWallet USDC balance: ${hotWalletBalance.toFixed(2)} USDC
- Low-balance threshold:        ${MATIC_ALERT_THRESHOLD.toFixed(2)} USDC
- Balance status: ${isBalanceCritical ? '🔴 CRITICAL — below threshold' : '🟢 HEALTHY'}

Analyse this data and provide:
1. A brief assessment of the expense trends
2. Whether the hot wallet balance is healthy or needs attention
3. Any actionable recommendations for cost optimisation

Keep the response concise (under 200 words).`;

            const aiAnalysis = await generateText(prompt);

            console.log('\n=== AI CFO ANALYSIS ===');
            console.log(aiAnalysis);
            console.log('========================\n');

            // ── 5. Persist CFO report notification ────────────────────────
            // Phase N2: route through notificationService for DB + socket + FCM
            const severity = isBalanceCritical
                ? 'CRITICAL'
                : totalExpense > 1000
                    ? 'WARNING'
                    : 'INFO';

            const notifSvc = new NotificationService(this.prisma, this.io);
            await notifSvc.sendNotification({
                userId: 1,
                title: `AI CFO Report [${severity}]`,
                body: aiAnalysis.substring(0, 500),
                category: 'ADMIN_SYSTEM',
                actionPayload: {
                    route:           '/admin/war-room',
                    action:          'VIEW_CFO_REPORT',
                    totalExpense:    String(totalExpense),
                    hotWalletBalance: String(hotWalletBalance),
                    severity
                }
            });

            return {
                totalExpense,
                expenseByService,
                hotWalletBalance,
                isBalanceCritical,
                aiAnalysis,
                severity
            };

        } catch (error) {
            console.error('[CFO Worker] analyzeExpenses error:', error.message);
        }
    }
}

module.exports = CfoWorker;
