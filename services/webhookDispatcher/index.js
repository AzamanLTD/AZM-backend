const axios = require('axios');
const crypto = require('crypto');
const prisma = require('../../prisma/client');

class WebhookDispatcher {
    /**
     * Dispatches a webhook event to all active matching webhooks for a business.
     * @param {string} businessProfileId 
     * @param {string} eventType e.g., 'order.created'
     * @param {Object} payload The event payload
     */
    async dispatch(businessProfileId, eventType, payload) {
        try {
            const webhooks = await prisma.businessWebhook.findMany({
                where: { businessProfileId, isActive: true }
            });

            const matching = webhooks.filter(w => w.events.includes(eventType) || w.events.includes('*'));
            if (!matching.length) return;

            const payloadStr = JSON.stringify({
                event: eventType,
                timestamp: new Date().toISOString(),
                data: payload
            });

            for (const webhook of matching) {
                const signature = crypto.createHmac('sha256', webhook.secret).update(payloadStr).digest('hex');
                
                // Fire and forget (background delivery). A real system would use BullMQ.
                axios.post(webhook.url, payloadStr, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-AZM-Signature': signature,
                        'X-AZM-Event': eventType
                    },
                    timeout: 5000
                }).catch(err => {
                    console.error(`[WebhookDispatcher] Failed to send ${eventType} to ${webhook.url}:`, err.message);
                });
            }
        } catch (error) {
            console.error('[WebhookDispatcher] Error dispatching webhooks:', error);
        }
    }
}

module.exports = new WebhookDispatcher();
