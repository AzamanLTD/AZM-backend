'use strict';

// ── Phase 9: Storefront E2E API Tests ────────────────────────────────────────
// Tests the full storefront lifecycle: themes, render, draft, publish, staking.
// Uses unit-level mocks (no live DB / no Supertest HTTP needed).

const storefrontService = require('../services/storefrontService');

// ── Mock prisma ──
const mockPrisma = {
  businessProfile: { findUnique: jest.fn() },
  azmStake: { findMany: jest.fn() },
  businessStorefrontTheme: { findFirst: jest.fn() },
  businessStorefrontLayout: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  businessStorefrontLayoutVersion: {
    aggregate: jest.fn(),
    create: jest.fn(),
  },
  businessStorefrontWidgetCatalog: { findMany: jest.fn() },
  storefrontAnalyticsEvent: { create: jest.fn().mockResolvedValue({}) },
};

// ── Helpers ──
function makeBusiness(id = 'biz-1', userId = 'user-1', overrides = {}) {
  return {
    id, userId,
    storefrontDisabled: false,
    isSuspended: false,
    businessName: 'Test Biz',
    category: 'Retail',
    logoUrl: null,
    coverPhotoUrl: null,
    averageRating: 4.5,
    phoneNumber: '+233123456789',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.businessProfile.findUnique.mockResolvedValue(makeBusiness());
  mockPrisma.azmStake.findMany.mockResolvedValue([]);
  mockPrisma.businessStorefrontTheme.findFirst.mockResolvedValue({
    id: 'theme-1', key: 'classic_light', name: 'Classic',
    tokenSet: { accent: '#6C4FD1' }, typography: {}, borderRadius: 8, spacingScale: 1,
  });
  mockPrisma.storefrontAnalyticsEvent.create.mockResolvedValue({});
});

// ── Tests ──

describe('Storefront E2E — Themes & Catalog', () => {
  test('service exposes listThemes', () => {
    expect(typeof storefrontService.listThemes).toBe('function');
  });
  test('service exposes listWidgets', () => {
    expect(typeof storefrontService.listWidgets).toBe('function');
  });
});

describe('Storefront E2E — Render', () => {
  test('renderService exports renderStorefront', () => {
    const renderService = require('../services/storefrontRenderService');
    expect(typeof renderService.renderStorefront).toBe('function');
  });
  test('renderService exports invalidateCache', () => {
    const renderService = require('../services/storefrontRenderService');
    expect(typeof renderService.invalidateCache).toBe('function');
  });
  test('downgradePremiumWidgets downgrades premium widget to free', () => {
    const layout = {
      tiles: [
        { id: 't1', widgetType: 'video_player', props: {} },
        { id: 't2', widgetType: 'hero_header', props: {} },
      ],
    };
    const result = storefrontService.downgradePremiumWidgets(layout);
    expect(result.downgraded).toHaveLength(1);
    expect(result.downgraded[0].from).toBe('video_player');
    expect(result.layoutJson.tiles[0].widgetType).toBe('hero_header');
    expect(result.layoutJson.tiles[1].widgetType).toBe('hero_header');
  });
});

describe('Storefront E2E — Draft & Publish', () => {
  test('service exposes saveDraft', () => {
    expect(typeof storefrontService.saveDraft).toBe('function');
  });
  test('service exposes publishLayout', () => {
    expect(typeof storefrontService.publishLayout).toBe('function');
  });

  test('publish validation rejects with FREE tier + premium widget', async () => {
    mockPrisma.azmStake.findMany.mockResolvedValue([]); // 0 staked = FREE
    const result = await storefrontService.validateNitroEligibility(
      mockPrisma, 'biz-1', { tiles: [{ id: 't1', widgetType: 'video_player' }] }, null
    );
    expect(result.eligible).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].key).toBe('video_player');
    expect(result.violations[0].requiredTier).toBe('NITRO_BRONZE');
    expect(result.tier).toBe('FREE');
    expect(result.stakedBalance).toBe(0);
  });

  test('publish validation allows BRONZE tier + bronze widget', async () => {
    mockPrisma.azmStake.findMany.mockResolvedValue([{ amountAzm: 600, status: 'ACTIVE' }]);
    const result = await storefrontService.validateNitroEligibility(
      mockPrisma, 'biz-1', { tiles: [{ id: 't1', widgetType: 'video_player' }] }, null
    );
    expect(result.eligible).toBe(true);
    expect(result.tier).toBe('NITRO_BRONZE');
  });

  test('publish validation rejects premium theme on FREE tier', async () => {
    mockPrisma.azmStake.findMany.mockResolvedValue([]);
    const result = await storefrontService.validateNitroEligibility(
      mockPrisma, 'biz-1', { tiles: [] }, 'neon'
    );
    expect(result.eligible).toBe(false);
    expect(result.violations[0].type).toBe('theme');
    expect(result.violations[0].requiredTier).toBe('NITRO_SILVER');
  });

  test('service exposes getHistory and revertToVersion', () => {
    expect(typeof storefrontService.getHistory).toBe('function');
    expect(typeof storefrontService.revertToVersion).toBe('function');
  });
});

