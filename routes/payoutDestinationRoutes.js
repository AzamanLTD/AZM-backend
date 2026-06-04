const express = require('express');
const router = express.Router();
const payoutDestinationController = require('../controllers/payoutDestinationController');
const authMiddleware = require('../middleware/authMiddleware');

const protect = authMiddleware.protect;

router.post('/', protect, payoutDestinationController.addPayoutDestination);
router.get('/', protect, payoutDestinationController.getPayoutDestinations);

module.exports = router;
