// routes/adminWarRoomRoutes.js
// =============================================================================
// /api/admin/war-room/alerts (adminOnly)
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const ctrl = require('../controllers/susu/adminWarRoomController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/alerts', protect, adminOnly, ctrl.listAlerts);
router.post('/alerts/:id/acknowledge', protect, adminOnly, ctrl.acknowledgeAlert);

module.exports = router;
