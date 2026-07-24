// services/susuService.js
// =============================================================================
// AZAMAN — SUSU SERVICE  (Master Sprint, 2026-05-27)
//
// Multi-party rotational savings (susu) on top of a GroupChat. Configurable
// cycle duration + contribution amount. All members must accept a severe
// legally-binding contract before the susu starts. Smart-rotation logic
// orders payouts by `trustScore` — high-trust admins go first, newly-vouched
// members go last.
//
// On each cycle's collection day the susuWorker fires `processCycle`, which:
//   1. Atomically deducts contribution from every active member.
//   2. Marks members short on funds as DEFAULTED → seizes whatever idle
//      balance they have, freezes the account (banStatus=BANNED_INDEF),
//      and applies trustScore penalties to BOTH the inviter and the second
//      voucher per the brief's "Voucher Accountability" mandate.
//   3. Routes the pool to the cycle's payoutUserId.
//
// Trust score
//   Initial: 100 + (vendorXp / 50) + min(loyaltyTier bonus, 25)
//   Penalty for vouching for a defaulter: -25 (compounding) per default.
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');

const FREQUENCY_MS = {
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    BIWEEKLY: 14 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

const VOUCHER_TRUST_PENALTY = 25;        // applied to each voucher per default
const DEFAULT_TRUST_SCORE = 100;

class SusuService {
    constructor(prisma, io, notificationService, azmRewardService) {
        this.prisma = prisma;
        this.io = io;
        this.notificationService = notificationService;
        this.azmRewardService = azmRewardService;
    }

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    /**
     * Admin creates the susu config for a group. Members are seeded from
     * GroupMember rows. trustScore is computed at this moment and frozen
     * into SusuMember.trustScore (used to rank cycleSlot at start time).
     * Status starts as CONFIGURING — `start()` is the explicit transition
     * once contractAcceptedCount === contractRequiredCount.
     */
    async createSusu({ adminId, groupChatId, contributionUsdc, frequency, startDate }) {
        const group = await this.prisma.groupChat.findUnique({
            where: { id: groupChatId },
            include: {
                members: { where: { removedAt: null } },
            },
        });
        if (!group) throw new Error('Group not found');
        if (group.susuGroupId) throw new Error('Group already has a susu');

        const adminRow = group.members.find((m) => m.userId === adminId && m.role === 'ADMIN');
        if (!adminRow) throw new Error('Only group admins can configure a susu');

        if (!FREQUENCY_MS[frequency]) throw new Error('frequency must be WEEKLY|BIWEEKLY|MONTHLY');
        const contribution = new Prisma.Decimal(contributionUsdc);
        if (contribution.lte(0)) throw new Error('contributionUsdc must be > 0');
        const start = new Date(startDate || Date.now());
        if (Number.isNaN(start.getTime())) throw new Error('Invalid startDate');

        const memberUserIds = group.members.map((m) => m.userId);
        if (memberUserIds.length < 3) throw new Error('Susu requires at least 3 members');

        // Compute trustScore for each member
        const users = await this.prisma.user.findMany({
            where: { id: { in: memberUserIds } },
            select: {
                id: true,
                vendorXp: true,
                loyaltyTier: true,
                role: true,
                strikeCount: true,
            },
        });
        const trustByUser = new Map();
        for (const u of users) {
            trustByUser.set(u.id, this._initialTrustScore(u));
        }

        // Sort by trustScore DESC. Admins get a +50 hard bias to ensure
        // they're at the front of the rotation (the brief: "high-trust /
        // admin users can take the early payout slots").
        const adminIds = new Set(
            group.members.filter((m) => m.role === 'ADMIN').map((m) => m.userId)
        );
        const ordered = memberUserIds
            .map((uid) => ({
                uid,
                trust: trustByUser.get(uid) + (adminIds.has(uid) ? 50 : 0),
            }))
            .sort((a, b) => b.trust - a.trust);

        const totalCycles = ordered.length;
        const rotationSnapshot = ordered.map((row, idx) => ({
            slot: idx + 1,
            userId: row.uid,
            trustScore: row.trust,
            isAdmin: adminIds.has(row.uid),
        }));

        // Create SusuGroup + SusuMember rows + bind to GroupChat
        const result = await this.prisma.$transaction(async (tx) => {
            const susu = await tx.susuGroup.create({
                data: {
                    contributionUsdc: contribution,
                    frequency,
                    totalCycles,
                    startDate: start,
                    contractRequiredCount: totalCycles,
                    rotationSnapshot,
                },
            });

            await tx.susuMember.createMany({
                data: rotationSnapshot.map((row) => ({
                    susuGroupId: susu.id,
                    userId: row.userId,
                    cycleSlot: row.slot,
                    trustScore: new Prisma.Decimal(row.trustScore),
                    status: 'PENDING_CONTRACT',
                })),
            });

            await tx.groupChat.update({
                where: { id: groupChatId },
                data: { susuGroupId: susu.id },
            });

            return susu;
        });

        // Notify all members to accept the contract
        for (const row of rotationSnapshot) {
            this.notificationService
                .sendNotification({
                    userId: row.userId,
                    title: 'Susu Contract Required',
                    body: `Admin started a susu: ${contribution.toFixed(2)} USDC ${frequency.toLowerCase()}. Tap to read and sign the agreement.`,
                    category: 'SUSU',
                    actionPayload: {
                        action: 'OPEN_SUSU_CONTRACT',
                        susuGroupId: result.id,
                        groupChatId,
                    },
                })
                .catch(() => {});
        }

        return result;
    }

    /**
     * Member accepts the legally-binding contract. Once everyone has
     * accepted, the susu transitions ACTIVE and SusuCycle rows are
     * generated for the full rotation.
     */
    async acceptContract({ userId, susuGroupId }) {
        return this.prisma.$transaction(async (tx) => {
            const member = await tx.susuMember.findUnique({
                where: { susuGroupId_userId: { susuGroupId, userId } },
            });
            if (!member) throw new Error('Not a susu member');
            if (member.status === 'ACTIVE') return { status: 'ALREADY_ACCEPTED' };
            if (member.status === 'DEFAULTED' || member.status === 'REMOVED') {
                throw new Error('Member is not eligible to sign');
            }

            await tx.susuMember.update({
                where: { id: member.id },
                data: { status: 'ACTIVE', contractAcceptedAt: new Date() },
            });
            const susu = await tx.susuGroup.update({
                where: { id: susuGroupId },
                data: { contractAcceptedCount: { increment: 1 } },
            });

            // Auto-start when all contracts signed
            if (susu.contractAcceptedCount >= susu.contractRequiredCount && susu.status === 'CONFIGURING') {
                await this._materializeCycles(tx, susu);
                await tx.susuGroup.update({
                    where: { id: susu.id },
                    data: { status: 'ACTIVE' },
                });
                return { status: 'STARTED' };
            }

            return {
                status: 'ACCEPTED',
                progress: `${susu.contractAcceptedCount}/${susu.contractRequiredCount}`,
            };
        });
    }

    async cancel({ adminId, susuGroupId }) {
        const susu = await this.prisma.susuGroup.findUnique({
            where: { id: susuGroupId },
            include: { groupChat: true },
        });
        if (!susu) throw new Error('Susu not found');
        if (susu.status !== 'CONFIGURING') {
            throw new Error('Cannot cancel an active or completed susu');
        }
        // verify actor is admin
        const groupChat = await this.prisma.groupChat.findFirst({
            where: { susuGroupId },
            include: { members: true },
        });
        const adminRow = groupChat?.members?.find((m) => m.userId === adminId && m.role === 'ADMIN');
        if (!adminRow) throw new Error('Admin only');

        await this.prisma.$transaction([
            this.prisma.susuGroup.update({
                where: { id: susuGroupId },
                data: { status: 'CANCELLED' },
            }),
            this.prisma.groupChat.updateMany({
                where: { susuGroupId },
                data: { susuGroupId: null },
            }),
        ]);
    }

    // =========================================================================
    // CYCLE PROCESSING (called by susuWorker)
    // =========================================================================

    /**
     * Atomically process a single cycle's collection. Returns a structured
     * report of paid/defaulted members + payout result.
     */
    async processCycle(cycleId) {
        const cycle = await this.prisma.susuCycle.findUnique({
            where: { id: cycleId },
            include: {
                susu: {
                    include: {
                        members: {
                            where: { status: { in: ['ACTIVE', 'DEFAULTED'] } },
                        },
                    },
                },
            },
        });
        if (!cycle) throw new Error('Cycle not found');
        if (cycle.status !== 'PENDING') return { skipped: true, reason: 'not pending' };

        // Mark COLLECTING immediately so concurrent worker ticks don't
        // double-process the same cycle.
        await this.prisma.susuCycle.update({
            where: { id: cycle.id },
            data: { status: 'COLLECTING' },
        });

        const contribution = new Prisma.Decimal(cycle.susu.contributionUsdc);
        const paid = [];
        const defaulted = [];
        let totalCollected = new Prisma.Decimal(0);

        for (const member of cycle.susu.members) {
            if (member.status === 'DEFAULTED') {
                defaulted.push({ memberId: member.id, userId: member.userId, shortfall: contribution });
                continue;
            }
            // Atomic deduct from User.availableBalance
            try {
                await this.prisma.$transaction(async (tx) => {
                    const u = await tx.user.findUnique({
                        where: { id: member.userId },
                        select: { availableBalance: true },
                    });
                    const balance = new Prisma.Decimal(u?.availableBalance || 0);
                    if (balance.gte(contribution)) {
                        await tx.user.update({
                            where: { id: member.userId },
                            data: { availableBalance: { decrement: contribution } },
                        });
                        await tx.susuContribution.create({
                            data: {
                                cycleId: cycle.id,
                                memberId: member.id,
                                userId: member.userId,
                                amountUsdc: contribution,
                                status: 'PAID',
                            },
                        });
                        totalCollected = totalCollected.plus(contribution);
                        paid.push({ memberId: member.id, userId: member.userId });
                    } else {
                        // Partial seize from available + flag default
                        const seizable = balance;
                        const shortfall = contribution.minus(seizable);
                        if (seizable.gt(0)) {
                            await tx.user.update({
                                where: { id: member.userId },
                                data: { availableBalance: { decrement: seizable } },
                            });
                            totalCollected = totalCollected.plus(seizable);
                        }
                        await tx.susuContribution.create({
                            data: {
                                cycleId: cycle.id,
                                memberId: member.id,
                                userId: member.userId,
                                amountUsdc: contribution,
                                status: 'SEIZED',
                                seizedFromAvailable: seizable,
                                shortfall,
                            },
                        });
                        await tx.susuMember.update({
                            where: { id: member.id },
                            data: {
                                status: 'DEFAULTED',
                                defaultedAt: new Date(),
                                totalSeizedUsdc: { increment: seizable },
                            },
                        });
                        defaulted.push({
                            memberId: member.id,
                            userId: member.userId,
                            shortfall,
                            seized: seizable,
                        });
                    }
                });
            } catch (err) {
                logger.error({ err: err }, '[susuService.processCycle] transaction error');
                defaulted.push({
                    memberId: member.id,
                    userId: member.userId,
                    shortfall: contribution,
                    error: err.message,
                });
            }
        }

        // Apply default penalties: freeze accounts + voucher trust hits
        for (const d of defaulted) {
            await this._handleDefault(d.userId, d.shortfall || contribution);
        }

        // =====================================================================
        // PHASE 5: ADMIN PROFIT ENGINE
        // Skim the platform fee from the pool before payout
        // =====================================================================
        const settings = await this.prisma.globalSettings.findFirst();
        const profitPct = new Prisma.Decimal(settings?.susuProfitPct || 0.03);
        const feeUsdc = totalCollected.mul(profitPct).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
        const netPayout = totalCollected.minus(feeUsdc);

        // Pay out the net pool to the winner + log the fee
        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: cycle.payoutUserId },
                data: { availableBalance: { increment: netPayout } },
            }),
            this.prisma.susuCycle.update({
                where: { id: cycle.id },
                data: {
                    status: defaulted.length > 0 ? 'DEFAULTED' : 'PAID_OUT',
                    paidOutAt: new Date(),
                    defaultsCount: defaulted.length,
                    payoutAmount: netPayout,
                    feeUsdc,
                },
            }),
            this.prisma.transactionHistory.create({
                data: {
                    userId: cycle.payoutUserId,
                    type: 'SUSU_PAYOUT',
                    amountUsdc: netPayout,
                    status: 'COMPLETED',
                },
            }),
            // Log the platform fee to AdminProfitLog
            this.prisma.adminProfitLog.create({
                data: {
                    source: 'SUSU_FEE',
                    amountUsdc: feeUsdc,
                    metadata: {
                        cycleId: cycle.id,
                        susuGroupId: cycle.susuGroupId,
                        cycleNumber: cycle.cycleNumber,
                        totalCollected: totalCollected.toFixed(2),
                        profitPct: profitPct.toFixed(4),
                    },
                },
            }),
            // Also log as a SUSU_PROFIT transaction for audit trail
            this.prisma.transactionHistory.create({
                data: {
                    userId: null, // Platform transaction
                    type: 'SUSU_PROFIT',
                    amountUsdc: feeUsdc,
                    status: 'COMPLETED',
                    metadata: {
                        cycleId: cycle.id,
                        susuGroupId: cycle.susuGroupId,
                    },
                },
            }),
        ]);

        // Notifications
        try {
            await this.notificationService.sendNotification({
                userId: cycle.payoutUserId,
                title: 'Susu Payout Received!',
                body: `You received $${netPayout.toFixed(2)} from cycle ${cycle.cycleNumber}.`,
                category: 'SUSU',
                actionPayload: { action: 'OPEN_SUSU', susuGroupId: cycle.susuGroupId },
            });
        } catch (_) { /* swallow */ }

        // Emit to group room
        if (this.io) {
            this.io.to(`susu_${cycle.susuGroupId}`).emit('susu:cycle_paid_out', {
                cycleId: cycle.id,
                cycleNumber: cycle.cycleNumber,
                payoutUserId: cycle.payoutUserId,
                amount: Number(netPayout.toFixed(2)),
                fee: Number(feeUsdc.toFixed(2)),
                defaults: defaulted.length,
            });
        }

        // Check if final cycle → mark susu COMPLETED
        const remaining = await this.prisma.susuCycle.count({
            where: { susuGroupId: cycle.susuGroupId, status: { in: ['PENDING', 'COLLECTING'] } },
        });
        if (remaining === 0) {
            await this.prisma.susuGroup.update({
                where: { id: cycle.susuGroupId },
                data: { status: 'COMPLETED' },
            });
            // Award completion AZM to all non-defaulted members
            const completed = await this.prisma.susuMember.findMany({
                where: { susuGroupId: cycle.susuGroupId, status: 'ACTIVE' },
            });
            for (const m of completed) {
                this.azmRewardService
                    ?.creditAzm({
                        userId: m.userId,
                        amount: 25,
                        source: 'SUSU_COMPLETION',
                        reason: 'Susu cycle completed without default (+25 AZM)',
                        metadata: { susuGroupId: cycle.susuGroupId },
                        dedupKey: `susu-complete-${cycle.susuGroupId}-${m.userId}`,
                    })
                    .catch(() => {});
            }
        }

        return {
            cycleId: cycle.id,
            paid: paid.length,
            defaulted: defaulted.length,
            totalCollected: Number(totalCollected.toFixed(2)),
            feeUsdc: Number(feeUsdc.toFixed(2)),
            netPayout: Number(netPayout.toFixed(2)),
            payoutUserId: cycle.payoutUserId,
        };
    }

    // =========================================================================
    // VOUCHING
    // =========================================================================

    /**
     * Submit a vouch form. Used by the second voucher (and any future
     * required vouchers) to fill out their part of the form.
     */
    async submitVouch({ voucherId, vouchRecordId, payload }) {
        const vouch = await this.prisma.vouchRecord.findUnique({ where: { id: vouchRecordId } });
        if (!vouch) throw new Error('Vouch record not found');
        if (vouch.voucherId !== voucherId) throw new Error('Not your vouch to submit');
        if (vouch.status === 'COMPLETED') return { status: 'ALREADY_SUBMITTED' };

        return this.prisma.vouchRecord.update({
            where: { id: vouch.id },
            data: {
                relationship: String(payload.relationship).slice(0, 80),
                durationKnown: String(payload.durationKnown || 'unspecified').slice(0, 40),
                reasonForTrust: String(payload.reasonForTrust).slice(0, 500),
                acknowledgesPenalty: !!payload.acknowledgesPenalty,
                status: 'COMPLETED',
                submittedAt: new Date(),
            },
        });
    }

    /**
     * Pre-registration vouch hook — called from authController on signup.
     * Scans VouchRecord rows for inviteePhone matches and re-keys them to
     * the new userId. Idempotent (safe to retry).
     */
    static async linkPreRegistrationVouches(prisma, userId, phoneNumber) {
        if (!phoneNumber) return 0;
        const result = await prisma.vouchRecord.updateMany({
            where: { inviteePhone: phoneNumber, inviteeId: null },
            data: { inviteeId: userId, inviteePhone: null },
        });
        return result.count;
    }

    async pendingVouchesFor(userId) {
        return this.prisma.vouchRecord.findMany({
            where: { voucherId: userId, status: 'PENDING' },
            include: {
                group: { select: { id: true, name: true, avatarUrl: true } },
                invitee: { select: { id: true, username: true, profilePictureUrl: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

    _initialTrustScore(user) {
        let score = DEFAULT_TRUST_SCORE;
        score += Math.min(40, Math.floor((user.vendorXp || 0) / 50));
        if (user.loyaltyTier === 'GOLD') score += 15;
        if (user.loyaltyTier === 'PLATINUM') score += 25;
        if (user.role === 'ADMIN') score += 50;
        score -= Math.min(40, (user.strikeCount || 0) * 5);
        return Math.max(0, Math.round(score * 100) / 100);
    }

    async _materializeCycles(tx, susu) {
        const interval = FREQUENCY_MS[susu.frequency];
        const totalPool = new Prisma.Decimal(susu.contributionUsdc).mul(susu.totalCycles);
        const members = await tx.susuMember.findMany({
            where: { susuGroupId: susu.id },
            orderBy: { cycleSlot: 'asc' },
        });
        const rows = members.map((m) => ({
            susuGroupId: susu.id,
            cycleNumber: m.cycleSlot,
            collectionDate: new Date(susu.startDate.getTime() + (m.cycleSlot - 1) * interval),
            payoutAmount: totalPool,
            payoutUserId: m.userId,
            status: 'PENDING',
        }));
        await tx.susuCycle.createMany({ data: rows });
    }

    /**
     * Default handler: freeze the defaulter, apply trust-score penalties to
     * the inviter + second voucher (Voucher Accountability mandate).
     */
    async _handleDefault(userId, shortfall) {
        try {
            // Freeze account
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    banStatus: 'BANNED_INDEF',
                    strikeCount: { increment: 1 },
                },
            });

            // Find the vouchers — we look at the most recent COMPLETED
            // VouchRecord rows for this user as invitee.
            const vouches = await this.prisma.vouchRecord.findMany({
                where: { inviteeId: userId, status: 'COMPLETED' },
                orderBy: { createdAt: 'desc' },
                take: 2,
            });

            for (const v of vouches) {
                // Apply trust-score penalty to ALL active SusuMember rows
                // for the voucher across every group they belong to.
                await this.prisma.$executeRawUnsafe(
                    `UPDATE "SusuMember"
                       SET "trustScore" = GREATEST(0, "trustScore" - $1)
                     WHERE "userId" = $2`,
                    VOUCHER_TRUST_PENALTY,
                    v.voucherId
                );

                // Notify the voucher
                this.notificationService
                    .sendNotification({
                        userId: v.voucherId,
                        title: 'Vouchee Defaulted',
                        body: `Someone you vouched for defaulted on a Susu. Trust penalty: -${VOUCHER_TRUST_PENALTY} on all Susu memberships. Account flagged.`,
                        category: 'SUSU',
                        actionPayload: {
                            action: 'OPEN_VOUCHES',
                            defaulterUserId: userId,
                        },
                    })
                    .catch(() => {});
            }

            // Notify defaulter
            this.notificationService
                .sendNotification({
                    userId,
                    title: '⚠️ Susu Default — Account Frozen',
                    body: `You defaulted on a Susu contribution ($${new Prisma.Decimal(shortfall).toFixed(2)} short). Your account has been frozen pending admin review.`,
                    category: 'SECURITY_ACCOUNT',
                    actionPayload: { action: 'OPEN_TICKETS' },
                })
                .catch(() => {});
        } catch (err) {
            logger.error({ err: err }, '[susuService._handleDefault] failed');
        }
    }
}

module.exports = { SusuService, FREQUENCY_MS, VOUCHER_TRUST_PENALTY };
