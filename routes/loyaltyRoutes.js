// routes/loyaltyRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/loyaltyController');

// ── Business side ───────────────────────────────────────────────────────────────
router.post   ('/business/:businessId/programs',             protect, ctrl.createProgram);
router.get    ('/business/:businessId/programs',             protect, ctrl.listPrograms);
router.patch  ('/business/:businessId/programs/:programId',  protect, ctrl.updateProgram);
router.delete ('/business/:businessId/programs/:programId',  protect, ctrl.deleteProgram);
router.post   ('/business/:businessId/programs/:programId/stamp', protect, ctrl.addStamp);

// ── Customer side ───────────────────────────────────────────────────────────────
router.get    ('/me/cards',                    protect, ctrl.getMyCards);
router.get    ('/me/programs/:programId/card', protect, ctrl.getMyCard);
router.post   ('/me/programs/:programId/redeem', protect, ctrl.redeemReward);

module.exports = router;
