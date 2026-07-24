// services/susu/susuInvite.service.js
// =============================================================================
// SusuInvite_Service — Req 6
// =============================================================================

const logger = require('../../src/config/logger');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('./errors');
const SusuInviteRepo = require('../../repositories/susuInviteRepo');
const SusuMemberRepo = require('../../repositories/susuMemberRepo');

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

class SusuInviteService {
  constructor(prisma, { susuVouchService, susuMemberService, notificationService } = {}) {
    this.prisma = prisma;
    this.repo = new SusuInviteRepo(prisma);
    this.memberRepo = new SusuMemberRepo(prisma);
    this.susuVouchService = susuVouchService;
    this.susuMemberService = susuMemberService;
    this.notificationService = notificationService;
  }

  // ── Single-invite create dispatcher (Req 6.1, 6.2, 6.5) ─────────────
  async createInvite({ susuGroupId, inviterId, channel, inviteeUserId, inviteePhone }) {
    const susu = await this.prisma.susuGroup.findUnique({ where: { id: susuGroupId } });
    if (!susu) throw new SusuError(ErrorCodes.SUSU_NOT_FOUND, 'Not found', 404);
    if (susu.status !== 'CONFIGURING') {
      throw new SusuError(ErrorCodes.SUSU_ALREADY_ACTIVE, `Susu is in ${susu.status}; invites are closed.`, 409);
    }

    // Self-invite + duplicate-pending guard (Req 6.12)
    if (channel === 'FRIEND') {
      if (!inviteeUserId) throw new SusuError(ErrorCodes.INVITE_INVALID, 'inviteeUserId required for FRIEND channel.', 400);
      if (inviteeUserId === inviterId) throw new SusuError(ErrorCodes.INVITE_INVALID, 'Cannot invite yourself.', 400);
      const friendship = await this.prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { requesterId: inviterId, addresseeId: inviteeUserId },
            { requesterId: inviteeUserId, addresseeId: inviterId },
          ],
        },
      });
      if (!friendship) {
        throw new SusuError(ErrorCodes.INVITE_INVALID, 'Friendship required for FRIEND-channel invites.', 400);
      }
      const dup = await this.repo.findExistingPending({ susuGroupId, inviteeUserId }, this.prisma);
      if (dup) throw new SusuError(ErrorCodes.INVITE_INVALID, 'A pending invite already exists for this user.', 400);
      return this.repo.create({ susuGroupId, inviterId, inviteeUserId, channel });
    }

    if (channel === 'PHONE') {
      if (!inviteePhone || !E164_REGEX.test(inviteePhone)) {
        throw new SusuError(ErrorCodes.INVITE_INVALID, 'inviteePhone must be E.164.', 400);
      }
      // Self-phone (Req 6.12)
      const me = await this.prisma.user.findUnique({
        where: { id: inviterId },
        select: { phoneNumber: true, phoneVerified: true },
      });
      if (me?.phoneVerified && me.phoneNumber === inviteePhone) {
        throw new SusuError(ErrorCodes.INVITE_INVALID, 'Cannot invite your own phone number.', 400);
      }
      const dup = await this.repo.findExistingPending({ susuGroupId, inviteePhone }, this.prisma);
      if (dup) throw new SusuError(ErrorCodes.INVITE_INVALID, 'A pending invite already exists for this phone.', 400);

      // Bind to a verified user if one exists
      const matched = await this.prisma.user.findFirst({
        where: { phoneNumber: inviteePhone, phoneVerified: true },
        select: { id: true },
      });
      const bind = matched?.id || null;
      return this.repo.create({
        susuGroupId,
        inviterId,
        inviteePhone,
        inviteeUserId: bind,
        channel: 'PHONE',
      });
    }

    if (channel === 'LINK') {
      const token = crypto.randomBytes(32).toString('base64url');
      return this.repo.create({ susuGroupId, inviterId, channel: 'LINK', token });
    }

    throw new SusuError(ErrorCodes.INVITE_INVALID, `Unknown channel ${channel}`, 400);
  }

  // ── Public preview (Req 6.7 — minimal payload, no Susu id leakage) ──
  async previewByToken(token) {
    const invite = await this.repo.findByToken(token);
    if (!invite) {
      throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    }
    if (invite.status !== 'PENDING' || invite.expiresAt <= new Date()) {
      throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    }
    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: invite.susuGroupId },
      include: { groupChat: { select: { name: true } } },
    });
    const inviter = await this.prisma.user.findUnique({
      where: { id: invite.inviterId },
      select: { username: true, profilePictureUrl: true },
    });
    return {
      susu: {
        name: susu?.groupChat?.name || 'Susu',
        contributionUsdc: susu.contributionUsdc.toString(),
        frequency: susu.frequency,
        memberCount: susu.contractRequiredCount,
      },
      inviter: { displayName: inviter?.username || '', avatar: inviter?.profilePictureUrl || null },
      expiresAt: invite.expiresAt,
    };
  }

  // ── Internal acceptance core (atomic) ───────────────────────────────
  // Creates SusuMember in PENDING_VOUCH, creates VouchRecord, marks
  // invite ACCEPTED, attempts immediate PENDING_VOUCH → PENDING_CONTRACT
  // promotion. Used by both /accept (FRIEND/PHONE) and /redeem (LINK).
  async _acceptInternal({ inviteRow, redeemingUserId, tx }) {
    if (inviteRow.status !== 'PENDING' || inviteRow.expiresAt <= new Date()) {
      throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    }
    // Bind inviteeUserId for LINK + unbound PHONE channels
    const inviteeUserId = inviteRow.inviteeUserId || redeemingUserId;
    if (inviteeUserId !== redeemingUserId && inviteRow.channel !== 'LINK') {
      throw new SusuError(ErrorCodes.INVITE_INVALID, 'Caller is not the invite target.', 403);
    }

    // KYC + PoR gate on the redeemer (Req 2.2, 2.3)
    const redeemer = await tx.user.findUnique({
      where: { id: redeemingUserId },
      select: { id: true, kycStatus: true, proofOfResidencyStatus: true },
    });
    if (!redeemer || redeemer.kycStatus !== 'VERIFIED') {
      throw new SusuError(ErrorCodes.KYC_REQUIRED, 'KYC verification required.', 403);
    }
    if (redeemer.proofOfResidencyStatus !== 'VERIFIED') {
      throw new SusuError(ErrorCodes.RESIDENCY_REQUIRED, 'Proof of Residency required.', 403);
    }

    // Already a member?
    const existing = await tx.susuMember.findUnique({
      where: { susuGroupId_userId: { susuGroupId: inviteRow.susuGroupId, userId: inviteeUserId } },
    });
    if (existing) {
      throw new SusuError(ErrorCodes.INVITE_INVALID, 'You are already a member of this Susu.', 409);
    }

    // Create SusuMember in PENDING_VOUCH. The deployed schema has a
    // unique on (susuGroupId, cycleSlot) — we use a negative sentinel
    // keyed on userId so each pre-activation member has a distinct slot.
    // The activation flow rewrites every cycleSlot to its final 1..N
    // value (Property 7).
    const member = await tx.susuMember.create({
      data: {
        susuGroupId: inviteRow.susuGroupId,
        userId: inviteeUserId,
        cycleSlot: -inviteeUserId,
        trustScore: new Prisma.Decimal(100),
        status: 'PENDING_VOUCH',
        inviterId: inviteRow.inviterId,
      },
    });

    // Create VouchRecord (Req 7.1)
    if (this.susuVouchService) {
      await this.susuVouchService.createVouchAtAcceptance(
        { ...inviteRow, inviteeUserId },
        tx,
      );
    }

    // Mark invite ACCEPTED
    await tx.susuInvite.update({
      where: { id: inviteRow.id },
      data: { status: 'ACCEPTED', redeemedAt: new Date(), inviteeUserId },
    });

    // Try the PENDING_VOUCH → PENDING_CONTRACT promotion immediately
    // (KYC + PoR are already VERIFIED at this point, so it should
    // succeed in the same transaction).
    if (this.susuMemberService) {
      await this.susuMemberService.transitionToPendingContractIfReady(member.id, tx);
    }

    return member;
  }

  async redeemLinkInvite(token, redeemingUserId) {
    const inviteRow = await this.repo.findByToken(token);
    if (!inviteRow) throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    return this.prisma.$transaction(async (tx) => {
      return this._acceptInternal({ inviteRow, redeemingUserId, tx });
    });
  }

  async acceptInvite(inviteId, redeemingUserId) {
    const inviteRow = await this.repo.findById(inviteId);
    if (!inviteRow) throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    if (inviteRow.channel === 'LINK' && !inviteRow.inviteeUserId) {
      // For LINK we expect /redeem path
      throw new SusuError(ErrorCodes.INVITE_INVALID, 'Use /redeem for LINK channel.', 400);
    }
    return this.prisma.$transaction(async (tx) => {
      return this._acceptInternal({ inviteRow, redeemingUserId, tx });
    });
  }

  async declineInvite(inviteId, callerId) {
    const inviteRow = await this.repo.findById(inviteId);
    if (!inviteRow) throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    if (inviteRow.status !== 'PENDING') {
      throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    }
    if (inviteRow.inviteeUserId && inviteRow.inviteeUserId !== callerId) {
      throw new SusuError(ErrorCodes.INVITE_INVALID, 'Not the invite target.', 403);
    }
    return this.repo.updateStatus(inviteId, 'DECLINED');
  }

  async revokeInvite(inviteId, callerId) {
    const inviteRow = await this.repo.findById(inviteId);
    if (!inviteRow) throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    if (inviteRow.status !== 'PENDING') {
      throw new SusuError(ErrorCodes.INVITE_EXPIRED_OR_USED, 'Invite expired or used.', 410);
    }
    // Initiator-only: walk to GroupChat.createdById
    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: inviteRow.susuGroupId },
      include: { groupChat: { select: { createdById: true } } },
    });
    if (susu?.groupChat?.createdById !== callerId) {
      throw new SusuError(ErrorCodes.INVITE_INVALID, 'Only the initiator may revoke.', 403);
    }
    return this.repo.updateStatus(inviteId, 'REVOKED');
  }
}

module.exports = SusuInviteService;
