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
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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

// GET /api/storefront/discover — browse businesses with published storefronts
// Public endpoint. Supports search, category filter, pagination.
router.get('/discover', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { q, category, limit = 20, offset = 0 } = req.query;
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);

  // Find businesses that have a PUBLISHED storefront layout and are not suspended
  const where = {
    status: 'PUBLISHED',
    businessProfile: {
      isSuspended: false,
      isPausedByOwner: false,
      ...(category ? { businessProfile: { category } } : {}),
    },
  };

  // If search query provided, filter by business name (case-insensitive)
  if (q && q.trim()) {
    where.businessProfile = {
      ...where.businessProfile,
      businessName: { contains: q.trim(), mode: 'insensitive' },
    };
  }

  const [layouts, total] = await Promise.all([
    prisma.businessStorefrontLayout.findMany({
      where,
      include: {
        businessProfile: {
          select: {
            id: true,
            bizId: true,
            businessName: true,
            category: true,
            logoUrl: true,
            coverPhotoUrl: true,
            averageRating: true,
            reviewCount: true,
            description: true,
            address: true,
            phoneNumber: true,
          },
        },
        theme: { select: { key: true, name: true, tokenSet: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take,
      skip,
    }),
    prisma.businessStorefrontLayout.count({ where }),
  ]);

  const results = layouts.map(l => ({
    businessProfileId: l.businessProfileId,
    business: l.businessProfile,
    theme: { key: l.theme.key, name: l.theme.name, accent: l.theme.tokenSet?.accent || '#6C4FD1' },
    publishedAt: l.publishedAt,
    tileCount: l.layoutJson?.tiles?.length || 0,
  }));

  res.json({ success: true, data: { results, total, hasMore: skip + take < total } });
}));

// GET /api/storefront/:businessProfileId/products — public product listing for storefront ordering
router.get('/:businessProfileId/products', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  const { category, limit = 50 } = req.query;
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

  // Verify the business exists and has a published storefront
  const [business, hasStorefront] = await Promise.all([
    prisma.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { id: true, businessName: true, isSuspended: true, isPausedByOwner: true, category: true },
    }),
    prisma.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
      select: { id: true },
    }),
  ]);

  if (!business || business.isSuspended) {
    return res.status(404).json({ success: false, message: 'Business not found.' });
  }

  // Return active products even if no published storefront (for ordering)
  const products = await prisma.businessProduct.findMany({
    where: {
      businessProfileId,
      isActive: true,
      isAvailable: true,
      ...(category ? { category } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      priceUsdc: true,
      imageUrls: true,
      category: true,
      tags: true,
      preparationMins: true,
      variants: true,
      modifierGroups: true,
      slug: true,
    },
    orderBy: [{ catalogSectionId: 'asc' }, { name: 'asc' }],
    take,
  });

  res.json({
    success: true,
    data: {
      business: { id: business.id, name: business.businessName, category: business.category },
      hasStorefront: !!hasStorefront,
      products: products.map(p => ({
        ...p,
        priceUsdc: Number(p.priceUsdc),
        imageUrls: p.imageUrls || [],
      })),
    },
  });
}));

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
router.get('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { category: true } });
  const draft = await storefrontService.getOrCreateDraft(prisma, businessProfileId, business?.category);
  res.json({ success: true, data: draft });
}));

// GET /api/storefront/me/published — get the published layout
router.get('/me/published', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const published = await storefrontService.getPublishedLayout(prisma, businessProfileId);
  res.json({ success: true, data: published });
}));

// PUT /api/storefront/me/draft — save draft layout
router.put('/me/draft', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = saveDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.saveDraft(prisma, businessProfileId, parsed.data.layoutJson, parsed.data.themeId, parsed.data.expectedUpdatedAt);
  res.json({ success: true, data: draft });
}));

// POST /api/storefront/me/publish — publish the draft
router.post('/me/publish', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const published = await storefrontService.publishLayout(prisma, businessProfileId, req.user.id);
  // Invalidate render cache
  await renderService.invalidateCache(businessProfileId);
  res.json({ success: true, data: published, message: 'Storefront published successfully.' });
}));

// GET /api/storefront/me/history — get version history
router.get('/me/history', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const history = await storefrontService.getHistory(prisma, businessProfileId, parseInt(req.query.limit) || 20);
  res.json({ success: true, data: history });
}));

// POST /api/storefront/me/revert — revert to a previous version
router.post('/me/revert', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = revertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.revertToVersion(prisma, businessProfileId, parsed.data.versionId);
  res.json({ success: true, data: draft, message: 'Reverted to selected version. Review and publish.' });
}));

