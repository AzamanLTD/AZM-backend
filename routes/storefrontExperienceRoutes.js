'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const experienceBlueprintService = require('../services/experienceBlueprintService');

const router = express.Router();

function businessProfileIdFromRequest(req) {
  return req.businessProfileId || req.user?.businessProfileId;
}

// Public: the experience contract is safe to expose with the published
// storefront. It contains only presentation/interaction policy, never private
// operational data.
router.get('/:businessProfileId/experience', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const business = await prisma.businessProfile.findUnique({
      where: { id: req.params.businessProfileId },
      select: {
        id: true,
        category: true,
        businessMeta: true,
        isSuspended: true,
        storefrontDisabled: true,
      },
    });

    if (!business || business.isSuspended || business.storefrontDisabled) {
      return res.status(404).json({ success: false, message: 'Experience not available.' });
    }

    res.json({
      success: true,
      data: experienceBlueprintService.getExperienceBlueprint(business),
    });
  } catch (err) {
    next(err);
  }
});

// Authenticated business editor: retrieve the effective blueprint plus safe
// category defaults so the portal can present a useful editor immediately.
router.get('/me/experience', protect, protectActive, requirePermission('storefront.manage'), async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const businessProfileId = businessProfileIdFromRequest(req);
    if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

    const business = await prisma.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { id: true, category: true, businessMeta: true },
    });
    if (!business) return res.status(404).json({ success: false, message: 'Business profile not found.' });

    res.json({
      success: true,
      data: {
        category: business.category,
        blueprint: experienceBlueprintService.getExperienceBlueprint(business),
        defaults: experienceBlueprintService.defaultsForCategory(business.category),
        presets: experienceBlueprintService.PRESETS,
        motionTempos: experienceBlueprintService.MOTION_TEMPOS,
        commitStyles: experienceBlueprintService.COMMIT_STYLES,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/me/experience', protect, protectActive, requirePermission('storefront.manage'), async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const businessProfileId = businessProfileIdFromRequest(req);
    if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'Invalid experience blueprint.' });
    }

    const blueprint = await experienceBlueprintService.saveExperienceBlueprint(
      prisma,
      businessProfileId,
      req.body,
    );

    const { invalidateCache } = require('../services/storefrontRenderService');
    await invalidateCache(businessProfileId);

    res.json({ success: true, data: blueprint, message: 'Experience settings saved.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
