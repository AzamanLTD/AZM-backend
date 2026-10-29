const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const cb = require('../controllers/crossBorderSusuController');
const { requireKyc } = require('../middleware/requireKyc');

const protect = authMiddleware.protect;

router.post('/',                protect, cb.createCrossBorderSusu);
router.post('/contribute',     protect, requireKyc('susu'), idempotency(), cb.contributeLocalCurrency);
router.post('/payout',         protect, requireKyc('susu'), idempotency(), cb.payoutLocalCurrency);
router.get('/:susuGroupId',    protect, cb.getCrossBorderDetails);

module.exports = router;
