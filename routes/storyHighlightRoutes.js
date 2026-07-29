// routes/storyHighlightRoutes.js
// Routes for story highlights, close friends, and story analytics

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/storyHighlightController');

// ── Highlights ───────────────────────────────────────────────────────────────────
router.post   ('/highlights',           protect, ctrl.createHighlight);
router.get    ('/highlights',           protect, ctrl.listHighlights);
router.get    ('/highlights/:id',       protect, ctrl.getHighlight);
router.delete ('/highlights/:id',       protect, ctrl.deleteHighlight);
router.post   ('/highlights/:id/items',  protect, ctrl.addItem);
router.delete ('/highlights/:id/items/:itemId', protect, ctrl.removeItem);

// ── Close Friends ───────────────────────────────────────────────────────────────
router.get    ('/close-friends',                 protect, ctrl.listCloseFriends);
router.post   ('/close-friends',                 protect, ctrl.addCloseFriend);
router.delete ('/close-friends/:friendId',        protect, ctrl.removeCloseFriend);

// ── Story Analytics ──────────────────────────────────────────────────────────────
router.get    ('/analytics/:storyId',            protect, ctrl.getStoryAnalytics);
router.get    ('/analytics/business/:businessId', protect, ctrl.getBusinessAnalytics);

module.exports = router;
