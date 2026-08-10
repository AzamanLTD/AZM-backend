// =============================================================================
// AZAMAN — Webhook Controller (Phase 4)
//
// Businesses register webhook endpoints to receive real-time event notifications.
// Uses existing BusinessWebhook + WebhookDelivery Prisma models.
//
// Events: order.created, order.completed, order.cancelled,
//         payment.received, payment.disputed,
//         trade.started, trade.completed, trade.disputed,
//         review.posted, kyc.verified, kyc.rejected, reservation.created/cancelled
//
// Reference: Stripe Webhooks, Shopify Webhooks
// =============================================================================

const crypto = require('crypto');
const logger = require('../src/config/logger');

// ── List endpoints ─────────────────────────────────────────────────────────

exports.listEndpoints = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'No business profile' });
        }

        const endpoints = await prisma.businessWebhook.findMany({
            where: { businessProfileId: profile.id },
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
        const { url, events } = req.body;

        if (!url || !events || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ success: false, message: 'URL and events array required' });
        }

        if (!url.startsWith('https://')) {
            return res.status(400).json({ success: false, message: 'Webhook URL must be HTTPS' });
        }

        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'No business profile' });
        }

        const secret = crypto.randomBytes(32).toString('hex');

        const endpoint = await prisma.businessWebhook.create({
            data: {
                businessProfileId: profile.id,
                url,
                events,
                secret,
            },
        });

        logger.info({ webhookId: endpoint.id, bizId: profile.bizId }, '[webhookController] Endpoint created');

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

        const endpoint = await prisma.businessWebhook.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Verify ownership
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile || endpoint.businessProfileId !== profile.id) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
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

        const updated = await prisma.businessWebhook.update({
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

        const endpoint = await prisma.businessWebhook.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Verify ownership
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile || endpoint.businessProfileId !== profile.id) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        await prisma.businessWebhook.delete({ where: { id } });

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

        const endpoint = await prisma.businessWebhook.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Verify ownership
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile || endpoint.businessProfileId !== profile.id) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        const newSecret = crypto.randomBytes(32).toString('hex');
        const updated = await prisma.businessWebhook.update({
            where: { id },
            data: { secret: newSecret },
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
        const { webhookId } = req.params;
        const { status, limit = 50 } = req.query;

        const where = { webhookId };
        if (status) where.status = String(status).toUpperCase();

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

        const endpoint = await prisma.businessWebhook.findUnique({ where: { id } });
        if (!endpoint) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Verify ownership
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile || endpoint.businessProfileId !== profile.id) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        const testEvent = 'webhook.test';
        const testPayload = {
            event: testEvent,
            timestamp: new Date().toISOString(),
            data: { message: 'This is a test event from AZAMAN', webhookId: id },
        };

        const delivery = await prisma.webhookDelivery.create({
            data: {
                webhookId: id,
                event: testEvent,
                payload: testPayload,
                status: 'PENDING',
            },
        });

        const result = await _deliverWebhook(prisma, endpoint, delivery, testPayload);

        return res.json({
            success: true,
            data: {
                deliveryId: delivery.id,
                status: result.status,
                statusCode: result.statusCode,
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
            { event: 'order.created',        description: 'A new order is placed' },
            { event: 'order.completed',      description: 'An order is marked as completed' },
            { event: 'order.cancelled',       description: 'An order is cancelled' },
            { event: 'payment.received',      description: 'A payment is received for an order' },
            { event: 'payment.disputed',      description: 'A payment dispute is opened' },
            { event: 'trade.started',         description: 'A P2P trade is initiated' },
            { event: 'trade.completed',       description: 'A P2P trade is completed' },
            { event: 'trade.disputed',        description: 'A P2P trade dispute is opened' },
            { event: 'review.posted',         description: 'A new review is posted for the business' },
            { event: 'kyc.verified',          description: 'Business KYC is verified' },
            { event: 'kyc.rejected',          description: 'Business KYC is rejected' },
            { event: 'reservation.created',   description: 'A new reservation is made' },
            { event: 'reservation.cancelled', description: 'A reservation is cancelled' },
        ],
    });
};

// ── Internal: deliver webhook via HTTP ──────────────────────────────────────

