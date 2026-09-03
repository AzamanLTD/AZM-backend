'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

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

router.post('/restaurant/inventory/:id/restock', requirePermission('restaurant.inventory.manage'), wrap(async (req, res) => {
    const businessProfileId = await getBusinessProfileId(req);
    const result = await new InventoryRestockService(getPrisma(req)).restock({
        businessProfileId,
        itemId: req.params.id,
        quantity: req.body.quantity,
        costPerUnit: req.body.costPerUnit,
    });
    res.json({ success: true, ...result });
}));

module.exports = router;
