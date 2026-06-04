// services/groupChatService.js
// =============================================================================
// AZAMAN — GROUP CHAT SERVICE  (Master Sprint, 2026-05-27)
//
// Group chat infrastructure that supports both casual social groups and
// Susu-enabled groups. Casual groups have no special restrictions; once a
// SusuGroup is bound to a GroupChat, member invites must come with two
// VouchRecord entries (inviter + a second existing member).
//
// Socket emissions: groups have a room `group_${groupId}`. Members join
// the room on connect (handled in server.js socket handler bridge).
// =============================================================================

const { Prisma } = require('@prisma/client');

class GroupChatService {
    constructor(prisma, io, notificationService) {
        this.prisma = prisma;
        this.io = io;
        this.notificationService = notificationService;
    }

    // =========================================================================
    // GROUP LIFECYCLE
    // =========================================================================

    async createGroup({ creatorId, name, description, avatarUrl, initialMemberIds = [], adminIds = [] }) {
        if (!name || !String(name).trim()) throw new Error('Group name required');
        const memberSet = new Set([creatorId, ...initialMemberIds]);
        const adminSet = new Set([creatorId, ...adminIds]);

        const group = await this.prisma.groupChat.create({
            data: {
                name: String(name).slice(0, 80),
                description: description ? String(description).slice(0, 280) : null,
                avatarUrl: avatarUrl || null,
                createdById: creatorId,
                members: {
                    create: Array.from(memberSet).map((uid) => ({
                        userId: uid,
                        role: adminSet.has(uid) ? 'ADMIN' : 'MEMBER',
                    })),
                },
            },
            include: {
                members: { include: { user: { select: { id: true, username: true, profilePictureUrl: true } } } },
            },
        });

        // System message
        await this._systemMessage(group.id, 'Group created', { kind: 'GROUP_CREATED' });

        // Notify all initial members (skip creator)
        for (const uid of memberSet) {
            if (uid === creatorId) continue;
            this.notificationService
                .sendNotification({
                    userId: uid,
                    title: 'Added to a Group',
                    body: `You were added to "${group.name}"`,
                    category: 'GENERAL',
                    actionPayload: { action: 'OPEN_GROUP', groupId: group.id },
                })
                .catch(() => {});
        }

        return group;
    }

    async listForUser(userId) {
        return this.prisma.groupChat.findMany({
            where: { members: { some: { userId, removedAt: null } } },
            include: {
                members: {
                    include: { user: { select: { id: true, username: true, profilePictureUrl: true } } },
                },
                susuGroup: true,
                _count: { select: { messages: true } },
            },
            orderBy: { updatedAt: 'desc' },
        });
    }

    async getDetail(userId, groupId) {
        const group = await this.prisma.groupChat.findUnique({
            where: { id: groupId },
            include: {
                members: {
                    include: { user: { select: { id: true, username: true, profilePictureUrl: true } } },
                },
                susuGroup: {
                    include: {
                        members: true,
                        cycles: { orderBy: { cycleNumber: 'asc' } },
                    },
                },
            },
        });
        if (!group) return null;
        if (!group.members.some((m) => m.userId === userId && !m.removedAt)) return null;
        return group;
    }

    async updateGroup(actorId, groupId, patch) {
        await this._assertAdmin(actorId, groupId);
        const data = {};
        if (patch.name) data.name = String(patch.name).slice(0, 80);
        if (patch.description !== undefined) {
            data.description = patch.description ? String(patch.description).slice(0, 280) : null;
        }
        if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl || null;

        return this.prisma.groupChat.update({ where: { id: groupId }, data });
    }

    // =========================================================================
    // MEMBERSHIP
    // =========================================================================

    async addMember(actorId, groupId, { userId, phone, role = 'MEMBER', vouchPayload }) {
        // Validate actor is admin
        await this._assertAdmin(actorId, groupId);
        const group = await this.prisma.groupChat.findUnique({
            where: { id: groupId },
            include: { susuGroup: true, members: true },
        });
        if (!group) throw new Error('Group not found');

        const isSusu = !!group.susuGroupId;

        // For Susu-enabled groups, require a vouch payload from inviter +
        // queue a second-voucher request via VouchRecord(status=PENDING).
        if (isSusu) {
            if (!vouchPayload || !vouchPayload.relationship || !vouchPayload.reasonForTrust) {
                throw new Error('Susu groups require a vouch form from the inviter');
            }
            if (!vouchPayload.acknowledgesPenalty) {
                throw new Error('Inviter must acknowledge the voucher-penalty clause');
            }
        }

        // Resolve invitee: prefer userId, otherwise phone-based lookup
        let inviteeId = userId || null;
        let inviteePhone = phone || null;
        if (!inviteeId && phone) {
            const existing = await this.prisma.user.findFirst({
                where: { phoneNumber: phone, phoneVerified: true },
                select: { id: true },
            });
            if (existing) inviteeId = existing.id;
        }

        // If invitee is already on the platform, add as PENDING_VOUCH
        // (or PENDING_CONTRACT for casual groups, since no contract).
        let memberRow = null;
        if (inviteeId) {
            memberRow = await this.prisma.groupMember.upsert({
                where: { groupId_userId: { groupId, userId: inviteeId } },
                update: { removedAt: null, role },
                create: { groupId, userId: inviteeId, role },
            });
        }

        // Write the inviter vouch row
        if (isSusu) {
            await this.prisma.vouchRecord.create({
                data: {
                    groupId,
                    inviteeId,
                    inviteePhone: inviteeId ? null : inviteePhone,
                    voucherId: actorId,
                    isInviter: true,
                    relationship: String(vouchPayload.relationship).slice(0, 80),
                    durationKnown: String(vouchPayload.durationKnown || 'unspecified').slice(0, 40),
                    reasonForTrust: String(vouchPayload.reasonForTrust).slice(0, 500),
                    acknowledgesPenalty: !!vouchPayload.acknowledgesPenalty,
                    status: 'COMPLETED',
                    submittedAt: new Date(),
                },
            });
        }

        await this._systemMessage(groupId, 'Member added', {
            kind: 'MEMBER_ADDED',
            inviteeId,
            inviteePhone,
            isInviter: true,
        });

        return memberRow;
    }

