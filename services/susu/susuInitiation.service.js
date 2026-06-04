// services/susu/susuInitiation.service.js
// =============================================================================
// SusuInitiation_Service — Phase 5 / Workstream D (2026-06-01)
//
// The "Group-Chat-First" Susu evolution. A casual GroupChat becomes a Susu
// when its admin clicks "Initiate Susu": we bind a SusuGroup (status
// CONFIGURING) to the GroupChat, set an initiation countdown deadline, and
// create a SusuMember (PENDING_VOUCH) row for every current group member.
//
// During the countdown window every member must reach:
//   • kycStatus = VERIFIED
//   • proofOfResidencyStatus = VERIFIED
//   • accept the Liability_Contract (PENDING_CONTRACT → ACTIVE)
//
// The SusuInitiationSweep worker enforces the deadline: members who haven't
// reached ACTIVE are removed from the GroupChat; if ≥2 verified members
// remain the Susu activates (AZM-rank slots + cycles via Susu_Service),
// otherwise the initiation aborts and the SusuGroup unbinds (back to a
// plain group).
//
// This service does NOT mutate balances or run cycles — it only owns the
// initiation lifecycle. Activation is delegated to Susu_Service.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes, susuNotFound } = require('./errors');

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 24;
const FREQS = new Set(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']);
const MAX_CONTRIBUTION = new Prisma.Decimal('1000000');
// Allowed countdown windows (hours) the admin may pick.
const ALLOWED_WINDOW_HOURS = new Set([24, 48, 72, 96, 120, 168]);

class SusuInitiationService {
  constructor(prisma, {
    susuOverlayService,
    susuMemberService,
    liabilityContractService,
    notificationService,
    io,
  } = {}) {
    this.prisma = prisma;
    this.susuOverlayService = susuOverlayService;
    this.susuMemberService = susuMemberService;
    this.liabilityContractService = liabilityContractService;
    this.notificationService = notificationService;
    this.io = io;
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  async _assertGroupAdmin(groupId, userId) {
    const gm = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, removedAt: true },
    });
    if (!gm || gm.removedAt) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Not a group member.', 403);
    }
    if (gm.role !== 'ADMIN') {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Only a group admin can initiate a Susu.', 403);
    }
  }

  // ── Initiate ─────────────────────────────────────────────────────────
  /**
   * Bind a SusuGroup (CONFIGURING) to a GroupChat and open the countdown.
   * @param {object} args
   * @param {string} args.groupId    GroupChat id
   * @param {number} args.initiatorId
   * @param {string|number} args.contributionUsdc
   * @param {string} args.frequency  DAILY|WEEKLY|BIWEEKLY|MONTHLY
   * @param {number} args.windowHours  countdown length (default 72)
   */
  async initiate({ groupId, initiatorId, contributionUsdc, frequency, windowHours = 72 }) {
    await this._assertGroupAdmin(groupId, initiatorId);

    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      include: { members: { where: { removedAt: null } }, susuGroup: true },
    });
    if (!group) throw susuNotFound();
    if (group.susuGroupId) {
      throw new SusuError(ErrorCodes.SUSU_ALREADY_ACTIVE, 'This group already has a Susu.', 409);
    }

    // Validation
    if (!FREQS.has(frequency)) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, `frequency must be one of ${[...FREQS].join('/')}.`, 400);
    }
    let contribution;
    try {
      contribution = new Prisma.Decimal(contributionUsdc);
    } catch {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'contributionUsdc must be a number.', 400);
    }
    if (contribution.lte(0) || contribution.gt(MAX_CONTRIBUTION)) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, `contributionUsdc must be 0 < x ≤ ${MAX_CONTRIBUTION}.`, 400);
    }
    if (!ALLOWED_WINDOW_HOURS.has(Number(windowHours))) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, `windowHours must be one of ${[...ALLOWED_WINDOW_HOURS].join('/')}.`, 400);
    }

    const memberCount = group.members.length;
    if (memberCount < MIN_MEMBERS || memberCount > MAX_MEMBERS) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        `Group must have ${MIN_MEMBERS}..${MAX_MEMBERS} members to start a Susu (has ${memberCount}).`,
        400,
      );
    }

    // Pin the active contract at initiation time (Req 4.10)
    const activeContract = this.liabilityContractService
      ? await this.liabilityContractService.getActiveContract().catch(() => null)
      : null;

    const deadline = new Date(Date.now() + Number(windowHours) * 60 * 60 * 1000);

    const susu = await this.prisma.$transaction(async (tx) => {
      const created = await tx.susuGroup.create({
        data: {
          status: 'CONFIGURING',
          contributionUsdc: contribution,
          frequency,
          totalCycles: memberCount,
          startDate: deadline, // first cycle reference; recomputed at activation
          contractRequiredCount: memberCount,
          contractAcceptedCount: 0,
          rotationSnapshot: { pending: true, computedAt: null },
          contractVersion: activeContract?.version || null,
          contractHash: activeContract?.contractHash || null,
          initiationDeadline: deadline,
          initiatedById: initiatorId,
        },
      });

      await tx.groupChat.update({
        where: { id: groupId },
        data: { susuGroupId: created.id },
      });

      // One PENDING_VOUCH SusuMember per current group member. The
      // initiator's row is created the same way; everyone proves KYC+PoR
      // and accepts the contract during the window. cycleSlot uses a
      // negative-userId sentinel until activation rewrites slots 1..N.
      for (const gm of group.members) {
        await tx.susuMember.create({
          data: {
            susuGroupId: created.id,
            userId: gm.userId,
            cycleSlot: -gm.userId,
            trustScore: new Prisma.Decimal(100),
            status: 'PENDING_VOUCH',
            inviterId: gm.userId === initiatorId ? null : initiatorId,
          },
        });
      }

      // System message into the group chat
      await tx.groupMessage.create({
        data: {
          groupId,
          senderId: null,
          type: 'SYSTEM',
          content: 'Susu initiation started',
          metadata: {
            kind: 'SUSU_INITIATED',
            susuGroupId: created.id,
            deadline: deadline.toISOString(),
            contributionUsdc: contribution.toString(),
            frequency,
          },
        },
      });

      return created;
    });

    // Promote any members who already satisfy KYC+PoR straight to
    // PENDING_CONTRACT (so the chips show correctly immediately).
    if (this.susuMemberService) {
      const members = await this.prisma.susuMember.findMany({
        where: { susuGroupId: susu.id, status: 'PENDING_VOUCH' },
        select: { id: true },
      });
      for (const m of members) {
        await this.susuMemberService.transitionToPendingContractIfReady(m.id).catch(() => {});
      }
    }

    // Notify members + socket fanout
    this._notifyInitiated(group, susu, deadline).catch(() => {});
    if (this.io) {
      this.io.to(`group_${groupId}`).emit('group:susu_initiated', {
        groupId,
        susuGroupId: susu.id,
        deadline: deadline.toISOString(),
        contributionUsdc: Number(contribution.toFixed(2)),
        frequency,
      });
    }

    return susu;
  }

  // ── Cancel initiation (admin, before activation) ─────────────────────
  async cancelInitiation({ groupId, actorId }) {
    await this._assertGroupAdmin(groupId, actorId);
    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      include: { susuGroup: true },
    });
    if (!group || !group.susuGroupId) throw susuNotFound();
    if (group.susuGroup.status !== 'CONFIGURING') {
      throw new SusuError(ErrorCodes.SUSU_ALREADY_ACTIVE, 'Susu is no longer in configuration.', 409);
    }
    await this._abort(group.susuGroupId, groupId, 'admin cancelled');
    return { cancelled: true };
  }

  // ── Verification-status projection for the group profile ─────────────
  /**
   * Returns, for each active group member, their KYC + PoR + susu-member
   * status so the UI can render the red/yellow/green chips. Visible to any
   * group member.
   *
   * PHASE 6 / Phase 4: now includes `vouched` (boolean) per member,
   * indicating whether they have a voucher linkage (GroupMember.vouchedById
   * is set). Unvouched members must secure a voucher before the deadline or
   * they are auto-kicked.
   */
  async getInitiationStatus({ groupId, viewerId }) {
    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      include: {
        members: {
          where: { removedAt: null },
          include: {
            user: {
              select: {
                id: true, username: true, profilePictureUrl: true,
                kycStatus: true, proofOfResidencyStatus: true,
              },
            },
          },
        },
        susuGroup: {
          include: { members: true },
        },
      },
    });
    if (!group) throw susuNotFound();
    if (!group.members.some((m) => m.userId === viewerId)) throw susuNotFound();

    const susu = group.susuGroup;
    const susuMemberByUser = new Map(
      (susu?.members || []).map((sm) => [sm.userId, sm]),
    );

    // Fetch GroupMember vouch linkage for the vouched flag.
    const groupMemberVouches = await this.prisma.groupMember.findMany({
      where: { groupId, removedAt: null },
      select: { userId: true, vouchedById: true },
    });
    const vouchedByUser = new Map(
      groupMemberVouches.map((gm) => [gm.userId, !!gm.vouchedById]),
    );

    const members = group.members.map((gm) => {
      const sm = susuMemberByUser.get(gm.userId);
      return {
        userId: gm.userId,
        username: gm.user.username,
        avatar: gm.user.profilePictureUrl,
        groupRole: gm.role,
        kyc: gm.user.kycStatus,                       // UNVERIFIED|PENDING|VERIFIED|REJECTED
        por: gm.user.proofOfResidencyStatus,          // NOT_SUBMITTED|PENDING_REVIEW|VERIFIED|REJECTED|EXPIRED
        susuMemberStatus: sm?.status || null,         // PENDING_VOUCH|PENDING_CONTRACT|ACTIVE|...
        vouched: vouchedByUser.get(gm.userId) || false, // PHASE 6 / Phase 4
        ready: sm?.status === 'ACTIVE',
      };
    });

    return {
      susuGroupId: susu?.id || null,
      status: susu?.status || null,
      initiationDeadline: susu?.initiationDeadline || null,
      contributionUsdc: susu ? Number(susu.contributionUsdc) : null,
      frequency: susu?.frequency || null,
      totalCycles: susu?.totalCycles || null,
      contractVersion: susu?.contractVersion || null,
      contractHash: susu?.contractHash || null,
      memberCount: members.length,
      readyCount: members.filter((m) => m.ready).length,
      members,
    };
  }

  // ── Vouch for an unvouched member (PHASE 6 / Phase 4) ────────────────
  /**
   * Set GroupMember.vouchedById for a target member. The voucher must be
   * an existing group member. This is the manual vouch path during
   * initiation; the auto-vouch at group-join-request approval is handled
   * by GroupJoinRequestService.
   */
  async vouchMember({ groupId, voucherId, targetUserId }) {
    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      include: { members: { where: { removedAt: null } } },
    });
    if (!group) throw susuNotFound();

    const voucherMember = group.members.find((m) => m.userId === voucherId);
    const targetMember = group.members.find((m) => m.userId === targetUserId);

    if (!voucherMember) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Voucher is not a group member.', 403);
    }
    if (!targetMember) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Target is not a group member.', 404);
    }
    if (targetMember.vouchedById) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'Target already has a voucher.', 409);
    }

    await this.prisma.groupMember.update({
      where: { groupId_userId: { groupId, userId: targetUserId } },
      data: { vouchedById: voucherId },
    });

    // Notify the target that they've been vouched for.
    if (this.notificationService) {
      this.notificationService.sendNotification({
        userId: targetUserId,
        title: 'You have been vouched for',
        body: `A member has vouched for you in "${group.name}". You can now proceed with Susu acceptance.`,
        category: 'SUSU',
        actionPayload: { action: 'OPEN_GROUP', groupId },
      }).catch(() => {});
    }

    return { vouched: true };
  }

  // ── Deadline enforcement (called by the sweep worker) ────────────────
  /**
   * Process every CONFIGURING SusuGroup whose initiationDeadline has
   * passed. Removes non-ACTIVE members from the group, then activates (if
   * ≥2 ACTIVE remain) or aborts the initiation.
   */
  async sweepExpiredInitiations() {
    const now = new Date();
    const expiring = await this.prisma.susuGroup.findMany({
      where: {
        status: 'CONFIGURING',
        initiationDeadline: { not: null, lte: now },
      },
      include: {
        groupChat: { select: { id: true } },
        members: true,
      },
    });

    const results = [];
    for (const susu of expiring) {
      try {
        results.push(await this._enforceDeadline(susu));
      } catch (e) {
        console.error(`[SusuInitiationSweep] susu ${susu.id} error:`, e.message);
      }
    }
    return results;
  }

  async _enforceDeadline(susu) {
    const groupId = susu.groupChat?.id;
    const activeMembers = susu.members.filter((m) => m.status === 'ACTIVE');
    const laggards = susu.members.filter((m) => m.status !== 'ACTIVE');

    // PHASE 6 / Phase 4: also check for unvouched members. Fetch
    // GroupMember.vouchedById for all members and kick those without a
    // voucher (even if they reached ACTIVE status).
    let unvouchedActiveIds = [];
    if (groupId) {
      const groupMembers = await this.prisma.groupMember.findMany({
        where: { groupId, removedAt: null },
        select: { userId: true, vouchedById: true },
      });
      const vouchedSet = new Set(
        groupMembers.filter((gm) => gm.vouchedById).map((gm) => gm.userId),
      );
      unvouchedActiveIds = activeMembers
        .filter((m) => !vouchedSet.has(m.userId))
        .map((m) => m.userId);
    }

    // Combine laggards + unvouched actives into the removal set.
    const toRemove = [
      ...laggards,
      ...activeMembers.filter((m) => unvouchedActiveIds.includes(m.userId)),
    ];

    // Remove from the GroupChat + drop their SusuMember rows.
    for (const m of toRemove) {
      await this.prisma.$transaction(async (tx) => {
        if (groupId) {
          const reason = laggards.includes(m)
            ? 'Susu verification not completed in time'
            : 'No voucher secured by deadline';
          await tx.groupMember.updateMany({
            where: { groupId, userId: m.userId, removedAt: null },
            data: { removedAt: new Date(), removedReason: reason },
          });
        }
        await tx.susuMember.delete({ where: { id: m.id } }).catch(() => {});
      });
      this._notifyKicked(m.userId, susu, groupId).catch(() => {});
    }

    const survivingActives = activeMembers.filter(
      (m) => !unvouchedActiveIds.includes(m.userId),
    );

    if (survivingActives.length >= MIN_MEMBERS) {
      // Re-base totalCycles/contractRequiredCount to the surviving set,
      // then activate via Susu_Service (AZM-rank slots + cycles).
      await this.prisma.susuGroup.update({
        where: { id: susu.id },
        data: {
          totalCycles: survivingActives.length,
          contractRequiredCount: survivingActives.length,
          initiationDeadline: null,
        },
      });
      if (this.susuOverlayService) {
        await this.susuOverlayService.activateSusuIfReady(susu.id);
      }
      if (this.io && groupId) {
        this.io.to(`group_${groupId}`).emit('group:susu_activated', { groupId, susuGroupId: susu.id });
      }
      this._notifyActivated(survivingActives, susu, groupId).catch(() => {});
      return { susuId: susu.id, outcome: 'ACTIVATED', members: survivingActives.length, removed: toRemove.length };
    }

    // Too few verified members → abort the initiation, unbind the group.
    if (groupId) await this._abort(susu.id, groupId, 'Not enough verified members by deadline');
    return { susuId: susu.id, outcome: 'ABORTED', members: survivingActives.length, removed: toRemove.length };
  }

  // ── Abort: unbind SusuGroup, return group to plain status ────────────
  async _abort(susuGroupId, groupId, reason) {
    await this.prisma.$transaction(async (tx) => {
      await tx.groupChat.update({
        where: { id: groupId },
        data: { susuGroupId: null },
      });
      // Detach members + cancel the SusuGroup (kept for audit, status CANCELLED).
      await tx.susuMember.deleteMany({ where: { susuGroupId } });
      await tx.susuGroup.update({
        where: { id: susuGroupId },
        data: { status: 'CANCELLED', initiationDeadline: null },
      });
      await tx.groupMessage.create({
        data: {
          groupId,
          senderId: null,
          type: 'SYSTEM',
          content: 'Susu initiation cancelled',
          metadata: { kind: 'SUSU_INITIATION_ABORTED', reason },
        },
      });
    });
    if (this.io) {
      this.io.to(`group_${groupId}`).emit('group:susu_initiation_aborted', { groupId, reason });
    }
  }

  // ── Notifications ─────────────────────────────────────────────────────
  async _notifyInitiated(group, susu, deadline) {
    if (!this.notificationService) return;
    for (const gm of group.members) {
      this.notificationService.sendNotification({
        userId: gm.userId,
        title: 'Susu starting in your group',
        body: `Verify your identity and proof of residency before ${deadline.toUTCString()} to join the Susu in "${group.name}".`,
        category: 'SUSU',
        actionPayload: { action: 'OPEN_GROUP', groupId: group.id, susuGroupId: susu.id },
      }).catch(() => {});
    }
  }

  async _notifyKicked(userId, susu, groupId) {
    if (!this.notificationService) return;
    this.notificationService.sendNotification({
      userId,
      title: 'Removed from Susu group',
      body: 'You did not complete identity + residency verification in time, so you were removed from the Susu group.',
      category: 'SUSU',
      actionPayload: { action: 'OPEN_PROOF_OF_RESIDENCY' },
    }).catch(() => {});
  }

  async _notifyActivated(members, susu, groupId) {
    if (!this.notificationService) return;
    for (const m of members) {
      this.notificationService.sendNotification({
        userId: m.userId,
        title: 'Susu is now active',
        body: 'Your Susu has been activated. Tap to view your payout slot and cycle schedule.',
        category: 'SUSU',
        actionPayload: { action: 'OPEN_SUSU', susuId: susu.id },
      }).catch(() => {});
    }
  }
}

module.exports = SusuInitiationService;
