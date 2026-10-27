// routes/recommendationFeedbackRoutes.js
// "Show less like this" feedback routes (Backend D). All authenticated.
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/recommendationFeedbackController');

router.post('/',                       protect, ctrl.applyShowLess);
router.get('/',                        protect, ctrl.mySuppressed);
router.get('/check/:businessProfileId', protect, ctrl.checkSuppressed);
router.delete('/:businessProfileId',   protect, ctrl.undoShowLess);

module.exports = router;
