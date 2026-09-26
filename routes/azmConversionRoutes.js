const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const convController = require('../controllers/azmConversionController');

const protect = authMiddleware.protect;

router.post('/',        protect, idempotency(), convController.convertAzmToUsdc);
router.get('/rate',     protect, convController.getRate);
router.get('/history',  protect, convController.getConversionHistory);

module.exports = router;
