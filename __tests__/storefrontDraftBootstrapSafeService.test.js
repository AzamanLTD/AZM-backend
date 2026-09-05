'use strict';

const { getOrCreateDraftSafe } = require('../services/storefrontDraftBootstrapSafeService');
const storefrontService = require('../services/storefrontService');
const safeMutation = require('../services/storefrontDraftMutationSafeService');

jest.mock('../services/storefrontService', () => ({
  getOrCreateDraft: jest.fn().mockResolvedValue({ id: 'draft-1', status: 'DRAFT' }),
}));

jest.mock('../services/storefrontDraftMutationSafeService', () => ({
  withDraftMutation: jest.fn(async (_prisma, _businessId, _expected, mutate) => mutate({ tx: true })),
}));

describe('storefrontDraftBootstrapSafeService', () => {
  afterEach(() => jest.clearAllMocks());

  test('delegates bootstrap through the shared serialized draft boundary', async () => {
    const prisma = { $transaction: jest.fn() };

    await expect(getOrCreateDraftSafe(prisma, 'biz-1', 'RETAIL')).resolves.toEqual({
      id: 'draft-1',
      status: 'DRAFT',
    });

    expect(safeMutation.withDraftMutation).toHaveBeenCalledWith(
      prisma,
      'biz-1',
      null,
      expect.any(Function),
    );
    expect(storefrontService.getOrCreateDraft).toHaveBeenCalledWith({ tx: true }, 'biz-1', 'RETAIL');
  });
});
