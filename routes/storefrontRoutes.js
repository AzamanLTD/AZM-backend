'use strict';

// =============================================================================
// AZAMAN — Storefront SDUI Routes
// Mounted at /api/storefront
//
// 14 endpoints: themes, widgets, templates (public) + draft CRUD, publish,
// history, revert, apply-template, eligibility, analytics, render (mixed)
// =============================================================================

const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const storefrontService = require('../services/storefrontService');
const renderService = require('../services/storefrontRenderService');
const { saveDraftSchema, applyTemplateSchema, revertSchema } = require('../services/validation/storefrontSchemas');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[Storefront]', err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  };
}

// ── PUBLIC endpoints (no auth) ──────────────────────────────────────────────

// GET /api/storefront/themes — list all active themes
router.get('/themes', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const themes = await storefrontService.listThemes(prisma, req.query.category);
  res.json({ success: true, data: themes });
}));

// GET /api/storefront/widgets — list all active widgets
router.get('/widgets', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const widgets = await storefrontService.listWidgets(prisma, req.query.category);
  res.json({ success: true, data: widgets });
}));

// GET /api/storefront/templates — list all active layout templates
router.get('/templates', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const templates = await storefrontService.listTemplates(prisma, req.query.category);
  res.json({ success: true, data: templates });
}));

// GET /api/storefront/:businessProfileId/render — public render endpoint (cached)
router.get('/:businessProfileId/render', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const rendered = await renderService.renderStorefront(prisma, req.params.businessProfileId);
  if (!rendered) return res.status(404).json({ success: false, message: 'Storefront not available.' });
  res.json({ success: true, data: rendered });
}));

// GET /api/storefront/:businessProfileId/theme — public theme for web ordering
router.get('/:businessProfileId/theme', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const theme = await renderService.getPublicTheme(prisma, req.params.businessProfileId);
  res.json({ success: true, data: theme });
}));

// GET /api/storefront/:businessProfileId/public-theme — simplified theme for web ordering integration
router.get('/:businessProfileId/public-theme', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;

  const layout = await prisma.businessStorefrontLayout.findFirst({
    where: { businessProfileId, status: 'PUBLISHED' },
    include: { theme: true },
  });

  if (!layout) {
    const defaultTheme = await prisma.businessStorefrontTheme.findFirst({
      where: { key: 'classic_light', isActive: true },
    });
    return res.json({
      success: true,
      data: {
        accent: defaultTheme?.tokenSet?.accent || '#6C4FD1',
        themeName: defaultTheme?.name || 'Classic',
        hasPublishedLayout: false,
      },
    });
  }

  res.json({
    success: true,
    data: {
      accent: layout.theme?.tokenSet?.accent || '#6C4FD1',
      themeName: layout.theme?.name || 'Classic',
      hasPublishedLayout: true,
      layoutJson: layout.layoutJson,
    },
  });
}));

// ── AUTHENTICATED endpoints ──────────────────────────────────────────────────

// All routes below require auth + active business + settings.manage permission

// GET /api/storefront/me/draft — get or create draft layout for the current business
router.get('/me/draft', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { category: true } });
  const draft = await storefrontService.getOrCreateDraft(prisma, businessProfileId, business?.category);
  res.json({ success: true, data: draft });
}));

// GET /api/storefront/me/published — get the published layout
router.get('/me/published', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const published = await storefrontService.getPublishedLayout(prisma, businessProfileId);
  res.json({ success: true, data: published });
}));

// PUT /api/storefront/me/draft — save draft layout
router.put('/me/draft', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = saveDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.saveDraft(prisma, businessProfileId, parsed.data.layoutJson, parsed.data.themeId, parsed.data.expectedUpdatedAt);
  res.json({ success: true, data: draft });
}));

// POST /api/storefront/me/publish — publish the draft
router.post('/me/publish', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const published = await storefrontService.publishLayout(prisma, businessProfileId, req.user.id);
  // Invalidate render cache
  await renderService.invalidateCache(businessProfileId);
  res.json({ success: true, data: published, message: 'Storefront published successfully.' });
}));

// GET /api/storefront/me/history — get version history
router.get('/me/history', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const history = await storefrontService.getHistory(prisma, businessProfileId, parseInt(req.query.limit) || 20);
  res.json({ success: true, data: history });
}));

// POST /api/storefront/me/revert — revert to a previous version
router.post('/me/revert', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = revertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.revertToVersion(prisma, businessProfileId, parsed.data.versionId);
  res.json({ success: true, data: draft, message: 'Reverted to selected version. Review and publish.' });
}));

// POST /api/storefront/me/apply-template — apply a template to the draft
router.post('/me/apply-template', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = applyTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.applyTemplate(prisma, businessProfileId, parsed.data.templateId);
  res.json({ success: true, data: draft, message: 'Template applied. Review and publish.' });
}));

// GET /api/storefront/me/eligibility — check theme/widget eligibility
router.get('/me/eligibility', protect, protectActive, requirePermission('settings.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const eligibility = await storefrontService.checkEligibility(prisma, businessProfileId, req.user.id);
  res.json({ success: true, data: eligibility });
}));

// POST /api/storefront/me/analytics — record an analytics event
router.post('/me/analytics', protect, protectActive, wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const { eventType, metadata } = req.body;
  if (!eventType) return res.status(400).json({ success: false, message: 'eventType is required.' });
  await storefrontService.recordEvent(prisma, businessProfileId, eventType, metadata || {});
  res.json({ success: true, message: 'Event recorded.' });
}));

module.exports = router;
