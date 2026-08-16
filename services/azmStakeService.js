'use strict';

// NOTE: prisma is passed as the first argument to every function (req.app.get('prisma')).

// Tier thresholds based on staked AZM
const TIER_THRESHOLDS = {
  NITRO_BRONZE: 500,
  NITRO_SILVER: 1500,
  NITRO_GOLD: 5000,
};

const COOLDOWN_DAYS = 7;

/**
 * Get a user's total active staked AZM.
 */
async function getStakedBalance(prisma, userId) {
  const stakes = await prisma.azmStake.findMany({
    where: { userId, status: 'ACTIVE' },
  });
  return stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
}

/**
 * Get a user's current tier based on staked AZM.
 */
async function getUserTier(prisma, userId) {
  const stakedBalance = await getStakedBalance(prisma, userId);
  if (stakedBalance >= TIER_THRESHOLDS.NITRO_GOLD) return 'NITRO_GOLD';
  if (stakedBalance >= TIER_THRESHOLDS.NITRO_SILVER) return 'NITRO_SILVER';
  if (stakedBalance >= TIER_THRESHOLDS.NITRO_BRONZE) return 'NITRO_BRONZE';
  return 'FREE';
}

/**
 * Create a new stake.
 */
async function createStake(prisma, userId, amountAzm) {
  if (amountAzm <= 0) throw new Error('Stake amount must be positive.');

  const tier = await getUserTier(prisma, userId);
  const newAmount = amountAzm;

  const stake = await prisma.azmStake.create({
    data: {
      userId,
      amountAzm: newAmount,
      status: 'ACTIVE',
      tierAtStake: tier,
      cooldownDays: COOLDOWN_DAYS,
    },
  });

  // Check if tier increased
  const newTier = await getUserTier(prisma, userId);

  return { stake, tier: newTier, stakedBalance: await getStakedBalance(prisma, userId) };
}

/**
 * Request unstaking (starts the cooldown).
 */
async function requestUnstake(prisma, userId, stakeId) {
  const stake = await prisma.azmStake.findUnique({ where: { id: stakeId } });
  if (!stake || stake.userId !== userId) throw new Error('Stake not found.');
  if (stake.status !== 'ACTIVE') throw new Error('Stake is not active.');

  const unstakeAvailableAt = new Date();
  unstakeAvailableAt.setDate(unstakeAvailableAt.getDate() + stake.cooldownDays);

  return prisma.azmStake.update({
    where: { id: stakeId },
    data: {
      status: 'UNSTAKING',
      unstakeRequestedAt: new Date(),
      unstakeAvailableAt,
    },
  });
}

/**
 * Complete unstaking after cooldown.
 * Called by the worker.
 */
async function completeUnstake(prisma, stakeId) {
  const stake = await prisma.azmStake.findUnique({ where: { id: stakeId } });
  if (!stake || stake.status !== 'UNSTAKING') return null;

  if (!stake.unstakeAvailableAt || stake.unstakeAvailableAt > new Date()) {
    return null; // Cooldown not yet complete
  }

  return prisma.azmStake.update({
    where: { id: stakeId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
}

/**
 * Get all stakes for a user.
 */
async function getUserStakes(prisma, userId) {
  return prisma.azmStake.findMany({
    where: { userId },
    orderBy: { stakedAt: 'desc' },
  });
}

/**
 * Check and complete any unstakes that have passed their cooldown.
 */
async function processUnstakeQueue(prisma) {
  const now = new Date();
  const pending = await prisma.azmStake.findMany({
    where: {
      status: 'UNSTAKING',
      unstakeAvailableAt: { lte: now },
    },
  });

  let completed = 0;
  for (const stake of pending) {
    await completeUnstake(prisma, stake.id);
    completed++;
  }

  return { completed, total: pending.length };
}

/**
 * Check all active stakes (daily check for tier enforcement).
 */
async function checkActiveStakes(prisma) {
  const activeStakes = await prisma.azmStake.findMany({
    where: { status: 'ACTIVE' },
  });
  return { checked: activeStakes.length };
}

module.exports = {
  TIER_THRESHOLDS,
  COOLDOWN_DAYS,
  getStakedBalance,
  getUserTier,
  createStake,
  requestUnstake,
  completeUnstake,
  getUserStakes,
  processUnstakeQueue,
  checkActiveStakes,
};
