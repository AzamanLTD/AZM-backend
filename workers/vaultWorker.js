// workers/vaultWorker.js
// =============================================================================
// AZAMAN — VAULT WORKER  (Master Sprint, 2026-05-27)
//
// Two responsibilities, both swept on a 1-hour interval:
//
//   1. Auto-rule firing
//      Scans Vault.autoRuleEnabled = true AND autoRuleNextRun <= now.
//      Calls vaultService.runAutoRule(vault). When the call returns
//      `{ ok: false, status: 'INSUFFICIENT' }`, we check the user's
const logger = require('../src/config/logger');
//      idle availableBalance: if it's >= the shortfall we fire the
//      Duolingo-style "streak at risk" push so the user can move idle
//      funds before the streak resets.
//
//   2. Maturity sweep
//      Scans Vault.status = 'ACTIVE' AND maturityDate <= now and
//      hands each one to vaultService.completeMatured(...).
// =============================================================================

class VaultWorker {
    constructor(prisma, vaultService, notificationService) {
        this.prisma = prisma;
        this.vaultService = vaultService;
        this.notificationService = notificationService;
        this.interval = null;
    }

    start(intervalMs = 60 * 60 * 1000) {
        logger.info('[VaultWorker] Started — sweeping every 60 minutes');
        this._tick();
        this.interval = setInterval(() => this._tick(), intervalMs);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }

    async _tick() {
        await this._fireAutoRules().catch((e) => logger.error({ err: e }, '[VaultWorker.autoRules]'));
        await this._sweepMatured().catch((e) => logger.error({ err: e }, '[VaultWorker.matured]'));
    }

    async _fireAutoRules() {
        const now = new Date();
        const due = await this.prisma.vault.findMany({
            where: {
                status: 'ACTIVE',
                autoRuleEnabled: true,
                autoRuleNextRun: { lte: now },
            },
            take: 50,
        });

        for (const vault of due) {
            try {
                const result = await this.vaultService.runAutoRule(vault);
                if (result.ok) continue;

                if (result.status === 'INSUFFICIENT') {
                    const idle = result.availableBalance;
                    const required = result.required;
                    const shortfall = result.shortfall;
                    // Duolingo cron: if user has idle funds covering the
                    // shortfall, fire a streak-at-risk nudge so they can
                    // top up the vault before the streak fully resets.
                    if (idle && idle.gt(0)) {
                        await this.notificationService
                            .sendNotification({
                                userId: vault.userId,
                                title: 'Your Savings Streak Is At Risk!',
                                body: `Your "${vault.name}" auto-deposit needs $${required.toFixed(2)} but only $${idle.toFixed(2)} is available. You're $${shortfall.toFixed(2)} short — but you have idle funds. Transfer them now to keep your streak.`,
                                category: 'VAULT',
                                actionPayload: {
                                    action: 'OPEN_VAULT',
                                    vaultId: vault.id,
                                    shortfall: Number(shortfall.toFixed(2)),
                                    idle: Number(idle.toFixed(2)),
                                },
                            })
                            .catch(() => {});
                    }
                }
            } catch (err) {
                logger.error(`[VaultWorker] auto-rule failed vault=${vault.id}:`, err.message);
            }
        }
    }

    async _sweepMatured() {
        const now = new Date();
        const matured = await this.prisma.vault.findMany({
            where: {
                status: 'ACTIVE',
                maturityDate: { lte: now },
            },
            take: 50,
        });
        for (const v of matured) {
            try {
                await this.vaultService.completeMatured(v);
            } catch (err) {
                logger.error(`[VaultWorker] complete failed vault=${v.id}:`, err.message);
            }
        }
    }
}

module.exports = VaultWorker;
