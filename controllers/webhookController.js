// =============================================================================
// AZAMAN — Webhook Controller (Phase 4)
//
// Businesses register webhook endpoints to receive real-time event notifications.
// Supports: CRUD for endpoints, delivery log, test event trigger.
//
// Events: order.created, order.completed, order.cancelled,
//         payment.received, payment.disputed,
//         trade.started, trade.completed, trade.disputed,
//         review.posted, kyc.verified, kyc.rejected
//
// Reference: Stripe Webhooks, Shopify Webhooks
// =============================================================================

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../src/config/logger');

// ── List endpoints ─────────────────────────────────────────────────────────

exports.listEndpoints = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bizId = req.user.businessProfile?.bizId || req.query.businessId;

        if (!bizId) {
            return res.status(400).json({ success: false, message: 'Business ID required' });
        }

        const endpoints = await prisma.webhookEndpoint.findMany({
            where: { businessId: bizId },
            orderBy: { createdAt: 'desc' },
            include: {
                deliveries: {
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                },
            },
        });

        return res.json({ success: true, data: endpoints });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.listEndpoints]');
        return res.status(500).json({ success: false, message: 'Failed to list endpoints' });
    }
};

// ── Create endpoint ────────────────────────────────────────────────────────

exports.createEndpoint = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { url, events, businessId } = req.body;

        if (!url || !events || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ success: false, message: 'URL and events array required' });
        }

        if (!url.startsWith('https://')) {
            return res.status(400).json({ success: false, message: 'Webhook URL must be HTTPS' });
        }

        const bizId = businessId || req.user.businessProfile?.bizId;
        if (!bizId) {
            return res.status(400).json({ success: false, message: 'Business ID required' });
        }

        // Generate a random signing secret
        const secret = crypto.randomBytes(32).toString('hex');

        const endpoint = await prisma.webhookEndpoint.create({
            data: { businessId: bizId, url, events, secret },
        });

        logger.info({ endpointId: endpoint.id, bizId }, '[webhookController] Endpoint created');

        return res.json({ success: true, data: endpoint });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.createEndpoint]');
        return res.status(500).json({ success: false, message: 'Failed to create endpoint' });
    }
};

// ── Update endpoint ─────────────────────────────────────────────────────────

exports.updateEndpoint = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { id } = req.params;
        const { url, events, isActive } = req.body;

        const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        const data = {};
        if (url !== undefined) {
            if (!url.startsWith('https://')) {
                return res.status(400).json({ success: false, message: 'Webhook URL must be HTTPS' });
            }
            data.url = url;
        }
        if (events !== undefined) data.events = events;
        if (isActive !== undefined) data.isActive = isActive;

        const updated = await prisma.webhookEndpoint.update({
            where: { id },
            data,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.updateEndpoint]');
        return res.status(500).json({ success: false, message: 'Failed to update endpoint' });
    }
};

// ── Delete endpoint ─────────────────────────────────────────────────────────

exports.deleteEndpoint = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { id } = req.params;

        await prisma.webhookEndpoint.delete({ where: { id } });

        return res.json({ success: true, message: 'Endpoint deleted' });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.deleteEndpoint]');
        return res.status(500).json({ success: false, message: 'Failed to delete endpoint' });
    }
};

// ── Rotate secret ───────────────────────────────────────────────────────────

exports.rotateSecret = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { id } = req.params;

        const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        const newSecret = crypto.randomBytes(32).toString('hex');
        const updated = await prisma.webhookEndpoint.update({
            where: { id },
            data: { secret: newSecret, failureCount: 0 },
        });

        return res.json({ success: true, data: { secret: newSecret } });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.rotateSecret]');
        return res.status(500).json({ success: false, message: 'Failed to rotate secret' });
    }
};

// ── Get delivery logs ───────────────────────────────────────────────────────

exports.getDeliveries = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { endpointId } = req.params;
        const { status, limit = 50 } = req.query;

        const where = { endpointId };
        if (status) where.status = status;

        const deliveries = await prisma.webhookDelivery.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: Math.min(parseInt(limit), 200),
        });

        return res.json({ success: true, data: deliveries });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.getDeliveries]');
        return res.status(500).json({ success: false, message: 'Failed to get deliveries' });
    }
};

// ── Send test event ────────────────────────────────────────────────────────

exports.sendTestEvent = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { id } = req.params;

        const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        const testEvent = 'webhook.test';
        const testPayload = {
            event: testEvent,
            timestamp: new Date().toISOString(),
            data: { message: 'This is a test event from AZAMAN', endpointId: id },
        };

        // Create delivery record
        const delivery = await prisma.webhookDelivery.create({
            data: {
                endpointId: id,
                event: testEvent,
                payload: testPayload,
                status: 'pending',
            },
        });

        // Attempt delivery immediately
        const result = await _deliverWebhook(prisma, endpoint, delivery, testPayload);

        return res.json({
            success: true,
            data: {
                deliveryId: delivery.id,
                status: result.status,
                responseCode: result.responseCode,
            },
        });
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.sendTestEvent]');
        return res.status(500).json({ success: false, message: 'Failed to send test event' });
    }
};

// ── Available events ────────────────────────────────────────────────────────

