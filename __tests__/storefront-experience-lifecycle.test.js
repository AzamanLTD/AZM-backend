'use strict';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../services/storefrontSchemaMigration', () => ({
  migrateLayout: jest.fn((layout) => ({ ...layout, schemaVersion: 2 })),
  generateEmptyLayout: jest.fn(() => ({ schemaVersion: 1, gridColumns: 4, tiles: [] })),
}));

const storefrontService = require('../services/storefrontService');

afterEach(() => jest.clearAllMocks());

function makePrisma({ versionLayout, templateLayout, existingDraft }) {
  const update = jest.fn(async ({ data }) => ({
    id: existingDraft?.id || 'draft-1',
    ...existingDraft,
    ...data,
  }));
  const create = jest.fn(async ({ data }) => ({ id: 'draft-created', ...data }));

  return {
    businessStorefrontLayoutVersion: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'version-1',
        businessProfileId: 'biz-1',
        themeId: 'theme-version',
        layoutJson: versionLayout,
      }),
    },
    businessStorefrontLayoutTemplate: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'template-1',
        isActive: true,
        themeId: 'theme-template',
        layoutJson: templateLayout,
      }),
    },
    businessStorefrontLayout: {
      findUnique: jest.fn().mockResolvedValue(existingDraft || null),
      update,
      create,
    },
  };
}

describe('storefront Experience Blueprint lifecycle preservation', () => {
  const experience = {
    preset: 'DINING_JOURNEY',
    motion: { tempo: 'RELAXED' },
  };

  test('revert preserves the current draft experience when historical layout predates it', async () => {
    const prisma = makePrisma({
      versionLayout: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [{ id: 'old-tile' }],
      },
      templateLayout: {},
      existingDraft: {
        id: 'draft-1',
        layoutJson: {
          schemaVersion: 2,
          gridColumns: 4,
          tiles: [{ id: 'current-tile' }],
          experience,
        },
      },
    });

    const draft = await storefrontService.revertToVersion(prisma, 'biz-1', 'version-1');

    expect(draft.layoutJson.experience).toEqual(experience);
    expect(draft.layoutJson.tiles).toEqual([{ id: 'old-tile' }]);
  });

  test('revert uses an explicit historical experience snapshot when one exists', async () => {
    const historicalExperience = { preset: 'SHOP_FLOOR', motion: { tempo: 'QUICK' } };
    const prisma = makePrisma({
      versionLayout: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [],
        experience: historicalExperience,
      },
      templateLayout: {},
      existingDraft: {
        id: 'draft-1',
        layoutJson: { schemaVersion: 2, tiles: [], experience },
      },
    });

    const draft = await storefrontService.revertToVersion(prisma, 'biz-1', 'version-1');

    expect(draft.layoutJson.experience).toEqual(historicalExperience);
  });

  test('template application preserves the current draft experience for legacy templates', async () => {
    const prisma = makePrisma({
      versionLayout: {},
      templateLayout: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [{ id: 'template-tile' }],
      },
      existingDraft: {
        id: 'draft-1',
        layoutJson: {
          schemaVersion: 2,
          tiles: [],
          experience,
        },
      },
    });

    const draft = await storefrontService.applyTemplate(prisma, 'biz-1', 'template-1');

    expect(draft.layoutJson.experience).toEqual(experience);
    expect(draft.layoutJson.tiles).toEqual([{ id: 'template-tile' }]);
  });

  test('template application keeps an explicit template experience snapshot', async () => {
    const templateExperience = { preset: 'TRAVEL_JOURNEY', motion: { tempo: 'BALANCED' } };
    const prisma = makePrisma({
      versionLayout: {},
      templateLayout: {
        schemaVersion: 1,
        tiles: [],
        experience: templateExperience,
      },
      existingDraft: {
        id: 'draft-1',
        layoutJson: { schemaVersion: 2, tiles: [], experience },
      },
    });

    const draft = await storefrontService.applyTemplate(prisma, 'biz-1', 'template-1');

    expect(draft.layoutJson.experience).toEqual(templateExperience);
  });

  test('new drafts do not invent an Experience Blueprint during revert', async () => {
    const prisma = makePrisma({
      versionLayout: {
        schemaVersion: 1,
        tiles: [{ id: 'old-tile' }],
      },
      templateLayout: {},
      existingDraft: null,
    });

    const draft = await storefrontService.revertToVersion(prisma, 'biz-1', 'version-1');

    expect(draft.layoutJson.experience).toBeUndefined();
    expect(prisma.businessStorefrontLayout.create).toHaveBeenCalledTimes(1);
  });
});
