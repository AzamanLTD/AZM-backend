jest.mock('../services/storefrontService', () => ({
  validateNitroEligibility: jest.fn().mockResolvedValue({ eligible: true, violations: [], tier: 'FREE', stakedBalance: 0 }),
}));

jest.mock('../services/storefrontStudioValidation', () => ({
  validateStudioDocument: jest.fn(),
}));

const { publishStorefrontSafely } = require('../services/storefrontSafePublishService');
const { validateNitroEligibility } = require('../services/storefrontService');

const draft = {
  id: 'draft-1',
  businessProfileId: 'business-1',
  status: 'DRAFT',
  updatedAt: new Date('2026-09-04T18:00:00.000Z'),
  themeId: 'theme-1',
  theme: { key: 'classic_light' },
  layoutJson: {
    experience: {
      schemaVersion: 2,
      pages: [{ id: 'home', name: 'Home', root: [] }],
      nodes: {},
      theme: { tokens: {} },
      navigation: {},
      assets: [],
    },
  },
};

function txMock() {
  return {
    businessStorefrontLayout: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
    },
    businessProfile: { findUnique: jest.fn().mockResolvedValue({ storefrontDisabled: false }) },
    businessStorefrontLayoutVersion: {
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 3 } }),
      create: jest.fn(),
    },
  };
}

describe('publishStorefrontSafely', () => {
  beforeEach(() => jest.clearAllMocks());

  test('claims the observed version before publishing', async () => {
    const tx = txMock();
    tx.businessStorefrontLayout.findUnique
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({ ...draft, updatedAt: new Date('2026-09-04T18:00:01.000Z') })
      .mockResolvedValueOnce(null);
    tx.businessStorefrontLayout.updateMany.mockResolvedValue({ count: 1 });
    tx.businessStorefrontLayout.create.mockResolvedValue({ id: 'published-1', status: 'PUBLISHED', themeId: 'theme-1', layoutJson: draft.layoutJson, publishedAt: new Date(), publishedBy: 99 });

    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const result = await publishStorefrontSafely(prisma, 'business-1', 99, '2026-09-04T18:00:00.000Z');

    expect(result.id).toBe('published-1');
    expect(tx.businessStorefrontLayout.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'draft-1', updatedAt: new Date('2026-09-04T18:00:00.000Z') }),
    }));
    expect(validateNitroEligibility).toHaveBeenCalled();
  });

  test('rejects a stale publishing snapshot', async () => {
    const tx = txMock();
    tx.businessStorefrontLayout.findUnique.mockResolvedValue(draft);
    tx.businessStorefrontLayout.updateMany.mockResolvedValue({ count: 0 });

    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    await expect(publishStorefrontSafely(prisma, 'business-1', 99, '2026-09-04T18:00:00.000Z'))
      .rejects.toMatchObject({ code: 'STALE_STOREFRONT_DRAFT', statusCode: 409 });
    expect(tx.businessStorefrontLayout.delete).not.toHaveBeenCalled();
  });

  test('invalid expected version fails before opening a transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    await expect(publishStorefrontSafely(prisma, 'business-1', 99, 'not-a-date'))
      .rejects.toMatchObject({ code: 'STALE_STOREFRONT_DRAFT', statusCode: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
