// routes/ticketRoutes.js
// =============================================================================
// AZAMAN — TICKETS ROUTES (Phase UI-4, 2026-05-26)
// Mounted at /api/tickets. All endpoints authenticated.
// =============================================================================

const express = require('express');
const router  = express.Router();

const ticketController = require('../controllers/ticketController');
const { protect }      = require('../middleware/authMiddleware');

router.post('/',                  protect, ticketController.createTicket);
router.get('/',                   protect, ticketController.listTickets);
router.get('/:id',                protect, ticketController.getTicket);
router.post('/:id/messages',      protect, ticketController.sendTicketMessage);
router.patch('/:id/status',       protect, ticketController.changeTicketStatus);
router.post('/:id/presence',      protect, ticketController.pingPresence);

module.exports = router;
