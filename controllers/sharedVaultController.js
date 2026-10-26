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
const ledger = require('../services/ledgerService');

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

    // NOTE: there is deliberately NO vault-status check on this stale
    // snapshot. The ACTIVE predicate lives INSIDE the transaction on the
    // vault increment itself (see below) — an outside check is exactly
    // the TOCTOU window the review flagged, and would only ever return a
    // verdict about the PAST. Membership is structurally stable, so the
    // membership 403 stays here.
    const membership = vault.members.find(m => m.userId === userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Not a member of this vault.' });

    // Money authority repair: this flow previously referenced a
    // `prisma.wallet` model that DOES NOT EXIST in the current schema (the
    // unified-ledger migration moved spendable USDC onto User.availableBalance
    // — the same authority every other money path uses). The deposit now
    // debits User.availableBalance with a CONDITIONAL (single-winner) update:
    // two concurrent deposits can never spend the same stale balance twice.
    const operation = res.locals?.financialOperation || null;
    const idemKey = operation
        ? `fo_${operation.id}`
        : `srv_sharedvault_${userId}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let data;
    await prisma.$transaction(async (tx) => {
        // Single-winner conditional debit — the DB nonneg CHECK is a
        // secondary invariant, never the guard.
        const debit = await tx.user.updateMany({
            where: { id: userId, availableBalance: { gte: amount } },
            data: {
                availableBalance: { decrement: amount },
                escrowLockedBalance: { increment: amount },
            },
        });
        if (debit.count !== 1) {
            const err = new Error('Insufficient balance.');
            err.code = 'INSUFFICIENT_FUNDS';
            throw err;
        }

        // RACE FIX: the ACTIVE check above ran OUTSIDE the transaction
        // against a stale snapshot; the writes below could land AFTER a
        // concurrent cancel had already flipped the vault (and refunded
        // its members), silently locking funds into a cancelled vault.
        // The vault increment is now a CONDITIONAL single-winner write on
        // `status: 'ACTIVE'` INSIDE this transaction: a deposit racing a
        // cancel either wins the row lock while the vault is still
        // ACTIVE (then the cancel refunds the new contribution too —
        // cancel re-reads members in ITS transaction), or finds the vault
        // no longer ACTIVE, refuses, and the whole transaction —
        // including the user debit — rolls back.
        const vaultBump = await tx.sharedVault.updateMany({
            where: { id, status: 'ACTIVE' },
            data: { currentAmountUsdc: { increment: amount } },
        });
        if (vaultBump.count !== 1) {
            const err = new Error('Vault is not active.');
            err.code = 'VAULT_NOT_ACTIVE';
            throw err;
        }

        const [updatedVault, updatedMember] = await Promise.all([
            tx.sharedVault.findUnique({ where: { id } }),
            tx.sharedVaultMember.update({
                where: { id: membership.id },
                data: { contributedUsdc: { increment: amount } },
            }),
        ]);

        // Target reached → guarded completion transition (single-winner:
        // a concurrent second deposit cannot double-flip COMPLETED).
        const newTotal = parseFloat(updatedVault.currentAmountUsdc);
        if (newTotal >= parseFloat(updatedVault.targetAmountUsdc)) {
            await tx.sharedVault.updateMany({
                where: { id, status: 'ACTIVE' },
                data: { status: 'COMPLETED', completedAt: new Date() },
            });
        }

        // §P.4 AUTHORITATIVE LEDGER — same transaction, idempotent on the
        // durable operation key:
        //   D user:{userId}:liability        — spendable liability down
        //   C escrow:shared-vault-{id}:locked — vault restriction up
        await ledger.post(tx, {
            idempotencyKey: `ledger:shared-vault:deposit:${idemKey}`,
            entryType: 'SHARED_VAULT_DEPOSIT',
            description: 'Shared vault deposit — spendable balance locked into vault restriction',
            userId,
            relatedEntity: 'sharedVault',
            relatedEntityId: id,
            lines: [
                { account: `user:${userId}:liability`, debit: amount.toFixed(8) },
                { account: `escrow:shared-vault-${id}:locked`, credit: amount.toFixed(8) },
            ],
        });

        data = {
            newVaultTotal: parseFloat(updatedVault.currentAmountUsdc),
            myContribution: parseFloat(updatedMember.contributedUsdc),
        };
    });

    logger.info({ vaultId: id, userId, amount }, '[sharedVault] Deposit');
    return res.status(200).json({
      success: true,
      message: 'Deposit successful.',
      data,
    });
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err?.code === 'VAULT_NOT_ACTIVE') {
      return res.status(409).json({ success: false, code: 'VAULT_NOT_ACTIVE', message: err.message });
    }
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

    // Cancellation is a REVERSAL of already-authorized deposits: it stays
    // available during an FX outage (documented settlement-protection
    // exception — see docs/native-ghs-fx-audit.md §4.1). Its integrity
    // requirements are SINGLE-WINNER and TRANSACTION-CONSISTENT SNAPSHOT
    // (review fix): the CANCELLED transition flips FIRST, on an EXPLICIT
    // eligible state (ACTIVE only — a COMPLETED vault's funds are already
    // spent on the goal and must never be "refunded"; the old
    // `not: CANCELLED` predicate would cancel a COMPLETED vault), inside
    // the same interactive transaction as the refunds. Members are
    // re-read INSIDE that transaction after the claim is won — never from
    // the stale pre-transaction snapshot, which could omit a deposit that
    // raced in after the outer read and strand that member's funds.
    let cancelled = false;
    let refundState = 'NOT_CANCELLABLE';
    await prisma.$transaction(async (tx) => {
      const transition = await tx.sharedVault.updateMany({
        where: { id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (transition.count !== 1) {
        // Honest refusal: distinguish an already-cancelled replay from a
        // vault that is not in a cancellable state at all.
        const current = await tx.sharedVault.findUnique({
          where: { id },
          select: { status: true },
        });
        refundState = current?.status === 'CANCELLED' ? 'ALREADY_CANCELLED' : 'NOT_CANCELLABLE';
        return;
      }

      // Refunds derive from the TRANSACTION-CONSISTENT member rows: read
      // them here, after the claim won the row lock, so a deposit that
      // committed before our claim is included in the refunds.
      const members = await tx.sharedVaultMember.findMany({
        where: { sharedVaultId: id },
      });

      // Refund each contributor to the REAL money authority
      // (User.availableBalance) and release the matching escrow
      // restriction, with the §P.4 ledger reversal of the deposit legs.
      for (const m of members) {
        const contributed = parseFloat(m.contributedUsdc);
        if (!(contributed > 0)) continue;
        await tx.user.update({
          where: { id: m.userId },
          data: {
            availableBalance: { increment: contributed },
            escrowLockedBalance: { decrement: contributed },
          },
        });
        await ledger.post(tx, {
          idempotencyKey: `ledger:shared-vault:refund:${id}:${m.userId}`,
          entryType: 'SHARED_VAULT_REFUND',
          description: 'Shared vault cancelled — vault restriction released back to spendable balance',
          userId: m.userId,
          relatedEntity: 'sharedVault',
          relatedEntityId: id,
          lines: [
            { account: `escrow:shared-vault-${id}:locked`, debit: contributed.toFixed(8) },
            { account: `user:${m.userId}:liability`, credit: contributed.toFixed(8) },
          ],
        });
      }
      cancelled = true;
    });

    if (!cancelled) {
      if (refundState === 'ALREADY_CANCELLED') {
        return res.status(409).json({ success: false, code: 'VAULT_ALREADY_CANCELLED', message: 'This shared vault has already been cancelled.' });
      }
      return res.status(409).json({ success: false, code: 'VAULT_NOT_CANCELLABLE', message: 'Only an active vault can be cancelled.' });
    }
    return res.status(200).json({ success: true, message: 'Vault cancelled. Funds returned to contributors.' });
  } catch (err) {
    logger.error({ err: err.message, vaultId: id }, '[sharedVault] Cancel failed');
    return res.status(500).json({ success: false, message: 'Failed to cancel vault.' });
  }
}

module.exports = { create, list, detail, deposit, invite, cancel };
