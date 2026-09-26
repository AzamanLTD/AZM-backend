// services/loyaltyService.js
// Business loyalty programs — stamp cards, points, and tiers.
// Customers earn stamps/points per order and redeem rewards.

'use strict';

// ── Loyalty Program CRUD (business side) ────────────────────────────────────────

const createProgram = async (prisma, { businessProfileId, name, description, type, stampsRequired, rewardDescription, pointsPerCedi, cardColor }) => {
  if (!name?.trim()) throw new Error('Program name is required');
  if (!rewardDescription?.trim()) throw new Error('Reward description is required');

  const existing = await prisma.loyaltyProgram.count({ where: { businessProfileId, isActive: true } });
  if (existing >= 5) throw new Error('Maximum 5 active loyalty programs per business');

  return prisma.loyaltyProgram.create({
    data: {
      businessProfileId,
      name: name.trim().slice(0, 100),
      description: description?.trim() || null,
      type: type || 'STAMP',
      stampsRequired: type === 'STAMP' ? Math.min(Math.max(stampsRequired || 10, 1), 50) : 10,
      rewardDescription: rewardDescription.trim().slice(0, 200),
      pointsPerCedi: type === 'POINTS' ? pointsPerCedi : null,
      cardColor: cardColor || '#FFD700',
    },
  });
};

const listPrograms = async (prisma, { businessProfileId, includeInactive }) => {
  return prisma.loyaltyProgram.findMany({
    where: { businessProfileId, ...(includeInactive ? {} : { isActive: true }) },
    include: { _count: { select: { cards: true } } },
    orderBy: { createdAt: 'desc' },
  });
};

const updateProgram = async (prisma, { programId, businessProfileId, ...updates }) => {
  const prog = await prisma.loyaltyProgram.findUnique({ where: { id: programId }, select: { businessProfileId: true } });
  if (!prog || prog.businessProfileId !== businessProfileId) throw new Error('Program not found');

  const allowed = {};
  if (updates.name !== undefined) allowed.name = updates.name.trim().slice(0, 100);
  if (updates.description !== undefined) allowed.description = updates.description?.trim() || null;
  if (updates.stampsRequired !== undefined) allowed.stampsRequired = Math.min(Math.max(updates.stampsRequired, 1), 50);
  if (updates.rewardDescription !== undefined) allowed.rewardDescription = updates.rewardDescription.trim().slice(0, 200);
  if (updates.pointsPerCedi !== undefined) allowed.pointsPerCedi = updates.pointsPerCedi;
  if (updates.cardColor !== undefined) allowed.cardColor = updates.cardColor;
  if (updates.isActive !== undefined) allowed.isActive = updates.isActive;

  return prisma.loyaltyProgram.update({ where: { id: programId }, data: allowed });
};

const deleteProgram = async (prisma, { programId, businessProfileId }) => {
  const prog = await prisma.loyaltyProgram.findUnique({ where: { id: programId }, select: { businessProfileId: true } });
  if (!prog || prog.businessProfileId !== businessProfileId) throw new Error('Program not found');
  return prisma.loyaltyProgram.delete({ where: { id: programId } });
};

// ── Loyalty Card (customer side) ───────────────────────────────────────────────

const getMyCard = async (prisma, { programId, userId }) => {
  let card = await prisma.loyaltyCard.findUnique({
    where: { loyaltyProgramId_userId: { loyaltyProgramId: programId, userId } },
    include: { loyaltyProgram: true },
  });
  if (!card) {
    // Auto-enroll on first view
    card = await prisma.loyaltyCard.create({
      data: { loyaltyProgramId: programId, userId },
      include: { loyaltyProgram: true },
    });
  }
  return card;
};

