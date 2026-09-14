'use strict';

const express = require('express');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { getDineInOverview } = require('../controllers/adminDineInController');

const router = express.Router();

router.use(protect);
router.use(adminOnly);
router.get('/dine-in/overview', getDineInOverview);

module.exports = router;