describe('Storefront E2E — AZM Staking', () => {
  test('azmStakeService exposes createStake', () => {
    const azmStakeService = require('../services/azmStakeService');
    expect(typeof azmStakeService.createStake).toBe('function');
  });
  test('azmStakeService exposes requestUnstake', () => {
    const azmStakeService = require('../services/azmStakeService');
    expect(typeof azmStakeService.requestUnstake).toBe('function');
  });
  test('azmStakeService exposes processUnstakeQueue', () => {
    const azmStakeService = require('../services/azmStakeService');
    expect(typeof azmStakeService.processUnstakeQueue).toBe('function');
  });
});

describe('Storefront E2E — Worker Auto-Downgrade', () => {
  test('worker exports autoDowngradeLapsedStakes', () => {
    const worker = require('../workers/storefrontStakeWorker');
    expect(typeof worker.autoDowngradeLapsedStakes).toBe('function');
  });
  test('downgradePremiumWidgets handles null layout', () => {
    const result = storefrontService.downgradePremiumWidgets(null);
    expect(result.layoutJson).toBeNull();
    expect(result.downgraded).toEqual([]);
  });
  test('downgradePremiumWidgets handles layout with no tiles', () => {
    const result = storefrontService.downgradePremiumWidgets({ gridColumns: 12 });
    expect(result.downgraded).toEqual([]);
  });
  test('downgradePremiumWidgets downgrades all premium widgets at once', () => {
    const layout = {
      tiles: [
        { id: 't1', widgetType: 'video_player' },
        { id: 't2', widgetType: 'live_stats' },
        { id: 't3', widgetType: 'custom_html' },
        { id: 't4', widgetType: 'hero_header' },
      ],
    };
    const result = storefrontService.downgradePremiumWidgets(layout);
    expect(result.downgraded).toHaveLength(3);
    expect(result.layoutJson.tiles[0].widgetType).not.toBe('video_player');
    expect(result.layoutJson.tiles[1].widgetType).not.toBe('live_stats');
    expect(result.layoutJson.tiles[2].widgetType).not.toBe('custom_html');
    expect(result.layoutJson.tiles[3].widgetType).toBe('hero_header');
  });
});

describe('Storefront E2E — Tier Thresholds', () => {
  test('0 → FREE', () => { expect(storefrontService.getTierForStake(0)).toBe('FREE'); });
  test('500 → BRONZE', () => { expect(storefrontService.getTierForStake(500)).toBe('NITRO_BRONZE'); });
  test('1500 → SILVER', () => { expect(storefrontService.getTierForStake(1500)).toBe('NITRO_SILVER'); });
  test('5000 → GOLD', () => { expect(storefrontService.getTierForStake(5000)).toBe('NITRO_GOLD'); });
  test('499 → FREE', () => { expect(storefrontService.getTierForStake(499)).toBe('FREE'); });
  test('1499 → BRONZE', () => { expect(storefrontService.getTierForStake(1499)).toBe('NITRO_BRONZE'); });
  test('4999 → SILVER', () => { expect(storefrontService.getTierForStake(4999)).toBe('NITRO_SILVER'); });
});
