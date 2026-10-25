// routes/bookmarkRoutes.js
// Business bookmark routes (marketplace personalisation, Backend A).
// All routes require authentication — bookmarks are private per-user state.
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/bookmarkController');

router.post('/',                       protect, ctrl.bookmark);
router.get('/',                        protect, ctrl.myBookmarks);
router.get('/check/:businessProfileId', protect, ctrl.checkBookmarked);
router.delete('/:businessProfileId',   protect, ctrl.unbookmark);

module.exports = router;
