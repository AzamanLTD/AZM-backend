'use strict';

// NOTE: prisma is passed as the first argument to every function (req.app.get('prisma')).
// This matches the existing codebase pattern — services never import a prisma singleton.
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
 */
async function getOrCreateDraft(businessProfileId, category) {
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
      throw new Error('Default theme not found. Run seed scripts.');
    }

    const layoutJson = generateDefaultLayout(businessProfileId, category);
    draft = await prisma.businessStorefrontLayout.create({
      data: {
        businessProfileId,
        status: 'DRAFT',
        themeId: defaultTheme.id,
        layoutJson,
      },
      include: { theme: true },
    });
  }

  return draft;
}

/**
 * Get the published layout for a business.
 */
async function getPublishedLayout(businessProfileId) {
  return prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    include: { theme: true },
  });
}

/**
 * Save a draft layout.
 */
async function saveDraft(businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  // Check for concurrent edits
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
 * Publish a draft layout.
 */
async function publishLayout(businessProfileId, userId) {
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
    // Get the max version number
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

  // Also archive the new published version
  const maxVersion = await prisma.businessStorefrontLayoutVersion.aggregate({
    where: { businessProfileId },
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version || 0) + 1;

  await prisma.businessStorefrontLayoutVersion.create({
    data: {
      businessProfileId,
      version: nextVersion,
      themeId: draft.themeId,
      layoutJson: draft.layoutJson,
      publishedAt: published.publishedAt,
      publishedBy: userId,
    },
  });

  // Delete the draft
  await prisma.businessStorefrontLayout.delete({ where: { id: draft.id } });

  return published;
}

/**
 * Get version history for a business.
 */
async function getHistory(businessProfileId, limit = 20) {
  return prisma.businessStorefrontLayoutVersion.findMany({
    where: { businessProfileId },
    orderBy: { version: 'desc' },
    take: Math.min(limit, 100),
    include: { theme: true },
  });
}

/**
 * Revert to a specific version.
 */
async function revertToVersion(businessProfileId, versionId) {
  const version = await prisma.businessStorefrontLayoutVersion.findUnique({
    where: { id: versionId },
  });

  if (!version || version.businessProfileId !== businessProfileId) {
    throw new Error('Version not found.');
  }

  // Create or update a draft with the version's layout
  const existingDraft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
  });

  const migratedLayout = migrateLayout(version.layoutJson);

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
 */
async function applyTemplate(businessProfileId, templateId) {
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
 * List themes.
 */
async function listThemes(category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontTheme.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
  });
}

/**
 * List widgets.
 */
async function listWidgets(category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontWidgetCatalog.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
  });
}

/**
 * List templates.
 */
async function listTemplates(category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontLayoutTemplate.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
    include: { theme: true },
  });
}

/**
 * Check eligibility (staked AZM balance, tier, etc.)
 */
async function checkEligibility(businessProfileId, userId) {
  const stakes = await prisma.azmStake.findMany({
    where: { userId, status: 'ACTIVE' },
  });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);

  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { storefrontDisabled: true },
  });

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
 * Record an analytics event.
 */
async function recordEvent(businessProfileId, eventType, metadata) {
  return prisma.storefrontAnalyticsEvent.create({
    data: { businessProfileId, eventType, metadata },
  });
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
};
