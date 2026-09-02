'use strict';

// =============================================================================
// AZAMAN — Storefront SDUI Service
// =============================================================================

const logger = require('../src/config/logger');
const { migrateLayout, generateEmptyLayout } = require('./storefrontSchemaMigration');
const { preserveDraftExperience } = require('./storefrontDraftExperienceGuard');

// Backward-compatible alias for callers that imported the old helper name.
const preserveExperienceSnapshot = preserveDraftExperience;

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
    tiles.push({ id: `tile_${Math.random().toString().substring(2, 10)}`, widgetType: 'action_buttons', position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 }, props: { showOrder: false, showBook: true, showFollow: true, showShare: true } });
  } else {
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'product_grid', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Featured Products', maxItems: 6, columns: 2, showPrice: true } });
    tiles.push({ id: `tile_${Math.random().toString(36).substring(2, 10)}`, widgetType: 'contact_card', position: { row: 6, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: false } });
  }
  return { schemaVersion: 1, gridColumns: 4, tiles };
}

async function getOrCreateDraft(prisma, businessProfileId, category) {
  let draft = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } }, include: { theme: true } });
  if (!draft) {
    const themeToUse = await prisma.businessStorefrontTheme.findFirst({ where: { key: 'classic_light', isActive: true } }) || await prisma.businessStorefrontTheme.findFirst({ where: { isActive: true }, orderBy: { displayOrder: 'asc' } });
    if (!themeToUse) throw new Error('No active themes found. Run: node scripts/seed-storefront-catalog.js');
    const layoutJson = generateDefaultLayout(businessProfileId, category);
    draft = await prisma.businessStorefrontLayout.create({ data: { businessProfileId, status: 'DRAFT', themeId: themeToUse.id, layoutJson }, include: { theme: true } });
  }
  return draft;
}

async function getPublishedLayout(prisma, businessProfileId) {
  return prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } }, include: { theme: true } });
}

async function saveDraft(prisma, businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  const existingDraft = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } } });
  if (expectedUpdatedAt && existingDraft && existingDraft.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new Error('Draft was modified by another editor. Please refresh.');
  }

  // The Experience Blueprint lives inside the draft layout. A generic layout
  // editor is never allowed to erase it merely because an older client omitted
  // the field; explicit values, including null, remain intentional.
  const safeLayoutJson = preserveDraftExperience(layoutJson, existingDraft?.layoutJson);
  const migratedLayout = migrateLayout(safeLayoutJson);

  return prisma.businessStorefrontLayout.upsert({
    where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    create: { businessProfileId, status: 'DRAFT', themeId, layoutJson: migratedLayout },
    update: { themeId, layoutJson: migratedLayout },
    include: { theme: true },
  });
}

async function publishLayout(prisma, businessProfileId, userId) {
  const draft = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } }, include: { theme: true } });
  if (!draft) throw new Error('No draft layout to publish.');
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { storefrontDisabled: true } });
  if (business?.storefrontDisabled) throw new Error('Storefront is disabled by admin. Contact support.');
  const themeKey = draft.theme?.key || null;
  const eligibility = await validateNitroEligibility(prisma, businessProfileId, draft.layoutJson, themeKey);
  if (!eligibility.eligible) {
    const err = new Error('Nitro eligibility check failed. Premium features require more staked AZM.');
    err.statusCode = 402; err.violations = eligibility.violations; err.tier = eligibility.tier; err.stakedBalance = eligibility.stakedBalance; throw err;
  }
  const currentPublished = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } } });
  if (currentPublished) {
    const maxVersion = await prisma.businessStorefrontLayoutVersion.aggregate({ where: { businessProfileId }, _max: { version: true } });
    await prisma.businessStorefrontLayoutVersion.create({ data: { businessProfileId, version: (maxVersion._max.version || 0) + 1, themeId: currentPublished.themeId, layoutJson: currentPublished.layoutJson, publishedAt: currentPublished.publishedAt, publishedBy: currentPublished.publishedBy } });
    await prisma.businessStorefrontLayout.delete({ where: { id: currentPublished.id } });
  }
  const published = await prisma.businessStorefrontLayout.create({ data: { businessProfileId, status: 'PUBLISHED', themeId: draft.themeId, layoutJson: draft.layoutJson, publishedAt: new Date(), publishedBy: userId }, include: { theme: true } });
  const maxVersion2 = await prisma.businessStorefrontLayoutVersion.aggregate({ where: { businessProfileId }, _max: { version: true } });
  await prisma.businessStorefrontLayoutVersion.create({ data: { businessProfileId, version: (maxVersion2._max.version || 0) + 1, themeId: draft.themeId, layoutJson: draft.layoutJson, publishedAt: published.publishedAt, publishedBy: userId } });
  await prisma.businessStorefrontLayout.delete({ where: { id: draft.id } });
  return published;
}

