// routes/oracleRoutes.js
// =============================================================================
// AZAMAN V4 — ORACLE ROUTES
//
// Public endpoints for live exchange rate data.
// No authentication required — rates are public information.
//
// Mounted at /api/oracle in server.js
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();

/**
 * GET /api/oracle/yellowcard-rate
 *
 * Returns the current USD→GHS live rate from GlobalSettings.
 * The frontend's TradeProvider.fetchYellowCardRate() calls this endpoint
 * to display the cached oracle rate in the UI.
 *
 * Response shape:
 * {
 *   success: true,
 *   rate: 15.20,
 *   source: "KOTANI_PAY",
 *   lastSync: "2026-05-23T22:00:00.000Z"
 * }
 */
router.get('/yellowcard-rate', async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        if (!settings) {
            return res.status(200).json({
                success: true,
                rate: 0,
                source: 'UNAVAILABLE',
                lastSync: null
            });
        }

        return res.status(200).json({
            success: true,
            rate: settings.liveUsdToGhs || 0,
            retailRate: settings.liveRetailRate || 0,
            corporateRate: settings.liveCorporateRate || 0,
            source: settings.liveRateSource || 'UNKNOWN',
            lastSync: settings.lastRateSync || null
        });
    } catch (error) {
        logger.error({ err: error }, '[Oracle] yellowcard-rate error');
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch oracle rate'
        });
    }
});

/**
 * GET /api/oracle/rates
 *
 * Returns all live rates in a single call (convenience endpoint).
 * Includes USD→GHS, retail margin, corporate margin.
 */
router.get('/rates', async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        return res.status(200).json({
            success: true,
            data: {
                liveUsdToGhs: settings?.liveUsdToGhs || 0,
                liveRetailRate: settings?.liveRetailRate || 0,
                liveCorporateRate: settings?.liveCorporateRate || 0,
                bankMargin: settings?.bankMargin || 3.0,
                thirdPartyMargin: settings?.thirdPartyMargin || 2.0,
                rateSource: settings?.liveRateSource || 'UNKNOWN',
                lastSync: settings?.lastRateSync || null
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[Oracle] rates error');
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch rates'
        });
    }
});

// =============================================================================
// RATE ALERTS (Phase Q12) — Authenticated endpoints
// =============================================================================

const { protect } = require('../middleware/authMiddleware');
const rateAlertController = require('../controllers/rateAlertController');

// Create a new rate alert
router.post('/alerts', protect, rateAlertController.createAlert);

// List user's rate alerts
router.get('/alerts', protect, rateAlertController.listAlerts);

// Delete a rate alert
router.delete('/alerts/:id', protect, rateAlertController.deleteAlert);

module.exports = router;
