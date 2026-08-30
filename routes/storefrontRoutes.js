'use strict';

// =============================================================================
// AZAMAN — Storefront SDUI Routes
// Mounted at /api/storefront
// =============================================================================

const logger = require('../src/config/logger');
const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requirePermission } = require('../middleware/requirePermission');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const storefrontService = require('../services/storefrontService');
const renderService = require('../services/storefrontRenderService');
const { saveDraftSchema, publishLayoutSchema, applyTemplateSchema, revertSchema } = require('../services/validation/storefrontSchemas');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, '[Storefront]');
      res.status(400).json({ success: false, message: err.message });
    }
  };
}

// ── PUBLIC endpoints ─────────────────────────────────────────────────────────
router.get('/themes', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  res.json({ success: true, data: await storefrontService.listThemes(prisma, req.query.category) });
}));

router.get('/widgets', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  res.json({ success: true, data: await storefrontService.listWidgets(prisma, req.query.category) });
}));

router.get('/templates', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  res.json({ success: true, data: await storefrontService.listTemplates(prisma, req.query.category) });
}));

router.get('/discover', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { q, category, limit = 20, offset = 0 } = req.query;
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);
  const businessProfile = { isSuspended: false, isPausedByOwner: false };
  if (category) businessProfile.category = category;
  if (q && q.trim()) businessProfile.businessName = { contains: q.trim(), mode: 'insensitive' };
  const where = { status: 'PUBLISHED', businessProfile };
  const [layouts, total] = await Promise.all([
    prisma.businessStorefrontLayout.findMany({
      where,
      include: { businessProfile: { select: { id: true, bizId: true, businessName: true, category: true, logoUrl: true, coverPhotoUrl: true, averageRating: true, reviewCount: true, description: true, address: true, phoneNumber: true } }, theme: { select: { key: true, name: true, tokenSet: true } } },
      orderBy: { publishedAt: 'desc' }, take, skip,
    }),
    prisma.businessStorefrontLayout.count({ where }),
  ]);
  const results = layouts.map(l => ({ businessProfileId: l.businessProfileId, business: l.businessProfile, theme: { key: l.theme.key, name: l.theme.name, accent: l.theme.tokenSet?.accent || '#6C4FD1' }, publishedAt: l.publishedAt, tileCount: l.layoutJson?.tiles?.length || 0 }));
  res.json({ success: true, data: { results, total, hasMore: skip + take < total } });
}));

router.get('/:businessProfileId/products', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  const { category, limit = 50 } = req.query;
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const [business, hasStorefront] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { id: true, businessName: true, isSuspended: true, isPausedByOwner: true, category: true } }),
    prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } }, select: { id: true } }),
  ]);
  if (!business || business.isSuspended) return res.status(404).json({ success: false, message: 'Business not found.' });
  const products = await prisma.businessProduct.findMany({ where: { businessProfileId, isActive: true, isAvailable: true, ...(category ? { category } : {}) }, select: { id: true, name: true, description: true, priceUsdc: true, imageUrls: true, category: true, tags: true, preparationMins: true, variants: true, modifierGroups: true, slug: true }, orderBy: [{ catalogSectionId: 'asc' }, { name: 'asc' }], take });
  res.json({ success: true, data: { business: { id: business.id, name: business.businessName, category: business.category }, hasStorefront: !!hasStorefront, products: products.map(p => ({ ...p, priceUsdc: Number(p.priceUsdc), imageUrls: p.imageUrls || [] })) } });
}));

router.get('/:businessProfileId/render', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const rendered = await renderService.renderStorefront(prisma, req.params.businessProfileId);
  if (!rendered) return res.status(404).json({ success: false, message: 'Storefront not available.' });
  res.json({ success: true, data: rendered });
}));

router.get('/:businessProfileId/theme', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  res.json({ success: true, data: await renderService.getPublicTheme(prisma, req.params.businessProfileId) });
}));

router.get('/:businessProfileId/public-theme', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  const layout = await prisma.businessStorefrontLayout.findFirst({ where: { businessProfileId, status: 'PUBLISHED' }, include: { theme: true } });
  if (!layout) {
    const defaultTheme = await prisma.businessStorefrontTheme.findFirst({ where: { key: 'classic_light', isActive: true } });
    return res.json({ success: true, data: { accent: defaultTheme?.tokenSet?.accent || '#6C4FD1', themeName: defaultTheme?.name || 'Classic', hasPublishedLayout: false } });
  }
  res.json({ success: true, data: { accent: layout.theme?.tokenSet?.accent || '#6C4FD1', themeName: layout.theme?.name || 'Classic', hasPublishedLayout: true, layoutJson: layout.layoutJson } });
}));

// ── AUTHENTICATED STOREFRONT MANAGEMENT ─────────────────────────────────────
router.get('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { category: true } });
  res.json({ success: true, data: await storefrontService.getOrCreateDraft(prisma, businessProfileId, business?.category) });
}));

router.get('/me/published', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  res.json({ success: true, data: await storefrontService.getPublishedLayout(prisma, businessProfileId) });
}));

router.put('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const parsed = saveDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  res.json({ success: true, data: await storefrontService.saveDraft(prisma, businessProfileId, parsed.data.layoutJson, parsed.data.themeId, parsed.data.expectedUpdatedAt) });
}));

router.post('/me/publish', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const parsed = publishLayoutSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const published = await storefrontService.publishLayout(prisma, businessProfileId, req.user.id, parsed.data.expectedUpdatedAt);
    await renderService.invalidateCache(businessProfileId);
    await prisma.storefrontAnalyticsEvent.create({ data: { businessProfileId, eventType: 'layout_published', metadata: { themeId: published.themeId, tileCount: published.layoutJson?.tiles?.length || 0, tier: published.tier || 'FREE' } } }).catch(() => {});
    res.json({ success: true, data: published, message: 'Storefront published successfully.' });
  } catch (err) {
    if (err.statusCode === 402) return res.status(402).json({ success: false, message: err.message, violations: err.violations, tier: err.tier, stakedBalance: err.stakedBalance });
    throw err;
  }
}));

router.get('/me/history', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  res.json({ success: true, data: await storefrontService.getHistory(prisma, businessProfileId, parseInt(req.query.limit) || 20) });
}));

router.post('/me/revert', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const parsed = revertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  res.json({ success: true, data: await storefrontService.revertToVersion(prisma, businessProfileId, parsed.data.versionId), message: 'Reverted to selected version. Review and publish.' });
}));

router.post('/me/apply-template', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const parsed = applyTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });
  res.json({ success: true, data: await storefrontService.applyTemplate(prisma, businessProfileId, parsed.data.templateId), message: 'Template applied. Review and publish.' });
}));

router.get('/me/eligibility', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  res.json({ success: true, data: await storefrontService.checkEligibility(prisma, businessProfileId, req.user.id) });
}));

module.exports = router;
