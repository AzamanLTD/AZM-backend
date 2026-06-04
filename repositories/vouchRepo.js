// repositories/vouchRepo.js
// =============================================================================
// Thin Prisma wrappers for the existing VouchRecord model and the new
// VoucherSlashLog model. The deployed VouchRecord carries a rich Vouch-Form
// payload (relationship, durationKnown, reasonForTrust, acknowledgesPenalty,
// isInviter); we preserve those fields and surface them through dedicated
// helpers.
// =============================================================================

class VouchRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  // ── VouchRecord (existing model) ──────────────────────────────────────────

  /**
   * Create a vouch tied to a parent GroupChat (the Susu's GroupChat). Caller
   * supplies the rich Vouch-Form payload — defaults are conservative so a
   * minimal "I invite you" record can still be created at SusuInvite
   * acceptance time, with the form completed asynchronously by the inviter.
   */
  createForInvite(
    {
      groupId,
      voucherId,
      inviteeId,
      inviteePhone,
      isInviter = true,
      relationship = 'Susu invitee',
      durationKnown = 'Recorded at invite acceptance',
      reasonForTrust = 'Pending vouch form',
      acknowledgesPenalty = false,
    },
    client = this.prisma,
  ) {
    return client.vouchRecord.create({
      data: {
        groupId,
        voucherId,
        inviteeId,
        inviteePhone,
        isInviter,
        relationship,
        durationKnown,
        reasonForTrust,
        acknowledgesPenalty,
        status: 'COMPLETED',
      },
    });
  }

  findById(id, client = this.prisma) {
    return client.vouchRecord.findUnique({ where: { id } });
  }

  /**
   * Find the canonical VouchRecord for a (vouchedUser, susu) pair. The
   * deployed VouchRecord keys off the parent GroupChat — we look up the
   * SusuGroup → groupChatId and match against that.
   */
  async findForPair({ vouchedUserId, susuGroupId }, client = this.prisma) {
    const susu = await client.susuGroup.findUnique({
      where: { id: susuGroupId },
      include: { groupChat: { select: { id: true } } },
    });
    if (!susu?.groupChat) return null;
    return client.vouchRecord.findFirst({
      where: {
        groupId: susu.groupChat.id,
        inviteeId: vouchedUserId,
        status: 'COMPLETED',
        isInviter: true,
      },
    });
  }

  /**
   * Flip every VouchRecord tied to a Susu's parent GroupChat to VOIDED.
   * Used by Susu_Service.cancelSusu (Req 7.11) — never delete a row.
   */
  async voidForSusu(susuGroupId, client = this.prisma) {
    const susu = await client.susuGroup.findUnique({
      where: { id: susuGroupId },
      include: { groupChat: { select: { id: true } } },
    });
    if (!susu?.groupChat) return { count: 0 };
    return client.vouchRecord.updateMany({
      where: { groupId: susu.groupChat.id, status: 'COMPLETED' },
      data: { status: 'VOIDED' },
    });
  }

  // ── VoucherSlashLog (new model) ──────────────────────────────────────────

  createSlashLog(data, client = this.prisma) {
    return client.voucherSlashLog.create({ data });
  }

  /**
   * Idempotency check: does a slash log already exist for this
   * (vouched user, cycle) pair? Used to guard against duplicate
   * Default_Event triggers (Req 11.2).
   */
  hasSlashFor({ vouchedUserId, cycleId }, client = this.prisma) {
    return client.voucherSlashLog.findFirst({
      where: { vouchedUserId, cycleId },
      select: { id: true },
    });
  }
}

module.exports = VouchRepo;