const getMyLoyaltyCards = async (prisma, { userId }) => {
  return prisma.loyaltyCard.findMany({
    where: { userId },
    include: {
      loyaltyProgram: {
        select: {
          id: true, name: true, description: true, type: true,
          stampsRequired: true, rewardDescription: true, cardColor: true,
          businessProfile: { select: { id: true, businessName: true, logoUrl: true } },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
};

const addStamp = async (prisma, { programId, userId, businessProfileId }) => {
  // Verify business ownership
  const prog = await prisma.loyaltyProgram.findUnique({
    where: { id: programId },
    include: { businessProfile: { select: { ownerId: true } } },
  });
  if (!prog) throw new Error('Program not found');
  if (prog.businessProfile.ownerId !== businessProfileId && !businessProfileId) {
    throw new Error('Not authorized');
  }

  let card = await prisma.loyaltyCard.findUnique({
    where: { loyaltyProgramId_userId: { loyaltyProgramId: programId, userId } },
  });
  if (!card) {
    card = await prisma.loyaltyCard.create({ data: { loyaltyProgramId: programId, userId } });
  }

  const newStamps = card.stampsCollected + 1;
  const isRedeemable = prog.type === 'STAMP' && newStamps >= prog.stampsRequired;

  return prisma.loyaltyCard.update({
    where: { id: card.id },
    data: {
      stampsCollected: newStamps,
      lastStampAt: new Date(),
    },
    include: { loyaltyProgram: true },
  });
};

const redeemReward = async (prisma, { programId, userId }) => {
  const card = await prisma.loyaltyCard.findUnique({
    where: { loyaltyProgramId_userId: { loyaltyProgramId: programId, userId } },
    include: { loyaltyProgram: true },
  });
  if (!card) throw new Error('No loyalty card found');
  if (card.loyaltyProgram.type !== 'STAMP') throw new Error('Only stamp programs support redemption');
  if (card.stampsCollected < card.loyaltyProgram.stampsRequired) {
    throw new Error(`Need ${card.loyaltyProgram.stampsRequired} stamps to redeem (you have ${card.stampsCollected})`);
  }

  return prisma.loyaltyCard.update({
    where: { id: card.id },
    data: {
      stampsCollected: card.stampsCollected - card.loyaltyProgram.stampsRequired,
      totalRewardsRedeemed: { increment: 1 },
      redeemedAt: new Date(),
    },
    include: { loyaltyProgram: true },
  });
};

// ── Auto-stamp on order completion ────────────────────────────────────────────────

const stampOnOrderComplete = async (prisma, { orderId }) => {
  const order = await prisma.businessOrder.findUnique({
    where: { id: orderId },
    include: { businessProfile: { select: { id: true } } },
  });
  if (!order || order.status !== 'COMPLETED') return null;

  const programs = await prisma.loyaltyProgram.findMany({
    where: { businessProfileId: order.businessProfileId, isActive: true },
  });
  if (!programs.length) return null;

  const results = [];
  for (const prog of programs) {
    let card = await prisma.loyaltyCard.findUnique({
      where: { loyaltyProgramId_userId: { loyaltyProgramId: prog.id, userId: order.userId } },
    });
    if (!card) {
      card = await prisma.loyaltyCard.create({ data: { loyaltyProgramId: prog.id, userId: order.userId } });
    }

    if (prog.type === 'STAMP') {
      card = await prisma.loyaltyCard.update({
        where: { id: card.id },
        data: { stampsCollected: { increment: 1 }, lastStampAt: new Date() },
      });
    } else if (prog.type === 'POINTS' && prog.pointsPerCedi) {
      const points = Math.floor(order.totalAmount * prog.pointsPerCedi);
      card = await prisma.loyaltyCard.update({
        where: { id: card.id },
        data: { pointsBalance: { increment: points }, lastStampAt: new Date() },
      });
    }
    results.push(card);
  }
  return results;
};

module.exports = {
  createProgram, listPrograms, updateProgram, deleteProgram,
  getMyCard, getMyLoyaltyCards, addStamp, redeemReward,
  stampOnOrderComplete,
};
