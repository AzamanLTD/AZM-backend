const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const mc = require('../controllers/multiCurrencyController');

const protect = authMiddleware.protect;

router.get('/wallets',            protect, mc.getWallets);
router.post('/wallets',           protect, mc.createWallet);
router.patch('/wallets/default',  protect, mc.setDefaultWallet);
router.post('/convert',           protect, idempotency(), mc.convertCurrency);
router.get('/rates',              protect, mc.getRates);
router.put('/rates',              protect, mc.updateFxRate);

module.exports = router;
