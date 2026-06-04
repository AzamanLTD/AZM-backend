// routes/azmAuctionRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/azmAuctionController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

// Public-ish: any authenticated user can see the auction state +
// promoted ads (the marketplace UI uses this to pin the top-3).
router.get('/current',   protect,       ctrl.current);
router.get('/promoted',  protect,       ctrl.promoted);

// Vendor actions
router.post('/bid',      protectActive, ctrl.placeBid);
router.delete('/bid',    protectActive, ctrl.withdrawBid);
router.get('/bid',       protect,       ctrl.myBid);
router.get('/history',   protect,       ctrl.history);

module.exports = router;
