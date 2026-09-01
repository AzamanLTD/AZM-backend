'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const experienceBlueprintService = require('../services/experienceBlueprintService');
const storefrontService = require('../services/storefrontService');
const { renderStorefront, invalidateCache } = require('../services/storefrontRenderService');

const router = express.Router();

function businessProfileIdFromRequest(req) {
  return req.businessProfileId || req.user?.businessProfileId;
}

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
        commitStyles: Object.values(experienceBlueprintService.COMMIT_STYLES),
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

    // Keep editable experience settings in the same draft/publish lifecycle
    // as the rest of the storefront. Public render reads only the published
    // layout snapshot, so editor saves cannot leak into customer traffic.
    const draft = await storefrontService.getOrCreateDraft(prisma, businessProfileId);
    await prisma.businessStorefrontLayout.update({
      where: { id: draft.id },
      data: {
        layoutJson: {
          ...(draft.layoutJson || {}),
          experience: blueprint,
        },
      },
    });

    await invalidateCache(businessProfileId);

    res.json({
      success: true,
      data: blueprint,
      message: 'Experience settings saved to the storefront draft. Publish the storefront to make them live.',
    });
  } catch (err) {
    next(err);
  }
});

// Public contract is derived from the published storefront. This prevents a
// business's unsaved/private experience metadata from leaking into customer
// discovery and keeps the experience contract in lockstep with storefront publication.
router.get('/:businessProfileId/experience', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma');
    const rendered = await renderStorefront(prisma, req.params.businessProfileId);
    if (!rendered) {
      return res.status(404).json({ success: false, message: 'Experience not available.' });
    }

    res.json({ success: true, data: rendered.experience });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
