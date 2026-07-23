'use strict';

// NOTE: prisma is passed as the FIRST argument to every function (req.app.get('prisma')).
// This matches the existing codebase DI pattern — services never import a prisma singleton.
const { migrateLayout } = require('./storefrontSchemaMigration');

function generateDefaultLayout(businessProfileId, category = 'UNIVERSAL') {
  const tiles = [];
  tiles.push({
    id: `tile_${Math.random().toString(36).substring(2, 10)}`,
    widgetType: 'hero_header',
    position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 },
    props: { mediaUrl: null, mediaType: 'image', title: null, subtitle: 'Welcome to our store', overlayOpacity: 0.3, height: 'standard' },
  });
  tiles.push({
    id: `tile_${Math.random().toString(36).substring(2, 10)}`,
    widgetType: 'quick_info_bar',
    position: { row: 2, col: 0, rowSpan: 1, colSpan: 4 },
    props: { showHours: true, showRating: true, showCategory: true, customInfo: '' },
  });
  if (category === 'RESTAURANT' || category === 'FOOD') {
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'product_grid', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Popular Dishes', maxItems: 6, columns: 2, showPrice: true } });
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'review_carousel', position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'What People Say', maxReviews: 5, minRating: 4 } });
  } else if (category === 'HOTEL' || category === 'LODGING') {
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'showcase_gallery', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Our Rooms', maxItems: 8, autoplay: false } });
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'location_map', position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'Find Us', zoom: 14 } });
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'action_buttons', position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 }, props: { showOrder: false, showBook: true, showFollow: true, showShare: true } });
  } else {
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'product_grid', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Featured Products', maxItems: 6, columns: 2, showPrice: true } });
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'contact_card', position: { row: 6, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: false } });
  }
  return { schemaVersion: 1, gridColumns: 4, tiles };
}

async function getOrCreateDraft(prisma, businessProfileId, category) {
  let draft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    include: { theme: true },
  });
  if (!draft) {
    let defaultTheme = await prisma.businessStorefrontTheme.findFirst({ where: { key: 'classic_light', isActive: true } });
    if (!defaultTheme) defaultTheme = await prisma.businessStorefrontTheme.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!defaultTheme) throw new Error('No active themes found. Run: npm run seed:storefront');
    const layoutJson = generateDefaultLayout(businessProfileId, category);
    draft = await prisma.businessStorefrontLayout.create({
      data: { businessProfileId, status: 'DRAFT', themeId: defaultTheme.id, layoutJson },
      include: { theme: true },
    });
  }
  return draft;
}

async function getPublishedLayout(prisma, businessProfileId) {
  return prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    include: { theme: true },
  });
}

async function saveDraft(prisma, businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  if (expectedUpdatedAt) {
    const existing = await prisma.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    });
    if (existing && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new Error('Draft was modified by another editor. Please refresh.');
    }
  }
  const migratedLayout = migrateLayout(layoutJson);
  return prisma.businessStorefrontLayout.upsert({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    create: { businessProfileId, status: 'DRAFT', themeId, layoutJson: migratedLayout },
    update: { themeId, layoutJson: migratedLayout },
    include: { theme: true },
  });
}

