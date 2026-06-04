// services/groups/groupJoinRequest.service.js
// =============================================================================
// GroupJoinRequestService — Phase 6 / Social & Vouching Evolution (Req 7–10).
//
// Owns the member-proposed "add to group" flow and the admin add-quota engine:
//
//   • propose({groupId, proposerId, targetUserIds, note}) — a group member
//     proposes one or more adds. Creates one PENDING GroupJoinRequest per
//     target (rejecting self / existing-member / existing-PENDING), then
//     notifies BOTH the group admin(s) and each target (Req 8.1/8.3/8.4).
//   • listPending(groupId, adminId) — admin-only list of PENDING requests
//     with proposer + target detail (Req 8.5).
//   • approve(reqId, adminId) — admin-only. Adds the target as a GroupMember
//     with vouchedById = proposerId, flips the request APPROVED, notifies the
//     target. Idempotent: re-approving a resolved request is a no-op (Req
//     8.6/8.9, Property 5/7).
//   • reject(reqId, adminId) — admin-only. Flips REJECTED, adds no member,
//     notifies the proposer. Idempotent (Req 8.7/8.9).
//   • adminDirectAdd({groupId, adminId, targetUserId}) — admin self-add,
//     quota-gated by resolveAddQuota(azmBalance); records vouchedById = admin
//     (Req 10.2, Property 6/7). Over quota → ADD_QUOTA_EXCEEDED (409).
//   • resolveAddQuota(azmBalance) — AZM-tiered ceiling (Req 10.1, D2).
//   • getAddQuota(groupId, adminId) — { used, quota, remaining } for the UI.
//
// Notifications use the shared NotificationService (passed in the deps) and
// fire fire-and-forget via setImmediate so a slow/failed push never blocks or
// rolls back the membership transaction. New FCM actions: OPEN_JOIN_REQUESTS
// (to admin), OPEN_GROUP_PROFILE (to target/proposer).
// =============================================================================

const { GroupError, GroupErrorCodes } = require('./errors');

class GroupJoinRequestService {
  /**
   * @param {import('@prisma/client').PrismaClient} prisma
   * @param {{ notificationService?: object, io?: object }} [deps]
   */
  constructor(prisma, deps = {}) {
    if (!prisma) throw new Error('GroupJoinRequestService: prisma required');
    this.prisma = prisma;
    this.notificationService = deps.notificationService || null;
    this.io = deps.io || null;
  }

  // ── Admin add-quota engine (Req 10.1 / decision D2) ─────────────────────
  // 0 AZM → 3, ≥500 → 5, ≥2000 → 8, ≥10000 → 12.
  resolveAddQuota(azmBalance) {
    const bal = this._toNumber(azmBalance);
    if (bal >= 10000) return 12;
    if (bal >= 2000) return 8;
    if (bal >= 500) return 5;
    return 3;
  }

  /**
   * Current direct-add usage + ceiling for an admin in a group (Req 10.4).
   * usage = count(GroupMember where groupId=? AND addedById=adminId).
   */
  async getAddQuota(groupId, adminId, client = this.prisma) {
    await this._assertAdmin(client, groupId, adminId);
    const admin = await client.user.findUnique({
      where: { id: adminId },
      select: { azmBalance: true },
    });
    const quota = this.resolveAddQuota(admin ? admin.azmBalance : 0);
    const used = await client.groupMember.count({
      where: { groupId, addedById: adminId },
    });
    return {
      used,
      quota,
      remaining: Math.max(0, quota - used),
      azmBalance: this._toNumber(admin ? admin.azmBalance : 0),
    };
  }

