'use strict';

// Canonical Nitro economy policy. Consumers should import this module rather
// than maintaining their own tier thresholds/ranking.
const NITRO_THRESHOLDS = Object.freeze({
  NITRO_BRONZE: 500,
  NITRO_SILVER: 1500,
  NITRO_GOLD: 5000,
});

const TIER_RANK = Object.freeze({
  FREE: 0,
  NITRO_BRONZE: 1,
  NITRO_SILVER: 2,
  NITRO_GOLD: 3,
});

function getTierForStake(stakedBalance) {
  const balance = Number(stakedBalance);
  if (!Number.isFinite(balance) || balance < 0) return 'FREE';
  if (balance >= NITRO_THRESHOLDS.NITRO_GOLD) return 'NITRO_GOLD';
  if (balance >= NITRO_THRESHOLDS.NITRO_SILVER) return 'NITRO_SILVER';
  if (balance >= NITRO_THRESHOLDS.NITRO_BRONZE) return 'NITRO_BRONZE';
  return 'FREE';
}

function meetsTier(currentTier, requiredTier) {
  return (TIER_RANK[currentTier] ?? -1) >= (TIER_RANK[requiredTier] ?? Infinity);
}

function shortageForTier(stakedBalance, requiredTier) {
  const threshold = NITRO_THRESHOLDS[requiredTier];
  if (threshold == null) return 0;
  const balance = Number(stakedBalance);
  if (!Number.isFinite(balance)) return threshold;
  return Math.max(0, threshold - balance);
}

module.exports = {
  NITRO_THRESHOLDS,
  TIER_RANK,
  getTierForStake,
  meetsTier,
  shortageForTier,
};
