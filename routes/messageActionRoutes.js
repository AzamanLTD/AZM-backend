// =============================================================================
// AZAMAN — Message Action Routes (Phase 3.3.4)
//
// Search, pin/unpin, star/unstar, forward, get starred messages
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const controller = require('../controllers/messageActionController');

// Search messages across all conversations
router.post('/search',       protect, controller.searchMessages);

// Get all starred messages for the user
router.get('/starred',        protect, controller.getStarredMessages);

// Toggle pin on a message
router.patch('/:context/:id/pin',  protect, controller.togglePin);

// Toggle star on a message
router.patch('/:context/:id/star', protect, controller.toggleStar);

// Forward a message to another conversation
router.post('/forward',       protect, controller.forwardMessage);

module.exports = router;
