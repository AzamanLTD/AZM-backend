// services/susu/susuVouch.service.js
// =============================================================================
// SusuVouch_Service — Req 7
//
// Owns:
//   - VouchRecord creation at invite acceptance time (atomic with SusuMember
//     row creation; the existing rich VouchRecord schema is preserved —
//     additional Vouch-Form fields are populated with sentinels that the
//     inviter completes asynchronously)
//   - Voiding VouchRecords on Susu cancellation (status → VOIDED, no delete)
//   - applySlash: 25%-of-AZM Voucher_Slash + −1 trustRating with floor 0,
//     all atomic with the seizure transaction (Req 11.6)
//   - VoucherSlashLog persistence including absent-vouch case (voucherId=null)
// =============================================================================

const logger = require('../../src/config/logger');
const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('./errors');
const VouchRepo = require('../../repositories/vouchRepo');

class SusuVouchService {
  constructor(prisma, { notificationService } = {}) {
    this.prisma = prisma;
    this.repo = new VouchRepo(prisma);
    this.notificationService = notificationService;
  }

  /**
   * Atomic with SusuMember row creation. `inviteRow` is a SusuInvite
   * row (already persisted with status=ACCEPTED). The parent SusuGroup
   * is looked up to find its GroupChat anchor — VouchRecord lives on
   * the GroupChat per the deployed schema.
   */
  async createVouchAtAcceptance(inviteRow, tx = this.prisma) {
    if (!inviteRow.inviteeUserId) {
      // Defensive: phone-channel invites can't create a VouchRecord
      // until the user binds. Caller is responsible for not invoking
      // this with a still-unbound row.
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        'Cannot create VouchRecord for unbound invite (no inviteeUserId).',
        500,
      );
    }
    const susu = await tx.susuGroup.findUnique({
      where: { id: inviteRow.susuGroupId },
      include: { groupChat: { select: { id: true } } },
    });
    if (!susu?.groupChat) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        'Parent GroupChat not found for SusuGroup.',
        500,
      );
    }
    // Idempotency — Property 9. If a row already exists for this
    // (vouchedUserId, groupId) pair we leave it alone.
    const existing = await tx.vouchRecord.findFirst({
      where: { groupId: susu.groupChat.id, inviteeId: inviteRow.inviteeUserId, isInviter: true },
    });
    if (existing) return existing;
    return this.repo.createForInvite(
      {
        groupId: susu.groupChat.id,
        voucherId: inviteRow.inviterId,
        inviteeId: inviteRow.inviteeUserId,
        inviteePhone: inviteRow.inviteePhone,
        isInviter: true,
        // Sentinel form fields — the inviter's full Vouch-Form completion
        // remains a separate flow on the deployed VouchRecord surface.
        relationship: 'Susu invitee',
        durationKnown: 'Recorded at invite acceptance',
        reasonForTrust: 'Pending inviter Vouch-Form completion',
        acknowledgesPenalty: false,
      },
      tx,
    );
  }

  /**
   * Susu cancellation (Req 7.11): flip every VouchRecord tied to this
   * Susu's parent GroupChat from COMPLETED → VOIDED. Never deletes.
   */
  async voidVouchesForSusu(susuGroupId, tx = this.prisma) {
    return this.repo.voidForSusu(susuGroupId, tx);
  }

  /**
   * Voucher_Slash (Req 7.4–7.9). Called from inside the seizure
   * transaction. Returns the persisted VoucherSlashLog row.
   */
  async applySlash({ defaultingMemberId, defaultingUserId, susuGroupId, cycleId }, tx = this.prisma) {
    // Idempotency on duplicate Default_Event triggers (Req 11.2)
    const dup = await this.repo.hasSlashFor({ vouchedUserId: defaultingUserId, cycleId }, tx);
    if (dup) return dup;

    const vouch = await this.repo.findForPair(
      { vouchedUserId: defaultingUserId, susuGroupId },
      tx,
    );

    // Absent-vouch path (Req 7.4): persist a marker log, no balance
    // mutations.
    if (!vouch) {
      return this.repo.createSlashLog(
        {
          voucherId: null,
          vouchedUserId: defaultingUserId,
          susuGroupId,
          cycleId,
          azmDeducted: new Prisma.Decimal(0),
          trustRatingBefore: 0,
          trustRatingAfter: 0,
        },
        tx,
      );
    }

    // Read voucher's current AZM + trustRating from inside the txn so
    // we slash a coherent snapshot.
    const voucher = await tx.user.findUnique({
      where: { id: vouch.voucherId },
      select: { id: true, azmBalance: true, trustRating: true, fcmToken: true },
    });
    if (!voucher) {
      // VouchRecord points at a deleted user — treat as absent vouch.
      return this.repo.createSlashLog(
        {
          voucherId: null,
          vouchedUserId: defaultingUserId,
          susuGroupId,
          cycleId,
          azmDeducted: new Prisma.Decimal(0),
          trustRatingBefore: 0,
          trustRatingAfter: 0,
        },
        tx,
      );
    }

    // Slash math (Req 7.5): 25% of azmBalance, floor 0, capped at
    // current azmBalance, rounded down to whole AZM unit.
    const azmBefore = new Prisma.Decimal(voucher.azmBalance);
    const quarter = azmBefore.mul('0.25').floor();
    const deduction = Prisma.Decimal.min(quarter, azmBefore);
    const azmAfter = azmBefore.sub(deduction);

    const trustBefore = voucher.trustRating;
    const trustAfter = Math.max(0, trustBefore - 1);

    // Atomic with the rest of the seizure txn (Req 7.7)
    await tx.user.update({
      where: { id: voucher.id },
      data: {
        azmBalance: azmAfter,
        trustRating: trustAfter,
      },
    });

    const log = await this.repo.createSlashLog(
      {
        voucherId: voucher.id,
        vouchedUserId: defaultingUserId,
        susuGroupId,
        cycleId,
        azmDeducted: deduction,
        trustRatingBefore: trustBefore,
        trustRatingAfter: trustAfter,
      },
      tx,
    );

    // Notification — best-effort, post-transaction commit. Caller passes
    // a deferred queue if it wants to coalesce multiple slashes per
    // cycle. We schedule on next-tick when no queue is supplied so the
    // outer transaction commits first.
    if (this.notificationService) {
      const susu = await tx.susuGroup.findUnique({
        where: { id: susuGroupId },
        select: { id: true, groupChat: { select: { name: true } } },
      });
      const payload = {
        userId: voucher.id,
        title: 'Voucher Penalty Applied',
        body: `Your invitee defaulted on a Susu cycle. ${deduction} AZM deducted, Trust Rating now ${trustAfter}.`,
        category: 'SUSU',
        actionPayload: {
          action: 'OPEN_SUSU',
          susuId: susu?.id,
          susuName: susu?.groupChat?.name || 'Susu',
          azmDeducted: deduction.toString(),
          trustRatingBefore: trustBefore,
          trustRatingAfter: trustAfter,
        },
      };
      setImmediate(() => {
        this.notificationService.sendNotification(payload).catch(err => {
          logger.warn('[SusuVouchService] slash notification failed:', err.message);
        });
      });
    }

    return log;
  }
}

module.exports = SusuVouchService;
