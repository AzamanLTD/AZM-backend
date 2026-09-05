'use strict';

const router = require('express').Router();
const logger = require('../src/config/logger');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { getOrCreateDraftSafe } = require('../services/storefrontDraftBootstrapSafeService');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, '[Storefront Draft Bootstrap]');
      res.status(err.statusCode || 400).json({ success: false, message: err.message });
    }
  };
}

router.get('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { category: true },
  });
  const draft = await getOrCreateDraftSafe(prisma, businessProfileId, business?.category);
  res.json({ success: true, data: draft });
}));

module.exports = router;
