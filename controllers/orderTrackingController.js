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

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const assertOrderParticipant = async (prisma, orderId, userId) => {
    const order = await prisma.businessOrder.findUnique({
        where: { id: orderId },
        select: { customerId: true, businessProfileId: true, status: true, orderRef: true }
    });

    if (!order) return { order: null, authorized: false };
    if (order.customerId === userId) return { order, authorized: true };

    const biz = await prisma.businessProfile.findUnique({
        where: { id: order.businessProfileId },
        select: { ownerId: true }
    });

    return { order, authorized: Boolean(biz && biz.ownerId === userId) };
};

exports.getTracking = wrap(async function getTracking(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;

    const { order, authorized } = await assertOrderParticipant(prisma, orderId, userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!authorized) return res.status(403).json({ success: false, message: 'Not authorized' });

    let tracking = await prisma.orderTracking.findUnique({ where: { orderId } });

    if (!tracking) {
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

exports.updateLocation = wrap(async function updateLocation(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;
    const { latitude, longitude, heading, speedKmh } = req.body;

    if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.status(400).json({ success: false, message: 'valid latitude and longitude required' });
    }
    if (heading != null && (!isFiniteNumber(heading) || heading < 0 || heading >= 360)) {
        return res.status(400).json({ success: false, message: 'invalid heading' });
    }
    if (speedKmh != null && (!isFiniteNumber(speedKmh) || speedKmh < 0)) {
        return res.status(400).json({ success: false, message: 'invalid speedKmh' });
    }

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
            courierHeading: heading ?? null,
            courierSpeedKmh: speedKmh ?? null,
            lastPingAt: new Date(),
        },
    });

    const io = req.app.get('io');
    if (io) {
        io.to(`order:${orderId}`).emit('order:location', {
            orderId, latitude, longitude,
            heading: heading ?? null,
            speedKmh: speedKmh ?? null,
            timestamp: new Date().toISOString(),
        });
    }

    res.json({ success: true, tracking });
});

exports.updateEta = wrap(async function updateEta(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;
    const { estimatedArrival } = req.body;

    if (!estimatedArrival || Number.isNaN(new Date(estimatedArrival).getTime())) {
        return res.status(400).json({ success: false, message: 'valid estimatedArrival required' });
    }

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
    if (io) io.to(`order:${orderId}`).emit('order:eta', { orderId, estimatedArrival });

    res.json({ success: true, tracking });
});

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

    const timeline = tracking.timeline || [];
    timeline.push({ status, note: note || '', timestamp: new Date().toISOString() });

    const updateData = { timeline };
    if (driverName) updateData.driverName = driverName;
    if (driverPhone) updateData.driverPhone = driverPhone;
    if (vehiclePlate) updateData.vehiclePlate = vehiclePlate;
    if (deliveryAddress) updateData.deliveryAddress = deliveryAddress;
    if (deliveryLat != null) updateData.deliveryLatitude = deliveryLat;
    if (deliveryLng != null) updateData.deliveryLongitude = deliveryLng;
    if (status === 'DELIVERED') updateData.actualArrival = new Date();

    tracking = await prisma.orderTracking.update({ where: { orderId }, data: updateData });

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
            orderId, status, note: note || '', timestamp: new Date().toISOString(), tracking,
        });
    }

    res.json({ success: true, tracking });
});

exports.getTimeline = wrap(async function getTimeline(req, res) {
    const prisma = req.app.get('prisma');
    const { orderId } = req.params;
    const userId = req.user.id;

    const { order, authorized } = await assertOrderParticipant(prisma, orderId, userId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!authorized) return res.status(403).json({ success: false, message: 'Not authorized' });

    const tracking = await prisma.orderTracking.findUnique({
        where: { orderId },
        select: { timeline: true }
    });

    if (!tracking) return res.json({ success: true, timeline: [] });
    res.json({ success: true, timeline: tracking.timeline || [] });
});
