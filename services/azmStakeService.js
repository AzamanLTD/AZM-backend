'use strict';

// NOTE: prisma is passed as the first argument to every function (req.app.get('prisma')).
const { NITRO_THRESHOLDS, getTierForStake } = require('./nitroPolicy');

const TIER_THRESHOLDS = NITRO_THRESHOLDS;
const COOLDOWN_DAYS = 7;

async function getStakedBalance(prisma, userId) {
  const stakes = await prisma.azmStake.findMany({ where: { userId, status: 'ACTIVE' } });
  return stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
}

async function getUserTier(prisma, userId) {
  return getTierForStake(await getStakedBalance(prisma, userId));
}

async function createStake(prisma, userId, amountAzm) {
  if (amountAzm <= 0) throw new Error('Stake amount must be positive.');
  const tier = await getUserTier(prisma, userId);
  const stake = await prisma.azmStake.create({
    data: { userId, amountAzm, status: 'ACTIVE', tierAtStake: tier, cooldownDays: COOLDOWN_DAYS },
  });
  const newTier = await getUserTier(prisma, userId);
  return { stake, tier: newTier, stakedBalance: await getStakedBalance(prisma, userId) };
}

async function requestUnstake(prisma, userId, stakeId) {
  const stake = await prisma.azmStake.findUnique({ where: { id: stakeId } });
  if (!stake || stake.userId !== userId) throw new Error('Stake not found.');
  if (stake.status !== 'ACTIVE') throw new Error('Stake is not active.');
  const now = new Date();
  const unstakeAvailableAt = new Date(now);
  unstakeAvailableAt.setDate(unstakeAvailableAt.getDate() + stake.cooldownDays);
  return prisma.azmStake.update({
    where: { id: stakeId },
    data: { status: 'UNSTAKING', unstakeRequestedAt: now, unstakeAvailableAt },
  });
}

async function completeUnstake(prisma, stakeId) {
  const stake = await prisma.azmStake.findUnique({ where: { id: stakeId } });
  if (!stake || stake.status !== 'UNSTAKING') return null;
  if (!stake.unstakeAvailableAt || stake.unstakeAvailableAt > new Date()) return null;
  return prisma.azmStake.update({ where: { id: stakeId }, data: { status: 'COMPLETED', completedAt: new Date() } });
}

async function getUserStakes(prisma, userId) {
  return prisma.azmStake.findMany({ where: { userId }, orderBy: { stakedAt: 'desc' } });
}

async function processUnstakeQueue(prisma) {
  const now = new Date();
  const pending = await prisma.azmStake.findMany({ where: { status: 'UNSTAKING', unstakeAvailableAt: { lte: now } } });
  let completed = 0;
  for (const stake of pending) {
    if (await completeUnstake(prisma, stake.id)) completed++;
  }
  return { completed, total: pending.length };
}

async function checkActiveStakes(prisma) {
  const activeStakes = await prisma.azmStake.findMany({ where: { status: 'ACTIVE' } });
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
