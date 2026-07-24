const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const securityController = require('../controllers/securityController');
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
