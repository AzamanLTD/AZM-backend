'use strict';

// =============================================================================
// AZAMAN — Storefront SDUI Service
//
// NOTE: `prisma` is passed as the first argument to every function.
// This matches the existing codebase pattern: services never import a
// prisma singleton. All callers get prisma via req.app.get('prisma').
// =============================================================================

const logger = require('../src/config/logger');
const { migrateLayout, generateEmptyLayout } = require('./storefrontSchemaMigration');
const { validateStudioDocument } = require('./storefrontStudioValidation');

function hasOwnExperience(layoutJson) {
  return Boolean(
    layoutJson &&
    typeof layoutJson === 'object' &&
    Object.prototype.hasOwnProperty.call(layoutJson, 'experience'),
  );
}

/**
 * Preserve the current draft's Experience Blueprint when applying a historical
 * layout/template that predates the blueprint being stored in layoutJson.
 * An explicit `experience` on the target always wins, including null, because
 * that is an intentional snapshot rather than an absent legacy field.
 */
function validateStudioExperience(layoutJson) {
  const experience = layoutJson?.experience;
  if (experience?.schemaVersion !== 2) return;
  try {
    validateStudioDocument(experience);
  } catch (error) {
    const err = new Error('Storefront Studio document validation failed.');
    err.code = error.code || 'STOREFRONT_DOCUMENT_INVALID';
    err.validationCode = err.code;
    err.statusCode = 422;
    throw err;
  }
}

function preserveExperienceSnapshot(nextLayout, currentDraftLayout) {
  if (
    !hasOwnExperience(nextLayout) &&
    hasOwnExperience(currentDraftLayout)
  ) {
    return { ...nextLayout, experience: currentDraftLayout.experience };
  }
  return nextLayout;
}

/**
 * Generate a default layout for a business based on its category.
 * @param {string} businessProfileId
 * @param {string} category - Business category (RESTAURANT, HOTEL, RETAIL, etc.)
 * @returns {object} - Default layout JSON
 */
function generateDefaultLayout(businessProfileId, category = 'UNIVERSAL') {
  const tiles = [];

  // All businesses get a hero header
  tiles.push({
    id: `tile_${Math.random().toString(36).substring(2, 10)}`,
    widgetType: 'hero_header',
    position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 },
    props: {
      mediaUrl: null,
      mediaType: 'image',
      title: null,
      subtitle: 'Welcome to our store',
      overlayOpacity: 0.3,
      height: 'standard',
    },
  });

  // Quick info bar
  tiles.push({
    id: `tile_${Math.random().toString(36).substring(2, 10)}`,
    widgetType: 'quick_info_bar',
    position: { row: 2, col: 0, rowSpan: 1, colSpan: 4 },
    props: { showHours: true, showRating: true, showCategory: true, customInfo: '' },
  });

  // Category-specific tiles
  if (category === 'RESTAURANT' || category === 'FOOD') {
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'product_grid',
      position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 },
      props: { title: 'Popular Dishes', maxItems: 6, columns: 2, showPrice: true },
    });
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'review_carousel',
      position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 },
      props: { title: 'What People Say', maxReviews: 5, minRating: 4 },
    });
  } else if (category === 'HOTEL' || category === 'LODGING') {
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'showcase_gallery',
      position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 },
      props: { title: 'Our Rooms', maxItems: 8, autoplay: false },
    });
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'location_map',
      position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 },
      props: { title: 'Find Us', zoom: 14 },
    });
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'action_buttons',
      position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 },
      props: { showOrder: false, showBook: true, showFollow: true, showShare: true },
    });
  } else {
    // Retail / universal
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'product_grid',
      position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 },
      props: { title: 'Featured Products', maxItems: 6, columns: 2, showPrice: true },
    });
    tiles.push({
      id: `tile_${Math.random().toString(36).substring(2, 10)}`,
      widgetType: 'contact_card',
      position: { row: 6, col: 0, rowSpan: 1, colSpan: 4 },
      props: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: false },
    });
  }

  return {
    schemaVersion: 1,
    gridColumns: 4,
    tiles,
  };
}

