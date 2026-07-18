'use strict';

// =============================================================================
// AZAMAN — Admin Storefront Routes
// Mounted at /api/admin/storefront
//
// 3 endpoints: disable/enable storefront, list all storefronts with analytics
// =============================================================================

const router = require('express').Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[AdminStorefront]', err.message);
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

module.exports = router;
