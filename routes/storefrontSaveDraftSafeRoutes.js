'use strict';

const router = require('express').Router();
const logger = require('../src/config/logger');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { saveDraftSchema } = require('../services/validation/storefrontSchemas');
const { saveDraftSafe } = require('../services/storefrontSaveDraftSafeService');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, '[Storefront Draft Save]');
      res.status(err.statusCode || 400).json({
        success: false,
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
  };
}

router.put('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = saveDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  }

  const draft = await saveDraftSafe(
    prisma,
    businessProfileId,
    parsed.data.layoutJson,
    parsed.data.themeId,
    parsed.data.expectedUpdatedAt,
  );

  res.json({ success: true, data: draft });
}));

module.exports = router;
