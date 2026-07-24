// services/susu/susu.service.js
// =============================================================================
// Susu_Service (overlay) — Reqs 2, 5, 8, 9
//
// This service complements (does not replace) the legacy services/susuService.js
// which already implements the deployed createSusu / acceptContract /
// cancel flow keyed on GroupChat. The overlay adds:
//
//   - createSusuStandalone: an invite-list-based create that does NOT require
//     a pre-existing GroupChat, used by the new Susu hub UI
//   - cancelWithVouchVoid: invokes vouch voiding (Req 7.11) + acceptance
//     deletion atomically inside the cancel transaction
//   - activateSusuIfReady: Req 8.7 + Req 9 atomic activation (snapshot AZM
//     ranking, write payoutSlot per member, generate cycles, set ACTIVE)
//   - markSusuCompletedIfDone: Req 10.10 finalization
//   - assertVisibleToCaller: Req 5 privacy gate (uniform 404 fallthrough)
// =============================================================================

const logger = require('../../src/config/logger');
const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes, susuNotFound } = require('./errors');
const SusuRepo = require('../../repositories/susuRepo');
const SusuMemberRepo = require('../../repositories/susuMemberRepo');
const LiabilityContractRepo = require('../../repositories/liabilityContractRepo');

const FREQUENCY_DAYS = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 30 };
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 24;
const MAX_CONTRIBUTION = new Prisma.Decimal('1000000');

class SusuService {
  constructor(prisma, { susuVouchService, susuMemberService, liabilityContractService } = {}) {
    this.prisma = prisma;
    this.repo = new SusuRepo(prisma);
    this.memberRepo = new SusuMemberRepo(prisma);
    this.liabilityRepo = new LiabilityContractRepo(prisma);
    this.susuVouchService = susuVouchService;
    this.susuMemberService = susuMemberService;
    this.liabilityContractService = liabilityContractService;
  }

