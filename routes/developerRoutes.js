const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { wrap } = require('../utils/catchAsync');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

const getPrisma = (req) => req.app.get('prisma') || require('../prisma/client');

// GET /api/developer/api-keys
router.get('/api-keys', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const keys = await prisma.businessApiKey.findMany({
        where: { businessProfileId: req.query.businessId },
        orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, apiKeys: keys });
}));

// POST /api/developer/api-keys
router.post('/api-keys', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { name, permissions, businessId } = req.body;
    
    if (!name || !businessId) {
        return res.status(400).json({ success: false, message: 'Name and businessId are required' });
    }

    // Generate a secure key
    const rawKey = crypto.randomBytes(32).toString('hex');
    const fullKey = `az_prod_${rawKey}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const prefix = fullKey.substring(0, 16) + '...';

    const apiKey = await prisma.businessApiKey.create({
        data: {
            businessProfileId: businessId,
            name,
            keyHash,
            prefix,
            permissions: permissions || []
        }
    });

    res.json({ success: true, apiKey, secretKey: fullKey }); // Return secret key ONLY once
}));

// DELETE /api/developer/api-keys/:id
router.delete('/api-keys/:id', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    await prisma.businessApiKey.delete({ where: { id: req.params.id } });
    res.json({ success: true });
}));

// GET /api/developer/webhooks
router.get('/webhooks', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const webhooks = await prisma.businessWebhook.findMany({
        where: { businessProfileId: req.query.businessId },
        orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, webhooks });
}));

// POST /api/developer/webhooks
router.post('/webhooks', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { url, events, secret, businessId } = req.body;
    
    if (!url || !businessId) {
        return res.status(400).json({ success: false, message: 'URL and businessId are required' });
    }

    const webhook = await prisma.businessWebhook.create({
        data: {
            businessProfileId: businessId,
            url,
            events: events || [],
            secret: secret || crypto.randomBytes(16).toString('hex')
        }
    });
    res.json({ success: true, webhook });
}));

// DELETE /api/developer/webhooks/:id
router.delete('/webhooks/:id', protect, protectActive, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    await prisma.businessWebhook.delete({ where: { id: req.params.id } });
    res.json({ success: true });
}));

module.exports = router;
