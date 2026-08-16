// services/susu/adminSusuMonitor.service.js
// =============================================================================
// AdminSusuMonitor_Service — Phase 5 / Workstream E (Admin Web Portal)
//
// Read + operator-action surface for the admin portal's Susu monitoring:
//   • listSusus          — paginated roster of every SusuGroup with status,
//                          member/cycle counts, frozen state, next cycle.
//   • getSusuDetail      — full drill-down: members (status, slot, default),
//                          cycle schedule (incl. graceUntil), frozen reason,
//                          related War Room alerts.
//   • getMemberDetail    — a single user's KYC identity (idNumber DECRYPTED
//                          for the authorized admin), PoR status, plus their
//                          cross-Susu strike/default history (defaults,
//                          seizures, voucher slashes received).
//   • resolveFrozenSusu  — RESUME (lift the freeze) or REFUND_AND_CLOSE
//                          (refund the current cycle's PAID contributions,
//                          cancel the Susu, default remaining cycles), per
//                          design.md "Admin operator endpoints".
//
// All methods are invoked only from adminOnly routes. Reads project a
// generous field set (this is the operator's back office, not the privacy-
// gated member view).
// =============================================================================

const logger = require('../../src/config/logger');
const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('./errors');
const fieldCipher = require('../crypto/fieldCipher');

class AdminSusuMonitorService {
  constructor(prisma, { susuVouchService, notificationService } = {}) {
    if (!prisma) throw new Error('AdminSusuMonitorService: prisma required');
    this.prisma = prisma;
    this.susuVouchService = susuVouchService;
    this.notificationService = notificationService;
  }

