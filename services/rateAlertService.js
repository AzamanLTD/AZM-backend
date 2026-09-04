// services/rateAlertService.js
// =============================================================================
// AZAMAN — RATE ALERT SERVICE (Phase Q12)
//
// Manages user rate alerts. On each oracle rate sync, checks all active
// un-triggered alerts against the new rate and fires notifications for
// any that cross their threshold.
//
// Legacy USD_GHS alerts remain supported for backward compatibility.
// New alerts default to the canonical USDC_GHS pair because USDC is the
// platform settlement unit and GHS is its local display equivalent.
// =============================================================================

const logger = require('../src/config/logger');

const CANONICAL_RATE_PAIR = 'USDC_GHS';
const LEGACY_RATE_PAIRS = new Set(['USD_GHS', CANONICAL_RATE_PAIR]);

class RateAlertService {
    constructor(prisma, notificationService) {
        this.prisma = prisma;
        this.notificationService = notificationService;
    }

    async checkAlerts(currentRate, ratePair = CANONICAL_RATE_PAIR) {
        try {
            if (!currentRate || currentRate <= 0) return;
            const normalizedPair = String(ratePair || CANONICAL_RATE_PAIR).toUpperCase();
            if (!LEGACY_RATE_PAIRS.has(normalizedPair)) return;

            const pairAliases = normalizedPair === CANONICAL_RATE_PAIR
                ? [CANONICAL_RATE_PAIR, 'USD_GHS']
                : ['USD_GHS', CANONICAL_RATE_PAIR];

            const select = {
                id: true,
                userId: true,
                targetRate: true,
                note: true,
                ratePair: true,
                direction: true,
            };

            const [aboveAlerts, belowAlerts] = await Promise.all([
                this.prisma.rateAlert.findMany({
                    where: {
                        ratePair: { in: pairAliases },
                        isActive: true,
                        isTriggered: false,
                        direction: 'ABOVE',
                        targetRate: { lte: currentRate },
                    },
                    select,
                }),
                this.prisma.rateAlert.findMany({
                    where: {
                        ratePair: { in: pairAliases },
                        isActive: true,
                        isTriggered: false,
                        direction: 'BELOW',
                        targetRate: { gte: currentRate },
                    },
                    select,
                }),
            ]);

            const triggeredAlerts = [...aboveAlerts, ...belowAlerts];
            if (triggeredAlerts.length === 0) return;

            logger.info(`[RateAlertService] ${triggeredAlerts.length} alert(s) triggered at ${CANONICAL_RATE_PAIR} = ${currentRate}`);

            const alertIds = triggeredAlerts.map(a => a.id);
            await this.prisma.rateAlert.updateMany({
                where: { id: { in: alertIds }, isTriggered: false, isActive: true },
                data: {
                    isTriggered: true,
                    triggeredAt: new Date(),
                    triggeredRate: currentRate,
                    isActive: false,
                },
            });

            for (const alert of triggeredAlerts) {
                setImmediate(async () => {
                    try {
                        const direction = alert.direction === 'BELOW' ? 'below' : 'above';
                        const formattedRate = Number(currentRate).toFixed(2);
                        const formattedTarget = Number(alert.targetRate).toFixed(2);
                        const label = alert.note ? ` (${alert.note})` : '';

                        await this.notificationService.sendNotification({
                            userId: alert.userId,
                            title: 'Rate Alert Triggered',
                            body: `USDC/GHS is now ${formattedRate} — crossed your ${direction} target of ${formattedTarget}${label}`,
                            category: 'MARKET',
                            actionPayload: {
                                action: 'OPEN_WALLET',
                                ratePair: CANONICAL_RATE_PAIR,
                            },
                        });
                    } catch (err) {
                        logger.error(`[RateAlertService] notification error for alert ${alert.id}:`, err.message);
                    }
                });
            }
        } catch (err) {
            logger.error({ err }, '[RateAlertService] checkAlerts error');
        }
    }

    async createAlert(userId, { targetRate, direction = 'ABOVE', ratePair = CANONICAL_RATE_PAIR, note }) {
        const activeCount = await this.prisma.rateAlert.count({
            where: { userId, isActive: true, isTriggered: false },
        });

        if (activeCount >= 10) {
            throw new Error('Maximum 10 active alerts allowed. Delete an existing alert to add a new one.');
        }

        const normalizedPair = String(ratePair || CANONICAL_RATE_PAIR).toUpperCase();
        if (!LEGACY_RATE_PAIRS.has(normalizedPair)) {
            throw new Error('ratePair must be USDC_GHS (canonical) or USD_GHS (legacy).');
        }

        return this.prisma.rateAlert.create({
            data: {
                userId,
                targetRate,
                direction: direction.toUpperCase(),
                ratePair: normalizedPair,
                note: note || null,
            },
        });
    }

    async listAlerts(userId, { includeTriggered = true } = {}) {
        const where = { userId };
        if (!includeTriggered) {
            where.isTriggered = false;
            where.isActive = true;
        }

        return this.prisma.rateAlert.findMany({
            where,
            orderBy: [
                { isActive: 'desc' },
                { createdAt: 'desc' },
            ],
            take: 50,
        });
    }

    async deleteAlert(userId, alertId) {
        const alert = await this.prisma.rateAlert.findUnique({ where: { id: alertId } });
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
module.exports.CANONICAL_RATE_PAIR = CANONICAL_RATE_PAIR;
