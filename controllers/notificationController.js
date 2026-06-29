const NotificationService = require('../services/notificationService');
const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

let notificationService;

function getService(req) {
    if (!notificationService) {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        notificationService = new NotificationService(prisma, io);
    }
    return notificationService;
}

exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const unreadOnly = req.query.unreadOnly === 'true';
        const category = req.query.category || null;
        const { take, cursor, page, mode } = parsePagination(req.query);

        const result = await getService(req).getNotifications(userId, {
            limit: take,
            page,
            cursor,
            unreadOnly,
            category
        });

        // result.notifications is the array; envelope wraps it with cursor info.
        const envelope = buildPageEnvelope(result.notifications, take, mode, page, result.total);

        res.status(200).json({
            success: true,
            notifications: result.notifications,
            ...envelope
        });
    } catch (error) {
        console.error('getNotifications error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getUnreadCount = async (req, res) => {
    try {
        const userId = req.user.id;
        const count = await getService(req).getUnreadCount(userId);
        res.status(200).json({ success: true, count });
    } catch (error) {
        console.error('getUnreadCount error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.markAsRead = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const updated = await getService(req).markAsRead(id, userId);

        // Phase B2 (2026-05-25): multi-device badge sync. Without this,
        // marking a notification read on one device leaves the badge
        // counter stale on every other open session of the same user
        // (web + phone). Emitting on the user's socket room lets other
        // clients refresh their unread counts. Best-effort — failure
        // here must not break the DB write.
        try {
            const io = req.app.get('socketio');
            if (io) {
                io.to(`user_${userId}`).emit('notifications_updated', {
                    type: 'MARKED_READ',
                    notificationId: id
                });
            }
        } catch (sockErr) {
            console.error(`[markAsRead] socket emit non-fatal: ${sockErr.message}`);
        }

        res.status(200).json({ success: true, notification: updated });
    } catch (error) {
        console.error('markAsRead error:', error.message);
        if (error.message === 'Notification not found') {
            return res.status(404).json({ success: false, message: error.message });
        }
        if (error.message === 'Not authorized') {
            return res.status(403).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await getService(req).markAllAsRead(userId);

        // Phase B2 (2026-05-25): same multi-device sync as markAsRead.
        // Sends a single bulk-mark event so other sessions can clear
        // their entire badge in one socket round-trip.
        try {
            const io = req.app.get('socketio');
            if (io) {
                io.to(`user_${userId}`).emit('notifications_updated', {
                    type: 'MARKED_ALL_READ',
                    affected: result.count
                });
            }
        } catch (sockErr) {
            console.error(`[markAllAsRead] socket emit non-fatal: ${sockErr.message}`);
        }

        res.status(200).json({ success: true, updated: result.count });
    } catch (error) {
        console.error('markAllAsRead error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.sendTradeStarted = async (req, res) => {
    try {
        const { userId, tradeId } = req.body;
        if (!userId || !tradeId) {
            return res.status(400).json({ success: false, message: 'userId and tradeId are required' });
        }
        const notification = await getService(req).sendTradeStarted(userId, tradeId);
        res.status(201).json({ success: true, notification });
    } catch (error) {
        console.error('sendTradeStarted error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.sendDisputeUpdated = async (req, res) => {
    try {
        const { userId, disputeId } = req.body;
        if (!userId || !disputeId) {
            return res.status(400).json({ success: false, message: 'userId and disputeId are required' });
        }
        const notification = await getService(req).sendDisputeUpdated(userId, disputeId);
        res.status(201).json({ success: true, notification });
    } catch (error) {
        console.error('sendDisputeUpdated error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.sendDepositSuccess = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }
        const notification = await getService(req).sendDepositSuccess(userId);
        res.status(201).json({ success: true, notification });
    } catch (error) {
        console.error('sendDepositSuccess error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.sendAiMaticLowWarning = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }
        const notification = await getService(req).sendAiMaticLowWarning(userId);
        res.status(201).json({ success: true, notification });
    } catch (error) {
        console.error('sendAiMaticLowWarning error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};