  // ── List all Susus (paginated) ────────────────────────────────────────
  async listSusus({ status, take = 50, cursor } = {}) {
    const where = {};
    if (status) where.status = status;
    const rows = await this.prisma.susuGroup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      select: {
        id: true,
        status: true,
        contributionUsdc: true,
        frequency: true,
        totalCycles: true,
        startDate: true,
        activatedAt: true,
        frozenAt: true,
        frozenReason: true,
        initiationDeadline: true,
        createdAt: true,
        groupChat: { select: { id: true, name: true } },
        _count: { select: { members: true, cycles: true } },
      },
    });

    // Per-Susu: count ACTIVE / DEFAULTED members + find the next live cycle.
    const enriched = await Promise.all(rows.map(async (s) => {
      const [activeCount, defaultedCount, nextCycle] = await Promise.all([
        this.prisma.susuMember.count({ where: { susuGroupId: s.id, status: 'ACTIVE' } }),
        this.prisma.susuMember.count({ where: { susuGroupId: s.id, status: 'DEFAULTED' } }),
        this.prisma.susuCycle.findFirst({
          where: { susuGroupId: s.id, status: { in: ['PENDING', 'COLLECTING', 'COLLECTING_GRACE'] } },
          orderBy: { cycleNumber: 'asc' },
          select: { id: true, cycleNumber: true, collectionDate: true, status: true, graceUntil: true },
        }),
      ]);
      return {
        id: s.id,
        name: s.groupChat?.name || 'Susu',
        groupChatId: s.groupChat?.id || null,
        status: s.status,
        contributionUsdc: s.contributionUsdc.toString(),
        frequency: s.frequency,
        totalCycles: s.totalCycles,
        memberCount: s._count.members,
        cycleCount: s._count.cycles,
        activeMembers: activeCount,
        defaultedMembers: defaultedCount,
        frozen: s.status === 'FROZEN_DISPUTE',
        frozenAt: s.frozenAt,
        frozenReason: s.frozenReason,
        activatedAt: s.activatedAt,
        initiationDeadline: s.initiationDeadline,
        createdAt: s.createdAt,
        nextCycle,
      };
    }));
    return enriched;
  }

  // ── Single Susu drill-down ────────────────────────────────────────────
  async getSusuDetail(susuGroupId) {
    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: susuGroupId },
      select: {
        id: true,
        status: true,
        contributionUsdc: true,
        frequency: true,
        totalCycles: true,
        startDate: true,
        activatedAt: true,
        frozenAt: true,
        frozenReason: true,
        contractVersion: true,
        initiationDeadline: true,
        rotationSnapshot: true,
        createdAt: true,
        groupChat: { select: { id: true, name: true } },
        members: {
          orderBy: { cycleSlot: 'asc' },
          select: {
            id: true,
            userId: true,
            cycleSlot: true,
            status: true,
            autoRetainNextCycle: true,
            defaultedAt: true,
            totalSeizedUsdc: true,
            inviterId: true,
            user: {
              select: {
                id: true, username: true, profilePictureUrl: true,
                kycStatus: true, proofOfResidencyStatus: true, trustRating: true,
              },
            },
          },
        },
        cycles: {
          orderBy: { cycleNumber: 'asc' },
          select: {
            id: true, cycleNumber: true, collectionDate: true, status: true,
            payoutUserId: true, payoutAmount: true, paidOutAt: true,
            escrowDivertedAt: true, graceUntil: true, defaultsCount: true,
          },
        },
        warRoomAlerts: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, alertType: true, cycleId: true, payload: true,
            createdAt: true, acknowledgedAt: true, resolution: true, resolvedAt: true,
          },
        },
      },
    });
    if (!susu) {
      throw new SusuError(ErrorCodes.SUSU_NOT_FOUND, 'Susu not found.', 404);
    }
    return {
      ...susu,
      contributionUsdc: susu.contributionUsdc.toString(),
      projectedPool: new Prisma.Decimal(susu.contributionUsdc).mul(susu.totalCycles).toString(),
      members: susu.members.map((m) => ({
        susuMemberId: m.id,
        userId: m.userId,
        displayName: m.user.username,
        avatar: m.user.profilePictureUrl,
        payoutSlot: m.cycleSlot,
        status: m.status,
        autoRetainNextCycle: m.autoRetainNextCycle,
        defaultedAt: m.defaultedAt,
        totalSeizedUsdc: m.totalSeizedUsdc?.toString?.() || '0',
        kycStatus: m.user.kycStatus,
        proofOfResidencyStatus: m.user.proofOfResidencyStatus,
        trustRating: m.user.trustRating,
        inviterId: m.inviterId,
      })),
      cycles: susu.cycles.map((c) => ({
        ...c,
        payoutAmount: c.payoutAmount?.toString?.() || '0',
      })),
    };
  }

  // ── Member detail + idNumber decryption + strike/default history ──────
  async getMemberDetail(userId) {
    const uid = parseInt(userId, 10);
    if (Number.isNaN(uid)) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Invalid user id.', 400);
    }
    const user = await this.prisma.user.findUnique({
      where: { id: uid },
      select: {
        id: true, username: true, email: true, displayName: true,
        phoneNumber: true, country: true, profilePictureUrl: true,
        kycStatus: true, legalName: true, idType: true, idNumber: true,
        idImageFront: true, idImageBack: true,
        proofOfResidencyStatus: true, proofOfResidencyUrl: true,
        proofOfResidencySubmittedAt: true, proofOfResidencyVerifiedAt: true,
        proofOfResidencyRejectionReason: true,
        trustRating: true, azmBalance: true, availableBalance: true,
        strikeCount: true, banStatus: true, createdAt: true,
      },
    });
    if (!user) {
      throw new SusuError(ErrorCodes.SUSU_NOT_FOUND, 'User not found.', 404);
    }

    // Decrypt the at-rest-encrypted idNumber for the authorized admin view.
    // tryDecrypt returns null on any failure (missing key / bad envelope)
    // so a bad row degrades to null instead of throwing. Legacy plaintext
    // rows pass through unchanged.
    const idNumberPlain = user.idNumber ? fieldCipher.tryDecrypt(user.idNumber) : null;

    // Cross-Susu Susu membership + default footprint.
    const memberships = await this.prisma.susuMember.findMany({
      where: { userId: uid },
      orderBy: { susu: { createdAt: 'desc' } },
      select: {
        id: true, susuGroupId: true, status: true, cycleSlot: true,
        defaultedAt: true, totalSeizedUsdc: true,
        susu: { select: { groupChat: { select: { name: true } }, status: true } },
      },
    });

    // Seizures + voucher slashes (their invitees' defaults that hit them).
    const [seizures, slashesReceived, slashesIssued, defaultCount] = await Promise.all([
      this.prisma.susuContribution.findMany({
        where: { userId: uid, status: 'SEIZED' },
        orderBy: { collectedAt: 'desc' },
        take: 50,
        select: {
          id: true, cycleId: true, seizedFromAvailable: true, shortfall: true, collectedAt: true,
        },
      }),
      this.prisma.voucherSlashLog.findMany({
        where: { vouchedUserId: uid },
        orderBy: { appliedAt: 'desc' },
        take: 50,
        select: { id: true, voucherId: true, susuGroupId: true, azmDeducted: true, appliedAt: true },
      }),
      this.prisma.voucherSlashLog.findMany({
        where: { voucherId: uid },
        orderBy: { appliedAt: 'desc' },
        take: 50,
        select: {
          id: true, vouchedUserId: true, susuGroupId: true, azmDeducted: true,
          trustRatingBefore: true, trustRatingAfter: true, appliedAt: true,
        },
      }),
      this.prisma.susuMember.count({ where: { userId: uid, status: 'DEFAULTED' } }),
    ]);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        phoneNumber: user.phoneNumber,
        country: user.country,
        avatar: user.profilePictureUrl,
        kycStatus: user.kycStatus,
        legalName: user.legalName,
        idType: user.idType,
        idNumber: idNumberPlain,                  // DECRYPTED for admin
        idNumberOnFile: !!user.idNumber,
        idImageFront: user.idImageFront,
        idImageBack: user.idImageBack,
        proofOfResidencyStatus: user.proofOfResidencyStatus,
        proofOfResidencyUrl: user.proofOfResidencyUrl,
        proofOfResidencySubmittedAt: user.proofOfResidencySubmittedAt,
        proofOfResidencyVerifiedAt: user.proofOfResidencyVerifiedAt,
        proofOfResidencyRejectionReason: user.proofOfResidencyRejectionReason,
        trustRating: user.trustRating,
        azmBalance: user.azmBalance?.toString?.() || '0',
        availableBalance: user.availableBalance?.toString?.() || '0',
        strikeCount: user.strikeCount,
        banStatus: user.banStatus,
        createdAt: user.createdAt,
      },
      history: {
        defaultCount,
        memberships: memberships.map((m) => ({
          susuMemberId: m.id,
          susuGroupId: m.susuGroupId,
          susuName: m.susu?.groupChat?.name || 'Susu',
          susuStatus: m.susu?.status,
          memberStatus: m.status,
          payoutSlot: m.cycleSlot,
          defaultedAt: m.defaultedAt,
          totalSeizedUsdc: m.totalSeizedUsdc?.toString?.() || '0',
        })),
        seizures: seizures.map((s) => ({
          id: s.id,
          cycleId: s.cycleId,
          seizedFromAvailable: s.seizedFromAvailable?.toString?.() || '0',
          shortfall: s.shortfall?.toString?.() || '0',
          at: s.collectedAt,
        })),
        slashesReceived: slashesReceived.map((s) => ({
          id: s.id,
          voucherId: s.voucherId,
          susuGroupId: s.susuGroupId,
          azmDeducted: s.azmDeducted?.toString?.() || '0',
          at: s.appliedAt,
        })),
        slashesIssued: slashesIssued.map((s) => ({
          id: s.id,
          vouchedUserId: s.vouchedUserId,
          susuGroupId: s.susuGroupId,
          azmDeducted: s.azmDeducted?.toString?.() || '0',
          trustRatingBefore: s.trustRatingBefore,
          trustRatingAfter: s.trustRatingAfter,
          at: s.appliedAt,
        })),
      },
    };
  }

  // ── Resolve a FROZEN_DISPUTE Susu (RESUME | REFUND_AND_CLOSE) ──────────
  async resolveFrozenSusu({ adminUserId, susuGroupId, action, notes, alertId }) {
    if (!['RESUME', 'REFUND_AND_CLOSE'].includes(action)) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'action must be RESUME or REFUND_AND_CLOSE.', 400);
    }
    const trimmed = (notes || '').trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'notes must be 1..500 characters.', 400);
    }

    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: susuGroupId },
      select: { id: true, status: true, groupChat: { select: { name: true } } },
    });
    if (!susu) {
      throw new SusuError(ErrorCodes.SUSU_NOT_FOUND, 'Susu not found.', 404);
    }
    if (susu.status !== 'FROZEN_DISPUTE') {
      throw new SusuError(ErrorCodes.SUSU_FROZEN, `Susu is ${susu.status}, not FROZEN_DISPUTE.`, 409);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (action === 'RESUME') {
        // Lift the freeze; cycles resume on the next scheduler tick.
        await tx.susuGroup.update({
          where: { id: susuGroupId },
          data: { status: 'ACTIVE', frozenAt: null, frozenReason: null },
        });
        return { status: 'ACTIVE', refundedMembers: 0, refundedTotal: '0' };
      }

      // REFUND_AND_CLOSE: refund every PAID contribution belonging to a
      // cycle of this Susu that has NOT yet been paid out (i.e. the frozen
      // pool that never reached a recipient). Then cancel the Susu and
      // default every still-PENDING / grace cycle.
      const refundableCycles = await tx.susuCycle.findMany({
        where: { susuGroupId, status: { in: ['PENDING', 'COLLECTING', 'COLLECTING_GRACE'] } },
        select: { id: true },
      });
      const cycleIds = refundableCycles.map((c) => c.id);

      let refundedMembers = 0;
      let refundedTotal = new Prisma.Decimal(0);

      if (cycleIds.length > 0) {
        const paid = await tx.susuContribution.findMany({
          where: { cycleId: { in: cycleIds }, status: 'PAID' },
          select: { id: true, userId: true, amountUsdc: true },
        });
        for (const c of paid) {
          const amount = new Prisma.Decimal(c.amountUsdc);
          await tx.user.update({
            where: { id: c.userId },
            data: { availableBalance: { increment: amount } },
          });
          await tx.transactionHistory.create({
            data: {
              userId: c.userId,
              type: 'SUSU_REFUND',
              amountUsdc: amount,
              status: 'COMPLETED',
            },
          }).catch(() => {});
          refundedMembers += 1;
          refundedTotal = refundedTotal.plus(amount);
        }
        // Default the still-open cycles (no payout will ever happen).
        await tx.susuCycle.updateMany({
          where: { id: { in: cycleIds } },
          data: { status: 'DEFAULTED' },
        });
      }

      await tx.susuGroup.update({
        where: { id: susuGroupId },
        data: { status: 'CANCELLED' },
      });

      // Void vouches tied to this Susu (no slash) — mirrors cancelSusu.
      if (this.susuVouchService) {
        await this.susuVouchService.voidVouchesForSusu(susuGroupId, tx);
      }

      return {
        status: 'CANCELLED',
        refundedMembers,
        refundedTotal: refundedTotal.toString(),
      };
    });

    // Mark the related unresolved alert(s) for this Susu as resolved.
    await this.prisma.adminWarRoomAlert.updateMany({
      where: alertId ? { id: alertId } : { susuGroupId, resolvedAt: null },
      data: {
        resolution: action,
        resolvedAt: new Date(),
        resolvedBy: adminUserId,
        acknowledgedAt: new Date(),
        acknowledgedBy: adminUserId,
      },
    });

    // Notify affected members (best-effort, post-commit).
    if (this.notificationService) {
      const members = await this.prisma.susuMember.findMany({
        where: { susuGroupId },
        select: { userId: true },
      });
      const title = action === 'RESUME' ? 'Susu Resumed' : 'Susu Closed & Refunded';
      const body = action === 'RESUME'
        ? `An admin reviewed the dispute on "${susu.groupChat?.name || 'your Susu'}" and resumed it.`
        : `"${susu.groupChat?.name || 'Your Susu'}" was closed after review. Any funds you contributed to the open cycle have been refunded.`;
      for (const m of members) {
        setImmediate(() => this.notificationService.sendNotification({
          userId: m.userId,
          title,
          body,
          category: 'SUSU',
          actionPayload: { action: 'OPEN_SUSU', susuId: susuGroupId },
        }).catch(() => {}));
      }
    }

    return { susu: { id: susuGroupId, status: result.status }, ...result };
  }
}

module.exports = AdminSusuMonitorService;