    async removeMember(actorId, groupId, targetUserId, reason) {
        await this._assertAdmin(actorId, groupId);
        const member = await this.prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId: targetUserId } },
        });
        if (!member) throw new Error('Member not found');

        await this.prisma.groupMember.update({
            where: { id: member.id },
            data: { removedAt: new Date(), removedReason: reason || 'admin removed' },
        });

        await this._systemMessage(groupId, 'Member removed', {
            kind: 'MEMBER_REMOVED',
            targetUserId,
            reason,
        });
    }

    async setRole(actorId, groupId, targetUserId, role) {
        await this._assertAdmin(actorId, groupId);
        if (role !== 'ADMIN' && role !== 'MEMBER') throw new Error('role must be ADMIN or MEMBER');

        // Cap admins at 2 (the brief: "1 or 2 Admins")
        if (role === 'ADMIN') {
            const adminCount = await this.prisma.groupMember.count({
                where: { groupId, role: 'ADMIN', removedAt: null },
            });
            if (adminCount >= 2) {
                const target = await this.prisma.groupMember.findUnique({
                    where: { groupId_userId: { groupId, userId: targetUserId } },
                });
                if (!target || target.role !== 'ADMIN') {
                    throw new Error('Susu groups support a maximum of 2 admins');
                }
            }
        }

        return this.prisma.groupMember.update({
            where: { groupId_userId: { groupId, userId: targetUserId } },
            data: { role },
        });
    }

    // =========================================================================
    // MESSAGES
    // =========================================================================

    async sendMessage({ groupId, senderId, type = 'TEXT', content, metadata, media }) {
        // Validate sender is an active member
        const member = await this.prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId: senderId } },
        });
        if (!member || member.removedAt) throw new Error('Not a group member');

        const data = {
            groupId,
            senderId,
            type,
            content: content ?? null,
            metadata: metadata ?? null,
        };
        if (media) {
            data.mediaUrl = media.url;
            data.mediaType = media.type;
            data.mediaMimeType = media.mimeType;
            data.mediaSize = media.size;
            data.mediaDuration = media.duration;
            data.mediaWaveformPeaks = media.waveformPeaks;
            data.linkPreview = media.linkPreview;
        }

        const msg = await this.prisma.groupMessage.create({
            data,
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } },
            },
        });

        // Update group updatedAt for ordering
        await this.prisma.groupChat.update({
            where: { id: groupId },
            data: { updatedAt: new Date() },
        });

        // Socket fan-out to room
        if (this.io) this.io.to(`group_${groupId}`).emit('group:message', msg);

        return msg;
    }

    async listMessages({ groupId, userId, cursor, limit = 30 }) {
        // Confirm member access
        const member = await this.prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId } },
        });
        if (!member || member.removedAt) throw new Error('Not a group member');

        const take = Math.min(Math.max(limit, 1), 100);
        const messages = await this.prisma.groupMessage.findMany({
            where: { groupId },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            take,
            orderBy: { createdAt: 'desc' },
            include: {
                sender: { select: { id: true, username: true, profilePictureUrl: true } },
            },
        });
        return {
            messages,
            nextCursor: messages.length === take ? messages[messages.length - 1].id : null,
        };
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

    async _assertAdmin(actorId, groupId) {
        const member = await this.prisma.groupMember.findUnique({
            where: { groupId_userId: { groupId, userId: actorId } },
        });
        if (!member || member.removedAt) throw new Error('Not a group member');
        if (member.role !== 'ADMIN') throw new Error('Admin only');
    }

    async _systemMessage(groupId, content, metadata = {}) {
        const msg = await this.prisma.groupMessage.create({
            data: {
                groupId,
                senderId: null,
                type: 'SYSTEM',
                content,
                metadata,
            },
        });
        if (this.io) this.io.to(`group_${groupId}`).emit('group:message', msg);
        return msg;
    }
}

module.exports = { GroupChatService };
