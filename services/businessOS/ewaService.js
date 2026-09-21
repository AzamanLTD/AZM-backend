// 📁 services/businessOS/ewaService.js
// services/businessOS/ewaService.js
// =============================================================================
// Earned Wage Access (EWA) Service
// =============================================================================
// Allows employees to withdraw a portion of their accrued wages before payday.
// Azaman fronts the cash; the business settles on payroll day.
//
// Rules:
// - Max withdrawal: 30% of accrued wages
// - Min withdrawal: 1 AZM
// - Fee: 1% of withdrawal (deducted from the employee's share, not the business)
// - The withdrawn amount is tracked as `withdrawnEarly` on the employee record
//   and deducted from their net pay on payroll day
//
// P0 settlement repair (2026-09-21):
// - The business treasury (BusinessProfile.userId's User.availableBalance) is
//   DEBITED the gross amount — previously the withdrawal was recorded without
//   ever funding it from the business.
// - The employee receives spendable USDC on User.availableBalance — NEVER
//   azmBalance (loyalty points).
// - All amounts are exact Prisma.Decimal end-to-end; JS numbers only appear in
//   non-authoritative response presentation.
// - The 1% fee is realized through the established platform fee mechanism
//   (SystemProfitFees + AdminProfitLog + the authoritative ledger line).
// - An optional caller-supplied idempotencyKey claims a DB-unique economic
//   identity BEFORE any mutation: a duplicate request cannot mint another
//   payout (r14 guarded-insert pattern).
// - External destinations (MOMO/WALLET/SPLIT) FAIL CLOSED — no authoritative
//   payout path exists, so the withdrawal is never recorded as sent.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { getBusinessRequestContext } = require('../../src/lib/businessRequestContext');
const ledger = require('../ledgerService');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;

const ZERO = new Prisma.Decimal(0);
const EWA_FEE_RATE = new Prisma.Decimal('0.01');
const EWA_CAP_RATE = new Prisma.Decimal('0.30');
const EWA_MIN_WITHDRAWAL = new Prisma.Decimal(1);

// Typed settlement errors (fail-closed): every one aborts the whole
// transaction — the employee's capacity, the treasury and every accounting
// write roll back together.
const settlementError = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

const isSerializableConflict = (error) => error?.code === 'P2034';

const waitForSerializableRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt));
});

