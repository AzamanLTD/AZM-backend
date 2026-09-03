'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { PosOrderService } = require('../services/businessOS/posOrderService');

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
        catch (err) { res.status(err.statusCode || 400).json({ success: false, message: err.message }); }
    };
}

router.use(protect, protectActive);

router.post('/pos/order', requirePermission('orders.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const result = await new PosOrderService(getPrisma(req)).createOrder({
        businessProfileId,
        actorId: req.user.id,
        items: req.body.items,
        paymentMethod: req.body.paymentMethod,
        cashGiven: req.body.cashGiven,
        azmAmount: req.body.azmAmount,
        idempotencyKey: req.body.idempotencyKey,
        source: req.body.source,
        locationId: req.body.locationId,
        tableId: req.body.tableId,
        customerId: req.body.customerId,
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, ...result });
}));

module.exports = router;
