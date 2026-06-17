// controllers/bizNotificationController.js
// =============================================================================
// AZAMAN — BUSINESS NOTIFICATION CONTROLLER (2026-06-17)
//
// HTTP layer for the owner-facing notification feed in the Business Portal.
// Mirrors businessProductController.js / businessOrderController.js:
//   prisma = req.app.get('prisma'); io = req.app.get('socketio');
//   userId = req.user.id;
//   success → { success: true, ... }; error → { success: false, message }.
//
// Every endpoint is owner-scoped: the caller must own a BusinessProfile, and a
// notification can only be read by the business it belongs to.
// =============================================================================

const bizNotificationService = require('../services/bizNotificationService');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Load the BusinessProfile owned by the calling user (null if none). */
async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findUnique({
        where: { userId },
        select: { id: true }
    });
}

// =============================================================================
// 1. GET /api/business/notifications — paginated feed + unread count.
// =============================================================================
exports.getNotifications = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const { limit, cursor, unreadOnly } = req.query;
        const result = await bizNotificationService.getNotifications(prisma, profile.id, {
            limit,
            cursor,
            unreadOnly
        });

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. GET /api/business/notifications/unread-count — badge value.
// =============================================================================
exports.getUnreadCount = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const count = await bizNotificationService.getUnreadCount(prisma, profile.id);
        return res.status(200).json({ success: true, count });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. POST /api/business/notifications/read/:id — mark one read (owner only).
// =============================================================================
exports.markAsRead = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const notification = await bizNotificationService.markAsRead(prisma, req.params.id, profile.id);

        // Multi-device badge sync — best-effort, never fatal.
        try {
            if (io) {
                io.to(`user_${req.user.id}`).emit('biz_notifications_updated', {
                    type: 'MARKED_READ',
                    notificationId: req.params.id
                });
            }
        } catch (sockErr) {
            console.error('[bizNotification.markAsRead] socket emit non-fatal:', sockErr.message);
        }

        return res.status(200).json({ success: true, notification });
    } catch (err) {
        const code = err.message === 'Notification not found.' ? 404 : 400;
        return res.status(code).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. POST /api/business/notifications/read-all — bulk clear (owner only).
// =============================================================================
exports.markAllAsRead = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const result = await bizNotificationService.markAllAsRead(prisma, profile.id);

        try {
            if (io) {
                io.to(`user_${req.user.id}`).emit('biz_notifications_updated', {
                    type: 'MARKED_ALL_READ',
                    affected: result.updated
                });
            }
        } catch (sockErr) {
            console.error('[bizNotification.markAllAsRead] socket emit non-fatal:', sockErr.message);
        }

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};
