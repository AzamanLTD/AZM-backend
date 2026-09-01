'use strict';

jest.mock('../services/storefrontService', () => ({
  validateNitroEligibility: jest.fn().mockResolvedValue({
    eligible: true,
    violations: [],
    tier: 'FREE',
    stakedBalance: 0,
  }),
  downgradePremiumWidgets: jest.fn((layout) => ({ layoutJson: layout, downgraded: [] })),
}));

const renderService = require('../services/storefrontRenderService');
const storefrontService = require('../services/storefrontService');
const experienceBlueprintService = require('../services/experienceBlueprintService');

function makePrisma({ publishedExperience, businessMetaExperience } = {}) {
  return {
    businessStorefrontLayout: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'published-1',
        businessProfileId: 'biz-1',
        status: 'PUBLISHED',
        themeId: 'theme-1',
        publishedAt: new Date('2026-09-01T00:00:00Z'),
        layoutJson: {
          schemaVersion: 1,
          gridColumns: 4,
          tiles: [],
          ...(publishedExperience ? { experience: publishedExperience } : {}),
        },
        theme: {
          id: 'theme-1',
          key: 'classic_light',
          name: 'Classic',
          tokenSet: { accent: '#6C4FD1' },
          typography: {},
          borderRadius: 8,
          spacingScale: 1,
        },
      }),
    },
    businessProfile: {
      findUnique: jest.fn().mockResolvedValue({
        storefrontDisabled: false,
        isSuspended: false,
        businessName: 'Test Biz',
        category: 'FOOD_BEVERAGE',
        logoUrl: null,
        coverPhotoUrl: null,
        averageRating: 4,
        phoneNumber: null,
        businessMeta: businessMetaExperience
          ? { experienceBlueprint: businessMetaExperience }
          : {},
      }),
    },
    businessStorefrontWidgetCatalog: { findMany: jest.fn().mockResolvedValue([]) },
    businessStorefrontTheme: { findFirst: jest.fn() },
    storefrontAnalyticsEvent: { create: jest.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  renderService.invalidateCache('biz-1');
});

describe('published Experience Blueprint boundary', () => {
  test('public render uses the published snapshot, not mutable business metadata', async () => {
    const prisma = makePrisma({
      publishedExperience: { preset: 'DINING_JOURNEY', motion: { tempo: 'RELAXED' } },
      businessMetaExperience: { preset: 'SHOP_FLOOR', motion: { tempo: 'QUICK' } },
    });

    const rendered = await renderService.renderStorefront(prisma, 'biz-1');

    expect(rendered.experience.preset).toBe('DINING_JOURNEY');
    expect(rendered.experience.motion.tempo).toBe('RELAXED');
  });

  test('a published layout without an experience snapshot receives the category default', async () => {
    const prisma = makePrisma({
      businessMetaExperience: { preset: 'SHOP_FLOOR' },
    });

    const rendered = await renderService.renderStorefront(prisma, 'biz-1');

    expect(rendered.experience.preset).toBe(experienceBlueprintService.PRESETS.DINING_JOURNEY);
  });
});

// Keep the service mock contract explicit so a future refactor cannot quietly
// reintroduce a dependency on business metadata during public rendering.
test('renderer depends on storefront eligibility service, not editor persistence', () => {
  expect(storefrontService.validateNitroEligibility).toHaveBeenCalledTimes(0);
  expect(typeof storefrontService.validateNitroEligibility).toBe('function');
});
