const express = require('express');
const { requireKyc } = require('../middleware/requireKyc');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { requireFreshFxRate } = require('../middleware/fxTransactionGateMiddleware');
const { idempotency } = require('../middleware/idempotency');
const cb = require('../controllers/crossBorderSusuController');

const protect = authMiddleware.protect;

router.post('/',                protect, cb.createCrossBorderSusu);
router.post('/contribute', protect, requireKyc('susu'), requireFreshFxRate(), idempotency(), cb.contributeLocalCurrency);
router.post('/payout',         protect, requireKyc('susu'), idempotency(), cb.payoutLocalCurrency);
router.get('/:susuGroupId',    protect, cb.getCrossBorderDetails);

module.exports = router;
