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
    const { getScheduler } = require('../../src/lib/bullScheduler');
    const scheduler = getScheduler();
    await scheduler.init();
    app.set('scheduler', scheduler);
    const register = async (name, schedule, handler, opts) => {
        if (IS_TEST_ENV) return;
        await scheduler.register(name, schedule, handler, opts);
    };

    const TradeWorker = require('../../workers/tradeWorker');
    const tradeWorker = new TradeWorker(prisma, io, tradeSocketService);
    const LeaderboardWorker = require('../../workers/leaderboardWorker');
    const leaderboardWorker = new LeaderboardWorker(prisma, io);
    const AnalyticsWorker = require('../../workers/analyticsWorker');
    const analyticsWorker = new AnalyticsWorker(prisma, app);
    const CfoWorker = require('../../workers/cfoWorker');
    const cfoWorker = new CfoWorker(prisma, io);
    const SavingsWorker = require('../../workers/savingsWorker');
    const savingsWorker = new SavingsWorker(prisma, io);
    const WithdrawalReconciliationWorker = require('../../workers/withdrawalReconciliationWorker');
    const withdrawalReconciliationWorker = new WithdrawalReconciliationWorker(prisma, io, paymentFailoverService || mtnDisbursementService, emailService, smsService);

    const PayoutBatchWorker = require('../../workers/payoutBatchWorker');
    const payoutBatchWorker = new PayoutBatchWorker(prisma, io, paymentFailoverService || mtnDisbursementService, notificationService);
    app.set('payoutBatchWorker', payoutBatchWorker);

    const EscrowExpiryWorker = require('../../workers/escrowExpiryWorker');
    const escrowExpiryWorker = new EscrowExpiryWorker(prisma, io, notificationService);
    app.set('escrowExpiryWorker', escrowExpiryWorker);

    const VaultWorker = require('../../workers/vaultWorker');
    const vaultWorker = new VaultWorker(prisma, vaultService, notificationService);
    const SusuWorker = require('../../workers/susuWorker');
    const susuWorker = new SusuWorker(prisma, susuService);
    const SmartRouteWorker = require('../../workers/smartRouteWorker');
    const smartRouteWorker = new SmartRouteWorker(prisma, smartRouteService);
    const AzmAuctionWorker = require('../../workers/azmAuctionWorker');
    const azmAuctionWorker = new AzmAuctionWorker(prisma, azmAuctionService);

    const OnchainSweepWorker = require('../../workers/onchainSweepWorker');
    const onchainSweepWorker = new OnchainSweepWorker(prisma, null);
    const DisappearingMessageWorker = require('../../workers/disappearingMessageWorker');
    const disappearingMessageWorker = new DisappearingMessageWorker(prisma);

    await register('leaderboard',        '0 0 * * 0',   () => leaderboardWorker.computeWeeklyLeaderboard());
    await register('analytics',         '0 * * * *',    () => analyticsWorker.aggregateDailySnapshot());
    await register('cfo',               '0 * * * *',    () => cfoWorker.runCfoCycle());
    await register('savings',           String(60 * 60 * 1000),       () => savingsWorker._checkReminders());
    await register('withdrawal-recon',  String(5 * 60 * 1000),        () => withdrawalReconciliationWorker._tick());
    await register('payout-batch',      String(2 * 60 * 1000),        () => payoutBatchWorker._tick());
    await register('escrow-expiry',     String(30 * 60 * 1000),       () => escrowExpiryWorker._tick());
    await register('vault',             String(60 * 60 * 1000),       () => vaultWorker._tick());
    await register('susu',              String(60 * 1000),            () => susuWorker._tick());
    await register('smart-route',       String(60 * 1000),            () => smartRouteWorker._tick());
    await register('azm-auction',       String(5 * 60 * 1000),        () => azmAuctionWorker._tick());
    await register('onchain-sweep',     String(60 * 60 * 1000),        () => onchainSweepWorker._tick());
    await register('disappearing-msg',  String(60 * 1000),             () => disappearingMessageWorker._tick());

    // Financial truth: immutable reserve/liability commitment once per hour.
    const proofOfReservesWorker = require('../../workers/proofOfReservesWorker');
    await register('proof-of-reserves', String(60 * 60 * 1000), () => proofOfReservesWorker.run());

    const noShowWorker = require('../../workers/reservationNoShowWorker');
    await register('no-show-sweep', '0 * * * *', async () => {
        const results = await noShowWorker.sweepAll(prisma);
        logger.info({ results }, 'NoShowWorker: sweep complete');
    });

    const { sweepTransitReminders } = require('../../workers/transitReminderWorker');
    const { sweepExpiredAds } = require('../../workers/businessAdExpiryWorker');
    await register('transit-reminders', '*/15 * * * *', () => sweepTransitReminders(prisma));
    await register('expired-ads', '*/30 * * * *', () => sweepExpiredAds(prisma));

    const TransitBookingExpiryWorker = require('../../workers/transitBookingExpiryWorker');
    const transitBookingExpiryWorker = new TransitBookingExpiryWorker(prisma, io, notificationService);
    await register('transit-booking-expiry', String(5 * 60 * 1000), () => transitBookingExpiryWorker._tick());

    const webhookDispatcher = require('../../services/webhookDispatcher');
    await register('webhook-retry', '*/2 * * * *', async () => {
        const count = await webhookDispatcher.processRetryQueue();
        if (count > 0) logger.info({ count }, 'WebhookRetry: processed stuck deliveries');
    });
    const webhookController = require('../../controllers/webhookController');
    await register('webhook-delivery-retry', '*/2 * * * *', async () => {
        await webhookController.processRetries(prisma);
    });

    if (!IS_TEST_ENV) {
        const SusuCycleService = require('../../services/susu/susuCycle.service');
        const SusuCycleSchedulerV2 = require('../../workers/susuCycleSchedulerV2');
        const SusuReminderCron = require('../../workers/susuReminderCron');
        const PorExpirySweep = require('../../workers/porExpirySweep');
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
                susuVouchService: app.get('susuVouchService'),
                susuMemberService: app.get('susuMemberService'),
                adminWarRoomService: app.get('adminWarRoomService'),
                notificationService,
                io,
                treasuryUserId,
            });
            app.set('susuCycleService', susuCycleService);
            const cycleSchedulerV2 = new SusuCycleSchedulerV2(prisma, susuCycleService);
            const reminderCron = new SusuReminderCron(prisma, notificationService);
            const porExpirySweep = new PorExpirySweep(prisma, app.get('susuMemberService'), notificationService);
            await scheduler.register('susu-cycle-v2', String(60 * 1000), () => cycleSchedulerV2._tick());
            await scheduler.register('susu-reminder', String(5 * 60 * 1000), () => reminderCron._tick());
            await scheduler.register('por-expiry', String(60 * 1000), () => porExpirySweep._tick());
            app.set('susuCycleSchedulerV2', cycleSchedulerV2);
            app.set('susuReminderCron', reminderCron);
            app.set('porExpirySweep', porExpirySweep);
            logger.info('[SusuV2] Workers registered with distributed scheduler');
        };
        startV2Workers().catch(err => logger.error({ err }, 'SusuV2 workers startup error'));

        const SusuInitiationSweep = require('../../workers/susuInitiationSweep');
        const susuInitiationSweep = new SusuInitiationSweep(prisma, susuInitiationService);
        await scheduler.register('susu-initiation', String(60 * 1000), () => susuInitiationSweep._tick());
        app.set('susuInitiationSweep', susuInitiationSweep);
    }

    if (!IS_TEST_ENV) {
        const gracefulShutdown = async () => {
            await scheduler.closeAll();
            process.exit(0);
        };
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
    }

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
        onchainSweepWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        disappearingMessageWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        proofOfReservesWorker: IS_TEST_ENV ? 'disabled_in_test' : 'running',
        tradeWorker: IS_TEST_ENV ? 'disabled_in_test' : 'pending_listen',
    });

    return { tradeWorker, withdrawalReconciliationWorker };
}

module.exports = { startWorkers };
