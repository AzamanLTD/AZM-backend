/**
 * Worker Registry — registers all background workers with the BullMQ
 * distributed scheduler.
 *
 * When REDIS_URL is set, BullMQ guarantees each scheduled tick fires on
 * exactly ONE server instance (Redis-backed distributed locking). When
 * REDIS_URL is absent, the scheduler falls back to in-process timers /
 * node-cron — identical to the pre-BullMQ behavior.
 *
 * Workers are NOT started in test mode (NODE_ENV === 'test').
 *
 * @param {import('express').Express} app  - Express app (for app.set/get)
 * @param {object} deps                  - All service/dependency instances
 * @returns {{ tradeWorker, withdrawalReconciliationWorker }}
 */
async function startWorkers(app, {
    prisma,
    io,
    workerStatus,
    tradeSocketService,
    mtnDisbursementService,
    paymentFailoverService,
    emailService,
    smsService,
    notificationService,
    vaultService,
    susuService,
    smartRouteService,
    azmAuctionService,
    susuInitiationService,
}) {
    const logger = require('../../src/config/logger');
    const IS_TEST_ENV = process.env.NODE_ENV === 'test';

    // ── Initialise the distributed scheduler ──────────────────────────────
    const { getScheduler } = require('../../src/lib/bullScheduler');
    const scheduler = getScheduler();
    await scheduler.init();
    app.set('scheduler', scheduler);

    // Helper: register a worker's tick handler with the scheduler
    const register = async (name, schedule, handler, opts) => {
        if (IS_TEST_ENV) return;
        await scheduler.register(name, schedule, handler, opts);
    };

    // ── Instantiate workers (constructors are side-effect free) ──────────
    const TradeWorker = require('../../workers/tradeWorker');
    const tradeWorker = new TradeWorker(prisma, io, tradeSocketService);

    const LeaderboardWorker = require('../../workers/leaderboardWorker');
    const leaderboardWorker = new LeaderboardWorker(prisma, io);

    const AnalyticsWorker = require('../../workers/analyticsWorker');
    const analyticsWorker = new AnalyticsWorker(prisma);

    const CfoWorker = require('../../workers/cfoWorker');
    const cfoWorker = new CfoWorker(prisma, io);

    const SavingsWorker = require('../../workers/savingsWorker');
    const savingsWorker = new SavingsWorker(prisma, io);

    const WithdrawalReconciliationWorker = require('../../workers/withdrawalReconciliationWorker');
    const withdrawalReconciliationWorker =
        new WithdrawalReconciliationWorker(prisma, io, paymentFailoverService || mtnDisbursementService, emailService, smsService);

    // ── Payout Batch Worker (Phase Q8) ─────────────────────────────────────
    const PayoutBatchWorker = require('../../workers/payoutBatchWorker');
    const payoutBatchWorker = new PayoutBatchWorker(prisma, io, paymentFailoverService || mtnDisbursementService, notificationService);
    app.set('payoutBatchWorker', payoutBatchWorker);

    // ── Smart Escrow Expiry Worker ─────────────────────────────────────────
    const EscrowExpiryWorker = require('../../workers/escrowExpiryWorker');
    const escrowExpiryWorker = new EscrowExpiryWorker(prisma, io, notificationService);
    app.set('escrowExpiryWorker', escrowExpiryWorker);

    // ── Master Sprint Workers ──────────────────────────────────────────────
    const VaultWorker = require('../../workers/vaultWorker');
    const vaultWorker = new VaultWorker(prisma, vaultService, notificationService);

    const SusuWorker = require('../../workers/susuWorker');
    const susuWorker = new SusuWorker(prisma, susuService);

    const SmartRouteWorker = require('../../workers/smartRouteWorker');
    const smartRouteWorker = new SmartRouteWorker(prisma, smartRouteService);

    const AzmAuctionWorker = require('../../workers/azmAuctionWorker');
    const azmAuctionWorker = new AzmAuctionWorker(prisma, azmAuctionService);

    // ── Register all workers with the scheduler ───────────────────────────
    // Cron-based workers (use cron expressions)
    await register('leaderboard',        '0 0 * * 0',   () => leaderboardWorker.computeWeeklyLeaderboard());
    await register('analytics',         '0 * * * *',    () => analyticsWorker.computeHourlyAnalytics());
    await register('cfo',               '0 * * * *',    () => cfoWorker.runCfoCycle());

    // Interval-based workers (use millisecond intervals)
    await register('savings',           String(60 * 60 * 1000),       () => savingsWorker._checkReminders());
    await register('withdrawal-recon',  String(5 * 60 * 1000),        () => withdrawalReconciliationWorker._tick());
    await register('payout-batch',      String(2 * 60 * 1000),        () => payoutBatchWorker._tick());
    await register('escrow-expiry',     String(30 * 60 * 1000),       () => escrowExpiryWorker._tick());
    await register('vault',             String(60 * 60 * 1000),       () => vaultWorker._tick());
    await register('susu',              String(60 * 1000),            () => susuWorker._tick());
    await register('smart-route',       String(60 * 1000),            () => smartRouteWorker._tick());
    await register('azm-auction',       String(5 * 60 * 1000),        () => azmAuctionWorker._tick());

    // ── Marketplace cron schedules ───────────────────────────────────────
    const noShowWorker = require('../../workers/reservationNoShowWorker');
    await register('no-show-sweep',     '0 * * * *',   async () => {
        const results = await noShowWorker.sweepAll(prisma);
        logger.info({ results }, 'NoShowWorker: sweep complete');
    });

    const { sweepTransitReminders } = require('../../workers/transitReminderWorker');
    const { sweepExpiredAds } = require('../../workers/businessAdExpiryWorker');
    await register('transit-reminders', '*/15 * * * *', () => sweepTransitReminders(prisma));
    await register('expired-ads',        '*/30 * * * *', () => sweepExpiredAds(prisma));

    // Webhook retry queue — process stuck RETRYING deliveries every 2 min
    const webhookDispatcher = require('../../services/webhookDispatcher');
    await register('webhook-retry',     '*/2 * * * *',  async () => {
        const count = await webhookDispatcher.processRetryQueue();
        if (count > 0) logger.info({ count }, 'WebhookRetry: processed stuck deliveries');
    });

    // ── Phase 3 (private-susu-ecosystem) workers ──────────────────────────
    // V2 cycle scheduler (60s cadence) handles SusuGroups with contractVersion.
    // Reminder cron + PoR expiry sweep complete the Phase 3 surface.
    if (!IS_TEST_ENV) {
        const SusuCycleService          = require('../../services/susu/susuCycle.service');
        const SusuCycleSchedulerV2      = require('../../workers/susuCycleSchedulerV2');
        const SusuReminderCron          = require('../../workers/susuReminderCron');
        const PorExpirySweep            = require('../../workers/porExpirySweep');

        // Wait until the treasury cache has resolved before instantiating the
        // cycle service — it depends on azamanTreasuryUserId.
        const startV2Workers = async () => {
            const start = Date.now();
            const MAX_WAIT_MS = 30 * 60 * 1000;
            while (!app.get('azamanTreasuryUserId') && Date.now() - start < MAX_WAIT_MS) {
                await new Promise(r => setTimeout(r, 5000));
            }
            const treasuryUserId = app.get('azamanTreasuryUserId');
            if (!treasuryUserId) {
                logger.warn('SusuV2 Workers: treasury cache not resolved within 30 min. Cycle/reminder/PoR workers NOT started.');
                return;
            }
            const susuCycleService = new SusuCycleService(prisma, {
                susuVouchService:    app.get('susuVouchService'),
                susuMemberService:   app.get('susuMemberService'),
                adminWarRoomService: app.get('adminWarRoomService'),
                notificationService,
                io,
                treasuryUserId,
            });
            app.set('susuCycleService', susuCycleService);

            const cycleSchedulerV2 = new SusuCycleSchedulerV2(prisma, susuCycleService);
            const reminderCron = new SusuReminderCron(prisma, notificationService);
            const porExpirySweep = new PorExpirySweep(prisma, app.get('susuMemberService'), notificationService);

            // Register with scheduler instead of calling .start() directly
            await scheduler.register('susu-cycle-v2',   String(60 * 1000), () => cycleSchedulerV2._tick());
            await scheduler.register('susu-reminder',    String(5 * 60 * 1000), () => reminderCron._tick());
            await scheduler.register('por-expiry',       String(60 * 1000), () => porExpirySweep._tick());

            app.set('susuCycleSchedulerV2', cycleSchedulerV2);
            app.set('susuReminderCron', reminderCron);
            app.set('porExpirySweep', porExpirySweep);

            logger.info('[SusuV2] Workers registered with distributed scheduler');
        };
        startV2Workers().catch(err => logger.error({ err }, 'SusuV2 workers startup error'));

        // Susu initiation countdown sweep (every 60s) — independent of treasury
        const SusuInitiationSweep = require('../../workers/susuInitiationSweep');
        const susuInitiationSweep = new SusuInitiationSweep(prisma, susuInitiationService);
        await scheduler.register('susu-initiation', String(60 * 1000), () => susuInitiationSweep._tick());
        app.set('susuInitiationSweep', susuInitiationSweep);
    }

    // ── Graceful shutdown wiring ───────────────────────────────────────────
    // Close all BullMQ workers + queues on process exit.
    if (!IS_TEST_ENV) {
        const gracefulShutdown = async () => {
            await scheduler.closeAll();
            process.exit(0);
        };
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
    }

    // ── D-05: record worker liveness for GET /health ──────────────────────
    // tradeWorker is special: instantiated here but only .start()'d in the
    // server.listen callback. Seeded as 'pending_listen', flipped to 'running'
    // from that callback.
    Object.assign(workerStatus, {
        leaderboardWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        analyticsWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        cfoWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        savingsWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        withdrawalReconciliationWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        payoutBatchWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        vaultWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        susuWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        smartRouteWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        azmAuctionWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        tradeWorker: IS_TEST_ENV ? 'disabled_in_test' : 'pending_listen',
    });

    return { tradeWorker, withdrawalReconciliationWorker };
}

module.exports = { startWorkers };
