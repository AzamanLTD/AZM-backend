// services/businessOS/businessDirectMessageService.js
// =============================================================================
// r35/P0-P1 — canonical authority for the legacy /api/direct-messages surface.
//
// The legacy routes (GET /business-inbox, GET /thread, POST /send) trusted
// caller-supplied businessId/userId, which let ANY authenticated user:
//   • enumerate a business's private customer conversations;
//   • read a conversation belonging to another business;
//   • create a conversation under another business while impersonating its
//     staff (the authenticated caller was recorded as participantA).
//
// This service is the single authority the legacy routes now delegate to,
// with the same semantics the Business OS messaging surface already
// enforces (server-derived business context + participant proof):
//   • business-side authority = the caller's SERVER-RESOLVED context (owner
//     of, or ACTIVE employee of, that exact business). A caller-supplied
//     businessId is advisory at most and can never elevate access;
//   • customer-side authority = proof that the caller PARTICIPATES in the
//     exact BusinessConversation being read or written;
//   • only business-side authority may CREATE a BusinessConversation — the
//     durable businessProfileId stays attached to a real staff identity;
//   • concurrent duplicate conversation creation is serialized per business
//     (row lock on the BusinessProfile) and converges on one conversation;
//   • message insert + conversation preview update commit in ONE transaction.
// =============================================================================

'use strict';

const { resolveBusinessContext } = require('../../middleware/requirePermission');

const fail = (status, code, message) => {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
};

// Strict positive integer parse — 'abc', 'NaN', '12.5', '-1' all fail closed.
const parseUserId = (value, field = 'userId') => {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isInteger(n) || n < 1) throw fail(400, 'INVALID_INPUT', `${field} must be a valid user id.`);
    return n;
};

class BusinessDirectMessageService {
    constructor(prisma, io = null) {
        this.prisma = prisma;
        this.io = io;
    }

    // Server-derived staff context for the authenticated caller. This is the
    // ONLY source of business authority — never req.body/req.query.
    async _resolveStaffContext(user, advisoryBusinessId = null) {
        const context = await resolveBusinessContext(this.prisma, user, {
            adminScoped: false,
            adminScopedBusinessId: null,
        });
        if (!context) return null;
        // An advisory businessId supplied by the caller must match the
        // server-derived context or it is a refusal, never a downgrade.
        if (advisoryBusinessId && advisoryBusinessId !== context.businessProfileId) {
            throw fail(403, 'FORBIDDEN', 'Caller is not authorized for this business.');
        }
        return context;
    }

    // Is the caller a business-side actor (owner / active employee) of the
    // exact businessProfileId?
    async _isStaffOf(user, businessProfileId) {
        const context = await resolveBusinessContext(this.prisma, user, {
            adminScoped: false,
            adminScopedBusinessId: null,
        });
        return Boolean(context && context.businessProfileId === businessProfileId);
    }

    _conversationSummary(conv, viewerId) {
        const other = conv.participantAId === viewerId ? conv.participantB : conv.participantA;
        return {
            id: conv.conversationId,
            user: {
                id: other?.id,
                name: other?.username,
                // Legacy envelope field name, sourced from the real column.
                avatarUrl: other?.profilePictureUrl,
            },
            lastMessagePreview: conv.lastMessagePreview,
            lastMessageTime: conv.lastMessageAt,
            unreadCount: 0,
        };
    }

    _messageSummary(msg, viewerId, viewerIsStaff) {
        return {
            id: msg.id,
            text: msg.content,
            createdAt: msg.createdAt,
            senderId: msg.senderId,
            senderType: msg.senderId === viewerId ? (viewerIsStaff ? 'business' : 'user') : (viewerIsStaff ? 'user' : 'business'),
        };
    }

