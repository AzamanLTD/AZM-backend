// services/rateAlertService.js
// =============================================================================
// AZAMAN — RATE ALERT SERVICE (Phase Q12)
//
// Manages user rate alerts. On each oracle rate sync, checks all active
// un-triggered alerts against the new rate and fires notifications for
// any that cross their threshold.
//
// Usage:
//   const rateAlertService = new RateAlertService(prisma, notificationService);
//   await rateAlertService.checkAlerts(currentRate, 'USD_GHS');
//
// Called from oracleService.fetchAndUpdateRates() after each successful sync.
// =============================================================================

class RateAlertService {
    constructor(prisma, notificationService) {
        this.prisma = prisma;
        this.notificationService = notificationService;
    }

    // =========================================================================
    // CHECK ALERTS — called after each oracle rate sync
    // =========================================================================

    /**
     * Check all active, un-triggered alerts for a given rate pair.
     * Fires notifications for any alerts that have crossed their threshold.
     *
     * @param {number} currentRate - The new live rate (e.g., 15.2 for USD/GHS)
     * @param {string} ratePair - The pair identifier (e.g., 'USD_GHS')
     */
    async checkAlerts(currentRate, ratePair = 'USD_GHS') {
        try {
            if (!currentRate || currentRate <= 0) return;

            // Find ABOVE alerts where currentRate >= targetRate
            const aboveAlerts = await this.prisma.rateAlert.findMany({
                where: {
                    ratePair,
                    isActive: true,
                    isTriggered: false,
                    direction: 'ABOVE',
                    targetRate: { lte: currentRate },
                },
                select: { id: true, userId: true, targetRate: true, note: true },
            });

            // Find BELOW alerts where currentRate <= targetRate
            const belowAlerts = await this.prisma.rateAlert.findMany({
                where: {
                    ratePair,
                    isActive: true,
                    isTriggered: false,
                    direction: 'BELOW',
                    targetRate: { gte: currentRate },
                },
                select: { id: true, userId: true, targetRate: true, note: true },
            });

            const triggeredAlerts = [...aboveAlerts, ...belowAlerts];

            if (triggeredAlerts.length === 0) return;

            logger.info(`[RateAlertService] ${triggeredAlerts.length} alert(s) triggered at ${ratePair} = ${currentRate}`);

            // Mark all as triggered in batch
            const alertIds = triggeredAlerts.map(a => a.id);
            await this.prisma.rateAlert.updateMany({
                where: { id: { in: alertIds } },
                data: {
                    isTriggered: true,
                    triggeredAt: new Date(),
                    triggeredRate: currentRate,
                    isActive: false,
                },
            });

            // Fire notifications (fire-and-forget)
            for (const alert of triggeredAlerts) {
                setImmediate(async () => {
                    try {
                        const direction = aboveAlerts.includes(alert) ? 'above' : 'below';
                        const formattedRate = Number(currentRate).toFixed(2);
                        const formattedTarget = Number(alert.targetRate).toFixed(2);
                        const label = alert.note ? ` (${alert.note})` : '';

                        await this.notificationService.sendNotification({
                            userId: alert.userId,
                            title: 'Rate Alert Triggered',
                            body: `USD/GHS is now ${formattedRate} — crossed your ${direction} target of ${formattedTarget}${label}`,
                            category: 'MARKET',
                            actionPayload: { action: 'OPEN_WALLET' },
                        });
                    } catch (err) {
                        logger.error(`[RateAlertService] notification error for alert ${alert.id}:`, err.message);
                    }
                });
            }

        } catch (err) {
            // Non-fatal — don't crash the oracle sync
            logger.error({ err: err }, '[RateAlertService] checkAlerts error');
        }
    }

    // =========================================================================
    // CRUD OPERATIONS (used by controller)
    // =========================================================================

    /**
     * Create a new rate alert for a user.
     */
    async createAlert(userId, { targetRate, direction = 'ABOVE', ratePair = 'USD_GHS', note }) {
        // Limit: max 10 active alerts per user
        const activeCount = await this.prisma.rateAlert.count({
            where: { userId, isActive: true, isTriggered: false },
        });

        if (activeCount >= 10) {
            throw new Error('Maximum 10 active alerts allowed. Delete an existing alert to add a new one.');
        }

        const alert = await this.prisma.rateAlert.create({
            data: {
                userId,
                targetRate,
                direction: direction.toUpperCase(),
                ratePair,
                note: note || null,
            },
        });

        return alert;
    }

    /**
     * List alerts for a user (active first, then triggered).
     */
    async listAlerts(userId, { includeTriggered = true } = {}) {
        const where = { userId };
        if (!includeTriggered) {
            where.isTriggered = false;
            where.isActive = true;
        }

        const alerts = await this.prisma.rateAlert.findMany({
            where,
            orderBy: [
                { isActive: 'desc' },
                { createdAt: 'desc' },
            ],
            take: 50,
        });

        return alerts;
    }

    /**
     * Delete (deactivate) an alert.
     */
    async deleteAlert(userId, alertId) {
        const alert = await this.prisma.rateAlert.findUnique({
            where: { id: alertId },
        });

        if (!alert) throw new Error('Alert not found');
        if (alert.userId !== userId) throw new Error('Not authorized');

        await this.prisma.rateAlert.update({
            where: { id: alertId },
            data: { isActive: false },
        });

        return { success: true };
    }
}

module.exports = RateAlertService;
