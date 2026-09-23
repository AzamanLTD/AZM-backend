// routes/businessDirectMessageRoutes.js
// =============================================================================
// Legacy /api/direct-messages compatibility adapter (used by the Business
// Portal Messages page).
//
// r35/P0-P1: these routes previously trusted caller-supplied businessId and
// userId, letting any authenticated user enumerate another business's
// customer conversations, read arbitrary business/user threads, and create
// BusinessConversation rows under businesses they do not staff. The routes
// are now THIN adapters over the canonical BusinessDirectMessageService:
// authority is derived server-side (business context / conversation
// participation), and the request/response envelopes are preserved for the
// portal. No separate message-authority implementation lives here.
// =============================================================================
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { BusinessDirectMessageService } = require('../services/businessOS/businessDirectMessageService');

const wrap = (handler) => async (req, res) => {
    try {
        await handler(req, res);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 400;
        res.status(status).json({ success: false, message: err.message });
    }
};

const getService = (req) => new BusinessDirectMessageService(
    req.app.get('prisma') || require('../prisma/client'),
    req.app.get('socketio') || null,
);

// GET /api/direct-messages/business-inbox
// businessId is ADVISORY: the inbox is always the caller's server-resolved
// business. A mismatched advisory id is refused, never honored.
router.get('/business-inbox', protect, protectActive, wrap(async (req, res) => {
    const result = await getService(req).businessInbox({
        user: req.user,
        advisoryBusinessId: req.query.businessId ? String(req.query.businessId) : null,
    });
    res.json({ success: true, conversations: result.conversations });
}));

// GET /api/direct-messages/thread
// Authority: staff of the exact business, or a participant of the exact
// BusinessConversation. Caller-supplied ids are locators, never authority.
router.get('/thread', protect, protectActive, wrap(async (req, res) => {
    const result = await getService(req).thread({
        user: req.user,
        businessId: req.query.businessId,
        userId: req.query.userId,
    });
    res.json({ success: true, messages: result.messages });
}));

// POST /api/direct-messages/send
// Only business-side authority (owner / active employee of that exact
// business) may CREATE a conversation. Everyone else may only write into a
// conversation they already participate in.
router.post('/send', protect, protectActive, wrap(async (req, res) => {
    const { businessId, userId, text } = req.body;
    const result = await getService(req).send({
        user: req.user,
        businessId,
        userId,
        text,
    });
    res.json({ success: true, message: result.message });
}));

module.exports = router;
