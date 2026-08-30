const stakeService = require('../services/azmStakeService');
const nitroPolicy = require('../services/nitroPolicy');

describe('stake service and Nitro policy contract', () => {
  test('stake service exposes the canonical thresholds', () => {
    expect(stakeService.TIER_THRESHOLDS).toBe(nitroPolicy.NITRO_THRESHOLDS);
  });

  test('tier calculation delegates to the canonical policy', async () => {
    const prisma = {
      azmStake: {
        findMany: jest.fn().mockResolvedValue([
          { amountAzm: 1000 },
          { amountAzm: 600 },
        ]),
      },
    };

    await expect(stakeService.getUserTier(prisma, 'user-1')).resolves.toBe('NITRO_SILVER');
  });
});