exports.listEvents = async (req, res) => {
    return res.json({
        success: true,
        data: [
            { event: 'order.created',      description: 'A new order is placed' },
            { event: 'order.completed',     description: 'An order is marked as completed' },
            { event: 'order.cancelled',     description: 'An order is cancelled' },
            { event: 'payment.received',     description: 'A payment is received for an order' },
            { event: 'payment.disputed',    description: 'A payment dispute is opened' },
            { event: 'trade.started',       description: 'A P2P trade is initiated' },
            { event: 'trade.completed',     description: 'A P2P trade is completed' },
            { event: 'trade.disputed',      description: 'A P2P trade dispute is opened' },
            { event: 'review.posted',       description: 'A new review is posted for the business' },
            { event: 'kyc.verified',        description: 'Business KYC is verified' },
            { event: 'kyc.rejected',        description: 'Business KYC is rejected' },
            { event: 'reservation.created', description: 'A new reservation is made' },
            { event: 'reservation.cancelled', description: 'A reservation is cancelled' },
        ],
    });
};

// ── Internal: deliver webhook via HTTP ──────────────────────────────────────

async function _deliverWebhook(prisma, endpoint, delivery, payload) {
    const axios = require('axios');
    const crypto = require('crypto');

    const body = JSON.stringify(payload);
    const signature = crypto
        .createHmac('sha256', endpoint.secret)
        .update(body)
        .digest('hex');

    let responseCode = null;
    let responseBody = null;
    let status = 'pending';

    try {
        const response = await axios.post(endpoint.url, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-AZAMAN-Signature': `sha256=${signature}`,
                'X-AZAMAN-Event': payload.event || delivery.event,
                'X-AZAMAN-Delivery': delivery.id,
            },
            timeout: 10000, // 10s timeout
            maxRedirects: 0,
        });

        responseCode = response.status;
        responseBody = typeof response.data === 'string'
            ? response.data.substring(0, 2000)
            : JSON.stringify(response.data).substring(0, 2000);

        if (response.status >= 200 && response.status < 300) {
            status = 'delivered';
        } else {
            status = 'retry';
        }
    } catch (err) {
        if (err.response) {
            responseCode = err.response.status;
            responseBody = err.response.data
                ? (typeof err.response.data === 'string'
                    ? err.response.data.substring(0, 2000)
                    : JSON.stringify(err.response.data).substring(0, 2000))
                : err.message;
        } else {
            responseBody = (err.message || '').substring(0, 2000);
        }
        status = 'retry';
    }

    const attempts = delivery.attempts + 1;
    const maxReached = attempts >= delivery.maxAttempts;

    if (status === 'delivered') {
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'delivered', attempts, responseCode, responseBody, deliveredAt: new Date() },
        });
        // Reset failure count on success
        await prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { failureCount: 0, lastTriggered: new Date() },
        });
    } else if (maxReached) {
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'failed', attempts, responseCode, responseBody },
        });
        // Increment failure count
        await prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { failureCount: { increment: 1 }, lastTriggered: new Date() },
        });
        // Auto-disable after 10 consecutive failures
        const updated = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
        if (updated && updated.failureCount >= 10) {
            await prisma.webhookEndpoint.update({
                where: { id: endpoint.id },
                data: { isActive: false },
            });
            logger.warn({ endpointId: endpoint.id }, '[webhookController] Auto-disabled after 10 failures');
        }
    } else {
        // Schedule retry with exponential backoff: 30s, 2m, 10m, 30m, 2h
        const backoffSeconds = [30, 120, 600, 1800, 7200];
        const nextRetryAt = new Date(Date.now() + (backoffSeconds[attempts - 1] || 7200) * 1000);
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'retry', attempts, responseCode, responseBody, nextRetryAt },
        });
    }

    return { status, responseCode };
}

// ── Internal: trigger webhook event (called from other controllers) ─────────

exports.triggerEvent = async (prisma, businessId, event, data) => {
    try {
        const endpoints = await prisma.webhookEndpoint.findMany({
            where: {
                businessId,
                isActive: true,
                events: { has: event },
            },
        });

        if (endpoints.length === 0) return;

        const payload = {
            event,
            timestamp: new Date().toISOString(),
            data,
        };

        for (const endpoint of endpoints) {
            const delivery = await prisma.webhookDelivery.create({
                data: {
                    endpointId: endpoint.id,
                    event,
                    payload,
                    status: 'pending',
                },
            });

            // Fire and forget — delivery happens async
            _deliverWebhook(prisma, endpoint, delivery, payload).catch(err => {
                logger.error({ err: err.message, endpointId: endpoint.id }, '[webhookController.triggerEvent] Delivery failed');
            });
        }

        logger.info({ businessId, event, count: endpoints.length }, '[webhookController] Event triggered');
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.triggerEvent]');
    }
};

// ── Worker: process retries ─────────────────────────────────────────────────

exports.processRetries = async (prisma) => {
    try {
        const pendingRetries = await prisma.webhookDelivery.findMany({
            where: {
                status: 'retry',
                nextRetryAt: { lte: new Date() },
            },
            include: { endpoint: true },
            take: 50,
        });

        for (const delivery of pendingRetries) {
            if (!delivery.endpoint.isActive) {
                await prisma.webhookDelivery.update({
                    where: { id: delivery.id },
                    data: { status: 'failed', responseBody: 'Endpoint disabled' },
                });
                continue;
            }

            await _deliverWebhook(prisma, delivery.endpoint, delivery, delivery.payload);
        }

        if (pendingRetries.length > 0) {
            logger.info({ count: pendingRetries.length }, '[webhookController] Processed webhook retries');
        }
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.processRetries]');
    }
};
