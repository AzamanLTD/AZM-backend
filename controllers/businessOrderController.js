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

const logger = require('../src/config/logger');
const businessOrderService = require('../services/businessOrderService');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Load the BusinessProfile owned by the calling user (null if none). */
async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findFirst({
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

        // Did the hand-over settle it (the buyer had already confirmed)?
        let settledNow = false;
        if (order.escrowId) {
            try {
                const e = await prisma.smartEscrow.findUnique({ where: { id: order.escrowId }, select: { status: true } });
                settledNow = !!e && e.status === 'SETTLED';
            } catch (_) { /* the notice falls back to the window wording */ }
        }
        const notificationService = req.app.get('notificationService');
        if (notificationService) {
            setImmediate(() => {
                // An escrow-paid order: the buyer has the release window to
                // confirm or report a problem (businessOrderService).
                const hours = Math.round(businessOrderService.ORDER_RELEASE_AFTER_DELIVERY_MS / 3600000);
                notificationService.sendNotification({
                    userId:   order.customerId,
                    title:    'Order handed over',
                    body:     !order.escrowId
                        ? `${profile.businessName} has marked your order "${order.title}" as delivered.`
                        : (settledNow
                            ? `${profile.businessName} handed over "${order.title}". You had already confirmed, so the store has been paid.`
                            : `${profile.businessName} says "${order.title}" was handed over. Tap Got it, or report a problem within ${Math.round(hours / 24)} days. After that the store is paid.`),
                    category: 'GENERAL',
                    actionPayload: {
                        route:   '/my-orders',
                        orderId: order.id
                    }
                }).catch((e) => logger.error({ err: e }, '[markDelivered] notification'));
            });
        }

        return res.status(200).json({ success: true, order });
    } catch (err) {
        const status = err && err.code === 'STORE_SUSPENDED' ? 403
            : (err && err.code === 'ORDER_NOT_PAID' ? 409 : 400);
        return res.status(status).json({ success: false, code: err && err.code, message: err.message });
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
