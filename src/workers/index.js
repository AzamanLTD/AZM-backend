/**
 * Worker Registry — instantiates and starts all background workers.
 *
 * Extracted from server.js as part of Phase 1 modularization.
 * Workers are NOT started in test mode (NODE_ENV === 'test') to avoid
 * open handles hanging the jest process.
 *
 * @param {import('express').Express} app  - Express app (for app.set/get)
 * @param {object} deps                  - All service/dependency instances
 * @returns {{ tradeWorker, withdrawalReconciliationWorker }}
 */
function startWorkers(app, {
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
    const cron   = require('node-cron');

    const IS_TEST_ENV = process.env.NODE_ENV === 'test';
    const startWorker = (w) => { if (!IS_TEST_ENV) w.start(); };

    // ── Core Workers ──────────────────────────────────────────────────────────
    const TradeWorker = require('../../workers/tradeWorker');
    const tradeWorker = new TradeWorker(prisma, io, tradeSocketService);

    const LeaderboardWorker = require('../../workers/leaderboardWorker');
    const leaderboardWorker = new LeaderboardWorker(prisma, io);
    startWorker(leaderboardWorker);

    const AnalyticsWorker = require('../../workers/analyticsWorker');
    const analyticsWorker = new AnalyticsWorker(prisma);
    startWorker(analyticsWorker);

    const CfoWorker = require('../../workers/cfoWorker');
    const cfoWorker = new CfoWorker(prisma, io);
    startWorker(cfoWorker);

    const SavingsWorker = require('../../workers/savingsWorker');
    const savingsWorker = new SavingsWorker(prisma, io);
    startWorker(savingsWorker);

    const WithdrawalReconciliationWorker = require('../../workers/withdrawalReconciliationWorker');
    const withdrawalReconciliationWorker =
        new WithdrawalReconciliationWorker(prisma, io, paymentFailoverService || mtnDisbursementService, emailService, smsService);
    startWorker(withdrawalReconciliationWorker);

    // ── Payout Batch Worker (Phase Q8) ─────────────────────────────────────────
    // Scans PENDING fiat withdrawals and auto-dispatches when pool has liquidity
    // AND amount is below the admin-configured threshold. Flags oversized or
    // under-funded withdrawals as NEEDS_MANUAL_REVIEW for the War Room.
    const PayoutBatchWorker = require('../../workers/payoutBatchWorker');
    const payoutBatchWorker = new PayoutBatchWorker(prisma, io, paymentFailoverService || mtnDisbursementService, notificationService);
    startWorker(payoutBatchWorker);
    app.set('payoutBatchWorker', payoutBatchWorker);

    // ── Smart Escrow Expiry Worker ─────────────────────────────────────────────
    // Sweeps DRAFT escrows past 24h and FUNDED escrows past 30d of inactivity
    // (refunding the payer), every 30 minutes. No-op safe in test mode.
    const EscrowExpiryWorker = require('../../workers/escrowExpiryWorker');
    const escrowExpiryWorker = new EscrowExpiryWorker(prisma, io, notificationService);
    startWorker(escrowExpiryWorker);
    app.set('escrowExpiryWorker', escrowExpiryWorker);

    // ── Master Sprint Workers (Vault / Susu / Smart Route / AZM Auction) ──────
    const VaultWorker = require('../../workers/vaultWorker');
    const vaultWorker = new VaultWorker(prisma, vaultService, notificationService);
    startWorker(vaultWorker);

    const SusuWorker = require('../../workers/susuWorker');
    const susuWorker = new SusuWorker(prisma, susuService);
    startWorker(susuWorker);

    // ── Phase 3 (private-susu-ecosystem) workers ──────────────────────────────
    // V2 cycle scheduler (60s cadence) handles SusuGroups with contractVersion
    // set. Legacy susuWorker above continues to handle pre-Phase-3 SusuGroups
    // whose contractVersion is null. Reminder cron + PoR expiry sweep complete
    // the Phase 3 surface. All three workers are no-ops in test mode.
    if (!IS_TEST_ENV) {
        const SusuCycleService          = require('../../services/susu/susuCycle.service');
        const SusuCycleSchedulerV2      = require('../../workers/susuCycleSchedulerV2');
        const SusuReminderCron          = require('../../workers/susuReminderCron');
        const PorExpirySweep            = require('../../workers/porExpirySweep');

        // Wait until the treasury cache has resolved before instantiating the
        // cycle service — it depends on azamanTreasuryUserId.
        // Resilience: the treasury seed may land after boot. Rather than give up
        // after 10s, we poll patiently (every 5s for up to 30 min).
        const startV2Workers = async () => {
            const start = Date.now();
            const MAX_WAIT_MS = 30 * 60 * 1000;
            while (!app.get('azamanTreasuryUserId') && Date.now() - start < MAX_WAIT_MS) {
                await new Promise(r => setTimeout(r, 5000));
            }
            const treasuryUserId = app.get('azamanTreasuryUserId');
            if (!treasuryUserId) {
                logger.warn('SusuV2 Workers: treasury cache not resolved within 30 min. Cycle/reminder/PoR workers NOT started. Seed the treasury row and restart the service. Rest of backend unaffected.');
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
            cycleSchedulerV2.start();
            app.set('susuCycleSchedulerV2', cycleSchedulerV2);

            const reminderCron = new SusuReminderCron(prisma, notificationService);
            reminderCron.start();
            app.set('susuReminderCron', reminderCron);

            const porExpirySweep = new PorExpirySweep(prisma, app.get('susuMemberService'), notificationService);
            porExpirySweep.start();
            app.set('porExpirySweep', porExpirySweep);
        };
        startV2Workers().catch(err => logger.error({ err }, 'SusuV2 workers startup error'));
    }

    const SmartRouteWorker = require('../../workers/smartRouteWorker');
    const smartRouteWorker = new SmartRouteWorker(prisma, smartRouteService);
    startWorker(smartRouteWorker);

    // ── Susu initiation countdown sweep (every 60s) ───────────────────────────
    // Independent of the treasury cache; starts unconditionally. No-op in test.
    if (!IS_TEST_ENV) {
        const SusuInitiationSweep = require('../../workers/susuInitiationSweep');
        const susuInitiationSweep = new SusuInitiationSweep(prisma, susuInitiationService);
        susuInitiationSweep.start();
        app.set('susuInitiationSweep', susuInitiationSweep);
    }

    const AzmAuctionWorker = require('../../workers/azmAuctionWorker');
    const azmAuctionWorker = new AzmAuctionWorker(prisma, azmAuctionService);
    startWorker(azmAuctionWorker);

    // ── Marketplace cron schedules ───────────────────────────────────────────
    if (!IS_TEST_ENV) {
        // No-Show Penalty Sweep — every hour
        const noShowWorker = require('../../workers/reservationNoShowWorker');
        cron.schedule('0 * * * *', async () => {
            try {
                logger.info('NoShowWorker: running scheduled sweep');
                const results = await noShowWorker.sweepAll(prisma);
                logger.info({ results }, 'NoShowWorker: sweep complete');
            } catch (err) {
                logger.error({ err }, 'NoShowWorker: sweep failed');
            }
        });

        // Transit reminders + expired ad sweep
        const { sweepTransitReminders } = require('../../workers/transitReminderWorker');
        const { sweepExpiredAds } = require('../../workers/businessAdExpiryWorker');
        cron.schedule('*/15 * * * *', () => sweepTransitReminders(prisma));
        cron.schedule('*/30 * * * *', () => sweepExpiredAds(prisma));

        // Webhook retry queue — process stuck RETRYING deliveries every 2 min
        const webhookDispatcher = require('../../services/webhookDispatcher');
        cron.schedule('*/2 * * * *', async () => {
            try {
                const count = await webhookDispatcher.processRetryQueue();
                if (count > 0) logger.info({ count }, 'WebhookRetry: processed stuck deliveries');
            } catch (e) {
                logger.warn({ err: e }, 'WebhookRetry error');
            }
        });
    }

    // ── D-05: record worker liveness for GET /health ──────────────────────────
    // tradeWorker is special: instantiated here but only .start()'d in the
    // server.listen callback. Seeded as 'pending_listen', flipped to 'running'
    // from that callback.
    Object.assign(workerStatus, {
        leaderboardWorker: 'running',
        analyticsWorker: 'running',
        cfoWorker: 'running',
        savingsWorker: 'running',
        withdrawalReconciliationWorker: 'running',
        payoutBatchWorker: 'running',
        vaultWorker: 'running',
        susuWorker: 'running',
        smartRouteWorker: 'running',
        azmAuctionWorker: 'running',
        tradeWorker: 'pending_listen',
    });
    if (IS_TEST_ENV) {
        for (const k of Object.keys(workerStatus)) workerStatus[k] = 'disabled_in_test';
    }

    return { tradeWorker, withdrawalReconciliationWorker };
}

module.exports = { startWorkers };
