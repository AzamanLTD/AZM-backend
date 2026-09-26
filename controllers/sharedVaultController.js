// controllers/sharedVaultController.js
// =============================================================================
// Shared Vault controller — group savings goals (Phase 4).
//
// Endpoints:
//   POST   /shared-vaults          → Create a shared vault + invite members
//   GET    /shared-vaults          → List user's shared vaults
//   GET    /shared-vaults/:id      → Get detail with member breakdown
//   POST   /shared-vaults/:id/deposit → Contribute to a shared vault
//   POST   /shared-vaults/:id/invite  → Invite additional member
//   PATCH  /shared-vaults/:id      → Update vault (co-owner only)
//   DELETE /shared-vaults/:id      → Cancel vault (owner only)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

// ── Create ──────────────────────────────────────────────────────────────────
async function create(req, res) {
  const { name, emoji, targetAmountUsdc, maturityDate, inviteAzamanIds = [] } = req.body;
  const creatorId = req.user.id;

  if (!name || !targetAmountUsdc) {
    return res.status(400).json({ success: false, message: 'Name and target amount are required.' });
  }

  try {
    // Resolve invite Azaman IDs to user records
    const inviteUsers = inviteAzamanIds.length > 0
      ? await prisma.user.findMany({
          where: { azamanId: { in: inviteAzamanIds } },
          select: { id: true, azamanId: true },
        })
      : [];

    const vault = await prisma.sharedVault.create({
      data: {
        name,
        emoji,
        targetAmountUsdc: parseFloat(targetAmountUsdc),
        maturityDate: maturityDate ? new Date(maturityDate) : null,
        creatorId,
        members: {
          create: [
            { userId: creatorId, role: 'OWNER', contributedUsdc: 0 },
            ...inviteUsers.map(u => ({
              userId: u.id,
              role: 'CONTRIBUTOR',
              contributedUsdc: 0,
            })),
          ],
        },
      },
      include: { members: true },
    });

    // TODO: Send push notification to invited users

    logger.info({ vaultId: vault.id, creatorId }, '[sharedVault] Created');
    return res.status(201).json({ success: true, data: vault });
  } catch (err) {
    logger.error({ err: err.message, creatorId }, '[sharedVault] Create failed');
    return res.status(500).json({ success: false, message: 'Failed to create shared vault.' });
  }
}