  // ── Propose adds (Req 8.1) ──────────────────────────────────────────────
  /**
   * @param {{ groupId:string, proposerId:number, targetUserIds:number[], note?:string }} args
   * @returns {Promise<{ requests: object[] }>}
   */
  async propose({ groupId, proposerId, targetUserIds, note }) {
    const targets = Array.from(
      new Set((targetUserIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n))),
    );
    if (targets.length === 0) {
      throw new GroupError(
        GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID,
        'At least one valid target user is required.',
        400,
      );
    }

    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });
    if (!group) {
      throw new GroupError(GroupErrorCodes.GROUP_NOT_FOUND, 'Group not found.', 404);
    }

    // Proposer must be an active member of the group.
    const proposerMember = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: proposerId } },
    });
    if (!proposerMember || proposerMember.removedAt) {
      throw new GroupError(GroupErrorCodes.NOT_A_MEMBER, 'You are not a member of this group.', 403);
    }

    const cleanNote = note ? String(note).trim().slice(0, 280) || null : null;

    // Validate every target up front (atomic — picker pre-filters, so an
    // invalid target here is an edge case worth surfacing loudly).
    for (const targetUserId of targets) {
      if (targetUserId === proposerId) {
        throw new GroupError(
          GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID,
          'You cannot propose to add yourself.',
          400,
        );
      }
      const target = await this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, isDeleted: true },
      });
      if (!target || target.isDeleted) {
        throw new GroupError(
          GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID,
          'Target user not found.',
          400,
        );
      }
      const existingMember = await this.prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: targetUserId } },
      });
      if (existingMember && !existingMember.removedAt) {
        throw new GroupError(
          GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID,
          'That user is already a member of this group.',
          400,
        );
      }
      const existingPending = await this.prisma.groupJoinRequest.findFirst({
        where: { groupId, targetUserId, status: 'PENDING' },
      });
      if (existingPending) {
        throw new GroupError(
          GroupErrorCodes.JOIN_REQUEST_DUPLICATE,
          'A pending request already exists for that user.',
          409,
        );
      }
    }

    // Create one PENDING row per target.
    const created = [];
    for (const targetUserId of targets) {
      const row = await this.prisma.groupJoinRequest.create({
        data: { groupId, proposerId, targetUserId, note: cleanNote, status: 'PENDING' },
        include: {
          proposer: { select: { id: true, username: true, displayName: true } },
          target: { select: { id: true, username: true, displayName: true } },
        },
      });
      created.push(row);
    }

    // Notify both sides (fire-and-forget). Admin(s) get the proposal queue
    // ping; each target gets the join-request ping.
    const adminIds = await this._adminIds(this.prisma, groupId);
    for (const row of created) {
      this._notifyProposalToAdmins(adminIds, group, row);
      this._notifyProposalToTarget(group, row);
    }

    return { requests: created };
  }

  // ── List pending (Req 8.5) ──────────────────────────────────────────────
  async listPending(groupId, adminId) {
    await this._assertAdmin(this.prisma, groupId, adminId);
    return this.prisma.groupJoinRequest.findMany({
      where: { groupId, status: 'PENDING' },
      include: {
        proposer: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
        target: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Approve (Req 8.6) ───────────────────────────────────────────────────
  async approve(reqId, adminId) {
    const request = await this.prisma.groupJoinRequest.findUnique({
      where: { id: reqId },
      include: {
        group: { select: { id: true, name: true } },
        proposer: { select: { id: true, username: true, displayName: true } },
        target: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!request) {
      throw new GroupError(GroupErrorCodes.JOIN_REQUEST_NOT_FOUND, 'Join request not found.', 404);
    }
    await this._assertAdmin(this.prisma, request.groupId, adminId);

    // Idempotent: a resolved request is a no-op (no double add / notify).
    if (request.status !== 'PENDING') {
      return { request, member: null, alreadyResolved: true };
    }

    const { updated, member } = await this.prisma.$transaction(async (tx) => {
      const member = await tx.groupMember.upsert({
        where: { groupId_userId: { groupId: request.groupId, userId: request.targetUserId } },
        update: {
          removedAt: null,
          removedReason: null,
          addedById: request.proposerId,
          vouchedById: request.proposerId,
        },
        create: {
          groupId: request.groupId,
          userId: request.targetUserId,
          role: 'MEMBER',
          addedById: request.proposerId,
          vouchedById: request.proposerId,
        },
      });
      const updated = await tx.groupJoinRequest.update({
        where: { id: reqId },
        data: { status: 'APPROVED', decidedById: adminId, decidedAt: new Date() },
      });
      return { updated, member };
    });

    // System message + notify the target they were added (Req 8.6).
    this._systemMessage(request.groupId, 'Member added via vouch', {
      kind: 'MEMBER_ADDED',
      targetUserId: request.targetUserId,
      proposerId: request.proposerId,
      via: 'JOIN_REQUEST',
    });
    this._notifyApprovedToTarget(request.group, request);

    return { request: { ...request, status: 'APPROVED' }, member, updated, alreadyResolved: false };
  }

  // ── Reject (Req 8.7) ────────────────────────────────────────────────────
  async reject(reqId, adminId) {
    const request = await this.prisma.groupJoinRequest.findUnique({
      where: { id: reqId },
      include: {
        group: { select: { id: true, name: true } },
        proposer: { select: { id: true, username: true, displayName: true } },
        target: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!request) {
      throw new GroupError(GroupErrorCodes.JOIN_REQUEST_NOT_FOUND, 'Join request not found.', 404);
    }
    await this._assertAdmin(this.prisma, request.groupId, adminId);

    if (request.status !== 'PENDING') {
      return { request, alreadyResolved: true };
    }

    const updated = await this.prisma.groupJoinRequest.update({
      where: { id: reqId },
      data: { status: 'REJECTED', decidedById: adminId, decidedAt: new Date() },
    });

    this._notifyRejectedToProposer(request.group, request);

    return { request: { ...request, status: 'REJECTED' }, updated, alreadyResolved: false };
  }

  // ── Admin direct add (Req 10.2/10.3, quota-gated) ───────────────────────
  async adminDirectAdd({ groupId, adminId, targetUserId }) {
    const tId = Number(targetUserId);
    await this._assertAdmin(this.prisma, groupId, adminId);

    const group = await this.prisma.groupChat.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });
    if (!group) {
      throw new GroupError(GroupErrorCodes.GROUP_NOT_FOUND, 'Group not found.', 404);
    }

    const target = await this.prisma.user.findUnique({
      where: { id: tId },
      select: { id: true, isDeleted: true, username: true, displayName: true },
    });
    if (!target || target.isDeleted) {
      throw new GroupError(GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID, 'Target user not found.', 400);
    }

    const existing = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: tId } },
    });
    if (existing && !existing.removedAt) {
      throw new GroupError(
        GroupErrorCodes.JOIN_REQUEST_TARGET_INVALID,
        'That user is already a member of this group.',
        400,
      );
    }

    // Quota gate: usage must be below resolveAddQuota(admin.azmBalance).
    const { used, quota } = await this.getAddQuota(groupId, adminId);
    if (used >= quota) {
      throw new GroupError(
        GroupErrorCodes.ADD_QUOTA_EXCEEDED,
        `You've used all ${quota} of your direct adds. Ask a member to propose this person so you can approve them.`,
        409,
      );
    }

    const member = await this.prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId: tId } },
      update: { removedAt: null, removedReason: null, addedById: adminId, vouchedById: adminId },
      create: { groupId, userId: tId, role: 'MEMBER', addedById: adminId, vouchedById: adminId },
    });

    this._systemMessage(groupId, 'Member added by admin', {
      kind: 'MEMBER_ADDED',
      targetUserId: tId,
      proposerId: adminId,
      via: 'ADMIN_DIRECT',
    });
    this._notifyAddedToTarget(group, tId);

    return { member, quota: await this.getAddQuota(groupId, adminId) };
  }

  // =========================================================================
  // INTERNAL — guards / notifications / helpers
  // =========================================================================

  async _assertAdmin(client, groupId, userId) {
    const member = await client.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member || member.removedAt) {
      throw new GroupError(GroupErrorCodes.JOIN_REQUEST_FORBIDDEN, 'Admin only.', 403);
    }
    if (member.role !== 'ADMIN') {
      throw new GroupError(GroupErrorCodes.JOIN_REQUEST_FORBIDDEN, 'Admin only.', 403);
    }
    return member;
  }

  async _adminIds(client, groupId) {
    const admins = await client.groupMember.findMany({
      where: { groupId, role: 'ADMIN', removedAt: null },
      select: { userId: true },
    });
    return admins.map((a) => a.userId);
  }

  _name(user) {
    if (!user) return 'Someone';
    return user.displayName || user.username || 'Someone';
  }

  // To admin: "User '<proposer>' wants to add user '<target>' to your group
  // '<group>'" (+ " — reason: <note>" when present). Action OPEN_JOIN_REQUESTS.
  _notifyProposalToAdmins(adminIds, group, request) {
    const proposer = this._name(request.proposer);
    const target = this._name(request.target);
    let body = `User '${proposer}' wants to add user '${target}' to your group '${group.name}'`;
    if (request.note) body += ` — reason: ${request.note}`;
    for (const adminId of adminIds) {
      // Don't ping the proposer if they happen to also be an admin.
      if (adminId === request.proposerId) continue;
      this._fire({
        userId: adminId,
        title: 'New member proposal',
        body,
        category: 'GENERAL',
        actionPayload: {
          route: `/groups/${group.id}/join-requests`,
          action: 'OPEN_JOIN_REQUESTS',
          groupId: group.id,
          requestId: request.id,
        },
      });
    }
  }

  // To target: "User '<proposer>' has sent you a request to join '<group>
  // group'" (+ ", with reference '<note>'" when present). Action
  // OPEN_GROUP_INVITE.
  _notifyProposalToTarget(group, request) {
    const proposer = this._name(request.proposer);
    let body = `User '${proposer}' has sent you a request to join '${group.name} group'`;
    if (request.note) body += `, with reference '${request.note}'`;
    this._fire({
      userId: request.targetUserId,
      title: 'Group invitation',
      body,
      category: 'GENERAL',
      actionPayload: {
        route: `/groups/${group.id}`,
        action: 'OPEN_GROUP_INVITE',
        groupId: group.id,
        requestId: request.id,
      },
    });
  }

  _notifyApprovedToTarget(group, request) {
    this._fire({
      userId: request.targetUserId,
      title: 'You were added to a group',
      body: `You've been added to '${group.name}'.`,
      category: 'GENERAL',
      actionPayload: {
        route: `/groups/${group.id}`,
        action: 'OPEN_GROUP_PROFILE',
        groupId: group.id,
      },
    });
  }

  _notifyAddedToTarget(group, targetUserId) {
    this._fire({
      userId: targetUserId,
      title: 'You were added to a group',
      body: `You've been added to '${group.name}'.`,
      category: 'GENERAL',
      actionPayload: {
        route: `/groups/${group.id}`,
        action: 'OPEN_GROUP_PROFILE',
        groupId: group.id,
      },
    });
  }

  _notifyRejectedToProposer(group, request) {
    const target = this._name(request.target);
    this._fire({
      userId: request.proposerId,
      title: 'Proposal not approved',
      body: `Your request to add '${target}' to '${group.name}' was not approved.`,
      category: 'GENERAL',
      actionPayload: {
        route: `/groups/${group.id}`,
        action: 'OPEN_GROUP_PROFILE',
        groupId: group.id,
      },
    });
  }

  // Fire-and-forget so a slow/failed notification never blocks or rolls back
  // the caller's transaction.
  _fire(payload) {
    if (!this.notificationService) return;
    setImmediate(() => {
      Promise.resolve(this.notificationService.sendNotification(payload)).catch((err) => {
        console.error('[GroupJoinRequestService] notify error:', err.message);
      });
    });
  }

  async _systemMessage(groupId, content, metadata = {}) {
    try {
      const msg = await this.prisma.groupMessage.create({
        data: { groupId, senderId: null, type: 'SYSTEM', content, metadata },
      });
      if (this.io) this.io.to(`group_${groupId}`).emit('group:message', msg);
    } catch (err) {
      console.error('[GroupJoinRequestService] system message error:', err.message);
    }
  }

  _toNumber(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}

module.exports = { GroupJoinRequestService };