/**
 * Get or create a draft layout for a business.
 * @param {object} prisma - Prisma client instance (req.app.get('prisma'))
 * @param {string} businessProfileId
 * @param {string} [category]
 */
async function getOrCreateDraft(prisma, businessProfileId, category) {
  let draft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    include: { theme: true },
  });

  if (!draft) {
    // Get the default theme
    const defaultTheme = await prisma.businessStorefrontTheme.findFirst({
      where: { key: 'classic_light', isActive: true },
    });

    if (!defaultTheme) {
      // Try any active theme as fallback
      const anyTheme = await prisma.businessStorefrontTheme.findFirst({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
      });
      if (!anyTheme) {
        throw new Error('No active themes found. Run seed scripts: node scripts/seed-storefront-catalog.js');
      }
    }

    const themeToUse = await prisma.businessStorefrontTheme.findFirst({
      where: { key: 'classic_light', isActive: true },
    }) || await prisma.businessStorefrontTheme.findFirst({ where: { isActive: true } });

    if (!themeToUse) {
      throw new Error('No active themes found. Run: node scripts/seed-storefront-catalog.js');
    }

    const layoutJson = generateDefaultLayout(businessProfileId, category);
    draft = await prisma.businessStorefrontLayout.create({
      data: {
        businessProfileId,
        status: 'DRAFT',
        themeId: themeToUse.id,
        layoutJson,
      },
      include: { theme: true },
    });
  }

  return draft;
}

/**
 * Get the published layout for a business.
 * @param {object} prisma
 * @param {string} businessProfileId
 */
async function getPublishedLayout(prisma, businessProfileId) {
  return prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    include: { theme: true },
  });
}

/**
 * Save a draft layout with optimistic concurrency check.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {object} layoutJson
 * @param {string} themeId
 * @param {string} [expectedUpdatedAt]
 */
async function saveDraft(prisma, businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  // Optimistic concurrency: reject if draft changed since client loaded it
  if (expectedUpdatedAt) {
    const existing = await prisma.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    });
    if (existing && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new Error('Draft was modified by another editor. Please refresh.');
    }
  }

  const migratedLayout = migrateLayout(layoutJson);
  validateStudioExperience(migratedLayout);

  const draft = await prisma.businessStorefrontLayout.upsert({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    create: {
      businessProfileId,
      status: 'DRAFT',
      themeId,
      layoutJson: migratedLayout,
    },
    update: {
      themeId,
      layoutJson: migratedLayout,
    },
    include: { theme: true },
  });

  return draft;
}

/**
 * Publish a draft layout — archives the current published version first.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {string} userId
 */
