const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const obController = require('../controllers/orderBookController');

const protect = authMiddleware.protect;

// §r42.1 wired: the claim commits INSIDE the placement $transaction, so an
// IN_PROGRESS claim after a 4xx is durable proof of rollback — the key is
// safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a post-
// commit failure must never re-arm a placed order.
router.post('/orders',       protect, idempotency({ releaseOn4xx: true }), obController.placeOrder);
router.get('/',              protect, obController.getOrderBook);
router.get('/orders/my',     protect, obController.getMyOrders);
router.get('/trades',        protect, obController.getTradeHistory);
router.delete('/orders/:id', protect, obController.cancelOrder);

module.exports = router;
