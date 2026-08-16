// src/routes/callLogRoutes.js
// =============================================================================
// AZAMAN — Call History REST API
//
// GET    /api/calls           — list call history for authenticated user
// GET    /api/calls/:id       — get a single call record
// DELETE /api/calls/:id       — soft-delete (mark as deleted for caller)
//
// All routes require JWT auth. Users can only see their own calls.
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');


// GET /api/calls — list call history (paginated)
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type; // 'VOICE' | 'VIDEO' | undefined (all)
    const status = req.query.status; // 'MISSED' | 'ENDED' | etc.

    const where = {
      OR: [{ callerId: userId }, { calleeId: userId }],
    };
    if (type) where.type = type.toUpperCase();
    if (status) where.status = status.toUpperCase();

    const [calls, total] = await Promise.all([
      req.app.get('prisma').callLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          caller: {
            select: { id: true, username: true, displayName: true, profilePictureUrl: true },
          },
          callee: {
            select: { id: true, username: true, displayName: true, profilePictureUrl: true },
          },
        },
      }),
      req.app.get('prisma').callLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: calls,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    logger.error({ err }, '[CallLog] list failed');
    res.status(500).json({ success: false, message: 'Failed to fetch call history' });
  }
});

// GET /api/calls/:id — get single call
router.get('/:id', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const call = await req.app.get('prisma').callLog.findUnique({
      where: { id: req.params.id },
      include: {
        caller: {
          select: { id: true, username: true, displayName: true, profilePictureUrl: true },
        },
        callee: {
          select: { id: true, username: true, displayName: true, profilePictureUrl: true },
        },
      },
    });

    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    // Authorization: only caller or callee can view
    if (call.callerId !== userId && call.calleeId !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    res.json({ success: true, data: call });
  } catch (err) {
    logger.error({ err }, '[CallLog] get failed');
    res.status(500).json({ success: false, message: 'Failed to fetch call' });
  }
});

// GET /api/calls/stats/summary — aggregated call stats
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const prisma = req.app.get('prisma');

    const [totalCalls, missedCalls, totalDuration, callsMade, callsReceived] = await Promise.all([
      prisma.callLog.count({ where: { OR: [{ callerId: userId }, { calleeId: userId }] } }),
      prisma.callLog.count({ where: { calleeId: userId, status: 'MISSED' } }),
      prisma.callLog.aggregate({
        where: { OR: [{ callerId: userId }, { calleeId: userId }], status: 'ENDED' },
        _sum: { durationSec: true },
      }),
      prisma.callLog.count({ where: { callerId: userId } }),
      prisma.callLog.count({ where: { calleeId: userId } }),
    ]);

    res.json({
      success: true,
      data: {
        totalCalls,
        missedCalls,
        totalDurationSec: totalDuration._sum.durationSec || 0,
        callsMade,
        callsReceived,
      },
    });
  } catch (err) {
    logger.error({ err }, '[CallLog] stats failed');
    res.status(500).json({ success: false, message: 'Failed to fetch call stats' });
  }
});

module.exports = router;