async function publishLayout(prisma, businessProfileId, userId) {
  const draft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    include: { theme: true },
  });

  if (!draft) throw new Error('No draft layout to publish.');

  // Check storefront disabled flag
  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { storefrontDisabled: true },
  });
  if (business?.storefrontDisabled) {
    throw new Error('Storefront is disabled by admin. Contact support.');
  }

  validateStudioExperience(draft.layoutJson);

  // PHASE 8: Validate Nitro eligibility — reject if layout references
  // premium widgets/themes the owner hasn't staked for.
  const themeKey = draft.theme?.key || null;
  const eligibility = await validateNitroEligibility(prisma, businessProfileId, draft.layoutJson, themeKey);
  if (!eligibility.eligible) {
    const err = new Error('Nitro eligibility check failed. Premium features require more staked AZM.');
    err.statusCode = 402;
    err.violations = eligibility.violations;
    err.tier = eligibility.tier;
    err.stakedBalance = eligibility.stakedBalance;
    throw err;
  }

  // Archive the current published version into history
  const currentPublished = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
  });

  if (currentPublished) {
    const maxVersion = await prisma.businessStorefrontLayoutVersion.aggregate({
      where: { businessProfileId },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    await prisma.businessStorefrontLayoutVersion.create({
      data: {
        businessProfileId,
        version: nextVersion,
        themeId: currentPublished.themeId,
        layoutJson: currentPublished.layoutJson,
        publishedAt: currentPublished.publishedAt,
        publishedBy: currentPublished.publishedBy,
      },
    });

    // Delete the old published layout
    await prisma.businessStorefrontLayout.delete({ where: { id: currentPublished.id } });
  }

  // Create the new published layout
  const published = await prisma.businessStorefrontLayout.create({
    data: {
      businessProfileId,
      status: 'PUBLISHED',
      themeId: draft.themeId,
      layoutJson: draft.layoutJson,
      publishedAt: new Date(),
      publishedBy: userId,
    },
    include: { theme: true },
  });

  // Also archive the new published version for history
  const maxVersion2 = await prisma.businessStorefrontLayoutVersion.aggregate({
    where: { businessProfileId },
    _max: { version: true },
  });
  const nextVersion2 = (maxVersion2._max.version || 0) + 1;

  await prisma.businessStorefrontLayoutVersion.create({
    data: {
      businessProfileId,
      version: nextVersion2,
      themeId: draft.themeId,
      layoutJson: draft.layoutJson,
      publishedAt: published.publishedAt,
      publishedBy: userId,
    },
  });

  // Delete the draft (now published)
  await prisma.businessStorefrontLayout.delete({ where: { id: draft.id } });

  return published;
}

/**
 * Get version history for a business.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {number} [limit=20]
 */
async function getHistory(prisma, businessProfileId, limit = 20) {
  return prisma.businessStorefrontLayoutVersion.findMany({
    where: { businessProfileId },
    orderBy: { version: 'desc' },
    take: Math.min(limit, 100),
    include: { theme: true },
  });
}

/**
 * Revert to a specific version (creates/updates the draft).
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {string} versionId
 */
async function revertToVersion(prisma, businessProfileId, versionId) {
  const version = await prisma.businessStorefrontLayoutVersion.findUnique({
    where: { id: versionId },
  });

  if (!version || version.businessProfileId !== businessProfileId) {
    throw new Error('Version not found.');
  }

  const migratedLayout = migrateLayout(version.layoutJson);

  const existingDraft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
  });

  if (existingDraft) {
    const layoutJson = preserveExperienceSnapshot(migratedLayout, existingDraft.layoutJson);
    return prisma.businessStorefrontLayout.update({
      where: { id: existingDraft.id },
      data: { themeId: version.themeId, layoutJson },
      include: { theme: true },
    });
  }

  return prisma.businessStorefrontLayout.create({
    data: {
      businessProfileId,
      status: 'DRAFT',
      themeId: version.themeId,
      layoutJson: migratedLayout,
    },
    include: { theme: true },
  });
}

/**
 * Apply a template to a business's draft.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {string} templateId
 */
async function applyTemplate(prisma, businessProfileId, templateId) {
  const template = await prisma.businessStorefrontLayoutTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template || !template.isActive) {
    throw new Error('Template not found or inactive.');
  }

  const migratedLayout = migrateLayout(template.layoutJson);
  const themeId = template.themeId;

  if (!themeId) {
    throw new Error('Template has no theme assigned.');
  }

  const existingDraft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
  });

  if (existingDraft) {
    const layoutJson = preserveExperienceSnapshot(migratedLayout, existingDraft.layoutJson);
    return prisma.businessStorefrontLayout.update({
      where: { id: existingDraft.id },
      data: { themeId, layoutJson },
      include: { theme: true },
    });
  }

  return prisma.businessStorefrontLayout.create({
    data: {
      businessProfileId,
      status: 'DRAFT',
      themeId,
      layoutJson: migratedLayout,
    },
    include: { theme: true },
  });
}

/**
 * List all active themes, optionally filtered by category.
 * @param {object} prisma
 * @param {string} [category]
 */
async function listThemes(prisma, category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontTheme.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
  });
}

/**
 * List all active widgets, optionally filtered by category.
 * @param {object} prisma
 * @param {string} [category]
 */
async function listWidgets(prisma, category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontWidgetCatalog.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
  });
}

/**
 * List all active layout templates, optionally filtered by category.
 * @param {object} prisma
 * @param {string} [category]
 */
async function listTemplates(prisma, category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontLayoutTemplate.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
    include: { theme: true },
  });
}

