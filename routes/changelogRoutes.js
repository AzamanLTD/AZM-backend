// routes/changelogRoutes.js
// Changelog routes — user-facing + admin

const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/changelogController');

// ── User-facing ────────────────────────────────────────────────────────────
router.get('/', protect, ctrl.listChangelog);
router.get('/unread-count', protect, ctrl.unreadCount);
router.post('/dismiss-all', protect, ctrl.dismissAll);
router.post('/:id/dismiss', protect, ctrl.dismissEntry);

// ── Admin ──────────────────────────────────────────────────────────────────
router.get('/admin', protect, adminOnly, ctrl.adminList);
router.post('/admin', protect, adminOnly, ctrl.adminCreate);
router.put('/admin/:id', protect, adminOnly, ctrl.adminUpdate);
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDelete);

module.exports = router;
