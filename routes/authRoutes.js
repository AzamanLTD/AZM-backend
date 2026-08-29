const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const ssoController = require('../controllers/ssoController');
const refreshController = require('../controllers/refreshController');
const businessSessionController = require('../controllers/businessSessionController');
const authMiddleware = require('../middleware/authMiddleware.js');
const { validate } = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../services/validation/authSchemas');

const protect = authMiddleware.protect;

router.post('/register', validate(registerSchema, 'authList'), authController.register);
router.post('/login', validate(loginSchema, 'authList'), authController.login);

router.post('/sso', ssoController.ssoLogin);

// Phase K: refresh-token rotation + logout.
router.post('/refresh', refreshController.refresh);
router.post('/logout', refreshController.logout);

// Business Portal browser sessions keep the rotated refresh token in an
// HttpOnly cookie. The initial Phase-K refresh token is supplied once by the
// Business Portal and is never persisted by browser JavaScript afterward.
router.post('/business-session', businessSessionController.bootstrap);
router.post('/business-session/logout', businessSessionController.logout);

router.get('/settings/rates', authController.getPublicRates);

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

router.get('/me/:id', protect, authController.getUserDetails);
router.put('/fcm-token', protect, authController.saveFcmToken);
router.post('/fcm-token', protect, authController.saveFcmToken);

module.exports = router;