/**
 * Check storefront eligibility for a business owner.
 * Returns staked AZM balance, tier, and whether storefront is disabled.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {number|string} userId
 */
async function checkEligibility(prisma, businessProfileId, userId) {
  const stakes = await prisma.azmStake.findMany({
    where: { userId, status: 'ACTIVE' },
  });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);

  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { storefrontDisabled: true },
  });

  // Tier thresholds (must match azmStakeService.TIER_THRESHOLDS)
  let tier = 'FREE';
  if (stakedBalance >= 5000) tier = 'NITRO_GOLD';
  else if (stakedBalance >= 1500) tier = 'NITRO_SILVER';
  else if (stakedBalance >= 500) tier = 'NITRO_BRONZE';

  return {
    stakedBalance,
    tier,
    storefrontDisabled: business?.storefrontDisabled || false,
  };
}

/**
 * Record a storefront analytics event.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {string} eventType
 * @param {object} [metadata={}]
 */
async function recordEvent(prisma, businessProfileId, eventType, metadata = {}) {
  return prisma.storefrontAnalyticsEvent.create({
    data: { businessProfileId, eventType, metadata },
  });
}


/**
 * Get storefront analytics for a business.
 * Returns aggregated metrics: total views, widget engagement, CTA clicks,
 * time-series data, and top-performing widgets.
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {object} [options] — { days, startDate, endDate }
 */
async function getAnalytics(prisma, businessProfileId, options = {}) {
  const days = options.days || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Fetch all events in the date range
  const events = await prisma.storefrontAnalyticsEvent.findMany({
    where: {
      businessProfileId,
      createdAt: { gte: startDate },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Aggregate by event type
  const byEventType = {};
  for (const ev of events) {
    byEventType[ev.eventType] = (byEventType[ev.eventType] || 0) + 1;
  }

  // Time series: group by day
  const timeSeries = {};
  for (const ev of events) {
    const day = ev.createdAt.toISOString().split('T')[0];
    if (!timeSeries[day]) timeSeries[day] = { views: 0, clicks: 0, interactions: 0 };
    if (ev.eventType === 'storefront_view' || ev.eventType === 'widget_view') {
      timeSeries[day].views++;
    } else if (ev.eventType === 'cta_click' || ev.eventType === 'product_tap') {
      timeSeries[day].clicks++;
    } else {
      timeSeries[day].interactions++;
    }
  }

  // Widget engagement: group by widgetType in metadata
  const widgetEngagement = {};
  for (const ev of events) {
    const widgetType = ev.metadata?.widgetType;
    if (!widgetType) continue;
    if (!widgetEngagement[widgetType]) {
      widgetEngagement[widgetType] = { views: 0, clicks: 0, taps: 0, total: 0 };
    }
    widgetEngagement[widgetType].total++;
    if (ev.eventType === 'widget_view') widgetEngagement[widgetType].views++;
    if (ev.eventType === 'cta_click') widgetEngagement[widgetType].clicks++;
    if (ev.eventType === 'product_tap') widgetEngagement[widgetType].taps++;
  }

  // CTA breakdown
  const ctaBreakdown = {};
  for (const ev of events) {
    if (ev.eventType === 'cta_click') {
      const action = ev.metadata?.action || 'unknown';
      ctaBreakdown[action] = (ctaBreakdown[action] || 0) + 1;
    }
  }

  // Traffic source breakdown (from metadata.referrer)
  const trafficSources = {};
  for (const ev of events) {
    if (ev.eventType === 'storefront_view') {
      const source = ev.metadata?.source || 'direct';
      trafficSources[source] = (trafficSources[source] || 0) + 1;
    }
  }

  // Unique visitors (approximate by distinct metadata.visitorId)
  const visitorIds = new Set();
  for (const ev of events) {
    if (ev.metadata?.visitorId) visitorIds.add(ev.metadata.visitorId);
  }

  // Order stats: count orders placed from the storefront in the date range
  const orderStats = { totalOrders: 0, totalOrderValue: 0, pendingOrders: 0 };
  try {
    const orders = await prisma.businessOrder.findMany({
      where: {
        businessProfileId,
        createdAt: { gte: startDate },
      },
      select: { id: true, status: true, amountUsdc: true },
    });
    orderStats.totalOrders = orders.length;
    orderStats.totalOrderValue = orders.reduce((sum, o) => sum + (parseFloat(o.amountUsdc) || 0), 0);
    orderStats.pendingOrders = orders.filter(o => o.status === 'AWAITING_PAYMENT').length;
  } catch (_) { /* order stats are best-effort */ }

  return {
    summary: {
      totalEvents: events.length,
      totalViews: byEventType.storefront_view || 0,
      totalWidgetViews: byEventType.widget_view || 0,
      totalCTAClicks: byEventType.cta_click || 0,
      totalProductTaps: byEventType.product_tap || 0,
      uniqueVisitors: visitorIds.size,
      avgCTR: byEventType.storefront_view > 0
        ? ((byEventType.cta_click || 0) / byEventType.storefront_view * 100).toFixed(1)
        : '0',
    },
    byEventType,
    timeSeries: Object.entries(timeSeries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data })),
    widgetEngagement: Object.entries(widgetEngagement)
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([widgetType, data]) => ({ widgetType, ...data })),
    ctaBreakdown,
    trafficSources,
    orderStats,
  };
}

