'use strict';

// =============================================================================
// AZAMAN — Storefront SDUI Service
//
// NOTE: `prisma` is passed as the first argument to every function.
// This matches the existing codebase pattern: services never import a
// prisma singleton. All callers get prisma via req.app.get('prisma').
// =============================================================================

const { migrateLayout, generateEmptyLayout } = require('./storefrontSchemaMigration');

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
    return prisma.businessStorefrontLayout.update({
      where: { id: existingDraft.id },
      data: { themeId: version.themeId, layoutJson: migratedLayout },
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
    return prisma.businessStorefrontLayout.update({
      where: { id: existingDraft.id },
      data: { themeId, layoutJson: migratedLayout },
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
  else if (stakedBalance >= 2000) tier = 'NITRO_SILVER';
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
};
