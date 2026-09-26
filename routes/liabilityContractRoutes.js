// routes/liabilityContractRoutes.js
// =============================================================================
// /api/liability-contract/active (public)
// /api/admin/liability-contract  (adminOnly POST)
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const overlay = require('../controllers/susu/susuOverlayController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

const publicRouter = express.Router();
publicRouter.get('/active', overlay.getActiveContract);

const adminRouter = express.Router();
adminRouter.post('/', protect, adminOnly, overlay.publishContract);

module.exports = { publicRouter, adminRouter };
