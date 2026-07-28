// =============================================================================
// AZAMAN — Webhook Routes (Phase 4)
//
// Business webhook endpoint management + delivery logs
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const controller = require('../controllers/webhookController');

// Available webhook events
router.get('/events',              protect, controller.listEvents);

// Endpoint CRUD
router.get('/',                    protect, controller.listEndpoints);
router.post('/',                   protect, controller.createEndpoint);
router.put('/:id',                 protect, controller.updateEndpoint);
router.delete('/:id',              protect, controller.deleteEndpoint);

// Rotate signing secret
router.post('/:id/rotate-secret',  protect, controller.rotateSecret);

// Delivery logs
router.get('/:endpointId/deliveries', protect, controller.getDeliveries);

// Send test event
router.post('/:id/test',           protect, controller.sendTestEvent);

module.exports = router;
