// routes/businessRoutes.js
// =============================================================================
// AZAMAN — BUSINESS ACCOUNTS ROUTES (2026-06-14)
// Mounted at /api/business. /search and /me are declared BEFORE /:bizId so
// Express does not capture them as a bizId path param.
// =============================================================================

const router = require('express').Router();
const ctrl = require('../controllers/businessController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', protect, ctrl.registerBusiness);
router.get('/search', ctrl.searchBusinesses); // public
router.get('/me', protect, ctrl.getMyBusiness);
router.patch('/profile', protect, ctrl.updateBusinessProfile);
router.get('/:bizId', ctrl.getBusinessByBizId); // public — keep last

module.exports = router;
