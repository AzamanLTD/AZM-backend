// services/smartRouteService.js
// =============================================================================
// AZAMAN — SMART ROUTE SERVICE  (Master Sprint, 2026-05-27, r16 hardening)
//
// Recurring "set-and-forget" financial obligations. Every run drains
// `amountUsdc` from User.availableBalance and routes it to one of:
//
//   • WITHDRAW_MOMO     — canonical fiat-withdrawal pipeline (r16 P0-B):
//                         processFiatWithdrawal reservation → provider
//                         dispatch → withdrawalReconciliationWorker settles
//   • INTERNAL_TRANSFER — peer transfer to a friend (USDC, in-platform)
//   • SAVINGS_DEPOSIT   — deposit into the user's SavingsGoal
//   • VAULT_DEPOSIT     — deposit into a user's Vault
//
// The smartRouteWorker scans `status=ACTIVE AND nextRunAt <= now` and calls
// `runOnce(routeId)`; POST /api/smart-routes/:id/run-now calls the same
// method with manual=true.
//
// ── r16 P0-A EXECUTION IDENTITY ───────────────────────────────────────────
// Every execution now owns a durable economic identity BEFORE any money
// moves: a SmartRouteRun row with a UNIQUE executionKey, created inside the
// claim transaction. The database — not an application read — decides the
// single winner:
//
//   • scheduled occurrence: `${routeId}:occ:${nextRunAt ISO}` — the scheduler,
//     /run-now and any concurrent workers converge on ONE run row per due
//     occurrence (a manual run-now consumes the due occurrence atomically
//     instead of duplicating it);
//   • manual while nothing is due: `${routeId}:manual:${uuid}` — a distinct
//     explicitly-manual operation identity, allowed to coexist with the
//     scheduled occurrence it did NOT consume;
//   • crash recovery (r16c): a run left PENDING longer than STALE_PENDING_MS
//     is re-driven by recoverStalePendingRuns(). TRANSFER / SAVINGS / VAULT
//     runs finalize INSIDE the money transaction — a stale PENDING row of
//     those kinds guarantees nothing committed, so re-driving is exactly-once
//     safe. MoMo runs commit the canonical fiat reservation in its OWN
//     transaction before dispatch (the provider cannot be called inside a
//     DB transaction), so a stale PENDING MoMo run is converged by
//     _executeMomo's idempotent re-entry: no canonical row → reserve now;
//     canonical PENDING with NO outbound evidence → resume dispatch with the
//     originally reserved GHS; canonical PENDING WITH evidence → provider
//     I/O may have happened, park AWAITING_RECONCILIATION (never re-dispatch
//     blindly); canonical COMPLETED/FAILED → converge to the honest outcome.
//
// Run finalization (PENDING → terminal) for TRANSFER / SAVINGS happens
// INSIDE the same transaction as the financial mutation, so a crash can only
// leave either "nothing happened" (run still PENDING → safe to retry) or
// "everything happened" (run terminal → never re-executed). MoMo runs
// finalize AFTER the provider outcome (r16c P0-B: SUCCESS means the provider
// accepted the dispatch, never merely that a reservation existed). The
// guarded finalization (updateMany WHERE status='PENDING') is the
// single-winner claim that makes retries and concurrent recoveries
// exactly-once.
//
// ── r16 P0-B CANONICAL MOMO PIPELINE ──────────────────────────────────────
// WITHDRAW_MOMO no longer builds a private Withdrawal/TransactionHistory
// pair. It enters the SAME canonical fiat-withdrawal state machine used by
// the direct fiat controller: processFiatWithdrawal creates the PENDING
// canonical TransactionHistory (type WITHDRAWAL_FIAT), debits the user,
// reserves the fiat pool / §P.5-D GHS liquidity, posts the §P.4 ledger
// reservation, creates the restricted obligation (withdrawal:fiat:{ref}) and
// creates the Withdrawal reconciliation record durably linked through
// transactionHistoryId — all in ONE transaction. Dispatch goes through the
// failover service's initiateTransfer (the obsolete .dispatch() call is
// gone), with the same durable dispatch evidence + payout ownership writes
// the direct controller performs. The financial transaction stays PENDING
// until the provider outcome is observed; the reconciler settles or reverses
// it. The run's SUCCESS means "the route fired", never "provider settled".
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const { randomUUID } = require('crypto');
const ledger = require('./ledgerService');
const restrictedObligations = require('./restrictedObligationService');
const financeService = require('./finance.service');
const fiatLiquidity = require('../src/services/fiatLiquidityService');
const { canonicalProviderName, persistPayoutOwnership } = require('./payoutProviderOwnership');
const { recordReconciliationExceptionLoud } = require('./reconciliationExceptionService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

const FREQUENCY_MS = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

// A PENDING run older than this had its financial transaction rolled back
// (finalization is in-transaction with the money) — recovery re-drives it.
const STALE_PENDING_MS = 10 * 60 * 1000;

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
     * Execute one run of a smart route. Used by the cron worker and the
     * manual "run-now" endpoint.
     *
     * r16 P0-A: the claim (a PENDING SmartRouteRun with a unique
     * executionKey) is created BEFORE any money moves, inside a database
     * transaction. Concurrent scheduled/manual invocations converge on the
     * same claim: exactly one winner per due scheduled occurrence, distinct
     * identities for explicit manual runs when nothing is due.
     */
    async runOnce(routeId, { manual = false } = {}) {
        const claim = await this._claimExecution(routeId, manual);
        if (claim.skipped) return claim;
        return this._executeClaim(claim);
    }

    /**
     * Recovery sweep for runs interrupted by a process crash between claim
     * and execution. TRANSFER / SAVINGS / VAULT runs finalize in the same
     * transaction as their money movement, so a stale PENDING row of those
     * kinds guarantees nothing committed. MoMo runs commit the canonical
     * fiat reservation in its own transaction before dispatch, so their
     * re-drive converges through _executeMomo's idempotent re-entry (r16c):
     * reserve / resume / park — never re-reserving and never blindly
     * re-dispatching. Concurrent recoveries converge through the guarded
     * finalization either way.
     */
    async recoverStalePendingRuns({ staleMs = STALE_PENDING_MS, take = 20 } = {}) {
        const cutoff = new Date(Date.now() - staleMs);
        const stale = await this.prisma.smartRouteRun.findMany({
            where: { status: 'PENDING', createdAt: { lt: cutoff } },
            orderBy: { createdAt: 'asc' },
            take,
        });
        const outcomes = [];
        for (const run of stale) {
            const route = await this.prisma.smartRoute.findUnique({ where: { id: run.routeId } });
            if (!route || route.status !== 'ACTIVE') {
                await this._finalizeGuardedRun(run, route, false, null, 'FAILED_OTHER', 'Recovered after interruption — route no longer active');
                outcomes.push({ runId: run.id, status: 'FAILED_OTHER' });
                continue;
            }
            const occurrenceBased = Boolean(run.executionKey && run.executionKey.includes(':occ:'));
            outcomes.push(await this._executeClaim({ run, route, occurrenceBased, occurrenceBase: route.nextRunAt, recovery: true }));
        }
        return outcomes;
    }

    /**
     * Claim one execution of a route. Returns a claim object, or
     * { skipped, reason } when no new execution may start.
     */
    async _claimExecution(routeId, manual) {
        // r16 P0-A: the claim is one transaction, but a unique-key collision
        // ABORTS that transaction (Postgres 25P02) — the collision outcome is
        // resolved OUTSIDE it on a fresh connection, never by querying the
        // poisoned transaction.
        try {
            return await this._claimExecutionTransaction(routeId, manual);
        } catch (e) {
            const uniqueViolation = e?.code === 'P2002'
                || /unique constraint|duplicate key/i.test(String(e?.message || ''));
            if (!uniqueViolation) throw e;

            const route = await this.prisma.smartRoute.findUnique({ where: { id: routeId } });
            if (!route) throw new Error('Route not found');
            const now = new Date();
            const due = route.nextRunAt <= now;
            if (!due) {
                // The winner already consumed the occurrence (it advanced
                // nextRunAt) — nothing is due from this caller's view.
                return { skipped: true, reason: 'Execution already claimed' };
            }
            const executionKey = `${route.id}:occ:${route.nextRunAt.toISOString()}`;
            const existing = await this.prisma.smartRouteRun.findUnique({ where: { executionKey } });
            const staleAt = new Date(Date.now() - STALE_PENDING_MS);
            if (existing && existing.status === 'PENDING' && existing.createdAt < staleAt) {
                return { run: existing, route, occurrenceBased: true, occurrenceBase: route.nextRunAt, recovery: true };
            }
            return { skipped: true, reason: 'Execution already claimed', run: existing || undefined };
        }
    }

    async _claimExecutionTransaction(routeId, manual) {
        return this.prisma.$transaction(async (tx) => {
            const route = await tx.smartRoute.findUnique({ where: { id: routeId } });
            if (!route) throw new Error('Route not found');

            if (route.status !== 'ACTIVE') {
                return { skipped: true, reason: 'Route not active' };
            }
            if (route.endDate && new Date() > route.endDate) {
                await tx.smartRoute.update({
                    where: { id: route.id },
                    data: { status: 'COMPLETED' },
                });
                return { skipped: true, reason: 'Past end date' };
            }

            const now = new Date();
            const due = route.nextRunAt <= now;
            let executionKey;
            let occurrenceBased = false;
            if (due) {
                // One durable identity per due scheduled occurrence. A
                // manual run-now arriving while an occurrence is due consumes
                // THAT occurrence atomically — it can never duplicate it.
                executionKey = `${route.id}:occ:${route.nextRunAt.toISOString()}`;
                occurrenceBased = true;
            } else if (manual) {
                // Nothing is due: an explicitly manual operation gets a
                // distinct identity and does NOT consume any scheduled
                // occurrence.
                executionKey = `${route.id}:manual:${randomUUID()}`;
            } else {
                return { skipped: true, reason: 'Not due' };
            }

            // A unique-key violation here rejects the WHOLE transaction —
            // the collision is resolved by the caller on a fresh connection.
            const run = await tx.smartRouteRun.create({
                data: {
                    routeId: route.id,
                    userId: route.userId,
                    status: 'PENDING',
                    amountUsdc: route.amountUsdc,
                    executionKey,
                },
            });
            return { run, route, occurrenceBased, occurrenceBase: route.nextRunAt };
        });
    }

    /**
     * Execute a claimed run: user-level guards, then the action executor.
     * All money-moving executors finalize the run INSIDE the same
     * transaction as the financial mutation.
     */
    async _executeClaim(claim) {
        const { run, route, occurrenceBased, occurrenceBase } = claim;
        const amount = new Prisma.Decimal(route.amountUsdc);

        try {
            const user = await this.prisma.user.findUnique({
                where: { id: route.userId },
                select: { availableBalance: true, banStatus: true },
            });
            if (!user) {
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', 'User missing');
            }
            if (user.banStatus !== 'ACTIVE') {
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'SKIPPED', `Account banned (${user.banStatus})`);
            }
            const bal = new Prisma.Decimal(user.availableBalance);
            if (bal.lt(amount)) {
                await this._notifyInsufficient(route, bal, amount);
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_INSUFFICIENT', `Balance ${bal.toFixed(2)} < ${amount.toFixed(2)}`);
            }

            switch (route.action) {
                case 'WITHDRAW_MOMO':
                    return await this._executeMomo(run, route, occurrenceBased, occurrenceBase);
                case 'INTERNAL_TRANSFER':
                    return await this._executeTransfer(run, route, occurrenceBased, occurrenceBase);
                case 'SAVINGS_DEPOSIT':
                    return await this._executeSavings(run, route, occurrenceBased, occurrenceBase);
                case 'VAULT_DEPOSIT':
                    return await this._executeVault(run, route, occurrenceBased, occurrenceBase);
                default:
                    return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', 'Unknown action');
            }
        } catch (err) {
            // The guarded executor claims fail closed on concurrent spend:
            // classify honestly instead of blanket FAILED_OTHER.
            if (err?.code === 'INSUFFICIENT_BALANCE') {
                await this._notifyInsufficient(route, new Prisma.Decimal(0), amount).catch(() => {});
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_INSUFFICIENT', 'Balance changed before execution');
            }
            logger.error({ err, routeId: route.id, runId: run.id }, '[SmartRoute] execution failed');
            return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', err.message);
        }
    }

    // =========================================================================
    // ACTION EXECUTORS
    // =========================================================================

    /**
     * r16c P0-B: Smart Route MoMo payouts ride the canonical fiat-withdrawal
     * state machine, and the run lifecycle is HONEST: SUCCESS means the
     * provider accepted the dispatch — never merely that a reservation
     * existed. Ordering: reservation (or crash-resume of an existing one) →
     * DB dispatch claim (mutually exclusive with admin rejection) → durable
     * DISPATCH_INTENT evidence → provider I/O → durable outcome evidence /
     * ownership → run finalization. The canonical TransactionHistory stays
     * PENDING until the provider settlement webhook / reconciler resolves
     * it; a run whose dispatch outcome is unprovable parks in
     * AWAITING_RECONCILIATION instead of guessing.
     */
    async _executeMomo(run, route, occurrenceBased, occurrenceBase) {
        const amount = new Prisma.Decimal(route.amountUsdc);
        // Reference derived from the run identity: a crashed-execution retry
        // or a concurrent recovery collides on the unique TransactionHistory
        // txHash instead of reserving the money twice.
        const reference = `SRWD_${run.id}`;

        // ── r16c P0-B: idempotent re-entry / crash convergence ────────────
        // A stale-PENDING recovery re-drive must converge on the existing
        // canonical state instead of re-reserving the money.
        const existing = await this.prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        let result;
        if (existing) {
            if (existing.status === 'COMPLETED') {
                // Settlement happened in an earlier attempt; only the run
                // finalization crashed. The guarded finalize converges once.
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'SUCCESS', 'recovered: canonical settlement confirmed');
            }
            if (existing.status !== 'PENDING') {
                // Definitively reversed in an earlier attempt (admin
                // rejection or provably-safe dispatch failure).
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_GATEWAY', 'recovered: reservation already reversed');
            }
            // Reservation is durable from an earlier attempt — resume at the
            // dispatch boundary with the ORIGINALLY reserved GHS amount
            // (§P.5-D: never recompute the payout after rate drift).
            const mirror = existing.id
                ? await this.prisma.withdrawal.findFirst({ where: { transactionHistoryId: existing.id } })
                : null;
            const meta = (existing.metadata && typeof existing.metadata === 'object') ? existing.metadata : {};
            result = {
                reference,
                withdrawalRecord: mirror,
                payoutGhs: meta.payoutGhs != null ? Number(meta.payoutGhs) : null,
                retailRate: meta.retailRate != null ? Number(meta.retailRate) : null,
                resumed: true,
            };
            // Durable dispatch evidence (intent or later) means provider I/O
            // may already have happened — a re-drive must NEVER blindly issue
            // a second provider call. Park for reconciliation (r16c rule).
            const priorEvidence = await this.prisma.fiatProviderEvent.findFirst({
                where: { relatedReference: reference, direction: 'OUTBOUND' },
            });
            if (priorEvidence) {
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'SMART_ROUTE_RESUME_AFTER_DISPATCH_EVIDENCE',
                    details: { evidence: priorEvidence.status, source: 'smart_route', rule: 'park, never re-dispatch on recovery' },
                }).catch(() => {});
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'recovered after durable dispatch evidence — reconciliation owns the payout');
            }
            if (!mirror) {
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'SMART_ROUTE_RESUME_MIRROR_MISSING',
                    details: { source: 'smart_route' },
                }).catch(() => {});
                return await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'recovered reservation has no withdrawal mirror — parked');
            }
        } else {
            result = await financeService.processFiatWithdrawal(
                this.prisma,
                route.userId,
                Number(route.amountUsdc),
                {
                    reference,
                    // §P.5-D intended route identity (mirrors the direct fiat
                    // controller: intent is the failover chain's primary rail;
                    // the actual accepting provider is recorded post-dispatch).
                    liquidityRoute: { provider: 'MOOLRE_DISBURSEMENT', rail: 'MOMO', destination: route.destMomoNumber },
                    // r15 hardening contract: the Withdrawal reconciliation
                    // record is created INSIDE the authoritative reservation
                    // transaction, durably linked to the canonical row.
                    createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                        const rows = await tx.$queryRawUnsafe(
                            'INSERT INTO "Withdrawal" ' +
                            '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                            'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                            'RETURNING "id", "userId", "amount", "payoutMethod", "network", "destination", "status"',
                            route.userId,
                            Number(route.amountUsdc),
                            route.destMomoProvider || 'MTN_MOMO',
                            'MOMO',
                            route.destMomoNumber,
                            'PENDING',
                            txRecord.id
                        );
                        return rows?.[0] || null;
                    },
                }
            );
            result.resumed = false;
        }

        const outcome = await this._dispatchMomoPayout(run, route, result, { occurrenceBased, occurrenceBase });

        const refreshed = await this.prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        if (outcome === 'ACCEPTED') {
            await this._notifySuccess(route, amount, `Routed $${amount.toFixed(2)} to MoMo ${route.destMomoNumber}`);
        }
        return refreshed;
    }

    /**
     * r16c P0-B: dispatch stage — claim, evidence, provider I/O, and honest
     * run finalization. Returns the dispatch outcome classification
     * ('ACCEPTED' | 'REVERSED' | 'PARKED'). Never throws past the claim: the
     * run reaches a durable terminal or parked state on every path.
     */
    async _dispatchMomoPayout(run, route, reservation, { occurrenceBased, occurrenceBase }) {
        const reference = reservation.reference;
        const phone = route.destMomoNumber;
        const payoutGhs = reservation.payoutGhs || reservation.withdrawalAmount;

        // Dispatcher availability BEFORE any durable dispatch intent (r16c
        // P0-B: deterministic pre-I/O failure). A missing dispatcher must
        // never leave a SUCCESS run over an undispatched reservation — the
        // reservation is reversed through the canonical state machine and
        // the run fails definitively.
        if (!this.mtnDisbursementService || typeof this.mtnDisbursementService.initiateTransfer !== 'function') {
            logger.error({ reference, runId: run.id }, '[SmartRoute] disbursement service unavailable — reversing reservation, run fails definitively');
            try {
                await financeService.reverseFiatWithdrawal(this.prisma, reference, {
                    reason: 'smart_route_dispatcher_unavailable'
                });
                await this._markMirrorFailed(reservation, 'DISPATCHER_UNAVAILABLE');
            } catch (revErr) {
                logger.error({ err: revErr, reference, runId: run.id },
                    '[SmartRoute] CRITICAL: dispatcher-unavailable reversal failed — parking for reconciliation');
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'SMART_ROUTE_DISPATCHER_UNAVAILABLE_REVERSAL_FAILED',
                    details: { reversalError: revErr.message },
                }).catch(() => {});
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'dispatcher unavailable and reversal failed — parked, never refunded by guess');
                return 'PARKED';
            }
            await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', 'dispatcher unavailable — reservation reversed');
            return 'REVERSED';
        }

        // ── r16c P0-A: DB-AUTHORITATIVE DISPATCH CLAIM ─────────────────────
        // Mutually exclusive with admin rejection (conditional PENDING →
        // REJECTED inside the reversal transaction) and the payout worker
        // (PENDING → PROCESSING). Exactly one winner; only the winner may
        // touch the provider or the money.
        if (reservation.withdrawalRecord?.id) {
            const claim = await this.prisma.withdrawal.updateMany({
                where: { id: reservation.withdrawalRecord.id, status: 'PENDING' },
                data: { status: 'DISPATCHING' },
            });
            if (claim.count !== 1) {
                const canonical = await this.prisma.transactionHistory.findUnique({ where: { txHash: reference } });
                if (canonical && canonical.status === 'FAILED') {
                    // Admin rejection won and already reversed + restored the
                    // user — converge, never reverse again.
                    await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', 'mirror claimed concurrently (admin rejection) — canonical already reversed');
                    return 'REVERSED';
                }
                // Payout worker claimed the mirror — it owns the dispatch;
                // never double-dispatch the same payout.
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'SMART_ROUTE_MIRROR_CLAIMED_CONCURRENTLY',
                    details: { rule: 'park, never double-dispatch' },
                }).catch(() => {});
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'mirror claimed concurrently — parked, never double-dispatched');
                return 'PARKED';
            }
        }

        // r16 P0-C: durable DISPATCH_INTENT evidence BEFORE any provider I/O.
        // If the intent write fails we do not start I/O; the canonical
        // reservation is reversed through the state machine and the run
        // fails definitively (no SUCCESS without dispatch).
        try {
            await fiatLiquidity.recordProviderEvent(this.prisma, {
                provider: 'AZM_DISPATCHER',
                rail: 'MOMO',
                direction: 'OUTBOUND',
                status: 'DISPATCH_INTENT',
                dedupKey: `event:payout-dispatch-intent:${reference}`,
                amountGhs: payoutGhs || null,
                relatedReference: reference,
                raw: { externalId: reference, recipientPhone: phone, stage: 'PRE_PROVIDER_IO', source: 'smart_route' },
            });
        } catch (intentErr) {
            logger.error({ err: intentErr, reference, runId: run.id },
                '[SmartRoute] dispatch-intent evidence failed — NOT starting provider I/O');
            try {
                await financeService.reverseFiatWithdrawal(this.prisma, reference, {
                    reason: 'smart_route_dispatch_intent_evidence_failed'
                });
                await this._markMirrorFailed(reservation, 'INTENT_EVIDENCE_FAILED');
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_OTHER', 'dispatch intent evidence failed — reservation reversed');
                return 'REVERSED';
            } catch (revErr) {
                logger.error({ err: revErr, reference, runId: run.id },
                    '[SmartRoute] CRITICAL: intent-failure reversal failed — parking for reconciliation');
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'WITHDRAWAL',
                    entityId: String(reservation.withdrawalRecord?.id || reference),
                    reference,
                    reason: 'SMART_ROUTE_DISPATCH_INTENT_FAILED',
                    details: { intentError: intentErr.message, reversalError: revErr.message },
                }).catch(() => {});
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'dispatch intent evidence failed and reversal failed — parked');
                return 'PARKED';
            }
        }

        let dispatch = null;
        try {
            dispatch = await this.mtnDisbursementService.initiateTransfer({
                referenceId: reference,
                amountGhs: payoutGhs,
                recipientPhone: phone,
                externalId: reference,
                payerMessage: `Azaman smart-route payout ref ${reference}`,
                payeeNote: `Smart Route ${route.name} ${reference}`,
            });
        } catch (dispatchErr) {
            // ── r15 R15-D outcome honesty (ported from the direct controller) ──
            // A thrown error is NOT proof the provider refused. Only
            // NOT_DISPATCHED / DEFINITIVE_REJECTION are provably safe to
            // unwind; anything ambiguous (UNKNOWN_OUTCOME,
            // DUPLICATE_REFERENCE, unclassified) may still be in flight —
            // auto-refunding double-spends, so park for reconciliation.
            const dispatchOutcome = dispatchErr?.providerOutcome || null;
            const SAFE_TO_UNWIND = dispatchOutcome === 'NOT_DISPATCHED' || dispatchOutcome === 'DEFINITIVE_REJECTION';

            if (!SAFE_TO_UNWIND) {
                logger.error({ err: dispatchErr, outcome: dispatchOutcome, reference, runId: run.id },
                    '[SmartRoute] MoMo dispatch outcome UNKNOWN — NOT refunding; payout may be in flight');
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'SMART_ROUTE_DISPATCH_OUTCOME_UNKNOWN_NO_REFUND',
                    details: { outcome: dispatchOutcome || 'UNCLASSIFIED', error: dispatchErr.message, source: 'smart_route' },
                }).catch(() => {});
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'dispatch outcome unknown — parked, never refunded by guess');
                return 'PARKED';
            }

            // Provably no disbursement happened — unwind exactly once.
            logger.error({ err: dispatchErr, outcome: dispatchOutcome, reference, runId: run.id },
                '[SmartRoute] MoMo dispatch failed synchronously — reversing canonical reservation');
            try {
                await financeService.reverseFiatWithdrawal(this.prisma, reference, {
                    reason: `smart_route_dispatch_failure:${dispatchErr.message}`
                });
                await this._markMirrorFailed(reservation, 'DISPATCH_FAILED');
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'FAILED_GATEWAY', `provider rejected: ${dispatchErr.message}`);
                return 'REVERSED';
            } catch (revErr) {
                logger.error({ err: revErr, reference, runId: run.id },
                    '[SmartRoute] CRITICAL: dispatch-failure reversal failed — reconciler must resolve the PENDING withdrawal');
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'WITHDRAWAL',
                    entityId: String(reservation.withdrawalRecord?.id || reference),
                    reference,
                    reason: 'SMART_ROUTE_DISPATCH_REVERSAL_FAILED',
                    details: { dispatchError: dispatchErr.message, reversalError: revErr.message },
                }).catch(() => {});
                await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'dispatch failed and reversal failed — parked, never refunded by guess');
                return 'PARKED';
            }
        }

        // Actual accepting provider identity from dispatch facts ONLY
        // (failover tag, then the adapter's self-identification) — the r15
        // rule: never guess a rail.
        const actualProviderTag = dispatch?._provider || null;
        const tagCanonicalName = actualProviderTag ? canonicalProviderName(actualProviderTag) : null;
        const actualProviderName = tagCanonicalName
            || (dispatch?.provider ? String(dispatch.provider).toUpperCase() : null);

        if (!actualProviderName) {
            logger.error({ reference, runId: run.id },
                '[SmartRoute] accepted dispatch carries NO provider identity — parking, never guessing a rail');
            await recordReconciliationExceptionLoud(this.prisma, {
                entityType: 'TRANSACTION',
                entityId: reference,
                reference,
                reason: 'DISPATCH_IDENTITY_UNKNOWN',
                details: { dispatched: true, source: 'smart_route', error: 'no failover tag and no adapter identity on an accepted dispatch' },
            }).catch(() => {});
            await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'AWAITING_RECONCILIATION', 'accepted dispatch has no provider identity — parked');
            return 'PARKED';
        }

        // Durable dispatch observation FIRST (the fallback owner authority),
        // then the canonical ownership write — both parked loudly on failure,
        // the reservation stays held, the reconciler still settles.
        try {
            await fiatLiquidity.recordProviderEvent(this.prisma, {
                provider: actualProviderName,
                rail: 'MOMO',
                direction: 'OUTBOUND',
                status: String(dispatch?.status || 'DISPATCH_ACCEPTED'),
                providerRef: dispatch?.data?.reference || dispatch?.providerRef || null,
                dedupKey: `event:payout-dispatch:${actualProviderName}:${reference}`,
                amountGhs: payoutGhs || null,
                relatedReference: reference,
                raw: { externalId: reference, recipientPhone: phone, actualProvider: actualProviderTag, source: 'smart_route' },
            });
        } catch (evidenceErr) {
            logger.error({ err: evidenceErr, reference, runId: run.id },
                '[SmartRoute] dispatch evidence write failed — NOT auto-refunding a dispatched payout');
            await recordReconciliationExceptionLoud(this.prisma, {
                entityType: 'TRANSACTION',
                entityId: reference,
                reference,
                reason: 'POST_DISPATCH_BOOKKEEPING_FAILED',
                details: { stage: 'DISPATCH_EVIDENCE', provider: actualProviderName, source: 'smart_route', error: evidenceErr.message },
            }).catch(() => {});
            // The provider DID accept the dispatch — the run honestly
            // reached the successful dispatch state; the open exception
            // tracks the bookkeeping failure for the reconciliation worker.
            await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'SUCCESS', 'dispatch accepted — evidence write failed, exception parked', {
                withdrawalId: reservation.withdrawalRecord?.id ?? null,
                amountGhs: reservation.payoutGhs,
                rateUsed: reservation.retailRate,
            });
            return 'ACCEPTED';
        }

        if (actualProviderTag) {
            try {
                await persistPayoutOwnership(this.prisma, {
                    reference,
                    failoverTag: actualProviderTag,
                    intendedProvider: 'MOOLRE_DISBURSEMENT',
                    providerRef: dispatch?.data?.reference || dispatch?.providerRef || null,
                });
            } catch (ownershipErr) {
                logger.error({ err: ownershipErr, reference, runId: run.id },
                    '[SmartRoute] ownership write failed after acceptance — evidence retains the owner');
                await recordReconciliationExceptionLoud(this.prisma, {
                    entityType: 'TRANSACTION',
                    entityId: reference,
                    reference,
                    reason: 'POST_DISPATCH_OWNERSHIP_WRITE_FAILED',
                    details: { provider: actualProviderName, source: 'smart_route', error: ownershipErr.message },
                }).catch(() => {});
            }
        }

        // Provider accepted: the scheduled execution genuinely reached the
        // intended successful dispatch state. The canonical fiat
        // TransactionHistory stays PENDING until the settlement webhook /
        // reconciler resolves it — the run never pretended to own settlement.
        await this._finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, 'SUCCESS', null, {
            withdrawalId: reservation.withdrawalRecord?.id ?? null,
            amountGhs: reservation.payoutGhs,
            rateUsed: reservation.retailRate,
        });
        return 'ACCEPTED';
    }

    /** r16c: best-effort mirror failure mark (non-fatal — reversal owns truth). */
    async _markMirrorFailed(reservation, stage) {
        if (!reservation?.withdrawalRecord?.id) return;
        try {
            await this.prisma.withdrawal.update({
                where: { id: reservation.withdrawalRecord.id },
                data: { status: 'FAILED' },
            });
        } catch (_) { /* non-fatal */ }
    }


    async _executeTransfer(run, route, occurrenceBased, occurrenceBase) {
        const amount = new Prisma.Decimal(route.amountUsdc);

        await this.prisma.$transaction(async (tx) => {
            // Guarded debit — the conditional claim fails closed on a
            // concurrent spend instead of driving the balance negative.
            const debit = await tx.user.updateMany({
                where: { id: route.userId, availableBalance: { gte: amount } },
                data: { availableBalance: { decrement: amount } },
            });
            if (debit.count !== 1) {
                const err = new Error('Insufficient USDC balance. Balance changed before execution.');
                err.code = 'INSUFFICIENT_BALANCE';
                throw err;
            }
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
            // §P.4 AUTHORITATIVE LEDGER — smart-route internal transfer,
            // same transaction, idempotent on the RUN's durable identity
            // (r16: keyed to run.id so a crashed-execution retry can never
            // double-post):
            //   D user:{sender}:liability    — sender owed less
            //   C user:{recipient}:liability — recipient owed more
            await ledger.post(tx, {
                idempotencyKey: `ledger:smartroute:transfer:${run.id}`,
                entryType: 'TRANSFER',
                description: 'Smart Route internal transfer — liability moved between users',
                userId: route.userId,
                relatedEntity: 'transactionHistory',
                relatedEntityId: runHistory.id,
                metadata: { recipientId: route.destFriendUserId, smartRouteRunId: run.id },
                lines: [
                    { account: `user:${route.userId}:liability`, debit: amount.toFixed(8) },
                    { account: `user:${route.destFriendUserId}:liability`, credit: amount.toFixed(8) },
                ],
            });
            // Run finalization INSIDE the money transaction: either the
            // transfer and the terminal run commit together, or neither.
            await this._finalizeRunInTx(tx, run, route, occurrenceBased, occurrenceBase, 'SUCCESS');
        });

        const refreshed = await this.prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        await this._notifySuccess(route, amount, `Sent $${amount.toFixed(2)} to friend`);
        return refreshed;
    }

    async _executeSavings(run, route, occurrenceBased, occurrenceBase) {
        const amount = new Prisma.Decimal(route.amountUsdc);

        await this.prisma.$transaction(async (tx) => {
            // Goal validation INSIDE the money transaction (the old
            // pre-transaction read was a TOCTOU on goal ownership/state).
            const goal = await tx.savingsGoal.findUnique({
                where: { id: route.destSavingsGoalId },
            });
            if (!goal || goal.userId !== route.userId) {
                throw new Error('Savings goal not found');
            }
            // Live rate for usdc → ghs translation
            const settings = await tx.globalSettings.findUnique({ where: { id: 1 } });
            const rate = new Prisma.Decimal(settings?.liveRetailRate || 12.5);
            const ghs = amount.mul(rate);

            const debit = await tx.user.updateMany({
                where: { id: route.userId, availableBalance: { gte: amount } },
                data: {
                    availableBalance: { decrement: amount },
                    // §P.4: projection escrow column moves with the goal
                    // restriction the ledger locks below.
                    escrowLockedBalance: { increment: amount },
                },
            });
            if (debit.count !== 1) {
                const err = new Error('Insufficient USDC balance. Balance changed before execution.');
                err.code = 'INSUFFICIENT_BALANCE';
                throw err;
            }
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
            // identity (this transaction is the single-writer — the guarded
            // run finalization below rolls back any concurrent duplicate):
            //   D user:{userId}:liability        — spendable liability down
            //   C escrow:savings-{goalId}:locked — goal restriction up
            await ledger.post(tx, {
                idempotencyKey: `ledger:savings:deposit:${depositRow.id}`,
                entryType: 'VAULT_DEPOSIT',
                description: 'Smart Route savings deposit — spendable balance locked into goal restriction',
                userId: route.userId,
                relatedEntity: 'savingsDeposit',
                relatedEntityId: depositRow.id,
                metadata: { goalId: goal.id, amountGhs: ghs.toFixed(8), rateUsed: rate.toFixed(8), smartRoute: true, smartRouteRunId: run.id },
                lines: [
                    { account: `user:${route.userId}:liability`, debit: amount.toFixed(8) },
                    { account: `escrow:savings-${goal.id}:locked`, credit: amount.toFixed(8) },
                ],
            });
            await this._finalizeRunInTx(tx, run, route, occurrenceBased, occurrenceBase, 'SUCCESS');
        });

        const refreshed = await this.prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        await this._notifySuccess(route, amount, `Deposited $${amount.toFixed(2)} to savings`);
        return refreshed;
    }

    async _executeVault(run, route, occurrenceBased, occurrenceBase) {
        const amount = new Prisma.Decimal(route.amountUsdc);

        // Vault deposits commit through vaultService's own transaction (a
        // guarded ACTIVE claim + guarded user debit inside it). The run's
        // durable idempotency key makes a crashed-execution retry converge
        // to the committed deposit instead of moving money twice.
        await this.vaultService.depositManual({
            userId: route.userId,
            vaultId: route.destVaultId,
            amountUsdc: amount,
            idempotencyKey: `smartroute-run-${run.id}`,
        });

        // Finalize the run in a second transaction. A crash between the
        // deposit commit and this finalization leaves a stale PENDING run;
        // the recovery sweep re-drives it, depositManual converges on the
        // idempotency key, and the guarded finalization claim admits
        // exactly one winner.
        await this.prisma.$transaction(async (tx) => {
            await this._finalizeRunInTx(tx, run, route, occurrenceBased, occurrenceBase, 'SUCCESS');
        });

        const refreshed = await this.prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        await this._notifySuccess(route, amount, `Deposited $${amount.toFixed(2)} to vault`);
        return refreshed;
    }

    // =========================================================================
    // RUN FINALIZATION (the single-winner claim)
    // =========================================================================

    /**
     * Finalize a run INSIDE a caller's money transaction. The guarded
     * PENDING claim is the single-winner guard: a concurrent recovery of
     * the same run gets count=0 and its whole transaction (money included)
     * rolls back.
     */
    async _finalizeRunInTx(tx, run, route, occurrenceBased, occurrenceBase, status, failureReason, extras = {}) {
        const finalize = await tx.smartRouteRun.updateMany({
            where: { id: run.id, status: 'PENDING' },
            data: {
                status,
                amountGhs: extras.amountGhs != null ? new Prisma.Decimal(extras.amountGhs) : null,
                rateUsed: extras.rateUsed != null ? new Prisma.Decimal(extras.rateUsed) : null,
                withdrawalId: extras.withdrawalId != null ? Number(extras.withdrawalId) : null,
                failureReason: failureReason || null,
            },
        });
        if (finalize.count !== 1) {
            // Another execution of this run already committed its money
            // transaction and finalized — this attempt must roll back.
            throw new Error(`SMART_ROUTE_RUN_ALREADY_FINALIZED:${run.id}`);
        }
        if (status === 'SUCCESS') {
            await tx.smartRoute.update({
                where: { id: route.id },
                data: {
                    totalRuns: { increment: 1 },
                    totalRoutedUsdc: { increment: new Prisma.Decimal(run.amountUsdc || route.amountUsdc) },
                },
            });
        }
        if (occurrenceBased) {
            // Advance the cadence from the CLAIMED occurrence base (not
            // wall-clock now) so the schedule never drifts, and so a failed
            // occurrence still consumes itself exactly once.
            await tx.smartRoute.update({
                where: { id: route.id },
                data: {
                    nextRunAt: this._computeNextRun(occurrenceBase, route.frequency, route.dayOfMonth),
                    lastRunAt: new Date(),
                },
            });
        }
        this._emitRun(route, run.id, status, new Prisma.Decimal(run.amountUsdc || route.amountUsdc));
    }

    /**
     * Finalize a run without an associated money transaction (guards,
     * unknown action, execution errors). Concurrent finalizations converge
     * on the guarded PENDING claim.
     */
    async _finalizeGuardedRun(run, route, occurrenceBased, occurrenceBase, status, failureReason, extras = {}) {
        try {
            await this.prisma.$transaction(async (tx) => {
                await this._finalizeRunInTx(tx, run, route, occurrenceBased, occurrenceBase, status, failureReason, extras);
            });
        } catch (e) {
            if (!String(e.message || '').startsWith('SMART_ROUTE_RUN_ALREADY_FINALIZED')) throw e;
            // Already finalized by a concurrent recovery — converge.
        }
        const refreshed = await this.prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        return refreshed;
    }

    _emitRun(route, runId, status, amount) {
        if (!this.io) return;
        try {
            this.io.to(`user_${route.userId}`).emit('smart_route:run', {
                routeId: route.id,
                runId,
                status,
                amount: Number(amount.toFixed(2)),
            });
        } catch (_) { /* swallow */ }
    }

    // =========================================================================
    // INTERNAL
    // =========================================================================

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
