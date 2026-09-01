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

function hasOwnExperience(layoutJson) {
  return Boolean(
    layoutJson &&
    typeof layoutJson === 'object' &&
    Object.prototype.hasOwnProperty.call(layoutJson, 'experience') &&
    layoutJson.experience,
  );
}

function legacyExperienceFromBusiness(business) {
  return experienceBlueprintService.getExperienceBlueprint(business);
}

// Authenticated business editor reads from the storefront draft. This keeps
// experience settings inside the same draft/publish lifecycle as the rest of
// the storefront rather than maintaining a second editable copy in businessMeta.
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

    const draft = await storefrontService.getOrCreateDraft(prisma, businessProfileId, business.category);
    const draftLayout = draft.layoutJson && typeof draft.layoutJson === 'object' ? draft.layoutJson : {};

    let blueprint = hasOwnExperience(draftLayout)
      ? experienceBlueprintService.normalizeExperienceBlueprint(draftLayout.experience, business.category)
      : legacyExperienceFromBusiness(business);

    // One-time migration for older businesses whose experience was stored only
    // in businessMeta. After this, the draft snapshot is the editor authority.
    if (!hasOwnExperience(draftLayout)) {
      blueprint = legacyExperienceFromBusiness(business);
      await prisma.businessStorefrontLayout.update({
        where: { id: draft.id },
        data: { layoutJson: { ...draftLayout, experience: blueprint } },
      });
    }

    res.json({
      success: true,
      data: {
        category: business.category,
        blueprint,
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

    const business = await prisma.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { id: true, category: true },
    });
    if (!business) return res.status(404).json({ success: false, message: 'Business profile not found.' });

    const draft = await storefrontService.getOrCreateDraft(prisma, businessProfileId, business.category);
    const draftLayout = draft.layoutJson && typeof draft.layoutJson === 'object' ? draft.layoutJson : {};
    const blueprint = experienceBlueprintService.normalizeExperienceBlueprint(req.body, business.category);

    await prisma.businessStorefrontLayout.update({
      where: { id: draft.id },
      data: {
        layoutJson: {
          ...draftLayout,
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
