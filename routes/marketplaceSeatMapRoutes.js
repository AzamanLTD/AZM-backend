const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/marketplaceSeatMapController');

router.get('/:tripId',     protect, ctrl.getSeatMap);
router.put('/:tripId',     protect, ctrl.saveSeatMap);

module.exports = router;
