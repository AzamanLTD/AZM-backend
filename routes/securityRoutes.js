const express = require('express');
const router = express.Router();
const securityController = require('../controllers/securityController');
const authMiddleware = require('../middleware/authMiddleware.js');

const protect = authMiddleware.protect;

router.post('/2fa/setup', protect, securityController.setup2FA);
router.post('/2fa/verify', protect, securityController.verify2FA);
router.post('/2fa/disable', protect, securityController.disable2FA);
router.post('/pin/set', protect, securityController.setPin);
router.post('/pin/verify', protect, securityController.verifyPin);
router.post('/change-password', protect, securityController.changePassword);

// Phase L2 — Phone OTP verification (gates SMS sends)
router.post('/phone/send-otp', protect, securityController.sendPhoneOtp);
router.post('/phone/verify-otp', protect, securityController.verifyPhoneOtp);

module.exports = router;