module.exports = {
  generateDefaultLayout,
  getOrCreateDraft,
  getPublishedLayout,
  saveDraft,
  publishLayout,
  getHistory,
  revertToVersion,
  applyTemplate,
  listThemes,
  listWidgets,
  listTemplates,
  checkEligibility,
  recordEvent,
  getAnalytics,
  preserveExperienceSnapshot,
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — Nitro Economy: Tier Validation & Enforcement
// ─────────────────────────────────────────────────────────────────────────────

// Tier thresholds (must match azmStakeService.TIER_THRESHOLDS)
const NITRO_THRESHOLDS = {
  NITRO_BRONZE: 500,
  NITRO_SILVER: 1500,
  NITRO_GOLD: 5000,
};

// Widget type → minimum tier required
const PREMIUM_WIDGETS = {
  // NITRO_BRONZE
  video_player:      'NITRO_BRONZE',
  promo_banner:      'NITRO_BRONZE',
  social_feed:       'NITRO_BRONZE',
  // NITRO_SILVER
  live_stats:        'NITRO_SILVER',
  animated_counter:  'NITRO_SILVER',
  // NITRO_GOLD
  custom_html:       'NITRO_GOLD',
  gradient_hero:     'NITRO_GOLD',
  // Legacy aliases (backward-compat with older layouts)
  video_header:      'NITRO_BRONZE',
  announcement_bar:  'NITRO_BRONZE',
  social_proof:      'NITRO_BRONZE',
  live_rate_ticker:  'NITRO_SILVER',
  glass_card:        'NITRO_SILVER',
  custom_embed:      'NITRO_GOLD',
  loyalty_program:   'NITRO_GOLD',
};

// Theme key → minimum tier required
const PREMIUM_THEMES = {
  ember:   'NITRO_BRONZE',
  forest:  'NITRO_BRONZE',
  neon:    'NITRO_SILVER',
  glass:   'NITRO_SILVER',
  royal:   'NITRO_GOLD',
};

const TIER_RANK = { FREE: 0, NITRO_BRONZE: 1, NITRO_SILVER: 2, NITRO_GOLD: 3 };

/**
 * Get the tier for a given staked AZM balance.
 * @param {number} stakedBalance
 * @returns {string} tier name
 */
function getTierForStake(stakedBalance) {
  if (stakedBalance >= NITRO_THRESHOLDS.NITRO_GOLD) return 'NITRO_GOLD';
  if (stakedBalance >= NITRO_THRESHOLDS.NITRO_SILVER) return 'NITRO_SILVER';
  if (stakedBalance >= NITRO_THRESHOLDS.NITRO_BRONZE) return 'NITRO_BRONZE';
  return 'FREE';
}

/**
 * Validate that a layout does not reference premium widgets or themes
 * the owner hasn't staked for.
 *
 * @param {object} prisma
 * @param {string} businessProfileId
 * @param {object} layoutJson - the layout JSON to validate
 * @param {string} themeKey - the theme key to validate
 * @returns {{ eligible: boolean, violations: array, tier: string, stakedBalance: number }}
 */
async function validateNitroEligibility(prisma, businessProfileId, layoutJson, themeKey) {
  // Get the business owner's user ID
  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { userId: true },
  });
  if (!business) throw new Error('Business not found.');

  // Get staked balance
  const stakes = await prisma.azmStake.findMany({
    where: { userId: business.userId, status: 'ACTIVE' },
  });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
  const tier = getTierForStake(stakedBalance);

  const violations = [];

  // Check theme
  if (themeKey && PREMIUM_THEMES[themeKey]) {
    const requiredTier = PREMIUM_THEMES[themeKey];
    if (TIER_RANK[tier] < TIER_RANK[requiredTier]) {
      violations.push({
        type: 'theme',
        key: themeKey,
        requiredTier,
        currentTier: tier,
        shortage: NITRO_THRESHOLDS[requiredTier] - stakedBalance,
      });
    }
  }

  // Check widgets in layout
  if (layoutJson && Array.isArray(layoutJson.tiles)) {
    for (const tile of layoutJson.tiles) {
      const widgetType = tile.widgetType || tile.type;
      if (widgetType && PREMIUM_WIDGETS[widgetType]) {
        const requiredTier = PREMIUM_WIDGETS[widgetType];
        if (TIER_RANK[tier] < TIER_RANK[requiredTier]) {
          violations.push({
            type: 'widget',
            key: widgetType,
            tileId: tile.id || tile.position,
            requiredTier,
            currentTier: tier,
            shortage: NITRO_THRESHOLDS[requiredTier] - stakedBalance,
          });
        }
      }
    }
  }

  return {
    eligible: violations.length === 0,
    violations,
    tier,
    stakedBalance,
  };
}