// POST /api/storefront/me/apply-template — apply a template to the draft
router.post('/me/apply-template', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });

  const parsed = applyTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Validation failed', errors: parsed.error.flatten() });

  const draft = await storefrontService.applyTemplate(prisma, businessProfileId, parsed.data.templateId);
  res.json({ success: true, data: draft, message: 'Template applied. Review and publish.' });
}));

// GET /api/storefront/me/eligibility — check theme/widget eligibility
router.get('/me/eligibility', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  const eligibility = await storefrontService.checkEligibility(prisma, businessProfileId, req.user.id);
  res.json({ success: true, data: eligibility });
}));



// POST /api/storefront/:businessProfileId/events — record a storefront view event (public, optional auth)
router.post('/:businessProfileId/events', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  const { eventType, metadata } = req.body;
  if (!eventType) return res.status(400).json({ success: false, message: 'eventType is required.' });

  // Validate eventType is a storefront event (not arbitrary)
  const allowedEvents = ['storefront_view', 'widget_view', 'cta_click', 'product_tap', 'follow_click', 'review_click', 'message_click', 'share_click'];
  if (!allowedEvents.includes(eventType)) {
    return res.status(400).json({ success: false, message: 'Invalid event type.' });
  }

  // Add viewer info if authenticated (optional)
  const enrichedMetadata = {
    ...metadata,
    viewerId: req.user?.id || null,
    viewerType: req.user ? 'app_user' : 'guest',
  };

  await storefrontService.recordEvent(prisma, businessProfileId, eventType, enrichedMetadata);
  res.json({ success: true });
}));

// GET /api/storefront/me/analytics — get aggregated storefront analytics
router.get('/me/analytics', protect, protectActive, requirePermission('storefront.manage'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'Business profile required.' });

  const days = parseInt(req.query.days, 10) || 30;
  const analytics = await storefrontService.getAnalytics(prisma, businessProfileId, { days });
  res.json({ success: true, data: analytics });
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


// POST /api/storefront/me/media — upload media for a tile (multipart/form-data)
router.post('/me/media', protect, protectActive, requirePermission('storefront.manage'), upload.single('file'), wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const businessProfileId = req.businessProfileId || req.user.businessProfileId;
  if (!businessProfileId) return res.status(400).json({ success: false, message: 'No business profile found.' });
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const { uploadToCloudinary } = require('../services/cloudinaryService');
  const result = await uploadToCloudinary(req.file, 'storefronts');
  res.json({ success: true, data: { url: result.url, publicId: result.publicId } });
}));

// POST /api/storefront/:businessProfileId/order — customer places an order from the storefront
// Requires authentication. Creates a BusinessOrder with status AWAITING_PAYMENT.
router.post('/:businessProfileId/order', protect, protectActive, wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const { businessProfileId } = req.params;
  const userId = req.user.id;
  const { productId, quantity = 1, customerNotes, deliveryNotes } = req.body;

  if (!productId) return res.status(400).json({ success: false, message: 'productId is required.' });

  // Verify business exists and is active
  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { id: true, isSuspended: true, isPausedByOwner: true },
  });
  if (!business || business.isSuspended) {
    return res.status(404).json({ success: false, message: 'Business not available.' });
  }
  if (business.isPausedByOwner) {
    return res.status(400).json({ success: false, message: 'This business is currently not accepting orders.' });
  }

  // Get product and validate
  const product = await prisma.businessProduct.findFirst({
    where: { id: productId, businessProfileId, isActive: true, isAvailable: true },
    select: { id: true, name: true, priceUsdc: true, isActive: true, isAvailable: true },
  });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not available.' });
  }

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const amount = parseFloat(product.priceUsdc) * qty;
  const orderTitle = qty > 1 ? `${product.name} x${qty}` : product.name;

  // Create the order
  const { v4: uuidv4 } = require('uuid');
  const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}-${uuidv4().slice(0, 6).toUpperCase()}`;

  const order = await prisma.businessOrder.create({
    data: {
      businessProfileId,
      customerId: userId,
      productId,
      status: 'AWAITING_PAYMENT',
      orderRef,
      title: orderTitle,
      description: `Storefront order for ${orderTitle}`,
      amountUsdc: amount,
      customerNotes: customerNotes ? String(customerNotes).slice(0, 500) : null,
      deliveryNotes: deliveryNotes ? String(deliveryNotes).slice(0, 500) : null,
    },
  });

  // Track order event
  try {
    await prisma.storefrontAnalyticsEvent.create({
      data: {
        businessProfileId,
        eventType: 'order_placed',
        visitorId: `user_${userId}`,
        metadata: { orderId: order.id, productId, quantity: qty, amount },
      },
    });
  } catch (_) { /* analytics is best-effort */ }

  res.status(201).json({ success: true, data: { order } });
}));

module.exports = router;