async function getHistory(prisma, businessProfileId, limit = 20) {
  return prisma.businessStorefrontLayoutVersion.findMany({ where: { businessProfileId }, orderBy: { version: 'desc' }, take: Math.min(limit, 100), include: { theme: true } });
}

async function revertToVersion(prisma, businessProfileId, versionId) {
  const version = await prisma.businessStorefrontLayoutVersion.findUnique({ where: { id: versionId } });
  if (!version || version.businessProfileId !== businessProfileId) throw new Error('Version not found.');
  const migratedLayout = migrateLayout(version.layoutJson);
  const existingDraft = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } } });
  if (existingDraft) return prisma.businessStorefrontLayout.update({ where: { id: existingDraft.id }, data: { themeId: version.themeId, layoutJson: preserveExperienceSnapshot(migratedLayout, existingDraft.layoutJson) }, include: { theme: true } });
  return prisma.businessStorefrontLayout.create({ data: { businessProfileId, status: 'DRAFT', themeId: version.themeId, layoutJson: migratedLayout }, include: { theme: true } });
}

async function applyTemplate(prisma, businessProfileId, templateId) {
  const template = await prisma.businessStorefrontLayoutTemplate.findUnique({ where: { id: templateId } });
  if (!template || !template.isActive) throw new Error('Template not found or inactive.');
  const migratedLayout = migrateLayout(template.layoutJson);
  if (!template.themeId) throw new Error('Template has no theme assigned.');
  const existingDraft = await prisma.businessStorefrontLayout.findUnique({ where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } } });
  if (existingDraft) return prisma.businessStorefrontLayout.update({ where: { id: existingDraft.id }, data: { themeId: template.themeId, layoutJson: preserveExperienceSnapshot(migratedLayout, existingDraft.layoutJson) }, include: { theme: true } });
  return prisma.businessStorefrontLayout.create({ data: { businessProfileId, status: 'DRAFT', themeId: template.themeId, layoutJson: migratedLayout }, include: { theme: true } });
}

