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
const ledger = require('./ledgerService');

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

    async depositManual({ userId, vaultId, amountUsdc, idempotencyKey = null }) {
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
            idempotencyKey,
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

        try {
            await this._executeDeposit({
                vault,
                amount: required,
                type: 'AUTO_RULE',
                scheduledFor: vault.autoRuleNextRun,
                extraVaultUpdate: { autoRuleNextRun: nextRun },
            });
        } catch (err) {
            // r16 P0-D: the guarded ACTIVE claim inside _executeDeposit is
            // the authority — a vault terminalized (broken/completed) between
            // the worker's stale read and the deposit claim must NOT commit
            // money into a terminal vault.
            if (err.code === 'VAULT_TERMINALIZED') return { ok: false, status: 'INACTIVE' };
            throw err;
        }
        return { ok: true, status: 'COMPLETED' };
    }

    /**
     * Early break: penalty applied, remainder returned to availableBalance.
     * AZM already credited stays credited (feature, not bug).
     *
     * r16 P0-D: one atomic terminal claim. The vault row is locked FOR
     * UPDATE inside the transaction and the ACTIVE status is re-proved
     * under that lock before any money moves — breakEarly vs
     * completeMatured (and breakEarly vs breakEarly) converge through the
     * same row lock, and exactly one terminal identity can win. The losing
     * concurrent operation rolls back without touching money.
     */
    async breakEarly({ userId, vaultId }) {
        const outcome = await this.prisma.$transaction(async (tx) => {
            // r16 P0-D: DB-authoritative terminal claim. SELECT ... FOR
            // UPDATE locks the row; every concurrent mutation of this vault
            // (deposit claim, competing break/complete) blocks behind it
            // and then re-proves status against the committed terminal
            // state. The stale pre-transaction read is no longer economic
            // authority.
            const rows = await tx.$queryRaw`SELECT * FROM "Vault" WHERE "id" = ${vaultId} FOR UPDATE`;
            const fresh = rows[0];
            if (!fresh || fresh.userId !== userId) throw new Error('Vault not found');
            if (fresh.status !== 'ACTIVE') {
                const err = new Error('Vault is no longer active.');
                err.code = 'VAULT_ALREADY_TERMINALIZED';
                throw err;
            }

            const balance = new Prisma.Decimal(fresh.currentAmountUsdc);
            const penaltyPct = new Prisma.Decimal(fresh.earlyBreakPenaltyPct);
            const penalty = balance.mul(penaltyPct);
            const refund = balance.minus(penalty);

            const userUpdate = await tx.user.update({
                where: { id: userId },
                data: { availableBalance: { increment: refund } },
            });
            const vaultUpdate = await tx.vault.update({
                where: { id: vaultId },
                data: {
                    status: 'BROKEN_EARLY',
                    brokenAt: new Date(),
                    currentAmountUsdc: 0,
                    completedAt: new Date(),
                    receiptSnapshot: this._buildReceipt(fresh, {
                        finalState: 'BROKEN_EARLY',
                        refund,
                        penalty,
                    }),
                },
            });
            const profitRow = await tx.adminProfitLog.create({
                data: {
                    amountUsdc: penalty,
                    source: 'SAVINGS_FEE',
                    relatedTxId: `vault-break-${vaultId}`,
                },
            });
            const historyRow = await tx.transactionHistory.create({
                data: {
                    userId,
                    type: 'VAULT_RELEASE',
                    amountUsdc: refund,
                    feeUsdc: penalty,
                    status: 'COMPLETED',
                },
            });
            // §P.4 AUTHORITATIVE LEDGER — early-break settlement, same
            // transaction, idempotent on the vault's break identity. With
            // the FOR UPDATE claim as the primary single-winner guard, the
            // ledger key is now the second line of defense, not the only
            // one:
            //   D escrow:vault-{vaultId}:locked — savings restriction released
            //   C user:{userId}:liability       — refund share
            //   C revenue:fees                   — early-break penalty realized
            // penalty + refund === balance exactly, so the posting balances
            // with no dust.
            await ledger.post(tx, {
                idempotencyKey: `ledger:vault:break-early:${vaultId}`,
                entryType: 'VAULT_RELEASE',
                description: `Vault "${fresh.name}" broken early — refund to wallet, penalty realized`,
                userId,
                relatedEntity: 'vault',
                relatedEntityId: vaultId,
                metadata: { penaltyPct: fresh.earlyBreakPenaltyPct, finalState: 'BROKEN_EARLY' },
                lines: [
                    { account: `escrow:vault-${vaultId}:locked`, debit: balance.toFixed(8) },
                    { account: `user:${userId}:liability`, credit: refund.toFixed(8) },
                    { account: 'revenue:fees', credit: penalty.toFixed(8) },
                ],
            });
            return { result: [userUpdate, vaultUpdate, profitRow, historyRow], refund, penalty, name: fresh.name };
        });

        // Notify
        try {
            await this.notificationService.sendNotification({
                userId,
                title: 'Vault Broken',
                body: `You broke "${outcome.name}" early. Penalty: $${outcome.penalty.toFixed(2)}. $${outcome.refund.toFixed(2)} returned to your wallet.`,
                category: 'VAULT',
                actionPayload: { action: 'VIEW_VAULT', vaultId, finalState: 'BROKEN_EARLY' },
            });
        } catch (_) { /* swallow */ }

        this._emitBalanceUpdate(userId);
        this._emitVaultEvent(userId, 'vault:update', vaultId);
        return outcome.result[1]; // updated vault
    }

    /**
     * Sweep matured vaults: full balance returns to availableBalance,
     * vault marked COMPLETED, receipt snapshot written, AZM completion
     * bonus credited.
     *
     * r16 P0-D: the same FOR UPDATE + ACTIVE re-proof as breakEarly — a
     * maturity sweep racing an early break (or another sweep) can no
     * longer release the same vault twice.
     */
    async completeMatured(vault) {
        const vaultId = typeof vault === 'string' ? vault : vault.id;
        let releaseInfo = null;

        await this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw`SELECT * FROM "Vault" WHERE "id" = ${vaultId} FOR UPDATE`;
            const fresh = rows[0];
            if (!fresh) throw new Error('Vault not found');
            if (fresh.status !== 'ACTIVE') {
                const err = new Error('Vault is no longer active.');
                err.code = 'VAULT_ALREADY_TERMINALIZED';
                throw err;
            }

            const balance = new Prisma.Decimal(fresh.currentAmountUsdc);
            releaseInfo = { balance, name: fresh.name, userId: fresh.userId };

            await tx.user.update({
                where: { id: fresh.userId },
                data: { availableBalance: { increment: balance } },
            });
            // §P.4 AUTHORITATIVE LEDGER — maturity settlement, same
            // transaction, idempotent on the vault's completion identity,
            // second line of defense behind the FOR UPDATE terminal claim:
            //   D escrow:vault-{vaultId}:locked — savings restriction released
            //   C user:{userId}:liability       — full balance returned
            await ledger.post(tx, {
                idempotencyKey: `ledger:vault:complete:${vaultId}`,
                entryType: 'VAULT_RELEASE',
                description: `Vault "${fresh.name}" matured — full balance returned to wallet`,
                userId: fresh.userId,
                relatedEntity: 'vault',
                relatedEntityId: vaultId,
                metadata: { finalState: 'COMPLETED' },
                lines: [
                    { account: `escrow:vault-${vaultId}:locked`, debit: balance.toFixed(8) },
                    { account: `user:${fresh.userId}:liability`, credit: balance.toFixed(8) },
                ],
            });
            await tx.vault.update({
                where: { id: vaultId },
                data: {
                    status: 'COMPLETED',
                    completedAt: new Date(),
                    currentAmountUsdc: 0,
                    consistencyScore: this._computeConsistencyScore(fresh),
                    receiptSnapshot: this._buildReceipt(fresh, {
                        finalState: 'COMPLETED',
                        refund: balance,
                        penalty: new Prisma.Decimal(0),
                    }),
                },
            });
            await tx.transactionHistory.create({
                data: {
                    userId: fresh.userId,
                    type: 'VAULT_RELEASE',
                    amountUsdc: balance,
                    status: 'COMPLETED',
                },
            });
        });

        // Completion AZM bonus — flat 25 AZM for every completed vault,
        // plus 5% of total deposits as bonus AZM.
        const completionBonus = releaseInfo.balance.mul(0.0125).plus(25); // ~1.25% + 25 base
        if (this.azmRewardService) {
            try {
                await this.azmRewardService.creditAzm({
                    userId: releaseInfo.userId,
                    amount: Number(completionBonus.toFixed(2)),
                    source: 'VAULT_COMPLETION',
                    reason: `Vault "${releaseInfo.name}" matured (+${completionBonus.toFixed(2)} AZM)`,
                    metadata: { vaultId, deposited: releaseInfo.balance.toString() },
                    dedupKey: `vault-completion-${vaultId}`,
                });
            } catch (_) { /* swallow */ }
        }

        try {
            await this.notificationService.sendNotification({
                userId: releaseInfo.userId,
                title: '🎉 Vault Matured!',
                body: `"${releaseInfo.name}" complete. $${releaseInfo.balance.toFixed(2)} returned to your wallet. Tap to view your stats and start a new goal.`,
                category: 'VAULT',
                actionPayload: { action: 'VIEW_VAULT_RECEIPT', vaultId },
            });
        } catch (_) { /* swallow */ }

        this._emitBalanceUpdate(releaseInfo.userId);
        this._emitVaultEvent(releaseInfo.userId, 'vault:completed', vaultId);
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

    async _executeDeposit({ vault, amount, type, scheduledFor, extraVaultUpdate = {}, idempotencyKey = null }) {
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
            // r16 P0-A crash-recovery convergence: a caller retrying a
            // crashed smart-route execution passes the run's durable
            // idempotency key. If a deposit already committed under that
            // key, the unique violation below converges the retry to the
            // committed deposit instead of moving money twice.
            if (idempotencyKey) {
                const existing = await this.prisma.vaultDeposit.findUnique({
                    where: { idempotencyKey },
                });
                if (existing) return existing;
            }

            const [userRow] = await this.prisma.$transaction(async (tx) => {
                // r16 P0-D: guarded user claim — the conditional decrement
                // fails closed on a concurrent spend instead of relying on
                // the CHECK constraint as the only guard.
                const userClaim = await tx.user.updateMany({
                    where: { id: vault.userId, availableBalance: { gte: amount } },
                    data: { availableBalance: { decrement: amount } },
                });
                if (userClaim.count !== 1) {
                    const err = new Error('Insufficient available balance for vault deposit.');
                    err.code = 'INSUFFICIENT_BALANCE';
                    throw err;
                }
                // r16 P0-D: guarded vault claim — a vault terminalized
                // (broken early / completed) between the caller's stale
                // read and this deposit can NEVER receive money: the
                // conditional ACTIVE claim is the single-winner guard.
                const vaultClaim = await tx.vault.updateMany({
                    where: { id: vault.id, status: 'ACTIVE' },
                    data: {
                        currentAmountUsdc: { increment: amount },
                        ...(isOnTime ? { streakCount: { increment: 1 } } : {}),
                        totalAzmEarned: { increment: new Prisma.Decimal(breakdown.totalAzm) },
                        ...extraVaultUpdate,
                    },
                });
                if (vaultClaim.count !== 1) {
                    const err = new Error('Vault is no longer active.');
                    err.code = 'VAULT_TERMINALIZED';
                    throw err;
                }
                // We hold the vault row lock from the claim inside this
                // transaction — the longest-streak read/compute/write below
                // cannot interleave with another deposit.
                if (isOnTime) {
                    const freshVault = await tx.vault.findUnique({
                        where: { id: vault.id },
                        select: { streakCount: true, longestStreak: true },
                    });
                    if (freshVault && freshVault.streakCount > freshVault.longestStreak) {
                        await tx.vault.update({
                            where: { id: vault.id },
                            data: { longestStreak: freshVault.streakCount },
                        });
                    }
                }
                const depositRow = await tx.vaultDeposit.create({
                    data: {
                        vaultId: vault.id,
                        userId: vault.userId,
                        amountUsdc: amount,
                        type,
                        status: 'COMPLETED',
                        azmAwarded: new Prisma.Decimal(breakdown.totalAzm),
                        azmBreakdown: breakdown,
                        scheduledFor,
                        ...(idempotencyKey ? { idempotencyKey } : {}),
                    },
                });
                const historyRow = await tx.transactionHistory.create({
                    data: {
                        userId: vault.userId,
                        type: 'VAULT_DEPOSIT',
                        amountUsdc: amount,
                        status: 'COMPLETED',
                    },
                });
                // §P.4 AUTHORITATIVE LEDGER — vault savings lock, same
                // transaction, idempotent on the deposit row's own durable
                // identity:
                //   D user:{userId}:liability       — available liability down
                //   C escrow:vault-{vaultId}:locked — savings restriction up
                await ledger.post(tx, {
                    idempotencyKey: `ledger:vault:deposit:${depositRow.id}`,
                    entryType: 'VAULT_DEPOSIT',
                    description: `Vault deposit "${vault.name}" — savings locked`,
                    userId: vault.userId,
                    relatedEntity: 'vaultDeposit',
                    relatedEntityId: depositRow.id,
                    metadata: { vaultId: vault.id, type },
                    lines: [
                        { account: `user:${vault.userId}:liability`, debit: amount.toFixed(8) },
                        { account: `escrow:vault-${vault.id}:locked`, credit: amount.toFixed(8) },
                    ],
                });
                const freshUser = await tx.user.findUnique({
                    where: { id: vault.userId },
                });
                const freshVault = await tx.vault.findUnique({
                    where: { id: vault.id },
                });
                return [freshUser, freshVault, depositRow, historyRow];
            });

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
