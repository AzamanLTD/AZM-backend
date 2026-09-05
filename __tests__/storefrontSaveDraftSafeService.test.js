'use strict';

const { saveDraftSafe } = require('../services/storefrontSaveDraftSafeService');
const storefrontService = require('../services/storefrontService');
const safeMutation = require('../services/storefrontDraftMutationSafeService');

jest.mock('../services/storefrontService', () => ({
  saveDraft: jest.fn().mockResolvedValue({ id: 'draft-1', status: 'DRAFT' }),
}));
jest.mock('../services/storefrontDraftMutationSafeService', () => ({
  withDraftMutation: jest.fn(async (_p, _b, _e, mutate) => mutate({ tx: true })),
}));

describe('storefrontSaveDraftSafeService', () => {
  afterEach(() => jest.clearAllMocks());

  test('passes the observed snapshot through the serialized mutation boundary', async () => {
    await expect(saveDraftSafe(
      { $transaction: jest.fn() }, 'biz-1',
      { schemaVersion: 1, gridColumns: 4, tiles: [] },
      '11111111-1111-4111-8111-111111111111', '2026-09-05T00:00:00.000Z',
    )).resolves.toEqual({ id: 'draft-1', status: 'DRAFT' });

    expect(safeMutation.withDraftMutation).toHaveBeenCalledWith(
      expect.anything(), 'biz-1', '2026-09-05T00:00:00.000Z', expect.any(Function),
    );
    expect(storefrontService.saveDraft).toHaveBeenCalledWith(
      { tx: true }, 'biz-1',
      { schemaVersion: 1, gridColumns: 4, tiles: [] },
      '11111111-1111-4111-8111-111111111111', '2026-09-05T00:00:00.000Z',
    );
  });
});
