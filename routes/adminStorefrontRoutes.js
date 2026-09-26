'use strict';

// =============================================================================
// AZAMAN — Admin Storefront Routes
// Mounted at /api/admin/storefront
//
// 3 endpoints: disable/enable storefront, list all storefronts with analytics
// =============================================================================

const logger = require('../src/config/logger');
const router = require('express').Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err: err }, '[AdminStorefront]');
      res.status(400).json({ success: false, message: err.message });
    }
  };
}

// Check if adminOnly exists, otherwise use a simple admin check
const adminGuard = adminOnly || ((req, res, next) => {
  if (req.user?.role === 'ADMIN' || req.user?.isAdmin) return next();
  return res.status(403).json({ success: false, message: 'Admin access required.' });
});

router.use(protect, adminGuard);

// PATCH /api/admin/storefront/:businessProfileId/disable — disable a storefront
router.patch('/:businessProfileId/disable', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { storefrontDisabled: true },
  });
  // Invalidate render cache
  const renderService = require('../services/storefrontRenderService');
  await renderService.invalidateCache(businessProfileId);
  res.json({ success: true, message: 'Storefront disabled.' });
}));

// PATCH /api/admin/storefront/:businessProfileId/enable — enable a storefront
router.patch('/:businessProfileId/enable', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { storefrontDisabled: false },
  });
  // Enabling changes the public renderability state just like disabling does.
  const renderService = require('../services/storefrontRenderService');
  await renderService.invalidateCache(businessProfileId);
  res.json({ success: true, message: 'Storefront enabled.' });
}));

// GET /api/admin/storefront — list all storefronts with analytics summary
router.get('/', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const [storefronts, total] = await Promise.all([
    prisma.businessStorefrontLayout.findMany({
      where: { status: 'PUBLISHED' },
      include: {
        businessProfile: { select: { id: true, businessName: true, category: true, logoUrl: true, storefrontDisabled: true } },
        theme: { select: { id: true, name: true, key: true } },
      },
      orderBy: { publishedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.businessStorefrontLayout.count({ where: { status: 'PUBLISHED' } }),
  ]);

  // Get analytics counts
  const analyticsCounts = await prisma.storefrontAnalyticsEvent.groupBy({
    by: ['eventType'],
    _count: true,
  });

  res.json({
    success: true,
    data: {
      storefronts,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      analytics: analyticsCounts,
    },
  });
}));


// POST /api/admin/storefront/:businessProfileId/revert/:versionId — force-revert a storefront layout
router.post('/:businessProfileId/revert/:versionId', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId, versionId } = req.params;
  const storefrontService = require('../services/storefrontService');
  const draft = await storefrontService.revertToVersion(prisma, businessProfileId, versionId);
  // Invalidate delivery cache
  const renderService = require('../services/storefrontRenderService');
  await renderService.invalidateCache(businessProfileId);
  res.json({ success: true, message: 'Storefront layout force-reverted by admin.', data: draft });
}));

// GET /api/admin/storefront/:businessProfileId/media — review uploaded media for a storefront
router.get('/:businessProfileId/media', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;

  // Get the published layout
  const layout = await prisma.businessStorefrontLayout.findFirst({
    where: { businessProfileId, status: 'PUBLISHED' },
    select: { id: true, layoutJson: true, publishedAt: true },
  });

  // Get the draft if exists
  const draft = await prisma.businessStorefrontLayout.findFirst({
    where: { businessProfileId, status: 'DRAFT' },
    select: { id: true, layoutJson: true },
  });

  // Extract all media URLs from both layouts
  const mediaItems = new Map();
  const extractMedia = (layoutJson) => {
    if (!layoutJson?.tiles) return;
    for (const tile of layoutJson.tiles) {
      const props = tile.props || {};
      if (props.mediaUrl) {
        mediaItems.set(props.mediaUrl, { url: props.mediaUrl, widgetType: tile.widgetType, tileId: tile.id, source: 'tile_media' });
      }
      if (props.imageUrl) {
        mediaItems.set(props.imageUrl, { url: props.imageUrl, widgetType: tile.widgetType, tileId: tile.id, source: 'tile_image' });
      }
      if (props.videoUrl) {
        mediaItems.set(props.videoUrl, { url: props.videoUrl, widgetType: tile.widgetType, tileId: tile.id, source: 'tile_video' });
      }
    }
  };

  if (layout) extractMedia(layout.layoutJson);
  if (draft) extractMedia(draft.layoutJson);

  // Also get the business profile cover photo and logo
  const biz = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { businessName: true, logoUrl: true, coverPhotoUrl: true },
  });

  if (biz?.logoUrl) mediaItems.set(biz.logoUrl, { url: biz.logoUrl, widgetType: 'business_logo', tileId: null, source: 'business' });
  if (biz?.coverPhotoUrl) mediaItems.set(biz.coverPhotoUrl, { url: biz.coverPhotoUrl, widgetType: 'business_cover', tileId: null, source: 'business' });

  res.json({
    success: true,
    data: {
      businessName: biz?.businessName || 'Unknown',
      media: Array.from(mediaItems.values()),
      publishedAt: layout?.publishedAt || null,
    },
  });
}));


module.exports = router;
