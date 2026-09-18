// services/smartRouteService.js
// =============================================================================
// AZAMAN — SMART ROUTE SERVICE  (Master Sprint, 2026-05-27)
//
// Recurring "set-and-forget" financial obligations. Every run drains
// `amountUsdc` from User.availableBalance and routes it to one of:
//
//   • WITHDRAW_MOMO     — convert USDC→GHS, write a Withdrawal row,
//                         dispatch via mtnDisbursementService
//   • INTERNAL_TRANSFER — peer transfer to a friend (USDC, in-platform)
//   • SAVINGS_DEPOSIT   — deposit into the user's SavingsGoal
//   • VAULT_DEPOSIT     — deposit into a user's Vault
//
// The smartRouteWorker scans `status=ACTIVE AND nextRunAt <= now`, calls
// `runOnce(routeId)`, and increments `nextRunAt` by the configured cadence.
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const ledger = require('./ledgerService');
const restrictedObligations = require('./restrictedObligationService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

const FREQUENCY_MS = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

class SmartRouteService {
    constructor({ prisma, io, notificationService, mtnDisbursementService, vaultService }) {
        this.prisma = prisma;
        this.io = io;
        this.notificationService = notificationService;
        this.mtnDisbursementService = mtnDisbursementService;
        this.vaultService = vaultService;
    }

    // =========================================================================
    // CRUD
    // =========================================================================

    async create({ userId, name, action, amountUsdc, frequency, dayOfMonth, startDate, endDate, destination }) {
        if (!name || !action || !amountUsdc || !frequency || !startDate) {
            throw new Error('name, action, amountUsdc, frequency and startDate are required');
        }
        if (Number(amountUsdc) <= 0) throw new Error('amountUsdc must be > 0');

        const start = new Date(startDate);
        if (Number.isNaN(start.getTime())) throw new Error('Invalid startDate');

        const data = {
            userId,
            name: String(name).slice(0, 60),
            action,
            amountUsdc: new Prisma.Decimal(amountUsdc),
            frequency,
            dayOfMonth: frequency === 'ON_DAY_OF_MONTH' ? Number(dayOfMonth) : null,
            startDate: start,
            endDate: endDate ? new Date(endDate) : null,
            nextRunAt: this._computeNextRun(start, frequency, dayOfMonth),
        };

        // Validate destination based on action
        switch (action) {
            case 'WITHDRAW_MOMO':
                if (!destination?.momoNumber || !destination?.momoProvider) {
                    throw new Error('WITHDRAW_MOMO requires momoNumber + momoProvider');
                }
                data.destMomoNumber = destination.momoNumber;
                data.destMomoProvider = destination.momoProvider;
                break;
            case 'INTERNAL_TRANSFER':
                if (!destination?.friendUserId) throw new Error('INTERNAL_TRANSFER requires friendUserId');
                data.destFriendUserId = Number(destination.friendUserId);
                break;
            case 'SAVINGS_DEPOSIT':
                if (!destination?.savingsGoalId) throw new Error('SAVINGS_DEPOSIT requires savingsGoalId');
                data.destSavingsGoalId = destination.savingsGoalId;
                break;
            case 'VAULT_DEPOSIT':
                if (!destination?.vaultId) throw new Error('VAULT_DEPOSIT requires vaultId');
                data.destVaultId = destination.vaultId;
                break;
            default:
                throw new Error('Invalid action');
        }

        return this.prisma.smartRoute.create({ data });
    }

    async update(userId, routeId, patch) {
        const route = await this.prisma.smartRoute.findUnique({ where: { id: routeId } });
        if (!route || route.userId !== userId) throw new Error('Route not found');

        const data = {};
        if (patch.name) data.name = String(patch.name).slice(0, 60);
        if (patch.amountUsdc) data.amountUsdc = new Prisma.Decimal(patch.amountUsdc);
        if (patch.frequency && FREQUENCY_MS[patch.frequency]) data.frequency = patch.frequency;
        if (patch.dayOfMonth !== undefined) data.dayOfMonth = Number(patch.dayOfMonth) || null;
        if (patch.endDate !== undefined) data.endDate = patch.endDate ? new Date(patch.endDate) : null;
        if (patch.destination) {
            const dest = patch.destination;
            if ('momoNumber' in dest) data.destMomoNumber = dest.momoNumber;
            if ('momoProvider' in dest) data.destMomoProvider = dest.momoProvider;
            if ('friendUserId' in dest) data.destFriendUserId = dest.friendUserId;
            if ('savingsGoalId' in dest) data.destSavingsGoalId = dest.savingsGoalId;
            if ('vaultId' in dest) data.destVaultId = dest.vaultId;
        }
        return this.prisma.smartRoute.update({ where: { id: routeId }, data });
    }

    async setStatus(userId, routeId, status) {
        const route = await this.prisma.smartRoute.findUnique({ where: { id: routeId } });
        if (!route || route.userId !== userId) throw new Error('Route not found');
        return this.prisma.smartRoute.update({ where: { id: routeId }, data: { status } });
    }

    async list(userId) {
        return this.prisma.smartRoute.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getDetail(userId, routeId) {
        const route = await this.prisma.smartRoute.findUnique({
            where: { id: routeId },
            include: {
                runs: { orderBy: { createdAt: 'desc' }, take: 50 },
            },
        });
        if (!route || route.userId !== userId) return null;
        return route;
    }

    // =========================================================================
    // EXECUTION
    // =========================================================================

    /**
     * Execute one run of a smart route. Used by both the cron worker and
     * the manual "run-now" endpoint. Returns the SmartRouteRun row.
     */
    async runOnce(routeId, { manual = false } = {}) {
        const route = await this.prisma.smartRoute.findUnique({ where: { id: routeId } });
        if (!route) throw new Error('Route not found');
        if (route.status !== 'ACTIVE') {
            return this._writeRun(route, 'SKIPPED', new Prisma.Decimal(0), 'Route not active');
        }

        // Check end-date
        if (route.endDate && new Date() > route.endDate) {
            await this.prisma.smartRoute.update({
                where: { id: route.id },
                data: { status: 'COMPLETED' },
            });
            return this._writeRun(route, 'SKIPPED', new Prisma.Decimal(0), 'Past end date');
        }

        const amount = new Prisma.Decimal(route.amountUsdc);
        const user = await this.prisma.user.findUnique({
            where: { id: route.userId },
            select: { availableBalance: true, banStatus: true },
        });
        if (!user) return this._writeRun(route, 'FAILED_OTHER', amount, 'User missing');
        if (user.banStatus !== 'ACTIVE') {
            return this._writeRun(route, 'SKIPPED', amount, `Account banned (${user.banStatus})`);
        }
        const bal = new Prisma.Decimal(user.availableBalance);
        if (bal.lt(amount)) {
            await this._notifyInsufficient(route, bal, amount);
            return this._writeRun(route, 'FAILED_INSUFFICIENT', amount, `Balance ${bal.toFixed(2)} < ${amount.toFixed(2)}`);
        }

        try {
            switch (route.action) {
                case 'WITHDRAW_MOMO':
                    return this._executeMomo(route, amount, manual);
                case 'INTERNAL_TRANSFER':
                    return this._executeTransfer(route, amount);
                case 'SAVINGS_DEPOSIT':
                    return this._executeSavings(route, amount);
                case 'VAULT_DEPOSIT':
                    return this._executeVault(route, amount);
                default:
                    return this._writeRun(route, 'FAILED_OTHER', amount, 'Unknown action');
            }
        } catch (err) {
            return this._writeRun(route, 'FAILED_OTHER', amount, err.message);
        } finally {
            // Always advance nextRunAt unless explicit manual run
            if (!manual) {
                await this.prisma.smartRoute.update({
                    where: { id: route.id },
                    data: {
                        nextRunAt: this._computeNextRun(new Date(), route.frequency, route.dayOfMonth),
                        lastRunAt: new Date(),
                    },
                });
            }
        }
    }

    // =========================================================================
    // ACTION EXECUTORS
    // =========================================================================

    async _executeMomo(route, amount, manual) {
        // Pull the live retail rate
        const settings = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const rate = new Prisma.Decimal(settings?.liveRetailRate || 12.5);
        const ghs = amount.mul(rate);

        // Atomic balance + Withdrawal row
        const result = await this.prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: route.userId },
                data: { availableBalance: { decrement: amount } },
            });
            const w = await tx.withdrawal.create({
                data: {
                    userId: route.userId,
                    amount,
                    payoutMethod: 'MOMO',
                    network: route.destMomoProvider,
                    destination: route.destMomoNumber,
                    status: 'PENDING',
                },
            });
            const runHistory = await tx.transactionHistory.create({
                data: {
                    userId: route.userId,
                    type: 'SMART_ROUTE_RUN',
                    amountUsdc: amount,
                    status: 'COMPLETED',
                },
            });
            // §P.4 AUTHORITATIVE ACCOUNTING — smart-route MoMo payout is a
            // PENDING provider disbursement: the customer's USDC liability
            // falls now, but the funds are RESERVED until the provider
            // outcome is observed. Idempotent on the Withdrawal row's own
            // identity (created above in this transaction):
            //   D user:{userId}:liability — customer owed less
            //   C restricted:reserves     — reserved for the PENDING payout
            const momoReservation = await ledger.post(tx, {
                idempotencyKey: `ledger:smartroute:momo:${w.id}`,
                entryType: 'WITHDRAWAL',
                description: 'Smart Route MoMo payout — provider settlement pending',
                userId: route.userId,
                relatedEntity: 'withdrawal',
                relatedEntityId: w.id,
                metadata: { status: 'PENDING', provider: route.destMomoProvider, smartRoute: true, runHistoryId: runHistory.id },
                lines: [
                    { account: `user:${route.userId}:liability`, debit: amount.toFixed(8) },
                    { account: 'restricted:reserves', credit: amount.toFixed(8) },
                ],
            });
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_FIAT_WITHDRAWAL',
                reference: `withdrawal:smartroute:${w.id}`,
                userId: route.userId,
                amount: new Prisma.Decimal(amount.toFixed(8)),
                asset: 'USDC',
                sourceEntity: 'withdrawal',
                sourceEntityId: w.id,
                ledgerTransactionId: momoReservation.transaction.id,
                metadata: { smartRoute: true, amountGhs: ghs.toFixed(8), rateUsed: rate.toFixed(8) },
            });
            return w;
        });

        // Fire-and-forget gateway dispatch (real disburse handled by worker
        // pipeline elsewhere — we just queue the Withdrawal).
        try {
            if (this.mtnDisbursementService?.dispatch) {
                await this.mtnDisbursementService.dispatch({
                    withdrawalId: result.id,
                    phoneNumber: route.destMomoNumber,
                    amountGhs: ghs,
                    provider: route.destMomoProvider,
                });
            }
        } catch (_) { /* swallow — withdrawalReconciliationWorker retries */ }

        const run = await this._writeRun(route, 'SUCCESS', amount, null, {
            amountGhs: ghs,
            rateUsed: rate,
            withdrawalId: result.id,
        });

        await this._notifySuccess(route, amount, `Routed $${amount.toFixed(2)} to MoMo ${route.destMomoNumber}`);
        return run;
    }

    async _executeTransfer(route, amount) {
        await this.prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: route.userId },
                data: {
                    availableBalance: { decrement: amount },
                    // §P.4: projection escrow column moves with the goal
                    // restriction the ledger locks below.
                    escrowLockedBalance: { increment: amount },
                },
            });
            await tx.user.update({
                where: { id: route.destFriendUserId },
                data: { availableBalance: { increment: amount } },
            });
            const runHistory = await tx.transactionHistory.create({
                data: {
                    userId: route.userId,
                    type: 'SMART_ROUTE_RUN',
                    amountUsdc: amount,
                    status: 'COMPLETED',
                },
            });
            // §P.4 AUTHORITATIVE LEDGER — smart-route internal transfer, same
            // transaction, idempotent on the durable TransactionHistory row's
            // own identity:
            //   D user:{sender}:liability    — sender owed less
            //   C user:{recipient}:liability — recipient owed more
            await ledger.post(tx, {
                idempotencyKey: `ledger:smartroute:transfer:${runHistory.id}`,
                entryType: 'TRANSFER',
                description: 'Smart Route internal transfer — liability moved between users',
                userId: route.userId,
                relatedEntity: 'transactionHistory',
                relatedEntityId: runHistory.id,
                metadata: { recipientId: route.destFriendUserId },
                lines: [
                    { account: `user:${route.userId}:liability`, debit: amount.toFixed(8) },
                    { account: `user:${route.destFriendUserId}:liability`, credit: amount.toFixed(8) },
                ],
            });
        });
        const run = await this._writeRun(route, 'SUCCESS', amount);
        await this._notifySuccess(route, amount, `Sent $${amount.toFixed(2)} to friend`);
        return run;
    }

    async _executeSavings(route, amount) {
        // Reuse savings deposit path — write deposit row + decrement available
        const goal = await this.prisma.savingsGoal.findUnique({
            where: { id: route.destSavingsGoalId },
        });
        if (!goal || goal.userId !== route.userId) {
            return this._writeRun(route, 'FAILED_OTHER', amount, 'Savings goal not found');
        }
        // Live rate for usdc → ghs translation
        const settings = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const rate = new Prisma.Decimal(settings?.liveRetailRate || 12.5);
        const ghs = amount.mul(rate);

        await this.prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: route.userId },
                data: {
                    availableBalance: { decrement: amount },
                    // §P.4: projection escrow column moves with the goal
                    // restriction the ledger locks below.
                    escrowLockedBalance: { increment: amount },
                },
            });
            await tx.savingsGoal.update({
                where: { id: goal.id },
                data: {
                    currentAmountGhs: { increment: ghs },
                    totalDeposits: { increment: 1 },
                },
            });
            const depositRow = await tx.savingsDeposit.create({
                data: {
                    goalId: goal.id,
                    userId: route.userId,
                    amountGhs: ghs,
                    amountUsdc: amount,
                    type: 'SCHEDULED',
                    status: 'COMPLETED',
                },
            });
            // §P.4 AUTHORITATIVE LEDGER — smart-route savings deposit, same
            // transaction, idempotent on the SavingsDeposit row's own durable
            // identity:
            //   D user:{userId}:liability        — spendable liability down
            //   C escrow:savings-{goalId}:locked — goal restriction up
            await ledger.post(tx, {
                idempotencyKey: `ledger:savings:deposit:${depositRow.id}`,
                entryType: 'VAULT_DEPOSIT',
                description: 'Smart Route savings deposit — spendable balance locked into goal restriction',
                userId: route.userId,
                relatedEntity: 'savingsDeposit',
                relatedEntityId: depositRow.id,
                metadata: { goalId: goal.id, amountGhs: ghs.toFixed(8), rateUsed: rate.toFixed(8), smartRoute: true },
                lines: [
                    { account: `user:${route.userId}:liability`, debit: amount.toFixed(8) },
                    { account: `escrow:savings-${goal.id}:locked`, credit: amount.toFixed(8) },
                ],
            });
        });
        const run = await this._writeRun(route, 'SUCCESS', amount, null, {
            amountGhs: ghs,
            rateUsed: rate,
        });
        await this._notifySuccess(route, amount, `Deposited $${amount.toFixed(2)} to "${goal.name}"`);
        return run;
    }

    async _executeVault(route, amount) {
        const vault = await this.prisma.vault.findUnique({ where: { id: route.destVaultId } });
        if (!vault || vault.userId !== route.userId || vault.status !== 'ACTIVE') {
            return this._writeRun(route, 'FAILED_OTHER', amount, 'Vault not eligible');
        }
        await this.vaultService.depositManual({
            userId: route.userId,
            vaultId: vault.id,
            amountUsdc: amount,
        });
        const run = await this._writeRun(route, 'SUCCESS', amount);
        await this._notifySuccess(route, amount, `Deposited $${amount.toFixed(2)} to vault "${vault.name}"`);
        return run;
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

    _writeRun(route, status, amount, failureReason, extras = {}) {
        return this.prisma.smartRouteRun.create({
            data: {
                routeId: route.id,
                userId: route.userId,
                status,
                amountUsdc: amount,
                amountGhs: extras.amountGhs || null,
                rateUsed: extras.rateUsed || null,
                withdrawalId: extras.withdrawalId || null,
                failureReason: failureReason || null,
            },
        }).then(async (run) => {
            if (status === 'SUCCESS') {
                await this.prisma.smartRoute.update({
                    where: { id: route.id },
                    data: {
                        totalRuns: { increment: 1 },
                        totalRoutedUsdc: { increment: amount },
                    },
                });
            }
            if (this.io) {
                this.io.to(`user_${route.userId}`).emit('smart_route:run', {
                    routeId: route.id,
                    runId: run.id,
                    status,
                    amount: Number(amount.toFixed(2)),
                });
            }
            return run;
        });
    }

    _computeNextRun(from, frequency, dayOfMonth) {
        const base = new Date(from);
        if (frequency === 'DAILY') return new Date(base.getTime() + FREQUENCY_MS.DAILY);
        if (frequency === 'WEEKLY') return new Date(base.getTime() + FREQUENCY_MS.WEEKLY);
        if (frequency === 'MONTHLY') return new Date(base.getTime() + FREQUENCY_MS.MONTHLY);
        if (frequency === 'ON_DAY_OF_MONTH') {
            const target = Math.min(Math.max(Number(dayOfMonth) || 1, 1), 28);
            const next = new Date(base.getFullYear(), base.getMonth() + 1, target, 9, 0, 0);
            return next;
        }
        // Fallback
        return new Date(base.getTime() + FREQUENCY_MS.WEEKLY);
    }

    _notifyInsufficient(route, balance, required) {
        return this.notificationService
            .sendNotification({
                userId: route.userId,
                title: 'Smart Route Skipped — Top Up',
                body: `Your "${route.name}" route needs $${required.toFixed(2)} but you only have $${balance.toFixed(2)}. Top up to keep it running.`,
                category: 'SMART_ROUTE',
                actionPayload: { action: 'OPEN_SMART_ROUTE', routeId: route.id },
            })
            .catch(() => {});
    }

    _notifySuccess(route, amount, body) {
        return this.notificationService
            .sendNotification({
                userId: route.userId,
                title: 'Smart Route Executed',
                body,
                category: 'SMART_ROUTE',
                actionPayload: { action: 'OPEN_SMART_ROUTE', routeId: route.id, amount: Number(amount.toFixed(2)) },
            })
            .catch(() => {});
    }
}

module.exports = { SmartRouteService, FREQUENCY_MS };
