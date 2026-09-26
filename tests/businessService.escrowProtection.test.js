const businessService = require('../services/businessService');

describe('businessService escrow protection capability', () => {
  test('public profile reports escrow protection as unavailable by default', async () => {
    const profile = {
      id: 'biz-1',
      userId: 7,
      bizId: 'BIZ-000000001',
      businessMeta: null,
    };
    const prisma = {
      businessProfile: {
        findFirst: jest.fn().mockResolvedValue(profile),
      },
    };

    const result = await businessService.getBusinessProfile(prisma, { bizId: profile.bizId });

    expect(result.escrowProtectionAvailable).toBe(false);
  });

  test('owner can enable escrow protection without losing existing business metadata', async () => {
    const profile = {
      id: 'biz-1',
      userId: 7,
      businessMeta: {
        storefront: { theme: 'dark' },
        customField: 'keep-me',
      },
    };
    const updated = {
      ...profile,
      businessMeta: {
        storefront: { theme: 'dark' },
        customField: 'keep-me',
        escrowProtection: { enabled: true },
      },
    };
    const update = jest.fn().mockResolvedValue(updated);
    const prisma = {
      businessProfile: {
        findFirst: jest.fn().mockResolvedValue(profile),
        update,
      },
    };

    const result = await businessService.updateBusinessProfile(prisma, {
      userId: profile.userId,
      updates: { offerEscrowProtection: true },
    });

    expect(update).toHaveBeenCalledWith({
      where: { userId: profile.userId },
      data: {
        businessMeta: {
          storefront: { theme: 'dark' },
          customField: 'keep-me',
          escrowProtection: { enabled: true },
        },
      },
    });
    expect(result.escrowProtectionAvailable).toBe(true);
    expect(result.businessMeta.customField).toBe('keep-me');
  });

  test('owner can disable escrow protection', async () => {
    const profile = {
      id: 'biz-1',
      userId: 7,
      businessMeta: { escrowProtection: { enabled: true }, other: 'keep' },
    };
    const updated = {
      ...profile,
      businessMeta: { escrowProtection: { enabled: false }, other: 'keep' },
    };
    const update = jest.fn().mockResolvedValue(updated);
    const prisma = {
      businessProfile: {
        findFirst: jest.fn().mockResolvedValue(profile),
        update,
      },
    };

    const result = await businessService.updateBusinessProfile(prisma, {
      userId: profile.userId,
      updates: { offerEscrowProtection: false },
    });

    expect(result.escrowProtectionAvailable).toBe(false);
    expect(result.businessMeta.other).toBe('keep');
  });
});
