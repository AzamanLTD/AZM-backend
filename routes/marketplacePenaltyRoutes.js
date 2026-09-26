const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/marketplacePenaltyController');

router.get('/',         protect, ctrl.getPolicy);
router.put('/',         protect, ctrl.updatePolicy);

module.exports = router;
