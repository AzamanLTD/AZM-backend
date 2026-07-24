const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const queueController = require('../controllers/queueController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

router.get('/capabilities', protect, adminOnly, aiController.getAiCapabilities);

router.post('/cfo/analyze', protect, adminOnly, aiController.triggerCfoAnalysis);

router.post('/queue/initiate', protect, queueController.initiateTradeWithQueue);
router.get('/queue/status', protect, queueController.getQueueStatus);
router.put('/queue/:queueId/leave', protect, queueController.leaveQueue);

router.post('/queue/process/:adId', protect, adminOnly, async (req, res) => {
    try {
        const { adId } = req.params;
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const result = await queueController.processNextInQueue(adId, { prisma, io });
        res.status(200).json({ success: true, processed: result });
    } catch (error) {
        logger.error('[AI Routes] processNextInQueue error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
