// controllers/businessOrderController.js
// =============================================================================
// AZAMAN — BUSINESS ORDER CONTROLLER (2026-06-16)
//
// HTTP layer for the Business Portal order management. Mirrors the conventions
// in businessController.js / escrowController.js:
//   prisma = req.app.get('prisma'); io = req.app.get('socketio');
//   userId = req.user.id;
//   success → { success: true, ... }; error → { success: false, message }.
//
// This controller NEVER moves USDC. Order state transitions that require fund
// movement (PAID/COMPLETED/REFUNDED) are driven by escrowService hooks, not here.
// =============================================================================

const businessOrderService = require('../services/businessOrderService');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Load the BusinessProfile owned by the calling user (null if none). */
async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findUnique({
        where: { userId },
        select: { id: true, businessName: true, kybStatus: true }
    });
}

// =============================================================================
// 1. GET /api/business/orders/stats — dashboard aggregates (owner only).
//    MUST be declared before /:orderId in the route file.
// =============================================================================
exports.getBusinessStats = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const stats = await businessOrderService.getBusinessStats(prisma, {
            businessProfileId: profile.id
        });

        return res.status(200).json({ success: true, stats });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. GET /api/business/orders — list orders for the caller's business.
// =============================================================================
exports.listBusinessOrders = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const { status, customerId, productId, dateFrom, dateTo, limit, cursor } = req.query;

        const result = await businessOrderService.listOrdersForBusiness(prisma, {
            businessProfileId: profile.id,
            status,
            customerId,
            productId,
            dateFrom,
            dateTo,
            limit,
            cursor
        });

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. GET /api/business/orders/:orderId — order detail (owner OR customer).
// =============================================================================
exports.getOrder = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { orderId } = req.params;

        const order = await businessOrderService.getOrder(prisma, { orderId });
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        const profile = await _ownedProfile(prisma, userId);
        const isOwner = profile && profile.id === order.businessProfileId;
        const isCustomer = userId === order.customerId;
        if (!isOwner && !isCustomer) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this order.' });
        }

        return res.status(200).json({ success: true, order });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. PATCH /api/business/orders/:orderId/delivered — mark delivered (owner only).
// =============================================================================
exports.markDelivered = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { orderId } = req.params;
        const { deliveryNotes } = req.body;

        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const order = await businessOrderService.markDelivered(prisma, {
            orderId,
            businessProfileId: profile.id,
            deliveryNotes
        });

        if (io) {
            io.to(`user_${order.customerId}`).emit('business_order_delivered', { order });
        }

        const notificationService = req.app.get('notificationService');
        if (notificationService) {
            setImmediate(() => {
                notificationService.sendNotification({
                    userId:   order.customerId,
                    title:    'Order Delivered',
                    body:     `${profile.businessName} has marked your order "${order.title}" as delivered. Confirm to release payment.`,
                    category: 'GENERAL',
                    actionPayload: {
                        route:   order.ticketId ? `/tickets/${order.ticketId}` : '/business/my-orders',
                        action:  'VIEW_TICKET',
                        orderId: order.id
                    }
                }).catch((e) => console.error('[markDelivered] notification:', e.message));
            });
        }

        return res.status(200).json({ success: true, order });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. GET /api/business/my-orders — caller's own purchase history (any user).
// =============================================================================
exports.listMyOrders = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { status, limit, cursor } = req.query;

        const result = await businessOrderService.listOrdersForCustomer(prisma, {
            customerId: userId,
            status,
            limit,
            cursor
        });

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};