    // GET /business-inbox — the business the caller is STAFF of. Never the
    // caller's claim about which business they want to read.
    async businessInbox({ user, advisoryBusinessId }) {
        const context = await this._resolveStaffContext(user, advisoryBusinessId ?? null);
        if (!context) {
            throw fail(403, 'NO_BUSINESS_CONTEXT', 'No business context found for this account.');
        }
        const conversations = await this.prisma.businessConversation.findMany({
            where: { businessProfileId: context.businessProfileId },
            include: {
                // NOTE: User has profilePictureUrl — the legacy code selected a
                // nonexistent avatarUrl, which made the inbox 500 at runtime.
                participantA: { select: { id: true, username: true, profilePictureUrl: true } },
                participantB: { select: { id: true, username: true, profilePictureUrl: true } },
            },
            orderBy: { lastMessageAt: 'desc' },
        });
        return {
            businessProfileId: context.businessProfileId,
            conversations: conversations.map((conv) => this._conversationSummary(conv, user.id)),
        };
    }

    // Locate the canonical BusinessConversation between a business and a
    // customer. r36/P0: CUSTOMER_SUPPORT threads (created by this service)
    // store the customer durably in participantB — the partial unique index
    // on (businessProfileId, participantBId) WHERE channel='CUSTOMER_SUPPORT'
    // makes one-thread-per-(business, customer) a DATABASE invariant. Legacy
    // rows (channel NULL) are located without the discriminator.
    async _findConversation(businessProfileId, participantUserId) {
        const canonical = await this.prisma.businessConversation.findFirst({
            where: {
                businessProfileId,
                channel: 'CUSTOMER_SUPPORT',
                participantBId: participantUserId,
            },
            orderBy: { createdAt: 'asc' },
        });
        if (canonical) return canonical;
        return this.prisma.businessConversation.findFirst({
            where: {
                businessProfileId,
                channel: null,
                OR: [{ participantAId: participantUserId }, { participantBId: participantUserId }],
            },
            orderBy: { createdAt: 'asc' },
        });
    }

    // Access rule for a support thread. r36/P0: business-side authority is
    // STAFF-ONLY — a suspended/terminated employee is a former participantA
    // without a staff context and loses all business-side access; the
    // customer (participantB) is the only non-staff reader/writer.
    _supportThreadAccess(conv, user, staff) {
        if (staff) return true;
        return conv.participantBId === user.id;
    }

    // GET /thread — two authority paths:
    //   staff: the caller's server-derived context covers this business;
    //   customer: the caller PARTICIPATES in the exact conversation.
    async thread({ user, businessId, userId }) {
        const targetUserId = parseUserId(userId);
        if (!businessId || typeof businessId !== 'string' || !businessId.trim()) {
            throw fail(400, 'INVALID_INPUT', 'businessId required');
        }
        const bizId = businessId.trim();
        const conv = await this._findConversation(bizId, targetUserId);
        if (!conv) return { messages: [] };

        const staff = await this._isStaffOf(user, bizId);
        const isSupportThread = conv.channel === 'CUSTOMER_SUPPORT';
        const allowed = isSupportThread
            ? this._supportThreadAccess(conv, user, staff)
            : (staff || conv.participantAId === user.id || conv.participantBId === user.id);
        if (!allowed) {
            // No authority over this business and no durable participant slot:
            // the thread simply does not exist for this caller.
            throw fail(403, 'FORBIDDEN', 'Not authorized to read this conversation.');
        }

        const messages = await this.prisma.message.findMany({
            where: { conversationId: conv.conversationId },
            orderBy: { createdAt: 'asc' },
        });
        return {
            messages: messages.map((msg) => this._messageSummary(msg, user.id, staff)),
        };
    }

