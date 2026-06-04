const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const ssoController = require('../controllers/ssoController');
const refreshController = require('../controllers/refreshController');
const authMiddleware = require('../middleware/authMiddleware.js');

const protect = authMiddleware.protect;

router.post('/register', authController.register);
router.post('/login', authController.login);

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

// --- THE NEW DOOR: Fetch User Balance & Details ---
router.get('/me/:id', protect, authController.getUserDetails);

// --- FCM PUSH TOKEN REGISTRATION ---
// PUT handles refreshes; POST kept as an alias so existing Flutter clients
// that happen to POST don't 404.
router.put('/fcm-token', protect, authController.saveFcmToken);
router.post('/fcm-token', protect, authController.saveFcmToken);

module.exports = router;
