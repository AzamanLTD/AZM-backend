'use strict';

const { getOrCreateDraftSafe } = require('../services/storefrontDraftBootstrapSafeService');
const storefrontService = require('../services/storefrontService');

jest.mock('../services/storefrontService', () => ({
  getOrCreateDraft: jest.fn().mockResolvedValue({ id: 'draft-1', status: 'DRAFT' }),
}));

describe('storefrontDraftBootstrapSafeService', () => {
  afterEach(() => jest.clearAllMocks());

  test('serializes draft bootstrap behind a transaction advisory lock', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };

    await expect(getOrCreateDraftSafe(prisma, 'biz-1', 'RETAIL')).resolves.toEqual({
      id: 'draft-1',
      status: 'DRAFT',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(storefrontService.getOrCreateDraft).toHaveBeenCalledWith(tx, 'biz-1', 'RETAIL');
  });
});