class EwaService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    _resolveBusinessProfileId(explicitBusinessProfileId) {
        const contextBusinessProfileId = getBusinessRequestContext()?.businessProfileId;
        if (explicitBusinessProfileId && contextBusinessProfileId && explicitBusinessProfileId !== contextBusinessProfileId) {
            throw new Error('Business scope mismatch.');
        }
        return explicitBusinessProfileId || contextBusinessProfileId || null;
    }

    async _assertWithdrawalAuthorization(tx, employee, businessProfileId) {
        const context = getBusinessRequestContext();
        if (!context?.businessProfileId) return;
        if (context.businessProfileId !== businessProfileId) throw new Error('Business scope mismatch.');
        if (context.isAdmin || context.isBusinessOwner || String(context.userId) === String(employee.userId)) return;

        const actor = await tx.businessEmployee.findFirst({
            where: {
                businessProfileId,
                userId: context.userId,
                status: 'ACTIVE',
            },
            select: { permissions: true },
        });
        if (!actor || !(actor.permissions || []).includes('*') && !(actor.permissions || []).includes('ewa.manage')) {
            throw new Error('You do not have permission to manage EWA for this employee.');
        }
    }

    // ── Check EWA Eligibility ──────────────────────────────────────────────
    async checkEligibility(employeeId, businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        const employee = scopedBusinessProfileId
            ? await this.prisma.businessEmployee.findFirst({
                where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
            })
            : await this.prisma.businessEmployee.findUnique({ where: { id: employeeId } });
        if (!employee) throw new Error('Employee not found.');
        if (employee.status !== 'ACTIVE') {
            return { eligible: false, reason: 'Employee is not active.' };
        }

        // exact cap math (presentation numbers in the response)
        const accrued = new Prisma.Decimal(employee.accruedWages);
        const alreadyWithdrawn = new Prisma.Decimal(employee.withdrawnEarly);
        const maxAvailable = accrued.mul(EWA_CAP_RATE);
        const remaining = Prisma.Decimal.max(ZERO, maxAvailable.minus(alreadyWithdrawn));

        return {
            eligible: remaining.gte(EWA_MIN_WITHDRAWAL),
            accruedWages: Number(accrued),
            alreadyWithdrawn: Number(alreadyWithdrawn),
            maxWithdrawable: Number(maxAvailable),
            remainingWithdrawable: Number(remaining),
            limitPercent: 30,
        };
    }

    // ── Request EWA Withdrawal ─────────────────────────────────────────────
    // The employee read, cap check, withdrawnEarly claim, guarded treasury
    // debit, employee credit, platform fee, and every ledger/history record are
    // one serializable transaction. A failure in ANY later write rolls back
    // the complete movement; concurrent withdrawals serialize on the guarded
    // claim; a duplicate idempotencyKey claim collides on a unique index and
    // rolls back instead of minting a second payout.
    async requestWithdrawal({ employeeId, amount, destination, businessProfileId, idempotencyKey }) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);

        // §5 DESTINATION SAFETY: only the internal AZAMAN_BALANCE credit has
        // an authoritative settlement path. 'AZM_BALANCE' is the legacy alias
        // used by the employee self-service route. Every external destination
        // (MOMO/WALLET/SPLIT) FAILS CLOSED — a payout is never recorded as
        // sent externally when it was not.
        const INTERNAL_DESTINATIONS = ['AZAMAN_BALANCE', 'AZM_BALANCE'];
        const requestedDestination = destination === undefined || destination === null
            ? 'AZAMAN_BALANCE'
            : String(destination);
        if (!INTERNAL_DESTINATIONS.includes(requestedDestination)) {
            throw settlementError(
                'EWA_EXTERNAL_DESTINATION_UNSUPPORTED',
                `EWA destination ${requestedDestination} has no authoritative payout path; the withdrawal was not executed.`,
            );
        }

        // §6 EXACT MONEY: the gross is an exact decimal end-to-end — never a
        // JS float in any authoritative calculation.
        let withdrawAmount;
        try {
            withdrawAmount = new Prisma.Decimal(String(amount));
        } catch (e) {
            throw new Error('Amount must be a valid number.');
        }
        if (!withdrawAmount.isFinite() || !withdrawAmount.isPositive()) {
            throw new Error('Amount must be a valid number.');
        }
        if (withdrawAmount.dp() > 8) {
            throw new Error('Amount supports at most 8 decimal places.');
        }
        if (withdrawAmount.lt(EWA_MIN_WITHDRAWAL)) {
            throw new Error('Minimum withdrawal is 1 AZM.');
        }
        if (idempotencyKey !== undefined && idempotencyKey !== null
            && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 140)) {
            throw new Error('idempotencyKey must be a string of 1-140 characters.');
        }

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const employee = scopedBusinessProfileId
                        ? await tx.businessEmployee.findFirst({
                            where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
                        })
                        : await tx.businessEmployee.findUnique({ where: { id: employeeId } });
                    if (!employee) throw new Error('Employee not found.');
                    if (scopedBusinessProfileId) {
                        await this._assertWithdrawalAuthorization(tx, employee, scopedBusinessProfileId);
                    }
                    if (!employee.ewaEligible) throw new Error('EWA is not available for this employee.');
                    if (employee.status !== 'ACTIVE') throw new Error('Only active employees can request EWA.');

                    // §7 exact cap math on the Decimal columns
                    const accrued = new Prisma.Decimal(employee.accruedWages);
                    const alreadyWithdrawn = new Prisma.Decimal(employee.withdrawnEarly);
                    const maxAvailable = accrued.mul(EWA_CAP_RATE);
                    const remaining = maxAvailable.minus(alreadyWithdrawn);

                    if (withdrawAmount.gt(remaining)) {
                        throw new Error(
                            `Amount exceeds available EWA balance. Max: ${Prisma.Decimal.max(ZERO, remaining).toFixed(2)} AZM`,
                        );
                    }

                    const fee = withdrawAmount.mul(EWA_FEE_RATE).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
                    const netToEmployee = withdrawAmount.minus(fee);

                    // §1 treasury source: the business owner's spendable balance
                    const business = await tx.businessProfile.findUnique({
                        where: { id: employee.businessProfileId },
                        select: { userId: true },
                    });
                    if (!business) throw new Error('Business profile not found.');

                    // ECONOMIC IDENTITY (r14 guarded-insert pattern): a caller-
                    // supplied idempotencyKey claims a DB-unique TransactionHistory
                    // txHash BEFORE any mutation. A retry or duplicate collides on
                    // the unique index and the WHOLE transaction rolls back — a
                    // duplicate economic request cannot mint another payout.
                    const txHash = idempotencyKey
                        ? `EWA_${employeeId}_${idempotencyKey}`.slice(0, 200)
                        : null;
                    if (txHash) {
                        const clash = await tx.transactionHistory.findFirst({ where: { txHash }, select: { id: true } });
                        if (clash) {
                            throw settlementError(
                                'EWA_DUPLICATE_REQUEST',
                                'An EWA withdrawal with this idempotency key was already processed.',
                            );
                        }
                    }

                    const guardWhere = {
                        id: employeeId,
                        status: 'ACTIVE',
                        ewaEligible: true,
                        withdrawnEarly: { lte: maxAvailable.minus(withdrawAmount) },
                    };
                    if (scopedBusinessProfileId) guardWhere.businessProfileId = scopedBusinessProfileId;

                    const guardResult = await tx.businessEmployee.updateMany({
                        where: guardWhere,
                        data: {
                            withdrawnEarly: { increment: withdrawAmount },
                        },
                    });

                    if (guardResult.count !== 1) {
                        throw new Error(
                            'EWA withdrawal failed — insufficient available balance (concurrent withdrawal detected).',
                        );
                    }

                    // §1 the treasury debit that was missing: guarded so the
                    // business cannot overdraw (invoice balanceClaim pattern).
                    const debit = await tx.user.updateMany({
                        where: { id: business.userId, availableBalance: { gte: withdrawAmount } },
                        data: { availableBalance: { decrement: withdrawAmount } },
                    });
                    if (debit.count !== 1) {
                        throw settlementError(
                            'EWA_INSUFFICIENT_BUSINESS_FUNDS',
                            'Business treasury has insufficient spendable balance for this EWA withdrawal; it was not executed.',
                        );
                    }

                    // Employee spendable credit — User.availableBalance ONLY.
                    // azmBalance is a loyalty-points ledger and must never
                    // receive EWA money.
                    await tx.user.update({
                        where: { id: employee.userId },
                        data: {
                            availableBalance: { increment: netToEmployee },
                        },
                    });

                    // §4 platform fee realized through the established platform
                    // fee mechanism (invoice pattern): SystemProfitFees +
                    // AdminProfitLog + the authoritative ledger line below.
                    if (fee.gt(ZERO)) {
                        await tx.systemProfitFees.upsert({
                            where: { id: 1 },
                            update: { balance: { increment: fee } },
                            create: { id: 1, balance: fee },
                        });
                    }

                    const historyRow = await tx.transactionHistory.create({
                        data: {
                            userId: employee.userId,
                            type: 'EWA_WITHDRAWAL',
                            amountUsdc: netToEmployee,
                            feeUsdc: fee,
                            txHash,
                            status: 'COMPLETED',
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount.toFixed(8),
                                fee: fee.toFixed(8),
                                netToEmployee: netToEmployee.toFixed(8),
                                destination: 'AZAMAN_BALANCE',
                                source: 'BUSINESS_OS_EWA',
                            },
                        },
                    });

                    if (fee.gt(ZERO)) {
                        await tx.adminProfitLog.create({
                            data: {
                                source: 'EWA_FEE',
                                amountUsdc: fee,
                                relatedTxId: txHash || `EWA_HISTORY_${historyRow.id}`,
                            },
                        });
                    }

                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId: employee.businessProfileId,
                            type: 'PAYROLL',
                            category: 'EWA Withdrawal',
                            description: `EWA withdrawal by employee ${employeeId}`,
                            amount: withdrawAmount.negated(),
                            sourceType: 'EWA',
                            sourceId: employeeId,
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount.toFixed(8),
                                fee: fee.toFixed(8),
                                netToEmployee: netToEmployee.toFixed(8),
                                destination: 'AZAMAN_BALANCE',
                            },
                        },
                    });

                    // §P.4 AUTHORITATIVE LEDGER — same transaction, durable
                    // economic identity (unique idempotencyKey):
                    //   D user:{businessOwner}:liability — treasury fronts gross X
                    //   C user:{employee}:liability   — employee receives X - F
                    //   C equity:treasury              — 1% fee realized
                    // X = (X - F) + F balances EXACTLY in Decimal arithmetic.
                    const ledgerLines = [
                        { account: `user:${business.userId}:liability`, debit: withdrawAmount.toFixed(8) },
                        { account: `user:${employee.userId}:liability`, credit: netToEmployee.toFixed(8) },
                    ];
                    if (fee.gt(ZERO)) {
                        ledgerLines.push({ account: 'equity:treasury', credit: fee.toFixed(8) });
                    }
                    await ledger.post(tx, {
                        idempotencyKey: txHash
                            ? `ledger:ewa:${txHash}`
                            : `ledger:ewa:withdraw:${historyRow.id}`,
                        entryType: 'BUSINESS_PAYMENT',
                        description: 'EWA withdrawal — liability moved business owner to employee, fee realized',
                        userId: employee.userId,
                        relatedEntity: 'businessEmployee',
                        relatedEntityId: employeeId,
                        metadata: {
                            grossAmount: withdrawAmount.toFixed(8),
                            fee: fee.toFixed(8),
                            netToEmployee: netToEmployee.toFixed(8),
                            destination: 'AZAMAN_BALANCE',
                        },
                        lines: ledgerLines,
                    });

                    const finalEmployee = scopedBusinessProfileId
                        ? await tx.businessEmployee.findFirst({
                            where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
                        })
                        : await tx.businessEmployee.findUnique({ where: { id: employeeId } });

                    // Response values are non-authoritative presentation (§6).
                    return {
                        success: true,
                        grossAmount: Number(withdrawAmount),
                        fee: Number(fee),
                        netToEmployee: Number(netToEmployee),
                        remainingWithdrawable: Number(Prisma.Decimal.max(ZERO, remaining.minus(withdrawAmount))),
                        employee: finalEmployee,
                    };
                }, { isolationLevel: 'Serializable' });
            } catch (error) {
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
                    throw error;
                }
                await waitForSerializableRetry(attempt);
            }
        }

        throw new Error('EWA withdrawal failed after retries.');
    }

    // ── Get EWA History ─────────────────────────────────────────────────────
    async getEwaHistory(employeeId, businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        const where = { sourceType: 'EWA', sourceId: employeeId };
        if (scopedBusinessProfileId) where.businessProfileId = scopedBusinessProfileId;
        return this.prisma.businessLedgerEntry.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    // ── Get EWA Summary for Business ───────────────────────────────────────
    async getEwaSummary(businessProfileId) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        if (!scopedBusinessProfileId) throw new Error('Business context required.');
        const employees = await this.prisma.businessEmployee.findMany({
            where: { businessProfileId: scopedBusinessProfileId, status: 'ACTIVE' },
            select: {
                id: true,
                accruedWages: true,
                withdrawnEarly: true,
                user: { select: { username: true } },
            },
        });

        let totalAccrued = new Prisma.Decimal(0);
        let totalWithdrawn = new Prisma.Decimal(0);
        for (const e of employees) {
            totalAccrued = totalAccrued.plus(new Prisma.Decimal(e.accruedWages));
            totalWithdrawn = totalWithdrawn.plus(new Prisma.Decimal(e.withdrawnEarly));
        }

        return {
            totalEmployees: employees.length,
            totalAccrued: Number(totalAccrued),
            totalWithdrawn: Number(totalWithdrawn),
            totalOutstanding: Number(totalAccrued.minus(totalWithdrawn)),
            employees: employees.map(e => {
                const accrued = new Prisma.Decimal(e.accruedWages);
                const withdrawn = new Prisma.Decimal(e.withdrawnEarly);
                return {
                    id: e.id,
                    username: e.user.username,
                    accrued: Number(accrued),
                    withdrawn: Number(withdrawn),
                    available: Number(Prisma.Decimal.max(ZERO, accrued.mul(EWA_CAP_RATE).minus(withdrawn))),
                };
            }),
        };
    }
}

module.exports = { EwaService };