async function _deliverWebhook(prisma, webhook, delivery, payload) {
    const axios = require('axios');

    const body = JSON.stringify(payload);
    const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');

    let statusCode = null;
    let responseBody = null;
    let status = 'PENDING';

    try {
        const response = await axios.post(webhook.url, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-AZAMAN-Signature': `sha256=${signature}`,
                'X-AZAMAN-Event': payload.event || delivery.event,
                'X-AZAMAN-Delivery': delivery.id,
            },
            timeout: 10000,
            maxRedirects: 0,
        });

        statusCode = response.status;
        responseBody = typeof response.data === 'string'
            ? response.data.substring(0, 2000)
            : JSON.stringify(response.data).substring(0, 2000);

        if (response.status >= 200 && response.status < 300) {
            status = 'DELIVERED';
        } else {
            status = 'RETRYING';
        }
    } catch (err) {
        if (err.response) {
            statusCode = err.response.status;
            responseBody = err.response.data
                ? (typeof err.response.data === 'string'
                    ? err.response.data.substring(0, 2000)
                    : JSON.stringify(err.response.data).substring(0, 2000))
                : err.message;
        } else {
            responseBody = (err.message || '').substring(0, 2000);
        }
        status = 'RETRYING';
    }

    const attemptCount = delivery.attemptCount + 1;
    const maxReached = attemptCount >= delivery.maxAttempts;

    if (status === 'DELIVERED') {
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'DELIVERED', attemptCount, statusCode, responseBody, deliveredAt: new Date() },
        });
    } else if (maxReached) {
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'FAILED', attemptCount, statusCode, responseBody },
        });
    } else {
        // Exponential backoff: 30s, 2m, 10m, 30m, 2h
        const backoffSeconds = [30, 120, 600, 1800, 7200];
        const nextRetryAt = new Date(Date.now() + (backoffSeconds[attemptCount - 1] || 7200) * 1000);
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: 'RETRYING', attemptCount, statusCode, responseBody, nextRetryAt },
        });
    }

    return { status, statusCode };
}

// ── Internal: trigger webhook event (called from other controllers) ─────────

exports.triggerEvent = async (prisma, businessProfileId, event, data) => {
    try {
        const webhooks = await prisma.businessWebhook.findMany({
            where: {
                businessProfileId,
                isActive: true,
                events: { has: event },
            },
        });

        if (webhooks.length === 0) return;

        const payload = {
            event,
            timestamp: new Date().toISOString(),
            data,
        };

        for (const webhook of webhooks) {
            const delivery = await prisma.webhookDelivery.create({
                data: {
                    webhookId: webhook.id,
                    event,
                    payload,
                    status: 'PENDING',
                },
            });

            _deliverWebhook(prisma, webhook, delivery, payload).catch(err => {
                logger.error({ err: err.message, webhookId: webhook.id }, '[webhookController.triggerEvent] Delivery failed');
            });
        }

        logger.info({ businessProfileId, event, count: webhooks.length }, '[webhookController] Event triggered');
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.triggerEvent]');
    }
};

// ── Worker: process retries ─────────────────────────────────────────────────

exports.processRetries = async (prisma) => {
    try {
        const pendingRetries = await prisma.webhookDelivery.findMany({
            where: {
                status: 'RETRYING',
                nextRetryAt: { lte: new Date() },
            },
            include: { webhook: true },
            take: 50,
        });

        for (const delivery of pendingRetries) {
            if (!delivery.webhook || !delivery.webhook.isActive) {
                await prisma.webhookDelivery.update({
                    where: { id: delivery.id },
                    data: { status: 'FAILED', responseBody: 'Webhook disabled' },
                });
                continue;
            }

            await _deliverWebhook(prisma, delivery.webhook, delivery, delivery.payload);
        }

        if (pendingRetries.length > 0) {
            logger.info({ count: pendingRetries.length }, '[webhookController] Processed webhook retries');
        }
    } catch (err) {
        logger.error({ err: err.message }, '[webhookController.processRetries]');
    }
};

// ── Helper: get owned business profile ───────────────────────────────────────

async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findFirst({
        where: { userId },
        select: { id: true, bizId: true, businessName: true },
    });
}