// ── List ────────────────────────────────────────────────────────────────────
async function list(req, res) {
  const userId = req.user.id;

  try {
    const vaults = await prisma.sharedVault.findMany({
      where: {
        members: { some: { userId } },
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      include: {
        members: {
          orderBy: { contributedUsdc: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with creator name + co-owner flag
    const enriched = await Promise.all(vaults.map(async (v) => {
      const creator = await prisma.user.findUnique({
        where: { id: v.creatorId },
        select: { fullName: true, azamanId: true, profilePictureUrl: true },
      });

      const myMembership = v.members.find(m => m.userId === userId);
      const memberNames = await Promise.all(v.members.map(async (m) => {
        const u = await prisma.user.findUnique({
          where: { id: m.userId },
          select: { fullName: true, azamanId: true, profilePictureUrl: true },
        });
        return {
          userId: m.userId.toString(),
          name: u?.fullName || 'Unknown',
          avatarUrl: u?.profilePictureUrl,
          contributedUsdc: parseFloat(m.contributedUsdc),
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }));

      return {
        id: v.id,
        name: v.name,
        emoji: v.emoji,
        targetAmountUsdc: parseFloat(v.targetAmountUsdc),
        currentAmountUsdc: parseFloat(v.currentAmountUsdc),
        status: v.status,
        startDate: v.startDate,
        maturityDate: v.maturityDate,
        creatorName: creator?.fullName || 'Unknown',
        creatorAzamanId: creator?.azamanId || '',
        isCoOwner: myMembership?.role === 'CO_OWNER' || myMembership?.role === 'OWNER',
        linkedChatId: v.linkedChatId,
        createdAt: v.createdAt,
        members: memberNames,
      };
    }));

    return res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    logger.error({ err: err.message, userId }, '[sharedVault] List failed');
    return res.status(500).json({ success: false, message: 'Failed to list shared vaults.' });
  }
}

// ── Detail ───────────────────────────────────────────────────────────────────
async function detail(req, res) {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const vault = await prisma.sharedVault.findUnique({
      where: { id },
      include: { members: { orderBy: { contributedUsdc: 'desc' } } },
    });

    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found.' });

    // Access control: must be a member
    const isMember = vault.members.some(m => m.userId === userId);
    if (!isMember) return res.status(403).json({ success: false, message: 'Not a member of this vault.' });

    const creator = await prisma.user.findUnique({
      where: { id: vault.creatorId },
      select: { fullName: true, azamanId: true },
    });

    const myMembership = vault.members.find(m => m.userId === userId);
    const memberNames = await Promise.all(vault.members.map(async (m) => {
      const u = await prisma.user.findUnique({
        where: { id: m.userId },
        select: { fullName: true, azamanId: true, profilePictureUrl: true },
      });
      return {
        userId: m.userId.toString(),
        name: u?.fullName || 'Unknown',
        avatarUrl: u?.profilePictureUrl,
        contributedUsdc: parseFloat(m.contributedUsdc),
        role: m.role,
        joinedAt: m.joinedAt,
      };
    }));

    return res.status(200).json({
      success: true,
      data: {
        id: vault.id,
        name: vault.name,
        emoji: vault.emoji,
        targetAmountUsdc: parseFloat(vault.targetAmountUsdc),
        currentAmountUsdc: parseFloat(vault.currentAmountUsdc),
        status: vault.status,
        startDate: vault.startDate,
        maturityDate: vault.maturityDate,
        creatorName: creator?.fullName || 'Unknown',
        creatorAzamanId: creator?.azamanId || '',
        isCoOwner: myMembership?.role === 'CO_OWNER' || myMembership?.role === 'OWNER',
        linkedChatId: vault.linkedChatId,
        createdAt: vault.createdAt,
        members: memberNames,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, vaultId: id }, '[sharedVault] Detail failed');
    return res.status(500).json({ success: false, message: 'Failed to load vault.' });
  }
}

// ── Deposit ──────────────────────────────────────────────────────────────────
async function deposit(req, res) {
  const { id } = req.params;
  const { amountUsdc } = req.body;
  const userId = req.user.id;

  if (!amountUsdc || parseFloat(amountUsdc) <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid amount.' });
  }

  const amount = parseFloat(amountUsdc);

  try {
    const vault = await prisma.sharedVault.findUnique({
      where: { id },
      include: { members: true },
    });

    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found.' });
    if (vault.status !== 'ACTIVE') return res.status(400).json({ success: false, message: 'Vault is not active.' });

    const membership = vault.members.find(m => m.userId === userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Not a member of this vault.' });

    // Check wallet balance
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || parseFloat(wallet.balanceUsdc) < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance.' });
    }

    // Atomic: debit wallet + credit vault + credit membership
    const [updatedWallet, updatedVault, updatedMember] = await prisma.$transaction([
      prisma.wallet.update({
        where: { userId },
        data: { balanceUsdc: { decrement: amount } },
      }),
      prisma.sharedVault.update({
        where: { id },
        data: { currentAmountUsdc: { increment: amount } },
      }),
      prisma.sharedVaultMember.update({
        where: { id: membership.id },
        data: { contributedUsdc: { increment: amount } },
      }),
    ]);

    // Check if vault target reached
    const newTotal = parseFloat(updatedVault.currentAmountUsdc);
    if (newTotal >= parseFloat(updatedVault.targetAmountUsdc) && vault.status === 'ACTIVE') {
      await prisma.sharedVault.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      // TODO: Send celebration notification to all members
    }

    logger.info({ vaultId: id, userId, amount }, '[sharedVault] Deposit');
    return res.status(200).json({
      success: true,
      message: 'Deposit successful.',
      data: {
        newVaultTotal: parseFloat(updatedVault.currentAmountUsdc),
        myContribution: parseFloat(updatedMember.contributedUsdc),
        walletBalance: parseFloat(updatedWallet.balanceUsdc),
      },
    });
  } catch (err) {
    logger.error({ err: err.message, vaultId: id, userId }, '[sharedVault] Deposit failed');
    return res.status(500).json({ success: false, message: 'Deposit failed.' });
  }
}

// ── Invite ───────────────────────────────────────────────────────────────────
async function invite(req, res) {
  const { id } = req.params;
  const { azamanId, role = 'CONTRIBUTOR' } = req.body;
  const userId = req.user.id;

  if (!azamanId) return res.status(400).json({ success: false, message: 'Azaman ID required.' });

  try {
    const vault = await prisma.sharedVault.findUnique({
      where: { id },
      include: { members: true },
    });

    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found.' });

    const myMembership = vault.members.find(m => m.userId === userId);
    if (!myMembership || (myMembership.role !== 'OWNER' && myMembership.role !== 'CO_OWNER')) {
      return res.status(403).json({ success: false, message: 'Only owners can invite.' });
    }

    const inviteUser = await prisma.user.findUnique({
      where: { azamanId },
      select: { id: true, fullName: true },
    });

    if (!inviteUser) return res.status(404).json({ success: false, message: 'User not found.' });

    // Check if already a member
    const existing = vault.members.find(m => m.userId === inviteUser.id);
    if (existing) return res.status(400).json({ success: false, message: 'Already a member.' });

    await prisma.sharedVaultMember.create({
      data: {
        sharedVaultId: id,
        userId: inviteUser.id,
        role,
        contributedUsdc: 0,
      },
    });

    return res.status(200).json({ success: true, message: `${inviteUser.fullName} added.` });
  } catch (err) {
    logger.error({ err: err.message, vaultId: id }, '[sharedVault] Invite failed');
    return res.status(500).json({ success: false, message: 'Failed to invite user.' });
  }
}

// ── Cancel ───────────────────────────────────────────────────────────────────
async function cancel(req, res) {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const vault = await prisma.sharedVault.findUnique({
      where: { id },
      include: { members: true },
    });

    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found.' });

    const myMembership = vault.members.find(m => m.userId === userId);
    if (!myMembership || myMembership.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: 'Only the owner can cancel.' });
    }

    // Refund all contributors to their wallets
    await prisma.$transaction([
      ...vault.members.map(m =>
        prisma.wallet.update({
          where: { userId: m.userId },
          data: { balanceUsdc: { increment: parseFloat(m.contributedUsdc) } },
        })
      ),
      prisma.sharedVault.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    ]);

    return res.status(200).json({ success: true, message: 'Vault cancelled. Funds returned to contributors.' });
  } catch (err) {
    logger.error({ err: err.message, vaultId: id }, '[sharedVault] Cancel failed');
    return res.status(500).json({ success: false, message: 'Failed to cancel vault.' });
  }
}

module.exports = { create, list, detail, deposit, invite, cancel };
