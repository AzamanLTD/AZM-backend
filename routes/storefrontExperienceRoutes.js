'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const experienceBlueprintService = require('../services/experienceBlueprintService');
const storefrontService = require('../services/storefrontService');
const { updateExperienceSafe } = require('../services/storefrontDraftMutationSafeService');
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

    if (!hasOwnExperience(draftLayout)) {
      blueprint = legacyExperienceFromBusiness(business);
      await updateExperienceSafe(prisma, businessProfileId, blueprint);
    }

    res.json({
      success: true,
      data: {
        category: business.category,
        blueprint,
        defaults: experienceBlueprintService.defaultsForCategory(business.category),
        presets: experienceBlueprintService.PRESETS,
        categoryOptions: experienceBlueprintService.categoryOptions(business.category),
        navigationModes: experienceBlueprintService.NAVIGATION_MODES,
        detailPresentations: experienceBlueprintService.DETAIL_PRESENTATIONS,
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

    const { expectedUpdatedAt, ...blueprintInput } = req.body;
    const blueprint = experienceBlueprintService.normalizeExperienceBlueprint(blueprintInput, business.category);

    await updateExperienceSafe(prisma, businessProfileId, blueprint, expectedUpdatedAt);
    await invalidateCache(businessProfileId);

    res.json({
      success: true,
      data: blueprint,
      message: 'Experience settings saved to the storefront draft. Publish the storefront to make them live.',
    });
  } catch (err) {
    if (err.statusCode === 409 || err.code === 'INVALID_EXPECTED_UPDATED_AT') {
      return res.status(err.statusCode || 400).json({
        success: false,
        message: err.message,
        code: err.code,
      });
    }
    next(err);
  }
});

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
