// services/webhookDispatcher/index.js
// =============================================================================
// Webhook Dispatcher — reliable event delivery with retry + backoff
// =============================================================================
const axios = require('axios');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

// Exponential backoff: 10s, 30s, 2min, 10min, 30min
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800];

class WebhookDispatcher {
    /**
     * Dispatch a webhook event to all active matching webhooks for a business.
     * Creates a WebhookDelivery record for each, then attempts delivery.
     * @param {string} businessProfileId
     * @param {string} eventType e.g., 'order.created'
     * @param {Object} payload The event payload
     */
    async dispatch(businessProfileId, eventType, payload) {
        try {
            const webhooks = await prisma.businessWebhook.findMany({
                where: { businessProfileId, isActive: true }
            });

            const matching = webhooks.filter(w =>
                w.events.includes(eventType) || w.events.includes('*')
            );
            if (!matching.length) return;

            for (const webhook of matching) {
                // Create a delivery record
                const delivery = await prisma.webhookDelivery.create({
                    data: {
                        webhookId: webhook.id,
                        event: eventType,
                        payload: {
                            event: eventType,
                            timestamp: new Date().toISOString(),
                            data: payload,
                        },
                        status: 'PENDING',
                        nextRetryAt: new Date(),
                    },
                });

                // Attempt immediate delivery (async, non-blocking)
                this._attemptDelivery(delivery.id, webhook).catch(err => {
                    console.error(`[WebhookDispatcher] Initial delivery error for ${delivery.id}:`, err.message);
                });
            }
        } catch (error) {
            console.error('[WebhookDispatcher] Error dispatching webhooks:', error);
        }
    }

    /**
     * Attempt a single delivery. On failure, schedules a retry with backoff.
     */
    async _attemptDelivery(deliveryId, webhook) {
        const delivery = await prisma.webhookDelivery.findUnique({
            where: { id: deliveryId },
        });
        if (!delivery || delivery.status === 'DELIVERED') return;
        if (delivery.attemptCount >= delivery.maxAttempts) {
            await prisma.webhookDelivery.update({
                where: { id: deliveryId },
                data: { status: 'FAILED', nextRetryAt: null },
            });
            console.warn(`[WebhookDispatcher] Delivery ${deliveryId} permanently failed after ${delivery.maxAttempts} attempts.`);
            return;
        }

        const payloadStr = JSON.stringify(delivery.payload);
        const signature = crypto.createHmac('sha256', webhook.secret).update(payloadStr).digest('hex');

        try {
            const response = await axios.post(webhook.url, payloadStr, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-AZM-Signature': signature,
                    'X-AZM-Event': delivery.event,
                    'X-AZM-Delivery': deliveryId,
                },
                timeout: 10000,
            });

            // Success — mark delivered
            await prisma.webhookDelivery.update({
                where: { id: deliveryId },
                data: {
                    status: 'DELIVERED',
                    statusCode: response.status,
                    responseBody: response.data ? JSON.stringify(response.data).substring(0, 2000) : null,
                    deliveredAt: new Date(),
                    nextRetryAt: null,
                },
            });
        } catch (err) {
            const attemptNum = delivery.attemptCount + 1;
            const backoffSec = BACKOFF_SECONDS[Math.min(attemptNum - 1, BACKOFF_SECONDS.length - 1)];
            const nextRetry = new Date(Date.now() + backoffSec * 1000);

            await prisma.webhookDelivery.update({
                where: { id: deliveryId },
                data: {
                    status: attemptNum >= delivery.maxAttempts ? 'FAILED' : 'RETRYING',
                    attemptCount: attemptNum,
                    statusCode: err.response?.status || null,
                    responseBody: err.message.substring(0, 2000),
                    nextRetryAt: attemptNum < delivery.maxAttempts ? nextRetry : null,
                },
            });

            if (attemptNum < delivery.maxAttempts) {
                console.warn(`[WebhookDispatcher] Delivery ${deliveryId} attempt ${attemptNum} failed, retrying in ${backoffSec}s.`);
                setTimeout(() => {
                    this._attemptDelivery(deliveryId, webhook).catch(e =>
                        console.error(`[WebhookDispatcher] Retry error for ${deliveryId}:`, e.message)
                    );
                }, backoffSec * 1000);
            } else {
                console.error(`[WebhookDispatcher] Delivery ${deliveryId} permanently failed after ${attemptNum} attempts.`);
            }
        }
    }

    /**
     * Process stuck RETRYING deliveries (called by a periodic job).
     * Picks up deliveries whose nextRetryAt has passed and retries them.
     */
    async processRetryQueue() {
        const now = new Date();
        const stuck = await prisma.webhookDelivery.findMany({
            where: {
                status: 'RETRYING',
                nextRetryAt: { lte: now },
            },
            take: 50,
        });

        for (const delivery of stuck) {
            const webhook = await prisma.businessWebhook.findUnique({
                where: { id: delivery.webhookId },
            });
            if (!webhook || !webhook.isActive) {
                await prisma.webhookDelivery.update({
                    where: { id: delivery.id },
                    data: { status: 'FAILED', nextRetryAt: null },
                });
                continue;
            }

            this._attemptDelivery(delivery.id, webhook).catch(err =>
                console.error(`[WebhookDispatcher] Queue retry error for ${delivery.id}:`, err.message)
            );
        }

        return stuck.length;
    }
}

module.exports = new WebhookDispatcher();
