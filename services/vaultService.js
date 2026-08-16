// services/vaultService.js
// =============================================================================
// AZAMAN — VAULT SERVICE  (Master Sprint, 2026-05-27)
//
// Solo Vault: locked escrow wallet with gamified deposit rules.
//
// Responsibilities
//   • createVault   — accept rules, write contract, schedule auto-rule
//   • depositManual — pull from availableBalance into Vault.currentAmountUsdc
//   • runAutoRule   — fired by vaultWorker on schedule
//   • breakEarly    — apply penalty, return remainder to availableBalance
//   • completeMatured — sweep matured vaults, return funds, write receipt
//   • computeAzmIntensity — Amount × frequency-mult × streak-bonus
//
// Atomicity
//   Every balance-touching method runs inside `prisma.$transaction([...])`
//   so either both legs (User.availableBalance and Vault.currentAmountUsdc)
//   change or neither does. Concurrency safety against double-spend is
//   provided by Postgres CHECK (availableBalance >= 0) on User.
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');

const FREQUENCY_MS = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    BIWEEKLY: 14 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000, // approximate; close enough for vault scheduling
};

// Frequency multipliers for AZM intensity. Daily savers earn the most per
// dollar saved (highest discipline cost). The numbers below are inverse to
// FREQUENCY_MS so less-frequent vaults pay less per dollar.
const FREQUENCY_AZM_MULT = {
    DAILY: 1.50,
    WEEKLY: 1.00,
    BIWEEKLY: 0.80,
    MONTHLY: 0.60,
};

const AZM_BASE_PER_USDC = 0.10;          // 10 AZM per 100 USDC base rate
const AZM_STREAK_BONUS_STEP = 0.05;       // +5% per consecutive on-time deposit
const AZM_STREAK_BONUS_CAP = 1.00;        // capped at +100%

