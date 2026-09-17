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

const ORACLE_REFRESH_INTERVAL_SECONDS = 10 * 60;

/**
 * GET /api/oracle/yellowcard-rate
 *
 * Returns the current USD→GHS live rate plus the user-facing retail rate.
 */
router.get('/yellowcard-rate', async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        if (!settings) {
            return res.status(200).json({
                success: true,
                rate: 0,
                retailRate: 0,
                corporateRate: 0,
                source: 'UNAVAILABLE',
                lastSync: null,
                refreshIntervalSeconds: ORACLE_REFRESH_INTERVAL_SECONDS,
            });
        }

        return res.status(200).json({
            success: true,
            rate: Number(settings.liveUsdToGhs) || 0,
            retailRate: Number(settings.liveRetailRate) || 0,
            corporateRate: Number(settings.liveCorporateRate) || 0,
            source: settings.liveRateSource || 'UNKNOWN',
            lastSync: settings.lastRateSync || null,
            // Truthful provenance (issue #271 / PR 271B): freshness is based on
            // the last genuine EXTERNAL observation, which is NULL (unknown)
            // for rows that predate 271B — never faked into a fresh age.
            lastExternalSync: settings.lastExternalSync || null,
            lastAdminSetAt: settings.lastAdminSetAt || null,
            lastEchoAt: settings.lastEchoAt || null,
            refreshIntervalSeconds: ORACLE_REFRESH_INTERVAL_SECONDS,
        });
    } catch (error) {
        logger.error({ err: error }, '[Oracle] yellowcard-rate error');
        return res.status(500).json({ success: false, message: 'Failed to fetch oracle rate' });
    }
});

/**
 * GET /api/oracle/rates
 *
 * Canonical dual-currency snapshot. USDC is the settlement unit; GHS is the
 * derived local display equivalent. The refresh interval is the server's
 * oracle sync cadence so clients can present an honest freshness countdown.
 */
router.get('/rates', async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        return res.status(200).json({
            success: true,
            data: {
                pair: 'USDC/GHS',
                settlementCurrency: 'USDC',
                displayCurrency: 'GHS',
                liveUsdToGhs: Number(settings?.liveUsdToGhs) || 0,
                liveRetailRate: Number(settings?.liveRetailRate) || 0,
                liveCorporateRate: Number(settings?.liveCorporateRate) || 0,
                bankMargin: Number(settings?.bankMargin) || 3.0,
                thirdPartyMargin: Number(settings?.thirdPartyMargin) || 2.0,
                rateSource: settings?.liveRateSource || 'UNKNOWN',
                lastSync: settings?.lastRateSync || null,
                // Truthful provenance (issue #271 / PR 271B): the canonical
                // freshness field for future 271C gating. NULL honestly means
                // "no genuine external observation recorded since 271B" — it
                // is never backfilled or converted into a fake fresh age.
                lastExternalSync: settings?.lastExternalSync || null,
                lastAdminSetAt: settings?.lastAdminSetAt || null,
                lastEchoAt: settings?.lastEchoAt || null,
                refreshIntervalSeconds: ORACLE_REFRESH_INTERVAL_SECONDS,
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[Oracle] rates error');
        return res.status(500).json({ success: false, message: 'Failed to fetch rates' });
    }
});

// =============================================================================
// RATE ALERTS (Phase Q12) — Authenticated endpoints
// =============================================================================
const { protect } = require('../middleware/authMiddleware');
const rateAlertController = require('../controllers/rateAlertController');
router.post('/alerts', protect, rateAlertController.createAlert);
router.get('/alerts', protect, rateAlertController.listAlerts);
router.delete('/alerts/:id', protect, rateAlertController.deleteAlert);

module.exports = router;