async function listThemes(prisma, category) { const where = { isActive: true }; if (category) where.category = category; return prisma.businessStorefrontTheme.findMany({ where, orderBy: { displayOrder: 'asc' } }); }
async function listWidgets(prisma, category) { const where = { isActive: true }; if (category) where.category = category; return prisma.businessStorefrontWidgetCatalog.findMany({ where, orderBy: { displayOrder: 'asc' } }); }
async function listTemplates(prisma, category) { const where = { isActive: true }; if (category) where.category = category; return prisma.businessStorefrontLayoutTemplate.findMany({ where, orderBy: { displayOrder: 'asc' }, include: { theme: true } }); }
async function checkEligibility(prisma, businessProfileId, userId) {
  const stakes = await prisma.azmStake.findMany({ where: { userId, status: 'ACTIVE' } });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { storefrontDisabled: true } });
  let tier = 'FREE'; if (stakedBalance >= 5000) tier = 'NITRO_GOLD'; else if (stakedBalance >= 1500) tier = 'NITRO_SILVER'; else if (stakedBalance >= 500) tier = 'NITRO_BRONZE';
  return { stakedBalance, tier, storefrontDisabled: business?.storefrontDisabled || false };
}
async function recordEvent(prisma, businessProfileId, eventType, metadata = {}) { return prisma.storefrontAnalyticsEvent.create({ data: { businessProfileId, eventType, metadata } }); }
async function getAnalytics(prisma, businessProfileId, options = {}) {
  const days = options.days || 30; const startDate = new Date(); startDate.setDate(startDate.getDate() - days);
  const events = await prisma.storefrontAnalyticsEvent.findMany({ where: { businessProfileId, createdAt: { gte: startDate } }, orderBy: { createdAt: 'desc' } });
  const byEventType = {}; for (const ev of events) byEventType[ev.eventType] = (byEventType[ev.eventType] || 0) + 1;
  const timeSeries = {}; for (const ev of events) { const day = ev.createdAt.toISOString().split('T')[0]; if (!timeSeries[day]) timeSeries[day] = { views: 0, clicks: 0, interactions: 0 }; if (ev.eventType === 'storefront_view' || ev.eventType === 'widget_view') timeSeries[day].views++; else if (ev.eventType === 'cta_click' || ev.eventType === 'product_tap') timeSeries[day].clicks++; else timeSeries[day].interactions++; }
  const widgetEngagement = {}; for (const ev of events) { const widgetType = ev.metadata?.widgetType; if (!widgetType) continue; if (!widgetEngagement[widgetType]) widgetEngagement[widgetType] = { views: 0, clicks: 0, taps: 0, total: 0 }; widgetEngagement[widgetType].total++; if (ev.eventType === 'widget_view') widgetEngagement[widgetType].views++; if (ev.eventType === 'cta_click') widgetEngagement[widgetType].clicks++; if (ev.eventType === 'product_tap') widgetEngagement[widgetType].taps++; }
  const ctaBreakdown = {}; for (const ev of events) if (ev.eventType === 'cta_click') { const action = ev.metadata?.action || 'unknown'; ctaBreakdown[action] = (ctaBreakdown[action] || 0) + 1; }
  const trafficSources = {}; for (const ev of events) if (ev.eventType === 'storefront_view') { const source = ev.metadata?.source || 'direct'; trafficSources[source] = (trafficSources[source] || 0) + 1; }
  const visitorIds = new Set(); for (const ev of events) if (ev.metadata?.visitorId) visitorIds.add(ev.metadata.visitorId);
  const orderStats = { totalOrders: 0, totalOrderValue: 0, pendingOrders: 0 }; try { const orders = await prisma.businessOrder.findMany({ where: { businessProfileId, createdAt: { gte: startDate } }, select: { id: true, status: true, amountUsdc: true } }); orderStats.totalOrders = orders.length; orderStats.totalOrderValue = orders.reduce((sum, o) => sum + (parseFloat(o.amountUsdc) || 0), 0); orderStats.pendingOrders = orders.filter(o => o.status === 'AWAITING_PAYMENT').length; } catch (_) {}
  return { summary: { totalEvents: events.length, totalViews: byEventType.storefront_view || 0, totalWidgetViews: byEventType.widget_view || 0, totalCTAClicks: byEventType.cta_click || 0, totalProductTaps: byEventType.product_tap || 0, uniqueVisitors: visitorIds.size, avgCTR: byEventType.storefront_view > 0 ? ((byEventType.cta_click || 0) / byEventType.storefront_view * 100).toFixed(1) : '0' }, byEventType, timeSeries: Object.entries(timeSeries).sort(([a], [b]) => a.localeCompare(b)).map(([date, data]) => ({ date, ...data })), widgetEngagement: Object.entries(widgetEngagement).sort(([, a], [, b]) => b.total - a.total).map(([widgetType, data]) => ({ widgetType, ...data })), ctaBreakdown, trafficSources, orderStats };
}

module.exports = { generateDefaultLayout, getOrCreateDraft, getPublishedLayout, saveDraft, publishLayout, getHistory, revertToVersion, applyTemplate, listThemes, listWidgets, listTemplates, checkEligibility, recordEvent, getAnalytics, preserveExperienceSnapshot };

