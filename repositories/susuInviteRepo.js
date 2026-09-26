// repositories/susuInviteRepo.js
// =============================================================================
// Thin Prisma wrappers for the new SusuInvite model (Req 6 — three-channel
// invites). See design.md > Data Models > Invite, Vouch, and Slash tables.
// =============================================================================

const logger = require('../src/config/logger');
const crypto = require('crypto');

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours per Req 6.6

class SusuInviteRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create a new invite. Caller is responsible for setting `channel`,
   * `inviterId`, `susuGroupId`, and one of {inviteeUserId, inviteePhone}.
   * `token` is auto-generated for LINK channel; for FRIEND/PHONE the
   * caller may omit it (null is fine).
   */
  create(data, client = this.prisma) {
    const expiresAt = data.expiresAt || new Date(Date.now() + INVITE_TTL_MS);
    const token = data.channel === 'LINK'
      ? (data.token || crypto.randomBytes(32).toString('base64url'))
      : null;
    return client.susuInvite.create({
      data: { ...data, expiresAt, token, status: data.status || 'PENDING' },
    });
  }

  findById(id, client = this.prisma) {
    return client.susuInvite.findUnique({ where: { id } });
  }

  findByToken(token, client = this.prisma) {
    return client.susuInvite.findUnique({ where: { token } });
  }

  /**
   * Find pending unbound (inviteeUserId=null) phone invites that match a
   * given E.164 number. Used at phone-verification time to bind any
   * waiting invites to the newly-verified user (Req 6.4).
   */
  findUnboundForPhone(inviteePhone, client = this.prisma) {
    return client.susuInvite.findMany({
      where: {
        inviteePhone,
        inviteeUserId: null,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
  }

  listForSusu(susuGroupId, status, client = this.prisma) {
    return client.susuInvite.findMany({
      where: { susuGroupId, ...(status && { status }) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find any pending duplicate invite for the same Susu and either user
   * or phone (used by Req 6.12 dedup check).
   */
  findExistingPending({ susuGroupId, inviteeUserId, inviteePhone }, client = this.prisma) {
    if (!inviteeUserId && !inviteePhone) return Promise.resolve(null);
    return client.susuInvite.findFirst({
      where: {
        susuGroupId,
        status: 'PENDING',
        OR: [
          ...(inviteeUserId ? [{ inviteeUserId }] : []),
          ...(inviteePhone  ? [{ inviteePhone }]  : []),
        ],
      },
    });
  }

  updateStatus(id, status, extra = {}, client = this.prisma) {
    return client.susuInvite.update({
      where: { id },
      data: { status, ...extra },
    });
  }

  bindInviteeUserId(id, inviteeUserId, client = this.prisma) {
    return client.susuInvite.update({
      where: { id },
      data: { inviteeUserId },
    });
  }
}

module.exports = SusuInviteRepo;
module.exports.INVITE_TTL_MS = INVITE_TTL_MS;