  // ── Req 2 KYC + PoR gate ────────────────────────────────────────────
  async _assertKycAndResidency(userId) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true, proofOfResidencyStatus: true },
    });
    if (!u || u.kycStatus !== 'VERIFIED') {
      throw new SusuError(
        ErrorCodes.KYC_REQUIRED,
        'KYC verification required.',
        403,
      );
    }
    if (u.proofOfResidencyStatus !== 'VERIFIED') {
      throw new SusuError(
        ErrorCodes.RESIDENCY_REQUIRED,
        'Proof of Residency required.',
        403,
      );
    }
  }

  // ── Req 5 visibility gate, returns the SusuGroup row or 404s ────────
  async assertVisibleToCaller(susuGroupId, callerId, { allowInitiatorWhileConfiguring = true } = {}) {
    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: susuGroupId },
      include: {
        members: {
          where: { userId: callerId },
          select: { id: true, status: true, userId: true },
        },
        groupChat: { select: { id: true, createdById: true } },
      },
    });
    if (!susu) throw susuNotFound();

    const myMember = susu.members[0];
    const isActiveMember = myMember && myMember.status === 'ACTIVE';
    const isInitiator = susu.groupChat?.createdById === callerId;

    if (isActiveMember) return susu;
    if (allowInitiatorWhileConfiguring && isInitiator && susu.status === 'CONFIGURING') return susu;

    throw susuNotFound();
  }

  // ── Req 8 create ────────────────────────────────────────────────────
  /**
   * Standalone Susu creation — does NOT require a pre-existing GroupChat.
   * Creates a private GroupChat under the hood, then a SusuGroup bound
   * to it. The legacy `services/susuService.js` continues to handle
   * the GroupChat-driven path.
   *
   * @param {object} args
   * @param {number} args.initiatorId
   * @param {string} args.name
   * @param {string|number} args.contributionUsdc
   * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} args.frequency
   * @param {Array} args.invites — channel-discriminated invite specs that are
   *                              fanned out as PENDING SusuInvite rows inside
   *                              the same transaction. Each spec is one of:
   *                                { channel: 'FRIEND', inviteeUserId: number }
   *                                { channel: 'PHONE',  inviteePhone:  string }
   *                                { channel: 'LINK' }
   */
  async createSusuStandalone({ initiatorId, name, contributionUsdc, frequency, invites }) {
    // Caller-side gate (Req 2.1)
    await this._assertKycAndResidency(initiatorId);

    // Validation (Req 8.1, 8.2)
    if (!name || typeof name !== 'string' || name.length < 3 || name.length > 60) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'name must be 3..60 chars.', 400);
    }
    if (!FREQUENCY_DAYS[frequency]) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, `frequency must be one of ${Object.keys(FREQUENCY_DAYS).join('/')}.`, 400);
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
    const inviteCount = Array.isArray(invites) ? invites.length : 0;
    const memberCount = inviteCount + 1; // initiator counts (Req 8.2)
    if (memberCount < MIN_MEMBERS || memberCount > MAX_MEMBERS) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        `Total member count (${memberCount}) must be ${MIN_MEMBERS}..${MAX_MEMBERS}.`,
        400,
      );
    }

    // Pin the active liability contract at creation time (Req 4.10).
    const activeContract = await this.liabilityRepo.getActiveContract();
    if (!activeContract) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        'No active liability contract published.',
        500,
      );
    }

    // Create the entire structure in one transaction.
    return this.prisma.$transaction(async (tx) => {
      // Lightweight private GroupChat anchor for the Susu — name mirrors
      // the Susu name, description marks it Susu-only.
      const groupChat = await tx.groupChat.create({
        data: {
          name,
          description: 'Private Susu (system-managed)',
          createdById: initiatorId,
          status: 'ACTIVE',
        },
      });
      // Initiator joins as ADMIN GroupMember (the role Circuit Breaker
      // checks against in Req 11.9 lives on GroupMember).
      await tx.groupMember.create({
        data: { groupId: groupChat.id, userId: initiatorId, role: 'ADMIN' },
      });

      // SusuGroup row.
      const startDate = new Date();
      const susu = await tx.susuGroup.create({
        data: {
          contributionUsdc: contribution,
          frequency,
          totalCycles: memberCount,
          startDate,
          contractAcceptedCount: 0,
          contractRequiredCount: memberCount,
          rotationSnapshot: { pending: true, computedAt: null },
          contractVersion: activeContract.version,
          contractHash: activeContract.contractHash,
        },
      });

      // Bind GroupChat → SusuGroup
      await tx.groupChat.update({
        where: { id: groupChat.id },
        data: { susuGroupId: susu.id },
      });

      // Initiator's own SusuMember row enters PENDING_CONTRACT directly
      // since they passed the KYC + PoR gate above. cycleSlot uses a
      // negative-userId sentinel so the unique (susuGroupId, cycleSlot)
      // constraint doesn't fire while members are still onboarding;
      // activation rewrites every slot to its final 1..N value.
      await tx.susuMember.create({
        data: {
          susuGroupId: susu.id,
          userId: initiatorId,
          cycleSlot: -initiatorId,
          trustScore: new Prisma.Decimal(100),
          status: 'PENDING_CONTRACT',
        },
      });

      // Fan-out PENDING SusuInvite rows for the supplied invite specs
      // (Req 6.1 / 6.2 / 6.5). Validation here is intentionally light —
      // the dedicated SusuInvite_Service.createInvite path is for users
      // adding invites later. At create time, malformed specs simply
      // skip; the controller is expected to have already validated the
      // shape of the body.
      const crypto = require('crypto');
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      for (const inv of invites || []) {
        if (inv.channel === 'FRIEND' && typeof inv.inviteeUserId === 'number') {
          await tx.susuInvite.create({
            data: {
              susuGroupId: susu.id,
              inviterId: initiatorId,
              inviteeUserId: inv.inviteeUserId,
              channel: 'FRIEND',
              status: 'PENDING',
              expiresAt,
            },
          });
        } else if (inv.channel === 'PHONE' && typeof inv.inviteePhone === 'string') {
          // Try to bind to a verified user immediately
          const matched = await tx.user.findFirst({
            where: { phoneNumber: inv.inviteePhone, phoneVerified: true },
            select: { id: true },
          });
          await tx.susuInvite.create({
            data: {
              susuGroupId: susu.id,
              inviterId: initiatorId,
              inviteePhone: inv.inviteePhone,
              inviteeUserId: matched?.id || null,
              channel: 'PHONE',
              status: 'PENDING',
              expiresAt,
            },
          });
        } else if (inv.channel === 'LINK') {
          await tx.susuInvite.create({
            data: {
              susuGroupId: susu.id,
              inviterId: initiatorId,
              channel: 'LINK',
              token: crypto.randomBytes(32).toString('base64url'),
              status: 'PENDING',
              expiresAt,
            },
          });
        }
      }

      return susu;
    });
  }

  // ── Req 8 cancel ───────────────────────────────────────────────────
  async cancelWithVouchVoid({ susuGroupId, callerId }) {
    const susu = await this.repo.findById(susuGroupId);
    if (!susu) throw susuNotFound();

    // Initiator-only: look up the parent GroupChat
    const groupChat = await this.prisma.groupChat.findFirst({
      where: { susuGroupId },
      select: { createdById: true },
    });
    if (!groupChat || groupChat.createdById !== callerId) {
      throw new SusuError(ErrorCodes.SUSU_CANCEL_FORBIDDEN, 'Only the initiator may cancel this Susu.', 403);
    }
    if (susu.status !== 'CONFIGURING') {
      throw new SusuError(ErrorCodes.SUSU_ALREADY_ACTIVE, `Cannot cancel a Susu in status ${susu.status}.`, 409);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.susuGroup.update({
        where: { id: susuGroupId },
        data: { status: 'CANCELLED' },
      });
      // Void all vouches (Req 7.11)
      if (this.susuVouchService) {
        await this.susuVouchService.voidVouchesForSusu(susuGroupId, tx);
      }
      // Wipe acceptance audit (kept simple per the repo; in a high-audit
      // setting the LiabilityAcceptance rows could carry a soft flag
      // instead of being deleted)
      await tx.liabilityAcceptance.deleteMany({ where: { susuGroupId } });
      // Revoke any pending invites
      await tx.susuInvite.updateMany({
        where: { susuGroupId, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      return tx.susuGroup.findUnique({ where: { id: susuGroupId } });
    });
  }

  // ── Req 8.7 + Req 9 activate ───────────────────────────────────────
  /**
   * If every SusuMember of the Susu is now ACTIVE, transition the
   * SusuGroup from CONFIGURING → ACTIVE. Snapshot AZM ranking, assign
   * payoutSlots (1..N), generate `cycleCount` SusuCycle rows, all
   * inside `tx` (Req 9.4 atomicity).
   */
  async activateSusuIfReady(susuGroupId, tx = this.prisma) {
    const susu = await tx.susuGroup.findUnique({
      where: { id: susuGroupId },
      include: {
        members: { include: { user: { select: { id: true, azmBalance: true, createdAt: true } } } },
      },
    });
    if (!susu) throw susuNotFound();
    if (susu.status !== 'CONFIGURING') return susu;
    const allActive = susu.members.every(m => m.status === 'ACTIVE');
    if (!allActive) return susu;
    if (susu.members.length !== susu.contractRequiredCount) return susu;

    // AZM-rank ordering: azmBalance DESC, createdAt ASC, id ASC (Req 9.1)
    const ranked = [...susu.members].sort((a, b) => {
      const az = new Prisma.Decimal(b.user.azmBalance).cmp(new Prisma.Decimal(a.user.azmBalance));
      if (az !== 0) return az;
      const ca = a.user.createdAt.getTime() - b.user.createdAt.getTime();
      if (ca !== 0) return ca;
      return a.user.id - b.user.id;
    });

    const activatedAt = new Date();
    const intervalDays = FREQUENCY_DAYS[susu.frequency];

    // Assign payoutSlot per member (1..N) and emit cycles
    const rotationSnapshot = [];
    for (let i = 0; i < ranked.length; i++) {
      const slot = i + 1;
      const m = ranked[i];
      await tx.susuMember.update({
        where: { id: m.id },
        data: { cycleSlot: slot },
      });
      const scheduledRunAt = new Date(activatedAt.getTime() + (slot - 1) * intervalDays * 24 * 60 * 60 * 1000);
      await tx.susuCycle.create({
        data: {
          susuGroupId: susu.id,
          cycleNumber: slot,
          collectionDate: scheduledRunAt,
          payoutAmount: new Prisma.Decimal(susu.contributionUsdc).mul(susu.totalCycles),
          payoutUserId: m.userId,
          status: 'PENDING',
        },
      });
      rotationSnapshot.push({
        slot,
        userId: m.userId,
        azmBalance: m.user.azmBalance.toString(),
      });
    }

    return tx.susuGroup.update({
      where: { id: susu.id },
      data: {
        status: 'ACTIVE',
        activatedAt,
        rotationSnapshot,
      },
    });
  }

  // ── Req 10.10 mark COMPLETED ───────────────────────────────────────
  async markSusuCompletedIfDone(susuGroupId, tx = this.prisma) {
    const cycles = await tx.susuCycle.findMany({
      where: { susuGroupId },
      select: { status: true },
    });
    if (cycles.length === 0) return null;
    const allTerminal = cycles.every(c => ['PAID_OUT', 'DEFAULTED'].includes(c.status));
    if (!allTerminal) return null;
    return tx.susuGroup.update({
      where: { id: susuGroupId },
      data: { status: 'COMPLETED' },
    });
  }
}

module.exports = SusuService;
