'use strict';

const router = require('express').Router();
const logger = require('../src/config/logger');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const { applyTemplateSchema, revertSchema } = require('../services/validation/storefrontSchemas');
const {
  revertToVersionSafe,
  applyTemplateSafe,
} = require('../services/storefrontDraftMutationSafeService');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, '[Storefront Draft Mutation]');
      res.status(err.statusCode || 400).json({
        success: false,
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
  };
}

router.post('/me/revert', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = revertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await revertToVersionSafe(
    prisma,
    businessProfileId,
    parsed.data.versionId,
    parsed.data.expectedUpdatedAt,
  );
  res.json({ success: true, data: draft, message: 'Reverted to selected version. Review and publish.' });
}));

router.post('/me/apply-template', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = applyTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await applyTemplateSafe(
    prisma,
    businessProfileId,
    parsed.data.templateId,
    parsed.data.expectedUpdatedAt,
  );
  res.json({ success: true, data: draft, message: 'Template applied. Review and publish.' });
}));

module.exports = router;