    // POST /send — staff may open a conversation with a customer of THEIR
    // business; everyone else may only write into a conversation they
    // PARTICIPATE in. Duplicate conversation creation converges.
    async send({ user, businessId, userId, text }) {
        const targetUserId = parseUserId(userId);
        if (!businessId || typeof businessId !== 'string' || !businessId.trim()) {
            throw fail(400, 'INVALID_INPUT', 'businessId required');
        }
        const bizId = businessId.trim();
        if (!text || typeof text !== 'string' || !text.trim()) {
            throw fail(400, 'INVALID_INPUT', 'Message text required');
        }
        const content = text.trim().slice(0, 4000);

        const staff = await this._isStaffOf(user, bizId);
        if (!staff) {
            // Customer path: may only message inside the exact support
            // conversation where the caller IS the durable customer
            // (participantB). Cannot CREATE a BusinessConversation, cannot
            // substitute another customer's id, and a former staff member
            // (suspended/terminated) has no path back in.
            const conv = await this._findConversation(bizId, targetUserId);
            if (!conv || !this._supportThreadAccess(conv, user, false)) {
                throw fail(403, 'FORBIDDEN', 'Not authorized to message this business conversation.');
            }
            return this._appendMessage({ conv, senderId: user.id, content, viewerIsStaff: false });
        }

        // Staff path — serialize conversation creation per business.
        const conv = await this.prisma.$transaction(async (tx) => {
            // Row lock on the business: concurrent creators converge.
            const locked = await tx.$queryRawUnsafe(
                'SELECT "id" FROM "BusinessProfile" WHERE "id" = $1 FOR UPDATE',
                bizId,
            );
            if (!locked || locked.length === 0) throw fail(404, 'BUSINESS_NOT_FOUND', 'Business not found.');

            let existing = await tx.businessConversation.findFirst({
                where: {
                    businessProfileId: bizId,
                    OR: [{ participantAId: targetUserId }, { participantBId: targetUserId }],
                },
            });
            if (!existing) {
                const customer = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
                if (!customer) throw fail(404, 'USER_NOT_FOUND', 'Recipient not found.');
                const conversation = await tx.conversation.create({ data: { type: 'BUSINESS' } });
                try {
                    existing = await tx.businessConversation.create({
                        data: {
                            businessProfileId: bizId,
                            conversationId: conversation.id,
                            participantAId: user.id, // the authenticated staff member
                            participantBId: targetUserId, // the customer (durable slot)
                            createdBy: user.id,
                            // Canonical channel — the partial unique index on
                            // (businessProfileId, participantBId) makes the
                            // one-thread-per-(business, customer) invariant a
                            // database constraint, not just a code path.
                            channel: 'CUSTOMER_SUPPORT',
                        },
                    });
                } catch (e) {
                    if (e.code === 'P2002') {
                        // Lost the create race: converge on the winner.
                        existing = await tx.businessConversation.findFirst({
                            where: {
                                businessProfileId: bizId,
                                channel: 'CUSTOMER_SUPPORT',
                                participantBId: targetUserId,
                            },
                            orderBy: { createdAt: 'asc' },
                        });
                        if (!existing) throw e;
                    } else {
                        throw e;
                    }
                }
            }
            return existing;
        });

        return this._appendMessage({ conv, senderId: user.id, content, viewerIsStaff: true, notifyIds: [targetUserId] });
    }

    // One transaction: the message AND the conversation preview commit together.
    async _appendMessage({ conv, senderId, content, viewerIsStaff, notifyIds = [] }) {
        const result = await this.prisma.$transaction(async (tx) => {
            const message = await tx.message.create({
                data: {
                    conversationId: conv.conversationId,
                    senderId,
                    messageType: 'TEXT',
                    content,
                },
            });
            await tx.businessConversation.update({
                where: { id: conv.id },
                data: {
                    lastMessageAt: new Date(),
                    lastMessagePreview: content.substring(0, 200),
                },
            });
            return message;
        });

        // Real-time fan-out (preserved from the legacy envelope).
        if (this.io) {
            const msgPayload = { id: result.id, text: result.content, createdAt: result.createdAt, senderId: result.senderId, senderType: viewerIsStaff ? 'business' : 'user' };
            for (const participantId of [conv.participantAId, conv.participantBId]) {
                if (participantId !== senderId) {
                    this.io.to(`user_${participantId}`).emit('new_message', { message: result });
                    this.io.to(`user_${participantId}`).emit('biz_new_message', { conversationId: conv.conversationId, message: msgPayload });
                }
            }
            for (const extra of notifyIds) {
                if (extra !== senderId) this.io.to(`user_${extra}`).emit('new_message', { message: result });
            }
        }

        return {
            message: {
                id: result.id,
                text: result.content,
                createdAt: result.createdAt,
                senderId: result.senderId,
                senderType: viewerIsStaff ? 'business' : 'user',
            },
            conversation: conv,
        };
    }
}

module.exports = { BusinessDirectMessageService };
