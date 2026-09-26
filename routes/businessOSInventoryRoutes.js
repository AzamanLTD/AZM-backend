'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');
const { InventoryRestockIntentService } = require('../services/businessOS/inventoryRestockIntentService');

function getPrisma(req) { return req.app.get('prisma'); }

async function getBusinessProfileId(req) {
    if (!req.user?.id) throw new Error('Authentication required.');
    if (req.businessProfileId) return req.businessProfileId;
    const profile = await getPrisma(req).businessProfile.findFirst({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) throw new Error('Business profile not found.');
    return profile.id;
}

function wrap(handler) {
    return async (req, res) => {
        try { await handler(req, res); }
        catch (err) { res.status(err.statusCode || 400).json({ success: false, code: err.code, message: err.message }); }
    };
}

router.use(protect, protectActive);

router.post('/restaurant/inventory/:id/restock', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const result = await new InventoryRestockService(getPrisma(req)).restock({
        businessProfileId,
        itemId: req.params.id,
        quantity: req.body.quantity,
        costPerUnit: req.body.costPerUnit,
        idempotencyKey: req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'] ?? req.body.clientRequestId ?? req.body.idempotencyKey,
    });
    res.json({ success: true, ...result });
}));

// ── §r40.4 — SERVER-OWNED RESTOCK INTENTS (final-audit P1 redesign) ──────────
// The intent id IS the idempotency key of the restock it registers. The
// identity is durable on the server, so browser storage loss, tab close,
// reloads and cross-tab confusion can never orphan a retry identity: the
// client recovers the exact prior operation (and its stored execution
// result) from the unresolved list. See
// services/businessOS/inventoryRestockIntentService.js for the guarded
// state machine and the audit rationale.

// Register a NEW restock operation (operation-level identity — two calls
// for the same item/quantity are two DISTINCT intents by design).
router.post('/restaurant/inventory/restock-intents', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const intent = await new InventoryRestockIntentService(getPrisma(req)).createIntent({
        businessProfileId,
        userId: req.user.id,
        itemId: req.body.itemId,
        quantity: req.body.quantity,
    });
    res.json({ success: true, intent });
}));

// The recovery list: every operation whose outcome the client has not
// observed (PENDING = never executed/unknown; EXECUTED = committed but
// unacknowledged, with the stored result to re-display).
router.get('/restaurant/inventory/restock-intents', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const intents = await new InventoryRestockIntentService(getPrisma(req)).listUnresolved({ businessProfileId });
    res.json({ success: true, intents });
}));

// Client observed the outcome (only valid for EXECUTED intents).
router.post('/restaurant/inventory/restock-intents/:id/ack', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const intent = await new InventoryRestockIntentService(getPrisma(req)).acknowledge({ businessProfileId, id: req.params.id });
    res.json({ success: true, intent });
}));

// Explicit operator cancel (only valid while PENDING — an executed restock
// can only be acknowledged; the server refuses and tells the truth).
router.post('/restaurant/inventory/restock-intents/:id/cancel', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const intent = await new InventoryRestockIntentService(getPrisma(req)).cancel({ businessProfileId, id: req.params.id });
    res.json({ success: true, intent });
}));

module.exports = router;
