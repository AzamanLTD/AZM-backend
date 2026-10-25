// routes/socialProofRoutes.js
// Business social-proof aggregates (Backend C). Personalised per-viewer —
// all routes require authentication.
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/socialProofController');

router.get('/:businessProfileId', protect, ctrl.getForBusiness);
router.post('/',                      protect, ctrl.getForBusinesses);

module.exports = router;
