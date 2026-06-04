// controllers/rateAlertController.js
// =============================================================================
// AZAMAN — RATE ALERT CONTROLLER (Phase Q12)
//
// Endpoints:
//   POST   /api/oracle/alerts          — Create a new rate alert
//   GET    /api/oracle/alerts          — List user's alerts
//   DELETE /api/oracle/alerts/:id      — Delete/deactivate an alert
//
// All require authentication.
// =============================================================================

// 1. CREATE RATE ALERT
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
            ratePair: ratePair || 'USD_GHS',
            note,
        });

        return res.status(201).json({
            success: true,
            data: alert,
        });

    } catch (error) {
        console.error('[rateAlert.create] error:', error.message);
        const status = error.message.includes('Maximum') ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

// 2. LIST RATE ALERTS
exports.listAlerts = async (req, res) => {
    try {
        const rateAlertService = req.app.get('rateAlertService');
        const userId = req.user.id;
        const includeTriggered = req.query.includeTriggered !== 'false';

        const alerts = await rateAlertService.listAlerts(userId, { includeTriggered });

        // Get current rate for context
        const prisma = req.app.get('prisma');
        const settings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveUsdToGhs: true },
        });

        return res.status(200).json({
            success: true,
            data: {
                alerts,
                currentRate: settings?.liveUsdToGhs || null,
                ratePair: 'USD_GHS',
            },
        });

    } catch (error) {
        console.error('[rateAlert.list] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// 3. DELETE RATE ALERT
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
        console.error('[rateAlert.delete] error:', error.message);
        const status = error.message.includes('Not authorized') ? 403 :
                       error.message.includes('not found') ? 404 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};
