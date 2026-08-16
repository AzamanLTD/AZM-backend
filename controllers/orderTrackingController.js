// controllers/orderTrackingController.js
// =============================================================================
// AZAMAN — Order Tracking Controller (Phase 3)
//
// Real-time order tracking with live courier location, ETA, and status timeline.
// Socket.IO events: 'order:location', 'order:status', 'order:eta'
// =============================================================================

const logger = require('../src/config/logger');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[orderTrackingCtrl] ${fn.name}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

// GET /api/orders/:orderId/tracking — get tracking info for an order
exports.getTracking = wrap(async function getTracking(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;

    const order = await prisma.businessOrder.findUnique({
        where: { id: orderId },
        select: { customerId: true, businessProfileId: true, status: true, orderRef: true }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.customerId !== userId) {
        // Also allow the business owner
        const biz = await prisma.businessProfile.findUnique({
            where: { id: order.businessProfileId },
            select: { ownerId: true }
        });
        if (!biz || biz.ownerId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
    }

    let tracking = await prisma.orderTracking.findUnique({
        where: { orderId },
    });

    if (!tracking) {
        // Auto-create tracking record when order is PAID
        if (order.status === 'PAID' || order.status === 'DELIVERED') {
            tracking = await prisma.orderTracking.create({
                data: { orderId, businessProfileId: order.businessProfileId }
            });
        } else {
            return res.json({ success: true, tracking: null, message: 'Tracking not available yet' });
        }
    }

    res.json({ success: true, tracking });
});

// PUT /api/orders/:orderId/tracking/location — update courier location (business/driver only)
exports.updateLocation = wrap(async function updateLocation(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;
    const { latitude, longitude, heading, speedKmh } = req.body;

    if (latitude == null || longitude == null) {
        return res.status(400).json({ success: false, message: 'latitude and longitude required' });
    }

    const order = await prisma.businessOrder.findUnique({
        where: { id: orderId },
        select: { customerId: true, businessProfileId: true, status: true }
    });

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Verify business owner
    const biz = await prisma.businessProfile.findUnique({
        where: { id: order.businessProfileId },
        select: { ownerId: true }
    });
    if (!biz || biz.ownerId !== userId) {
        return res.status(403).json({ success: false, message: 'Only the business can update location' });
    }

    let tracking = await prisma.orderTracking.findUnique({ where: { orderId } });
    if (!tracking) {
        tracking = await prisma.orderTracking.create({
            data: { orderId, businessProfileId: order.businessProfileId }
        });
    }

    tracking = await prisma.orderTracking.update({
        where: { orderId },
        data: {
            courierLatitude: latitude,
            courierLongitude: longitude,
            courierHeading: heading || null,
            courierSpeedKmh: speedKmh || null,
            lastPingAt: new Date(),
        },
    });

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
        io.to(`order:${orderId}`).emit('order:location', {
            orderId,
            latitude,
            longitude,
            heading: heading || null,
            speedKmh: speedKmh || null,
            timestamp: new Date().toISOString(),
        });
    }

    res.json({ success: true, tracking });
});

// PUT /api/orders/:orderId/tracking/eta — update ETA
exports.updateEta = wrap(async function updateEta(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;
    const { estimatedArrival } = req.body;

    const order = await prisma.businessOrder.findUnique({
        where: { id: orderId },
        select: { businessProfileId: true }
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const biz = await prisma.businessProfile.findUnique({
        where: { id: order.businessProfileId },
        select: { ownerId: true }
    });
    if (!biz || biz.ownerId !== userId) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const tracking = await prisma.orderTracking.update({
        where: { orderId },
        data: { estimatedArrival: new Date(estimatedArrival) },
    });

    const io = req.app.get('io');
    if (io) {
        io.to(`order:${orderId}`).emit('order:eta', {
            orderId, estimatedArrival,
        });
    }

    res.json({ success: true, tracking });
});

// POST /api/orders/:orderId/tracking/status — update tracking status (add to timeline)
exports.updateStatus = wrap(async function updateStatus(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;
    const { status, note, driverName, driverPhone, vehiclePlate, deliveryAddress, deliveryLat, deliveryLng } = req.body;

    const order = await prisma.businessOrder.findUnique({
        where: { id: orderId },
        select: { businessProfileId: true, customerId: true, status: true, orderRef: true }
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Verify business owner
    const biz = await prisma.businessProfile.findUnique({
        where: { id: order.businessProfileId },
        select: { ownerId: true }
    });
    if (!biz || biz.ownerId !== userId) {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    let tracking = await prisma.orderTracking.findUnique({ where: { orderId } });
    if (!tracking) {
        tracking = await prisma.orderTracking.create({
            data: { orderId, businessProfileId: order.businessProfileId }
        });
    }

    // Append to timeline
    const timeline = tracking.timeline || [];
    timeline.push({ status, note: note || '', timestamp: new Date().toISOString() });

    const updateData = { timeline };
    if (driverName) updateData.driverName = driverName;
    if (driverPhone) updateData.driverPhone = driverPhone;
    if (vehiclePlate) updateData.vehiclePlate = vehiclePlate;
    if (deliveryAddress) updateData.deliveryAddress = deliveryAddress;
    if (deliveryLat) updateData.deliveryLatitude = deliveryLat;
    if (deliveryLng) updateData.deliveryLongitude = deliveryLng;
    if (status === 'DELIVERED') updateData.actualArrival = new Date();

    tracking = await prisma.orderTracking.update({
        where: { orderId },
        data: updateData,
    });

    // Send notification to customer
    const notificationService = req.app.get('notificationService');
    if (notificationService) {
        await notificationService.sendToUser(order.customerId, {
            type: 'ORDER_TRACKING',
            title: `Order ${order.orderRef} — ${status}`,
            body: note || `Your order status has been updated to: ${status}`,
            data: { orderId, status },
        }).catch(() => {});
    }

    const io = req.app.get('io');
    if (io) {
        io.to(`order:${orderId}`).emit('order:status', {
            orderId, status, note: note || '', timestamp: new Date().toISOString(),
            tracking,
        });
    }

    res.json({ success: true, tracking });
});

// GET /api/orders/:orderId/tracking/timeline — get status timeline only
exports.getTimeline = wrap(async function getTimeline(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;

    const tracking = await prisma.orderTracking.findUnique({
        where: { orderId },
        select: { timeline: true }
    });

    if (!tracking) return res.json({ success: true, timeline: [] });
    res.json({ success: true, timeline: tracking.timeline || [] });
});
