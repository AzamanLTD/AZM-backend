const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const securityController = require('../controllers/securityController');
const appUnlockController = require('../controllers/appUnlockController');
const authMiddleware = require('../middleware/authMiddleware.js');
const { validate } = require('../middleware/validate');
const {
    changePasswordSchema,
    verify2FASchema,
    disable2FASchema,
    setPinSchema,
    verifyPinSchema,
    sendPhoneOtpSchema,
    verifyPhoneOtpSchema,
} = require('../services/validation/securitySchemas');

const protect = authMiddleware.protect;

// Zod edge-guards (additive). `protect` runs first (auth before validation,
// matching withdrawalRoutes); the `singleMessage` formatter reproduces each
// controller's exact { success:false, message:'…' } envelope. setup2FA takes no
// body, so it is left unguarded. Controllers retain their inline checks.
router.post('/2fa/setup', protect, securityController.setup2FA);
router.post('/2fa/verify', protect, validate(verify2FASchema, 'singleMessage'), securityController.verify2FA);
router.post('/2fa/disable', protect, validate(disable2FASchema, 'singleMessage'), securityController.disable2FA);
router.post('/pin/set', protect, validate(setPinSchema, 'singleMessage'), securityController.setPin);
router.post('/pin/verify', protect, validate(verifyPinSchema, 'singleMessage'), securityController.verifyPin);
router.post('/change-password', protect, validate(changePasswordSchema, 'singleMessage'), securityController.changePassword);

// Phase L2 — Phone OTP verification (gates SMS sends)
router.post('/phone/send-otp', protect, validate(sendPhoneOtpSchema, 'singleMessage'), securityController.sendPhoneOtp);
router.post('/phone/verify-otp', protect, validate(verifyPhoneOtpSchema, 'singleMessage'), securityController.verifyPhoneOtp);

module.exports = router;

// ── Session Management (Enterprise Readiness) ──────────────────────────────
const sessionController = require('../controllers/sessionController');
router.get('/sessions', protect, sessionController.listSessions);
router.post('/sessions/revoke-all', protect, sessionController.revokeAllSessions);
router.post('/sessions/:id/revoke', protect, sessionController.revokeSession);

// ── GDPR Data Export (Enterprise Readiness) ───────────────────────────────
const dataExportController = require('../controllers/dataExportController');
router.get('/data-export', protect, dataExportController.exportUserData);

// ── WebAuthn / Passkey Routes (Phase 2: Scalability & Security) ──────────────
const webauthnController = require('../controllers/webauthnController');

// Registration (requires existing auth — user must be logged in to add a passkey)
router.post('/webauthn/register/begin', protect, webauthnController.beginRegistration);
router.post('/webauthn/register/finish', protect, webauthnController.finishRegistration);

// Login (no auth required — passwordless login via passkey)
router.post('/webauthn/login/begin', webauthnController.beginLogin);
router.post('/webauthn/login/finish', webauthnController.finishLogin);

// Credential management (requires auth)
router.get('/webauthn/credentials', protect, webauthnController.listCredentials);
router.delete('/webauthn/credentials/:id', protect, webauthnController.deleteCredential);

// =============================================================================
// MEMBER APP UNLOCK (server-managed factors)
//
// Separate purpose from enrolment and from phone verification. `/2fa/verify`
// ENROLLS the authenticator; `/phone/verify-otp` MUTATES phone identity. Neither
// may be used to unlock, and nothing here touches either. Device biometrics are
// handled locally by local_auth and never reach these routes.
// =============================================================================
router.get('/app-unlock/capabilities',   protect, appUnlockController.getAppUnlockCapabilities);
router.post('/app-unlock/pin/verify',    protect, appUnlockController.verifyAppUnlockPin);
router.post('/app-unlock/totp/verify',   protect, appUnlockController.verifyAppUnlockTotp);
router.post('/app-unlock/sms/send',      protect, appUnlockController.sendAppUnlockOtp);
router.post('/app-unlock/sms/verify',    protect, appUnlockController.verifyAppUnlockOtp);

// PIN removal with fresh proof. The client must not say "removed" until this
// returns 200 — the handler writes the null hash before responding.
router.delete('/pin',                    protect, appUnlockController.removePin);

