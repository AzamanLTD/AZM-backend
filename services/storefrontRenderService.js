'use strict';

// NOTE: prisma is passed as the first argument to render functions (req.app.get('prisma')).
const { migrateLayout } = require('./storefrontSchemaMigration');
const storefrontService = require('./storefrontService');

// Redis cache for rendered layouts (falls back to in-memory if Redis unavailable)
let redisClient = null;
const memoryCache = new Map();
const CACHE_TTL = 200; // seconds (200ms target for GET /render)

try {
  const Redis = require('ioredis');
  if (process.env.REDIS_URL) {
    const isTLS = process.env.REDIS_URL.startsWith('rediss://');
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      tls: isTLS ? { rejectUnauthorized: false } : undefined,
      lazyConnect: true,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    redisClient.on('error', (e) => console.warn('[StorefrontRender] Redis cache error:', e.message));
    redisClient.on('connect', () => console.log('[StorefrontRender] Redis cache connected'));
  }
} catch (e) {
  console.warn('[StorefrontRender] Redis not available, using in-memory cache');
}

function getCacheKey(businessProfileId) {
  return `storefront:render:${businessProfileId}`;
}

async function getCached(key) {
  if (redisClient && redisClient.status === 'connect') {
    try {
      const cached = await redisClient.get(key);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* fall through */ }
    return null;
  }
  const memItem = memoryCache.get(key);
  if (memItem && memItem.expiresAt > Date.now()) {
    return memItem.value;
  }
  memoryCache.delete(key);
  return null;
}

async function setCached(key, value, ttl) {
  if (redisClient && redisClient.status === 'connect') {
    try {
      await redisClient.setex(key, ttl, JSON.stringify(value));
    } catch (e) { /* fall through */ }
    return;
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  // Clean up expired entries periodically
  if (memoryCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of memoryCache) {
      if (v.expiresAt <= now) memoryCache.delete(k);
    }
  }
}

async function invalidateCache(businessProfileId) {
  const key = getCacheKey(businessProfileId);
  if (redisClient && redisClient.status === 'connect') {
    try { await redisClient.del(key); } catch (e) { /* ignore */ }
  }
  memoryCache.delete(key);
}

/**
 * Render a storefront layout for public consumption.
 * Returns a single JSON object with the layout, theme tokens, and widget catalog merged.
 */
async function renderStorefront(prisma, businessProfileId) {
  const cacheKey = getCacheKey(businessProfileId);
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const layout = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    include: { theme: true },
  });

  // Check if storefront is disabled
  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { 
      storefrontDisabled: true, 
      isSuspended: true, 
      businessName: true, 
      category: true, 
      logoUrl: true,
      coverPhotoUrl: true,
      averageRating: true,
      phoneNumber: true 
    },
  });

  if (!layout || !business || business.storefrontDisabled || business.isSuspended) {
    return null;
  }

  // Migrate layout to current schema version
  let migratedLayout = migrateLayout(layout.layoutJson);
  let themeOverride = null;

  // PHASE 8: Defensive stake check — if the owner's stake has lapsed
  // post-publish, downgrade premium widgets to free equivalents.
  const themeKey = layout.theme?.key || null;
  try {
    const eligibility = await storefrontService.validateNitroEligibility(prisma, businessProfileId, migratedLayout, themeKey);
    if (!eligibility.eligible) {
      const { layoutJson: downgradedLayout, downgraded } = storefrontService.downgradePremiumWidgets(migratedLayout);
      migratedLayout = downgradedLayout;
      // Also downgrade the theme to a free theme if needed
      if (eligibility.violations.some(v => v.type === 'theme')) {
        const freeTheme = await prisma.businessStorefrontTheme.findFirst({
          where: { key: 'classic_light', isActive: true },
        });
        if (freeTheme) {
          themeOverride = freeTheme;
        }
      }
      // Track the downgrade event
      await prisma.storefrontAnalyticsEvent.create({
        data: {
          businessProfileId,
          eventType: 'nitro_auto_downgrade',
          metadata: { downgraded, tier: eligibility.tier, stakedBalance: eligibility.stakedBalance },
        },
      }).catch(() => {});
    }
  } catch (e) {
    // Non-blocking: if stake check fails, render the layout as-is
    console.warn('[StorefrontRender] Stake check error:', e.message);
  }

  // Merge widget defaultProps into tile props
  const widgetTypes = [...new Set(migratedLayout.tiles.map(t => t.widgetType))];
  const widgets = await prisma.businessStorefrontWidgetCatalog.findMany({
    where: { widgetType: { in: widgetTypes } },
  });

  const widgetMap = new Map(widgets.map(w => [w.widgetType, w]));

  const tilesWithDefaults = migratedLayout.tiles.map(tile => {
    const widget = widgetMap.get(tile.widgetType);
    const defaultProps = widget?.defaultProps || {};
    return {
      ...tile,
      props: { ...defaultProps, ...tile.props },
    };
  });

  const result = {
    business: {
      name: business.businessName,
      category: business.category,
      logoUrl: business.logoUrl,
      coverPhotoUrl: business.coverPhotoUrl || null,
      averageRating: business.averageRating != null ? Number(business.averageRating) : null,
      phoneNumber: business.phoneNumber || null,
    },
    theme: themeOverride ? {
      id: themeOverride.id,
      key: themeOverride.key,
      name: themeOverride.name,
      tokenSet: themeOverride.tokenSet,
      typography: themeOverride.typography,
      borderRadius: themeOverride.borderRadius,
      spacingScale: themeOverride.spacingScale,
    } : {
      id: layout.theme.id,
      key: layout.theme.key,
      name: layout.theme.name,
      tokenSet: layout.theme.tokenSet,
      typography: layout.theme.typography,
      borderRadius: layout.theme.borderRadius,
      spacingScale: layout.theme.spacingScale,
    },
    layout: {
      schemaVersion: migratedLayout.schemaVersion,
      gridColumns: migratedLayout.gridColumns,
      tiles: tilesWithDefaults,
    },
    publishedAt: layout.publishedAt,
  };

  await setCached(cacheKey, result, CACHE_TTL);
  return result;
}

/**
 * Get public theme data for web ordering integration.
 */
async function getPublicTheme(prisma, businessProfileId) {
  const layout = await prisma.businessStorefrontLayout.findUnique({
    where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    include: { theme: true },
  });

  if (!layout) {
    const defaultTheme = await prisma.businessStorefrontTheme.findFirst({
      where: { key: 'classic_light', isActive: true },
    });
    return {
      accent: defaultTheme?.tokenSet?.accent || '#6C4FD1',
      themeName: defaultTheme?.name || 'Classic',
      hasPublishedLayout: false,
    };
  }

  return {
    accent: layout.theme.tokenSet?.accent || '#6C4FD1',
    themeName: layout.theme.name,
    hasPublishedLayout: true,
    layoutJson: layout.layoutJson,
  };
}

module.exports = {
  renderStorefront,
  getPublicTheme,
  invalidateCache,
};
