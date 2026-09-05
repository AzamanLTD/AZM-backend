'use strict';

const {
  parseExpectedUpdatedAt,
  withDraftMutation,
  revertToVersionSafe,
  applyTemplateSafe,
  updateExperienceSafe,
} = require('../services/storefrontDraftMutationSafeService');
const storefrontService = require('../services/storefrontService');

jest.mock('../services/storefrontService', () => ({
  getOrCreateDraft: jest.fn(),
  revertToVersion: jest.fn().mockResolvedValue({ id: 'draft-1' }),
  applyTemplate: jest.fn().mockResolvedValue({ id: 'draft-2' }),
}));

describe('storefrontDraftMutationSafeService', () => {
  function makePrisma(draft) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      businessStorefrontLayout: {
        findUnique: jest.fn().mockResolvedValue(draft),
        update: jest.fn().mockResolvedValue({ id: 'draft-1', layoutJson: {} }),
      },
    };
    return {
      tx,
      prisma: {
        $transaction: jest.fn(async (callback) => callback(tx)),
      },
    };
  }

  afterEach(() => jest.clearAllMocks());

  test('parses absent snapshots as unversioned compatibility calls', () => {
    expect(parseExpectedUpdatedAt()).toBeNull();
    expect(parseExpectedUpdatedAt(null)).toBeNull();
    expect(parseExpectedUpdatedAt('')).toBeNull();
  });

  test('rejects malformed snapshots', () => {
    expect(() => parseExpectedUpdatedAt('not-a-date')).toThrow('expectedUpdatedAt must be a valid ISO timestamp string.');
    expect(() => parseExpectedUpdatedAt(123)).toThrow('expectedUpdatedAt must be a valid ISO timestamp string.');
  });

  test('serializes and accepts the exact observed draft snapshot', async () => {
    const updatedAt = new Date('2026-09-05T00:00:00.000Z');
    const { prisma, tx } = makePrisma({ id: 'draft-1', updatedAt });
    const result = await withDraftMutation(
      prisma,
      'biz-1',
      updatedAt.toISOString(),
      (lockedTx) => ({ ok: lockedTx === tx }),
    );

    expect(result).toEqual({ ok: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.businessStorefrontLayout.findUnique).toHaveBeenCalledTimes(1);
  });

  test('returns conflict when the observed draft has changed', async () => {
    const { prisma } = makePrisma({ id: 'draft-1', updatedAt: new Date('2026-09-05T00:00:01.000Z') });

    await expect(
      withDraftMutation(prisma, 'biz-1', '2026-09-05T00:00:00.000Z', async () => 'unreachable'),
    ).rejects.toMatchObject({ code: 'STOREFRONT_DRAFT_STALE', statusCode: 409 });
  });

  test('serializes no-draft compatibility calls so create operations share the same lock', async () => {
    const { prisma } = makePrisma(null);
    const result = await withDraftMutation(prisma, 'biz-1', null, async () => 'created');
    expect(result).toBe('created');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('revert and template calls pass the transaction client through', async () => {
    const updatedAt = new Date('2026-09-05T00:00:00.000Z');
    const { prisma, tx } = makePrisma({ id: 'draft-1', updatedAt });

    await revertToVersionSafe(prisma, 'biz-1', 'version-1', updatedAt.toISOString());
    await applyTemplateSafe(prisma, 'biz-1', 'template-1', updatedAt.toISOString());

    expect(storefrontService.revertToVersion).toHaveBeenCalledWith(tx, 'biz-1', 'version-1');
    expect(storefrontService.applyTemplate).toHaveBeenCalledWith(tx, 'biz-1', 'template-1');
  });

  test('updates the experience inside the same transaction and preserves the rest of the layout', async () => {
    const updatedAt = new Date('2026-09-05T00:00:00.000Z');
    const existingLayout = { tiles: [{ id: 'tile-1' }], experience: { old: true } };
    const { prisma, tx } = makePrisma({ id: 'draft-1', updatedAt });
    storefrontService.getOrCreateDraft.mockResolvedValue({ id: 'draft-1', layoutJson: existingLayout });

    await updateExperienceSafe(
      prisma,
      'biz-1',
      { schemaVersion: 2, categoryOptions: { selectedCategory: 'FOOD' } },
      updatedAt.toISOString(),
    );

    expect(storefrontService.getOrCreateDraft).toHaveBeenCalledWith(tx, 'biz-1');
    expect(tx.businessStorefrontLayout.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'draft-1' },
      data: {
        layoutJson: {
          ...existingLayout,
          experience: { schemaVersion: 2, categoryOptions: { selectedCategory: 'FOOD' } },
        },
      },
      include: { theme: true },
    }));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
