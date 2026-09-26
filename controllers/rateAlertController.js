// controllers/rateAlertController.js
// =============================================================================
// AZAMAN — RATE ALERT CONTROLLER (Phase Q12)
//
// Endpoints:
//   POST   /api/oracle/alerts          — Create a new rate alert
//   GET    /api/oracle/alerts          — List user's alerts
//   DELETE /api/oracle/alerts/:id      — Delete/deactivate an alert
//
// Legacy USD_GHS alerts remain readable/triggerable for compatibility, but new
// alerts and response metadata use the canonical USDC_GHS pair.
// =============================================================================

const logger = require('../src/config/logger');
const CANONICAL_RATE_PAIR = 'USDC_GHS';

exports.createAlert = async (req, res) => {
    try {
        const rateAlertService = req.app.get('rateAlertService');
        const userId = req.user.id;
        const { targetRate, direction, ratePair, note } = req.body;

        if (!targetRate || isNaN(parseFloat(targetRate)) || parseFloat(targetRate) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'targetRate is required and must be a positive number',
            });
        }

        if (direction && !['ABOVE', 'BELOW'].includes(direction.toUpperCase())) {
            return res.status(400).json({
                success: false,
                message: 'direction must be ABOVE or BELOW',
            });
        }

        const alert = await rateAlertService.createAlert(userId, {
            targetRate: parseFloat(targetRate),
            direction: direction || 'ABOVE',
            ratePair: ratePair || CANONICAL_RATE_PAIR,
            note,
        });

        return res.status(201).json({ success: true, data: alert });
    } catch (error) {
        logger.error({ err: error }, '[rateAlert.create] error');
        const status = error.message.includes('Maximum') || error.message.includes('ratePair') ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

exports.listAlerts = async (req, res) => {
    try {
        const rateAlertService = req.app.get('rateAlertService');
        const userId = req.user.id;
        const includeTriggered = req.query.includeTriggered !== 'false';
        const alerts = await rateAlertService.listAlerts(userId, { includeTriggered });

        const prisma = req.app.get('prisma');
        const settings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveRetailRate: true, liveUsdToGhs: true },
        });
        const currentRate = Number(settings?.liveRetailRate) > 0
            ? Number(settings.liveRetailRate)
            : Number(settings?.liveUsdToGhs) > 0
                ? Number(settings.liveUsdToGhs)
                : null;

        return res.status(200).json({
            success: true,
            data: {
                alerts,
                currentRate,
                ratePair: CANONICAL_RATE_PAIR,
            },
        });
    } catch (error) {
        logger.error({ err: error }, '[rateAlert.list] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteAlert = async (req, res) => {
    try {
        const rateAlertService = req.app.get('rateAlertService');
        const userId = req.user.id;
        const alertId = req.params.id;

        if (!alertId) {
            return res.status(400).json({ success: false, message: 'Alert ID required' });
        }

        await rateAlertService.deleteAlert(userId, alertId);
        return res.status(200).json({ success: true, message: 'Alert deleted' });
    } catch (error) {
        logger.error({ err: error }, '[rateAlert.delete] error');
        const status = error.message.includes('Not authorized') ? 403 :
                       error.message.includes('not found') ? 404 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};
