const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const obController = require('../controllers/orderBookController');

const protect = authMiddleware.protect;

router.post('/orders',       protect, idempotency(), obController.placeOrder);
router.get('/',              protect, obController.getOrderBook);
router.get('/orders/my',     protect, obController.getMyOrders);
router.get('/trades',        protect, obController.getTradeHistory);
router.delete('/orders/:id', protect, obController.cancelOrder);

module.exports = router;
