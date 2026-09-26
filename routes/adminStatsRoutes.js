'use strict';

const express = require('express');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { getPlatformStats } = require('../controllers/adminStatsController');

const router = express.Router();

router.use(protect);
router.use(adminOnly);
router.get('/stats', getPlatformStats);

module.exports = router;
