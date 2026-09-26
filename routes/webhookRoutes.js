// =============================================================================
// AZAMAN — Webhook Routes (Phase 4)
//
// Business webhook endpoint management + delivery logs
// Uses existing BusinessWebhook + WebhookDelivery models
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const controller = require('../controllers/webhookController');

// Available webhook events
router.get('/events',               protect, controller.listEvents);

// Webhook CRUD
router.get('/',                     protect, controller.listEndpoints);
router.post('/',                    protect, controller.createEndpoint);
router.put('/:id',                  protect, controller.updateEndpoint);
router.delete('/:id',               protect, controller.deleteEndpoint);

// Rotate signing secret
router.post('/:id/rotate-secret',  protect, controller.rotateSecret);

// Delivery logs
router.get('/:webhookId/deliveries', protect, controller.getDeliveries);

// Send test event
router.post('/:id/test',            protect, controller.sendTestEvent);

module.exports = router;
