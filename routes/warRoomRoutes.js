const logger = require('../src/config/logger');
const express                 = require('express');
const router                  = express.Router();
const warRoomController       = require('../controllers/warRoomController');
const { protect, adminOnly }  = require('../middleware/authMiddleware');
const { idempotency }         = require('../middleware/idempotency');

router.use(protect);
router.use(adminOnly);

// r272 finding 2 — corporate treasury credits move money and MUST sit under
// the shared idempotency authority. Until now both corporate-purchase routes
// were unprotected: a retried POST (double-click, network retry, replay)
// wrote a second CorporatePurchaseLog row and credited SystemMasterCrypto a
// second time — the API path's unique gatewayReference only stopped replays
// that re-sent the SAME reference, and the auto-generated reference is fresh
// per request, so it protected nothing. The claim commits INSIDE the
// handler's economic $transaction (wired commitOperation), so
// releaseOn4xx is valid: an IN_PROGRESS claim after a 4xx is durable proof
// the transaction rolled back. The key is REQUIRED — an unkeyed admin
// credit has no durable exactly-once identity anywhere else.
router.post(
  '/corporate-purchase',
  idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, identity: 'POST /api/war-room/corporate-purchase' }),
  warRoomController.logCorporatePurchase
);
router.post(
  '/corporate-purchase/api',
  idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, identity: 'POST /api/war-room/corporate-purchase/api' }),
  warRoomController.purchaseCorporateViaApi
);   // Phase B
router.post('/liquidate-profits',      warRoomController.liquidateProfits);
router.post('/cold-storage',           warRoomController.logColdStorage);

module.exports = router;