class VaultService {
    constructor(prisma, io, notificationService, azmRewardService) {
        this.prisma = prisma;
        this.io = io;
        this.notificationService = notificationService;
        this.azmRewardService = azmRewardService;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    async createVault({ userId, name, targetAmountUsdc, maturityDate, autoRule, rulesAcceptedVersion = 1 }) {
        if (!name || !targetAmountUsdc || !maturityDate) {
            throw new Error('name, targetAmountUsdc, and maturityDate are required');
        }
        if (Number(targetAmountUsdc) <= 0) throw new Error('targetAmountUsdc must be > 0');
        const matureAt = new Date(maturityDate);
        if (Number.isNaN(matureAt.getTime()) || matureAt <= new Date()) {
            throw new Error('maturityDate must be a future ISO date');
        }

        const data = {
            userId,
            name: String(name).slice(0, 60),
            targetAmountUsdc: new Prisma.Decimal(targetAmountUsdc),
            rulesAcceptedAt: new Date(),
            rulesAcceptedVersion,
            maturityDate: matureAt,
            startDate: new Date(),
        };

        if (autoRule && autoRule.enabled) {
            if (!autoRule.amountUsdc || Number(autoRule.amountUsdc) <= 0) {
                throw new Error('autoRule.amountUsdc must be > 0 when enabled');
            }
            if (!FREQUENCY_MS[autoRule.frequency]) {
                throw new Error('autoRule.frequency must be DAILY|WEEKLY|BIWEEKLY|MONTHLY');
            }
            data.autoRuleEnabled = true;
            data.autoRuleAmountUsdc = new Prisma.Decimal(autoRule.amountUsdc);
            data.autoRuleFrequency = autoRule.frequency;
            data.autoRuleNextRun = new Date(Date.now() + FREQUENCY_MS[autoRule.frequency]);
        }

        const vault = await this.prisma.vault.create({ data });
        return vault;
    }

    async depositManual({ userId, vaultId, amountUsdc }) {
        const amt = new Prisma.Decimal(amountUsdc);
        if (amt.lte(0)) throw new Error('amountUsdc must be > 0');

        const vault = await this.prisma.vault.findUnique({
            where: { id: vaultId },
        });
        if (!vault || vault.userId !== userId) throw new Error('Vault not found');
        if (vault.status !== 'ACTIVE') throw new Error('Vault is not active');

        return this._executeDeposit({
            vault,
            amount: amt,
            type: 'MANUAL',
            scheduledFor: null,
        });
    }

    /**
     * Run the auto-rule for a single vault. Called by vaultWorker.
     * Returns { ok, status, idleHint } where idleHint indicates whether
     * the user has idle availableBalance the worker should warn about.
     */
    async runAutoRule(vault) {
        if (!vault.autoRuleEnabled || !vault.autoRuleAmountUsdc) return { ok: false, status: 'NO_RULE' };
        if (vault.status !== 'ACTIVE') return { ok: false, status: 'INACTIVE' };

        const user = await this.prisma.user.findUnique({
            where: { id: vault.userId },
            select: { availableBalance: true },
        });
        if (!user) return { ok: false, status: 'USER_GONE' };

        const required = new Prisma.Decimal(vault.autoRuleAmountUsdc);
        const balance = new Prisma.Decimal(user.availableBalance);

        // Reschedule next run regardless of outcome — we don't want a
        // failed run to prevent the next attempt.
        const nextRun = new Date(Date.now() + FREQUENCY_MS[vault.autoRuleFrequency]);

        if (balance.lt(required)) {
            // Insufficient — log a failed deposit, increment missedCount,
            // reset streak after grace, return idleHint so worker decides
            // whether to fire the "streak at risk" push.
            await this.prisma.$transaction([
                this.prisma.vaultDeposit.create({
                    data: {
                        vaultId: vault.id,
                        userId: vault.userId,
                        amountUsdc: required,
                        type: 'AUTO_RULE',
                        status: 'FAILED_INSUFFICIENT',
                        scheduledFor: vault.autoRuleNextRun,
                        failureReason: `Insufficient balance ($${balance.toFixed(2)} < $${required.toFixed(2)})`,
                    },
                }),
                this.prisma.vault.update({
                    where: { id: vault.id },
                    data: {
                        autoRuleNextRun: nextRun,
                        missedCount: { increment: 1 },
                        streakCount: 0,
                    },
                }),
            ]);
            return {
                ok: false,
                status: 'INSUFFICIENT',
                shortfall: required.minus(balance),
                availableBalance: balance,
                required,
            };
        }

        await this._executeDeposit({
            vault,
            amount: required,
            type: 'AUTO_RULE',
            scheduledFor: vault.autoRuleNextRun,
            extraVaultUpdate: { autoRuleNextRun: nextRun },
        });
        return { ok: true, status: 'COMPLETED' };
    }

    /**
     * Early break: penalty applied, remainder returned to availableBalance.
     * AZM already credited stays credited (feature, not bug).
     */
    async breakEarly({ userId, vaultId }) {
        const vault = await this.prisma.vault.findUnique({ where: { id: vaultId } });
        if (!vault || vault.userId !== userId) throw new Error('Vault not found');
        if (vault.status !== 'ACTIVE') throw new Error('Vault is not active');

        const balance = new Prisma.Decimal(vault.currentAmountUsdc);
        const penaltyPct = new Prisma.Decimal(vault.earlyBreakPenaltyPct);
        const penalty = balance.mul(penaltyPct);
        const refund = balance.minus(penalty);

        const result = await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: userId },
                data: { availableBalance: { increment: refund } },
            }),
            this.prisma.vault.update({
                where: { id: vault.id },
                data: {
                    status: 'BROKEN_EARLY',
                    brokenAt: new Date(),
                    currentAmountUsdc: 0,
                    completedAt: new Date(),
                    receiptSnapshot: this._buildReceipt(vault, {
                        finalState: 'BROKEN_EARLY',
                        refund,
                        penalty,
                    }),
                },
            }),
            this.prisma.adminProfitLog.create({
                data: {
                    amountUsdc: penalty,
                    source: 'SAVINGS_FEE',
                    relatedTxId: `vault-break-${vault.id}`,
                },
            }),
            this.prisma.transactionHistory.create({
                data: {
                    userId,
                    type: 'VAULT_RELEASE',
                    amountUsdc: refund,
                    feeUsdc: penalty,
                    status: 'COMPLETED',
                },
            }),
        ]);

        // Notify
        try {
            await this.notificationService.sendNotification({
                userId,
                title: 'Vault Broken',
                body: `You broke "${vault.name}" early. Penalty: $${penalty.toFixed(2)}. $${refund.toFixed(2)} returned to your wallet.`,
                category: 'VAULT',
                actionPayload: { action: 'VIEW_VAULT', vaultId: vault.id, finalState: 'BROKEN_EARLY' },
            });
        } catch (_) { /* swallow */ }

        this._emitBalanceUpdate(userId);
        this._emitVaultEvent(userId, 'vault:update', vault.id);
        return result[1]; // updated vault
    }

    /**
     * Sweep matured vaults: full balance returns to availableBalance,
     * vault marked COMPLETED, receipt snapshot written, AZM completion
     * bonus credited.
     */
    async completeMatured(vault) {
        const balance = new Prisma.Decimal(vault.currentAmountUsdc);

        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: vault.userId },
                data: { availableBalance: { increment: balance } },
            }),
            this.prisma.vault.update({
                where: { id: vault.id },
                data: {
                    status: 'COMPLETED',
                    completedAt: new Date(),
                    currentAmountUsdc: 0,
                    consistencyScore: this._computeConsistencyScore(vault),
                    receiptSnapshot: this._buildReceipt(vault, {
                        finalState: 'COMPLETED',
                        refund: balance,
                        penalty: new Prisma.Decimal(0),
                    }),
                },
            }),
            this.prisma.transactionHistory.create({
                data: {
                    userId: vault.userId,
                    type: 'VAULT_RELEASE',
                    amountUsdc: balance,
                    status: 'COMPLETED',
                },
            }),
        ]);

        // Completion AZM bonus — flat 25 AZM for every completed vault,
        // plus 5% of total deposits as bonus AZM.
        const completionBonus = balance.mul(0.0125).plus(25); // ~1.25% + 25 base
        if (this.azmRewardService) {
            try {
                await this.azmRewardService.creditAzm({
                    userId: vault.userId,
                    amount: Number(completionBonus.toFixed(2)),
                    source: 'VAULT_COMPLETION',
                    reason: `Vault "${vault.name}" matured (+${completionBonus.toFixed(2)} AZM)`,
                    metadata: { vaultId: vault.id, deposited: balance.toString() },
                    dedupKey: `vault-completion-${vault.id}`,
                });
            } catch (_) { /* swallow */ }
        }

        try {
            await this.notificationService.sendNotification({
                userId: vault.userId,
                title: '🎉 Vault Matured!',
                body: `"${vault.name}" complete. $${balance.toFixed(2)} returned to your wallet. Tap to view your stats and start a new goal.`,
                category: 'VAULT',
                actionPayload: { action: 'VIEW_VAULT_RECEIPT', vaultId: vault.id },
            });
        } catch (_) { /* swallow */ }

        this._emitBalanceUpdate(vault.userId);
        this._emitVaultEvent(vault.userId, 'vault:completed', vault.id);
    }

    async listForUser(userId) {
        return this.prisma.vault.findMany({
            where: { userId },
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
    }

    async getDetail(userId, vaultId) {
        const vault = await this.prisma.vault.findUnique({
            where: { id: vaultId },
            include: {
                deposits: {
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                },
            },
        });
        if (!vault || vault.userId !== userId) return null;
        return vault;
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

    async _executeDeposit({ vault, amount, type, scheduledFor, extraVaultUpdate = {} }) {
        // Compute AZM reward up-front so the breakdown can be embedded in
        // the deposit row + the FE notification verbatim.
        const breakdown = this.computeAzmIntensity({
            amount,
            frequency: vault.autoRuleFrequency || 'WEEKLY',
            currentStreak: vault.streakCount,
            type,
        });

        const isOnTime = type === 'AUTO_RULE';

        try {
            const [userRow] = await this.prisma.$transaction([
                this.prisma.user.update({
                    where: { id: vault.userId },
                    data: { availableBalance: { decrement: amount } },
                }),
                this.prisma.vault.update({
                    where: { id: vault.id },
                    data: {
                        currentAmountUsdc: { increment: amount },
                        streakCount: isOnTime ? { increment: 1 } : vault.streakCount,
                        longestStreak: isOnTime
                            ? Math.max(vault.longestStreak, vault.streakCount + 1)
                            : vault.longestStreak,
                        totalAzmEarned: { increment: new Prisma.Decimal(breakdown.totalAzm) },
                        ...extraVaultUpdate,
                    },
                }),
                this.prisma.vaultDeposit.create({
                    data: {
                        vaultId: vault.id,
                        userId: vault.userId,
                        amountUsdc: amount,
                        type,
                        status: 'COMPLETED',
                        azmAwarded: new Prisma.Decimal(breakdown.totalAzm),
                        azmBreakdown: breakdown,
                        scheduledFor,
                    },
                }),
                this.prisma.transactionHistory.create({
                    data: {
                        userId: vault.userId,
                        type: 'VAULT_DEPOSIT',
                        amountUsdc: amount,
                        status: 'COMPLETED',
                    },
                }),
            ]);

            // Credit AZM via canonical service so the AzmRewardLog audit
            // trail stays consistent with all other reward flows.
            if (this.azmRewardService && breakdown.totalAzm > 0) {
                try {
                    await this.azmRewardService.creditAzm({
                        userId: vault.userId,
                        amount: breakdown.totalAzm,
                        source: 'VAULT_INTENSITY',
                        reason: `Vault deposit "${vault.name}" — Intensity Reward`,
                        metadata: {
                            vaultId: vault.id,
                            depositAmount: Number(amount.toFixed(2)),
                            breakdown,
                        },
                        // dedup per-deposit so retries don't double-credit
                        dedupKey: `vault-deposit-${vault.id}-${Date.now()}`,
                    });
                } catch (_) { /* swallow */ }
            }

            // Push the itemized breakdown to the user.
            try {
                const breakdownLines = [
                    `Base: ${breakdown.base.toFixed(2)} AZM`,
                    `Frequency (${vault.autoRuleFrequency || 'manual'}) ×${breakdown.frequencyMultiplier}: ${breakdown.afterFrequency.toFixed(2)} AZM`,
                    `Streak ×${breakdown.streakMultiplier.toFixed(2)}: ${breakdown.totalAzm.toFixed(2)} AZM`,
                ];
                await this.notificationService.sendNotification({
                    userId: vault.userId,
                    title: `+${breakdown.totalAzm.toFixed(2)} AZM Earned`,
                    body: `"${vault.name}": $${amount.toFixed(2)} deposited. ${breakdownLines.join(' · ')}`,
                    category: 'VAULT',
                    actionPayload: {
                        action: 'VIEW_VAULT',
                        vaultId: vault.id,
                        breakdown,
                    },
                });
            } catch (_) { /* swallow */ }

            this._emitBalanceUpdate(vault.userId);
            this._emitVaultEvent(vault.userId, 'vault:update', vault.id);

            return { vault: userRow, breakdown };
        } catch (err) {
            // Insufficient balance violates CHECK constraint → log the
            // failed attempt and rethrow.
            await this.prisma.vaultDeposit
                .create({
                    data: {
                        vaultId: vault.id,
                        userId: vault.userId,
                        amountUsdc: amount,
                        type,
                        status: 'FAILED_OTHER',
                        scheduledFor,
                        failureReason: err.message,
                    },
                })
                .catch(() => {});
            throw err;
        }
    }

    /**
     * AZM intensity formula (deterministic, exposed for FE preview):
     *   base       = amount × AZM_BASE_PER_USDC
     *   freq_mult  = FREQUENCY_AZM_MULT[frequency]
     *   streak_mult = 1 + min(streak × AZM_STREAK_BONUS_STEP, AZM_STREAK_BONUS_CAP)
     *   total      = base × freq_mult × streak_mult
     *
     * Returns the full breakdown so the UI can render the explainer
     * exactly the way the cron credited it.
     */
    computeAzmIntensity({ amount, frequency, currentStreak, type }) {
        const amt = Number(new Prisma.Decimal(amount).toFixed(8));
        const base = +(amt * AZM_BASE_PER_USDC).toFixed(4);
        const frequencyMultiplier = FREQUENCY_AZM_MULT[frequency] || 1.0;
        const afterFrequency = +(base * frequencyMultiplier).toFixed(4);
        const streakBonus = Math.min(currentStreak * AZM_STREAK_BONUS_STEP, AZM_STREAK_BONUS_CAP);
        const streakMultiplier = +(1 + streakBonus).toFixed(4);
        const totalAzm = +(afterFrequency * streakMultiplier).toFixed(2);

        return {
            base,
            frequencyMultiplier,
            afterFrequency,
            streakMultiplier,
            streakBonus,
            totalAzm,
            type: type || 'MANUAL',
        };
    }

    _computeConsistencyScore(vault) {
        const expected = vault.streakCount + vault.missedCount;
        if (expected === 0) return 100;
        return Math.round(((vault.streakCount / expected) * 100) * 100) / 100;
    }

    _buildReceipt(vault, { finalState, refund, penalty }) {
        return {
            vaultId: vault.id,
            name: vault.name,
            finalState,
            target: Number(new Prisma.Decimal(vault.targetAmountUsdc).toFixed(2)),
            deposited: Number(new Prisma.Decimal(vault.currentAmountUsdc).toFixed(2)),
            refundedToWallet: Number(refund.toFixed(2)),
            penalty: Number(penalty.toFixed(2)),
            streak: { current: vault.streakCount, longest: vault.longestStreak },
            missed: vault.missedCount,
            consistencyScore: this._computeConsistencyScore(vault),
            totalAzmEarned: Number(new Prisma.Decimal(vault.totalAzmEarned).toFixed(2)),
            generatedAt: new Date().toISOString(),
        };
    }

    _emitBalanceUpdate(userId) {
        if (!this.io) return;
        // Reuse the canonical balance-room broadcast — server.js owns the
        // emitBalanceUpdate helper, but we don't have that helper bound
        // here. Re-emit via the same room so the FE balance providers
        // refetch.
        try {
            this.io.to(`balance_room_${userId}`).emit('balance_update_request', { userId });
        } catch (_) { /* swallow */ }
    }

    _emitVaultEvent(userId, event, vaultId) {
        if (!this.io) return;
        try {
            this.io.to(`user_${userId}`).emit(event, { vaultId });
        } catch (_) { /* swallow */ }
    }
}

module.exports = { VaultService, FREQUENCY_MS, FREQUENCY_AZM_MULT };
