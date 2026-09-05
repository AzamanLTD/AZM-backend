'use strict';

const { publishLayoutSafe } = require('../services/storefrontPublishSafeService');
const { withDraftMutation } = require('../services/storefrontDraftMutationSafeService');
const storefrontService = require('../services/storefrontService');

jest.mock('../services/storefrontDraftMutationSafeService', () => ({
  withDraftMutation: jest.fn(async (prisma, businessProfileId, expectedUpdatedAt, mutate) => {
    const tx = { marker: 'tx' };
    return mutate(tx);
  }),
}));

jest.mock('../services/storefrontService', () => ({
  publishLayout: jest.fn().mockResolvedValue({ id: 'published-1', status: 'PUBLISHED' }),
}));

describe('storefrontPublishSafeService', () => {
  afterEach(() => jest.clearAllMocks());

  test('delegates to the canonical serialized draft mutation boundary', async () => {
    const prisma = { marker: 'prisma' };
    const result = await publishLayoutSafe(
      prisma,
      'biz-1',
      7,
      '2026-09-05T00:00:00.000Z',
    );

    expect(result).toEqual({ id: 'published-1', status: 'PUBLISHED' });
    expect(withDraftMutation).toHaveBeenCalledTimes(1);
    expect(withDraftMutation).toHaveBeenCalledWith(
      prisma,
      'biz-1',
      '2026-09-05T00:00:00.000Z',
      expect.any(Function),
    );
    expect(storefrontService.publishLayout).toHaveBeenCalledWith(
      { marker: 'tx' },
      'biz-1',
      7,
    );
  });

  test('preserves unversioned compatibility calls', async () => {
    await publishLayoutSafe({ marker: 'prisma' }, 'biz-1', 7);
    expect(withDraftMutation).toHaveBeenCalledWith(
      { marker: 'prisma' },
      'biz-1',
      null,
      expect.any(Function),
    );
  });
});