/**
 * Downgrade premium widgets in a layout to free equivalents.
 * Called by the render service when a stake has lapsed post-publish.
 *
 * @param {object} layoutJson
 * @returns {{ layoutJson: object, downgraded: array }}
 */
function downgradePremiumWidgets(layoutJson) {
  if (!layoutJson || !Array.isArray(layoutJson.tiles)) return { layoutJson, downgraded: [] };

  const downgraded = [];
  const FREE_REPLACEMENTS = {
    // Canonical (Flutter) names
    video_player: 'hero_header',
    promo_banner: 'hero_header',
    social_feed: 'review_carousel',
    live_stats: 'quick_info_bar',
    animated_counter: 'product_grid',
    custom_html: 'contact_card',
    gradient_hero: 'hero_header',
    // Legacy aliases
    video_header: 'hero_header',
    announcement_bar: 'hero_header',
    social_proof: 'review_carousel',
    live_rate_ticker: 'quick_info_bar',
    glass_card: 'product_grid',
    custom_embed: 'contact_card',
    loyalty_program: 'hero_header',
  };

  const newTiles = layoutJson.tiles.map((tile) => {
    const widgetType = tile.widgetType || tile.type;
    if (widgetType && PREMIUM_WIDGETS[widgetType] && FREE_REPLACEMENTS[widgetType]) {
      downgraded.push({ from: widgetType, to: FREE_REPLACEMENTS[widgetType], tileId: tile.id });
      return { ...tile, widgetType: FREE_REPLACEMENTS[widgetType], type: FREE_REPLACEMENTS[widgetType] };
    }
    return tile;
  });

  return { layoutJson: { ...layoutJson, tiles: newTiles }, downgraded };
}

module.exports.PREMIUM_WIDGETS = PREMIUM_WIDGETS;
module.exports.PREMIUM_THEMES = PREMIUM_THEMES;
module.exports.NITRO_THRESHOLDS = NITRO_THRESHOLDS;
module.exports.TIER_RANK = TIER_RANK;
module.exports.getTierForStake = getTierForStake;
module.exports.validateNitroEligibility = validateNitroEligibility;
module.exports.downgradePremiumWidgets = downgradePremiumWidgets;
