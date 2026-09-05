'use strict';

const { publishLayoutSafe } = require('../services/storefrontPublishSafeService');
const storefrontService = require('../services/storefrontService');

jest.mock('../services/storefrontService', () => ({
  publishLayout: jest.fn().mockResolvedValue({ id: 'published-1', status: 'PUBLISHED' }),
}));

describe('storefrontPublishSafeService', () => {
  function makePrisma(rows) {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    return {
      tx,
      prisma: { $transaction: jest.fn(async (callback) => callback(tx)) },
    };
  }

  afterEach(() => jest.clearAllMocks());

  test('locks the draft and delegates publish inside one transaction', async () => {
    const { prisma, tx } = makePrisma([{ id: 'draft-1' }]);
    const result = await publishLayoutSafe(prisma, 'biz-1', 7, '2026-09-05T00:00:00.000Z');

    expect(result).toEqual({ id: 'published-1', status: 'PUBLISHED' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(storefrontService.publishLayout).toHaveBeenCalledWith(tx, 'biz-1', 7);
  });

  test('rejects stale or missing versioned drafts with conflict', async () => {
    const { prisma } = makePrisma([]);

    await expect(
      publishLayoutSafe(prisma, 'biz-1', 7, '2026-09-05T00:00:00.000Z'),
    ).rejects.toMatchObject({
      code: 'STOREFRONT_DRAFT_STALE',
      statusCode: 409,
    });
    expect(storefrontService.publishLayout).not.toHaveBeenCalled();
  });

  test('rejects malformed expectedUpdatedAt before opening a transaction', async () => {
    const { prisma } = makePrisma([{ id: 'draft-1' }]);

    await expect(
      publishLayoutSafe(prisma, 'biz-1', 7, 'not-a-date'),
    ).rejects.toMatchObject({
      code: 'INVALID_EXPECTED_UPDATED_AT',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('supports an unversioned compatibility call while serializing publishes', async () => {
    const { prisma, tx } = makePrisma([{ id: 'draft-1' }]);

    await publishLayoutSafe(prisma, 'biz-1', 7);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(storefrontService.publishLayout).toHaveBeenCalledWith(tx, 'biz-1', 7);
  });
});
