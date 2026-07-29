const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const cb = require('../controllers/crossBorderSusuController');

const protect = authMiddleware.protect;

router.post('/',                protect, cb.createCrossBorderSusu);
router.post('/contribute',     protect, idempotency(), cb.contributeLocalCurrency);
router.post('/payout',         protect, idempotency(), cb.payoutLocalCurrency);
router.get('/:susuGroupId',    protect, cb.getCrossBorderDetails);

module.exports = router;