async function publishLayout(prisma, businessProfileId, userId) {
  const draft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    include: { theme: true },
  });
  if (!draft) throw new Error('No draft layout to publish.');

  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { storefrontDisabled: true } });
  if (business?.storefrontDisabled) throw new Error('Storefront is disabled by admin. Contact support.');

  const currentPublished = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
  });
  if (currentPublished) {
    const maxV = await prisma.businessStorefrontLayoutVersion.aggregate({ where: { businessProfileId }, _max: { version: true } });
    await prisma.businessStorefrontLayoutVersion.create({
      data: { businessProfileId, version: (maxV._max.version || 0) + 1, themeId: currentPublished.themeId, layoutJson: currentPublished.layoutJson, publishedAt: currentPublished.publishedAt, publishedBy: currentPublished.publishedBy },
    });
    await prisma.businessStorefrontLayout.delete({ where: { id: currentPublished.id } });
  }

  const published = await prisma.businessStorefrontLayout.create({
    data: { businessProfileId, status: 'PUBLISHED', themeId: draft.themeId, layoutJson: draft.layoutJson, publishedAt: new Date(), publishedBy: userId },
    include: { theme: true },
  });

  const maxV2 = await prisma.businessStorefrontLayoutVersion.aggregate({ where: { businessProfileId }, _max: { version: true } });
  await prisma.businessStorefrontLayoutVersion.create({
    data: { businessProfileId, version: (maxV2._max.version || 0) + 1, themeId: draft.themeId, layoutJson: draft.layoutJson, publishedAt: published.publishedAt, publishedBy: userId },
  });
  await prisma.businessStorefrontLayout.delete({ where: { id: draft.id } });
  return published;
}

async function getHistory(prisma, businessProfileId, limit = 20) {
  return prisma.businessStorefrontLayoutVersion.findMany({
    where: { businessProfileId },
    orderBy: { version: 'desc' },
    take: Math.min(limit, 100),
    include: { theme: true },
  });
}

async function revertToVersion(prisma, businessProfileId, versionId) {
  const version = await prisma.businessStorefrontLayoutVersion.findUnique({ where: { id: versionId } });
  if (!version || version.businessProfileId !== businessProfileId) throw new Error('Version not found.');
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
    data: { businessProfileId, status: 'DRAFT', themeId: version.themeId, layoutJson: migratedLayout },
    include: { theme: true },
  });
}

async function applyTemplate(prisma, businessProfileId, templateId) {
  const template = await prisma.businessStorefrontLayoutTemplate.findUnique({ where: { id: templateId } });
  if (!template || !template.isActive) throw new Error('Template not found or inactive.');
  if (!template.themeId) throw new Error('Template has no theme assigned.');
  const migratedLayout = migrateLayout(template.layoutJson);
  const existingDraft = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
  });
  if (existingDraft) {
    return prisma.businessStorefrontLayout.update({
      where: { id: existingDraft.id },
      data: { themeId: template.themeId, layoutJson: migratedLayout },
      include: { theme: true },
    });
  }
  return prisma.businessStorefrontLayout.create({
    data: { businessProfileId, status: 'DRAFT', themeId: template.themeId, layoutJson: migratedLayout },
    include: { theme: true },
  });
}

async function listThemes(prisma, category) {
  const where = { isActive: true };
  if (category) where.applicableCategories = { has: category };
  return prisma.businessStorefrontTheme.findMany({ where, orderBy: [{ minAzmStake: 'asc' }, { name: 'asc' }] });
}

async function listWidgets(prisma, category) {
  const where = { isActive: true };
  if (category) where.category = category;
  return prisma.businessStorefrontWidgetCatalog.findMany({ where, orderBy: [{ category: 'asc' }, { displayName: 'asc' }] });
}

async function listTemplates(prisma, category) {
  const where = { isActive: true };
  if (category) where.targetCategory = category;
  return prisma.businessStorefrontLayoutTemplate.findMany({ where, include: { theme: true }, orderBy: { name: 'asc' } });
}

async function checkEligibility(prisma, businessProfileId, userId) {
  const stakes = await prisma.azmStake.findMany({ where: { userId, status: 'ACTIVE' } });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { storefrontDisabled: true } });
  let tier = 'FREE';
  if (stakedBalance >= 5000) tier = 'NITRO_GOLD';
  else if (stakedBalance >= 2000) tier = 'NITRO_SILVER';
  else if (stakedBalance >= 500) tier = 'NITRO_BRONZE';
  return { stakedBalance, tier, storefrontDisabled: business?.storefrontDisabled || false };
}

async function recordEvent(prisma, businessProfileId, eventType, metadata) {
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
