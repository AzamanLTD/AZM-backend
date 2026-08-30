'use strict';

jest.mock('../services/storefrontService', () => ({
  validateNitroEligibility: jest.fn(),
}));

jest.mock('../services/storefrontSchemaMigration', () => ({
  migrateLayout: jest.fn(layout => layout),
}));

const storefrontService = require('../services/storefrontService');
const atomic = require('../services/storefrontAtomicService');

function makePrisma(tx) {
  return {
    $transaction: jest.fn(async callback => callback(tx)),
  };
}

describe('storefrontAtomicService', () => {
  test('saveDraft locks the business before checking and writing the draft', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'biz-1' }]),
      businessStorefrontLayout: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'draft-1',
          updatedAt: new Date('2026-08-30T10:00:00.000Z'),
        }),
        upsert: jest.fn().mockResolvedValue({ id: 'draft-1' }),
      },
    };
    const prisma = makePrisma(tx);

    await atomic.saveDraft(
      prisma,
      'biz-1',
      { schemaVersion: 1, tiles: [] },
      'theme-1',
      '2026-08-30T10:00:00.000Z',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT "id" FROM "BusinessProfile" WHERE "id" = $1 FOR UPDATE',
      'biz-1',
    );
    expect(tx.businessStorefrontLayout.upsert).toHaveBeenCalledTimes(1);
  });

  test('saveDraft returns a typed conflict when the draft changed', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'biz-1' }]),
      businessStorefrontLayout: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'draft-1',
          updatedAt: new Date('2026-08-30T11:00:00.000Z'),
        }),
        upsert: jest.fn(),
      },
    };
    const prisma = makePrisma(tx);

    await expect(atomic.saveDraft(
      prisma,
      'biz-1',
      { schemaVersion: 1, tiles: [] },
      'theme-1',
      '2026-08-30T10:00:00.000Z',
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'STOREFRONT_DRAFT_CONFLICT',
    });

    expect(tx.businessStorefrontLayout.upsert).not.toHaveBeenCalled();
  });

  test('publishLayout performs the complete publication transition inside one transaction', async () => {
    storefrontService.validateNitroEligibility.mockResolvedValue({
      eligible: true,
      violations: [],
      tier: 'FREE',
      stakedBalance: 0,
    });

    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'biz-1' }]),
      businessStorefrontLayout: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({
            id: 'draft-1',
            themeId: 'theme-2',
            layoutJson: { schemaVersion: 1, tiles: [] },
            updatedAt: new Date('2026-08-30T10:00:00.000Z'),
            theme: { key: 'classic_light' },
          })
          .mockResolvedValueOnce({ storefrontDisabled: false })
          .mockResolvedValueOnce({
            id: 'published-1',
            themeId: 'theme-1',
            layoutJson: { schemaVersion: 1, tiles: [{ id: 'old' }] },
            publishedAt: new Date('2026-08-29T10:00:00.000Z'),
            publishedBy: 9,
          }),
        create: jest.fn().mockResolvedValue({
          id: 'published-2',
          themeId: 'theme-2',
          layoutJson: { schemaVersion: 1, tiles: [] },
          publishedAt: new Date('2026-08-30T12:00:00.000Z'),
          publishedBy: 7,
          theme: { key: 'classic_light' },
        }),
        delete: jest.fn().mockResolvedValue({}),
      },
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ storefrontDisabled: false }),
      },
      businessStorefrontLayoutVersion: {
        aggregate: jest.fn()
          .mockResolvedValueOnce({ _max: { version: 4 } })
          .mockResolvedValueOnce({ _max: { version: 5 } }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = makePrisma(tx);

    await atomic.publishLayout(prisma, 'biz-1', 7, '2026-08-30T10:00:00.000Z');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.businessStorefrontLayoutVersion.create).toHaveBeenCalledTimes(2);
    expect(tx.businessStorefrontLayout.delete).toHaveBeenCalledTimes(2);
    expect(tx.businessStorefrontLayoutVersion.create.mock.calls.map(call => call[0].data.version)).toEqual([5, 6]);
  });
});