const NITRO_THRESHOLDS = { NITRO_BRONZE: 500, NITRO_SILVER: 1500, NITRO_GOLD: 5000 };
const PREMIUM_WIDGETS = { video_player: 'NITRO_BRONZE', promo_banner: 'NITRO_BRONZE', social_feed: 'NITRO_BRONZE', live_stats: 'NITRO_SILVER', animated_counter: 'NITRO_SILVER', custom_html: 'NITRO_GOLD', gradient_hero: 'NITRO_GOLD', video_header: 'NITRO_BRONZE', announcement_bar: 'NITRO_BRONZE', social_proof: 'NITRO_BRONZE', live_rate_ticker: 'NITRO_SILVER', glass_card: 'NITRO_SILVER', custom_embed: 'NITRO_GOLD', loyalty_program: 'NITRO_GOLD' };
const PREMIUM_THEMES = { ember: 'NITRO_BRONZE', forest: 'NITRO_BRONZE', neon: 'NITRO_SILVER', glass: 'NITRO_SILVER', royal: 'NITRO_GOLD' };
const TIER_RANK = { FREE: 0, NITRO_BRONZE: 1, NITRO_SILVER: 2, NITRO_GOLD: 3 };
function getTierForStake(stakedBalance) { if (stakedBalance >= NITRO_THRESHOLDS.NITRO_GOLD) return 'NITRO_GOLD'; if (stakedBalance >= NITRO_THRESHOLDS.NITRO_SILVER) return 'NITRO_SILVER'; if (stakedBalance >= NITRO_THRESHOLDS.NITRO_BRONZE) return 'NITRO_BRONZE'; return 'FREE'; }
async function validateNitroEligibility(prisma, businessProfileId, layoutJson, themeKey) {
  const business = await prisma.businessProfile.findUnique({ where: { id: businessProfileId }, select: { userId: true } });
  if (!business) throw new Error('Business not found.');
  const stakes = await prisma.azmStake.findMany({ where: { userId: business.userId, status: 'ACTIVE' } });
  const stakedBalance = stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0); const tier = getTierForStake(stakedBalance); const violations = [];
  if (themeKey && PREMIUM_THEMES[themeKey] && TIER_RANK[tier] < TIER_RANK[PREMIUM_THEMES[themeKey]]) violations.push({ type: 'theme', key: themeKey, requiredTier: PREMIUM_THEMES[themeKey], currentTier: tier, shortage: NITRO_THRESHOLDS[PREMIUM_THEMES[themeKey]] - stakedBalance });
  if (layoutJson && Array.isArray(layoutJson.tiles)) for (const tile of layoutJson.tiles) { const widgetType = tile.widgetType || tile.type; if (widgetType && PREMIUM_WIDGETS[widgetType] && TIER_RANK[tier] < TIER_RANK[PREMIUM_WIDGETS[widgetType]]) violations.push({ type: 'widget', key: widgetType, tileId: tile.id || tile.position, requiredTier: PREMIUM_WIDGETS[widgetType], currentTier: tier, shortage: NITRO_THRESHOLDS[PREMIUM_WIDGETS[widgetType]] - stakedBalance }); }
  return { eligible: violations.length === 0, violations, tier, stakedBalance };
}
function downgradePremiumWidgets(layoutJson) {
  if (!layoutJson || !Array.isArray(layoutJson.tiles)) return { layoutJson, downgraded: [] };
  const downgraded = []; const FREE_REPLACEMENTS = { video_player: 'hero_header', promo_banner: 'hero_header', social_feed: 'review_carousel', live_stats: 'quick_info_bar', animated_counter: 'product_grid', custom_html: 'contact_card', gradient_hero: 'hero_header', video_header: 'hero_header', announcement_bar: 'hero_header', social_proof: 'review_carousel', live_rate_ticker: 'quick_info_bar', glass_card: 'product_grid', custom_embed: 'contact_card', loyalty_program: 'hero_header' };
  const newTiles = layoutJson.tiles.map((tile) => { const widgetType = tile.widgetType || tile.type; if (widgetType && PREMIUM_WIDGETS[widgetType] && FREE_REPLACEMENTS[widgetType]) { downgraded.push({ from: widgetType, to: FREE_REPLACEMENTS[widgetType], tileId: tile.id }); return { ...tile, widgetType: FREE_REPLACEMENTS[widgetType], type: FREE_REPLACEMENTS[widgetType] }; } return tile; });
  return { layoutJson: { ...layoutJson, tiles: newTiles }, downgraded };
}
module.exports.PREMIUM_WIDGETS = PREMIUM_WIDGETS;
module.exports.PREMIUM_THEMES = PREMIUM_THEMES;
module.exports.NITRO_THRESHOLDS = NITRO_THRESHOLDS;
module.exports.TIER_RANK = TIER_RANK;
module.exports.getTierForStake = getTierForStake;
module.exports.validateNitroEligibility = validateNitroEligibility;
module.exports.downgradePremiumWidgets = downgradePremiumWidgets;
