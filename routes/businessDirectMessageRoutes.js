const express = require('express');
const router = express.Router();
const { wrap } = require('../utils/catchAsync');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

// Helper to get Prisma client
const getPrisma = (req) => req.app.get('prisma') || require('../prisma/client');

// GET /api/direct-messages/business-inbox
// Fetch all conversations for a specific business
router.get('/business-inbox', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { businessId } = req.query;
    
    if (!businessId) {
        return res.status(400).json({ success: false, message: 'businessId required' });
    }

    // A business conversation in this context is one between the business and a customer.
    // For simplicity, we'll look for BusinessConversation records or create a virtual list
    // based on orders, or we can just fetch BusinessConversations.
    const dbConversations = await prisma.businessConversation.findMany({
        where: { businessProfileId: businessId },
        include: {
            participantA: { select: { id: true, username: true, avatarUrl: true } },
            participantB: { select: { id: true, username: true, avatarUrl: true } },
            conversation: true
        },
        orderBy: { lastMessageAt: 'desc' },
    });

    // Format to match frontend expectations
    const conversations = dbConversations.map(conv => {
        // The "user" is the participant who is not the business owner/staff
        // In this simple mockup, we assume participantB is the customer if participantA is the business.
        // Actually we can just find the participant whose ID isn't req.user.id
        const user = conv.participantAId === req.user.id ? conv.participantB : conv.participantA;
        
        return {
            id: conv.conversationId,
            user: {
                id: user.id,
                name: user.username,
                avatarUrl: user.avatarUrl
            },
            lastMessagePreview: conv.lastMessagePreview,
            lastMessageTime: conv.lastMessageAt,
            unreadCount: 0 // Mocked for now
        };
    });

    res.json({ success: true, conversations });
}));

// GET /api/direct-messages/thread
// Fetch messages for a specific thread between a user and a business
router.get('/thread', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { userId, businessId } = req.query;

    if (!userId || !businessId) {
        return res.status(400).json({ success: false, message: 'userId and businessId required' });
    }

    // Find the conversation
    const bizConv = await prisma.businessConversation.findFirst({
        where: {
            businessProfileId: businessId,
            OR: [
                { participantAId: parseInt(userId) },
                { participantBId: parseInt(userId) }
            ]
        }
    });

    if (!bizConv) {
        return res.json({ success: true, messages: [] });
    }

    const dbMessages = await prisma.message.findMany({
        where: { conversationId: bizConv.conversationId },
        orderBy: { createdAt: 'asc' },
    });

    const messages = dbMessages.map(msg => ({
        id: msg.id,
        text: msg.content,
        createdAt: msg.createdAt,
        senderId: msg.senderId,
        senderType: msg.senderId === req.user.id ? 'business' : 'user'
    }));

    res.json({ success: true, messages });
}));

// POST /api/direct-messages/send
// Send a message
router.post('/send', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { businessId, userId, text, orderId, reservationId } = req.body;

    if (!businessId || !userId || !text) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let bizConv = await prisma.businessConversation.findFirst({
        where: {
            businessProfileId: businessId,
            OR: [
                { participantAId: parseInt(userId) },
                { participantBId: parseInt(userId) }
            ]
        }
    });

    if (!bizConv) {
        // Create conversation
        const conversation = await prisma.conversation.create({
            data: { type: 'BUSINESS' }
        });

        bizConv = await prisma.businessConversation.create({
            data: {
                businessProfileId: businessId,
                conversationId: conversation.id,
                participantAId: req.user.id, // business staff
                participantBId: parseInt(userId), // customer
                createdBy: req.user.id,
            }
        });
    }

    const message = await prisma.message.create({
        data: {
            conversationId: bizConv.conversationId,
            senderId: req.user.id,
            messageType: 'TEXT',
            content: text,
        }
    });

    await prisma.businessConversation.update({
        where: { id: bizConv.id },
        data: {
            lastMessageAt: new Date(),
            lastMessagePreview: text.substring(0, 200),
        }
    });

    // Optionally emit socket event here if io is available
    const io = req.app.get('socketio');
    if (io) {
        io.to(`user_${userId}`).emit('new_message', { message });
    }

    res.json({ success: true, message: {
        id: message.id,
        text: message.content,
        createdAt: message.createdAt,
        senderId: message.senderId,
        senderType: 'business'
    }});
}));

module.exports = router;
