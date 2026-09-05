'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const {
    listTaxPresets,
    createTaxPreset,
    updateTaxPreset,
    deleteTaxPreset,
} = require('../services/businessTaxPresetService');

async function getBusinessProfileId(req) {
    if (!req.user?.id) return null;
    if (req.businessProfileId) return req.businessProfileId;
    if (req.user.businessProfileId) return req.user.businessProfileId;

    const profile = await req.app.get('prisma').businessProfile.findFirst({
        where: { userId: req.user.id },
        select: { id: true },
    });
    return profile?.id || null;
}

function wrap(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (err) {
            const status = err.code === 'TAX_PRESET_NOT_FOUND' || err.code === 'BUSINESS_NOT_FOUND' ? 404
                : err.code === 'INVALID_TAX_PRESET' ? 400
                    : 500;
            return res.status(status).json({
                success: false,
                message: err.message,
                ...(err.code ? { code: err.code } : {}),
            });
        }
    };
}

router.use(protect, protectActive);

router.get('/tax-presets', wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const presets = await listTaxPresets(req.app.get('prisma'), bpId);
    res.json({ success: true, presets });
}));

router.post('/tax-presets', requirePermission('settings.manage'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const preset = await createTaxPreset(req.app.get('prisma'), bpId, req.body || {});
    res.status(201).json({ success: true, preset });
}));

router.patch('/tax-presets/:id', requirePermission('settings.manage'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    const preset = await updateTaxPreset(req.app.get('prisma'), bpId, req.params.id, req.body || {});
    res.json({ success: true, preset });
}));

router.delete('/tax-presets/:id', requirePermission('settings.manage'), wrap(async (req, res) => {
    const bpId = await getBusinessProfileId(req);
    await deleteTaxPreset(req.app.get('prisma'), bpId, req.params.id);
    res.json({ success: true, message: 'Tax preset deleted.' });
}));

module.exports = router;
