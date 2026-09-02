'use strict';

jest.mock('../services/storefrontSchemaMigration', () => ({
  migrateLayout: jest.fn((layout) => layout),
  generateEmptyLayout: jest.fn(),
}));

const { migrateLayout } = require('../services/storefrontSchemaMigration');
const storefrontService = require('../services/storefrontService');

describe('storefront draft Experience Blueprint invariant', () => {
  test('preserves an existing blueprint when a generic save omits it', async () => {
    const existing = {
      id: 'draft-1',
      updatedAt: new Date('2026-09-02T10:00:00.000Z'),
      layoutJson: {
        tiles: [{ widgetType: 'hero_header' }],
        experience: { preset: 'DINING_JOURNEY', commit: { style: 'PAPER_RIP' } },
      },
    };
    const upsert = jest.fn().mockResolvedValue({ id: 'draft-1' });
    const prisma = {
      businessStorefrontLayout: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert,
      },
    };

    await storefrontService.saveDraft(prisma, 'biz-1', { tiles: [] }, 'theme-1');

    const input = upsert.mock.calls[0][0];
    expect(input.update.layoutJson.experience).toEqual(existing.layoutJson.experience);
    expect(migrateLayout).toHaveBeenCalledWith(expect.objectContaining({ experience: existing.layoutJson.experience }));
  });

  test('explicit experience values, including null, remain authoritative', async () => {
    const existing = {
      id: 'draft-1',
      updatedAt: new Date('2026-09-02T10:00:00.000Z'),
      layoutJson: { experience: { preset: 'DINING_JOURNEY' } },
    };
    const upsert = jest.fn().mockResolvedValue({ id: 'draft-1' });
    const prisma = {
      businessStorefrontLayout: { findUnique: jest.fn().mockResolvedValue(existing), upsert },
    };

    await storefrontService.saveDraft(prisma, 'biz-1', { experience: null }, 'theme-1');

    expect(upsert.mock.calls[0][0].update.layoutJson.experience).toBeNull();
  });
});
