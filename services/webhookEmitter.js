// services/webhookEmitter.js
// =============================================================================
// Thin wrapper around WebhookDispatcher that fires events fire-and-forget.
// Callers import { emitWebhookEvent } and pass businessProfileId + eventType
// + payload. Non-blocking: never throws, never blocks the request.
//
// Usage:
//   const { emitWebhookEvent } = require('./webhookEmitter');
//   await emitWebhookEvent(businessProfileId, 'order.created', { order });
//
// Supported events (add more as needed):
//   order.created, order.delivered, order.cancelled
//   reservation.created, reservation.confirmed, reservation.cancelled
//   invoice.created, invoice.paid
// =============================================================================

const logger = require('../src/config/logger');

// Lazy-load the dispatcher to avoid circular deps at module load time
let _dispatcher = null;
function getDispatcher() {
    if (!_dispatcher) {
        try {
            _dispatcher = require('./webhookDispatcher');
        } catch (e) {
            logger.warn({ err: e.message }, '[webhookEmitter] could not load dispatcher');
            return null;
        }
    }
    return _dispatcher;
}

/**
 * Fire a webhook event for a business. Non-blocking, best-effort.
 * @param {string} businessProfileId
 * @param {string} eventType  e.g. 'order.created'
 * @param {object} payload     JSON-serializable event data
 */
async function emitWebhookEvent(businessProfileId, eventType, payload) {
    if (!businessProfileId || !eventType) return;
    try {
        const dispatcher = getDispatcher();
        if (!dispatcher) return;
        // Fire-and-forget — dispatch creates delivery records and attempts
        // immediate delivery asynchronously. We do NOT await the HTTP calls.
        await dispatcher.dispatch(businessProfileId, eventType, payload);
    } catch (e) {
        // Webhook failures must NEVER break the parent request.
        logger.error({ err: e, eventType, businessProfileId }, '[webhookEmitter] dispatch failed (suppressed)');
    }
}

module.exports = { emitWebhookEvent };
