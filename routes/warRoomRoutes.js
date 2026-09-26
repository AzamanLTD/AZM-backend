const logger = require('../src/config/logger');
const express                 = require('express');
const router                  = express.Router();
const warRoomController       = require('../controllers/warRoomController');
const { protect, adminOnly }  = require('../middleware/authMiddleware');

router.use(protect);
router.use(adminOnly);

router.post('/corporate-purchase',     warRoomController.logCorporatePurchase);
router.post('/corporate-purchase/api', warRoomController.purchaseCorporateViaApi);   // Phase B
router.post('/liquidate-profits',      warRoomController.liquidateProfits);
router.post('/cold-storage',           warRoomController.logColdStorage);

module.exports = router;
