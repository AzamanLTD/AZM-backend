const {
  NITRO_THRESHOLDS,
  TIER_RANK,
  getTierForStake,
  meetsTier,
  shortageForTier,
} = require('../services/nitroPolicy');

describe('canonical Nitro policy', () => {
  test('keeps the published tier thresholds stable', () => {
    expect(NITRO_THRESHOLDS).toEqual({
      NITRO_BRONZE: 500,
      NITRO_SILVER: 1500,
      NITRO_GOLD: 5000,
    });
  });

  test.each([
    [0, 'FREE'],
    [499.99, 'FREE'],
    [500, 'NITRO_BRONZE'],
    [1499.99, 'NITRO_BRONZE'],
    [1500, 'NITRO_SILVER'],
    [4999.99, 'NITRO_SILVER'],
    [5000, 'NITRO_GOLD'],
    [10000, 'NITRO_GOLD'],
  ])('maps %p staked AZM to %s', (balance, expected) => {
    expect(getTierForStake(balance)).toBe(expected);
  });

  test('rejects invalid balances as FREE rather than granting premium access', () => {
    expect(getTierForStake(-1)).toBe('FREE');
    expect(getTierForStake(Number.NaN)).toBe('FREE');
    expect(getTierForStake(Number.POSITIVE_INFINITY)).toBe('FREE');
  });

  test('uses an ordered rank for capability checks', () => {
    expect(TIER_RANK.FREE).toBeLessThan(TIER_RANK.NITRO_BRONZE);
    expect(meetsTier('NITRO_SILVER', 'NITRO_BRONZE')).toBe(true);
    expect(meetsTier('NITRO_BRONZE', 'NITRO_SILVER')).toBe(false);
    expect(meetsTier('FREE', 'NITRO_GOLD')).toBe(false);
  });

  test('reports only the amount of stake missing for a required tier', () => {
    expect(shortageForTier(400, 'NITRO_BRONZE')).toBe(100);
    expect(shortageForTier(1500, 'NITRO_SILVER')).toBe(0);
    expect(shortageForTier(5000, 'NITRO_GOLD')).toBe(0);
  });
});
