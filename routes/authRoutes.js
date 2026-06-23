const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const ssoController = require('../controllers/ssoController');
const refreshController = require('../controllers/refreshController');
const authMiddleware = require('../middleware/authMiddleware.js');
const { validate } = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../services/validation/authSchemas');

const protect = authMiddleware.protect;

// Zod edge-guard (additive). The `authList` formatter reproduces the controller's
// exact { message:"Validation failed", errors:[...] } envelope, so the Flutter
// client sees no shape change. Controllers retain their inline validation.
router.post('/register', validate(registerSchema, 'authList'), authController.register);
router.post('/login', validate(loginSchema, 'authList'), authController.login);

// --- SSO (Google & Apple Sign-In via Firebase) ---
router.post('/sso', ssoController.ssoLogin);

// --- Phase K: refresh-token rotation + logout ---
//   POST /api/auth/refresh — exchange a refresh token for a fresh access
//                            JWT + a rotated refresh token. The endpoint
//                            does NOT use `protect` because the access
//                            token has expired by definition; it
//                            authenticates via the refresh token alone.
//   POST /api/auth/logout  — revokes the supplied refresh token. Also
//                            does not require a valid access token — a
//                            client trying to log out from an expired
//                            session shouldn't be blocked.
router.post('/refresh', refreshController.refresh);
router.post('/logout',  refreshController.logout);

// --- NEW PUBLIC DOOR: Fetch Live Oracle Rates (Used by Dashboards & Wallets) ---
router.get('/settings/rates', authController.getPublicRates);

// --- Phase ADMIN-CONTROL-2: Public Platform Configuration (FIX 1) ---
// GET /api/auth/platform/config — returns all user-facing fee rates from
// GlobalSettings. No authentication required. Falls back to hardcoded
// defaults if DB is offline. Called by Flutter PlatformConfigProvider on
// app start. Rate-limited to 60 req/min per IP (via generalLimiter).
const { generalLimiter } = require('../middleware/rateLimitMiddleware');
router.get('/platform/config', generalLimiter, async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        let settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) {
            settings = {
                fiatWithdrawalFeePct: 0.02,
                cryptoPlatformFeePct: 0.00,
                cryptoWithdrawalFeePct: 0.01,
                p2pFeePct: 0.02,
                tierThreshold: 1000,
                vendorShareUnder1k: 0.40,
                vendorShareOver1k: 0.50,
                bankMargin: 0.03,
                thirdPartyMargin: 0.02,
                susuProfitPct: 0.03
            };
        }
        return res.status(200).json({
            success: true,
            config: {
                fiatWithdrawalFeePct: Number(settings.fiatWithdrawalFeePct),
                cryptoPlatformFeePct: Number(settings.cryptoPlatformFeePct),
                cryptoWithdrawalFeePct: Number(settings.cryptoWithdrawalFeePct),
                p2pFeePct: Number(settings.p2pFeePct),
                tierThreshold: Number(settings.tierThreshold),
                vendorShareUnder1k: Number(settings.vendorShareUnder1k),
                vendorShareOver1k: Number(settings.vendorShareOver1k),
                bankMargin: Number(settings.bankMargin),
                thirdPartyMargin: Number(settings.thirdPartyMargin),
                susuProfitPct: Number(settings.susuProfitPct)
            }
        });
    } catch (e) {
        return res.status(200).json({
            success: true,
            config: {
                fiatWithdrawalFeePct: 0.02,
                cryptoPlatformFeePct: 0.00,
                cryptoWithdrawalFeePct: 0.01,
                p2pFeePct: 0.02,
                tierThreshold: 1000,
                vendorShareUnder1k: 0.40,
                vendorShareOver1k: 0.50,
                bankMargin: 0.03,
                thirdPartyMargin: 0.02,
                susuProfitPct: 0.03
            }
        });
    }
});

// --- THE NEW DOOR: Fetch User Balance & Details ---
router.get('/me/:id', protect, authController.getUserDetails);

// --- FCM PUSH TOKEN REGISTRATION ---
// PUT handles refreshes; POST kept as an alias so existing Flutter clients
// that happen to POST don't 404.
router.put('/fcm-token', protect, authController.saveFcmToken);
router.post('/fcm-token', protect, authController.saveFcmToken);

module.exports = router;
