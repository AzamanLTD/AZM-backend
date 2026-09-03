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
// - Fee: 1% of withdrawal (deducted from employee's share, not the business)
// - The withdrawn amount is tracked as `withdrawnEarly` on the employee record
//   and deducted from their net pay on payroll day
// =============================================================================

const { getBusinessRequestContext } = require('../../src/lib/businessRequestContext');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;

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

        const accrued = parseFloat(employee.accruedWages);
        const alreadyWithdrawn = parseFloat(employee.withdrawnEarly);
        const maxAvailable = accrued * 0.30;
        const remaining = Math.max(0, maxAvailable - alreadyWithdrawn);

        return {
            eligible: remaining >= 1,
            accruedWages: accrued,
            alreadyWithdrawn,
            maxWithdrawable: maxAvailable,
            remainingWithdrawable: remaining,
            limitPercent: 30,
        };
    }

    // ── Request EWA Withdrawal ─────────────────────────────────────────────
    // The employee read, cap check, withdrawnEarly claim, balance credit, and
    // both ledger records are one serializable transaction. This prevents a
    // successful claim from becoming a permanent balance deduction when a later
    // ledger/balance write fails, and makes concurrent withdrawals serialize.
    async requestWithdrawal({ employeeId, amount, destination, businessProfileId }) {
        const scopedBusinessProfileId = this._resolveBusinessProfileId(businessProfileId);
        const withdrawAmount = Number(amount);
        if (!Number.isFinite(withdrawAmount)) {
            throw new Error('Amount must be a valid number.');
        }
        if (withdrawAmount < 1) {
            throw new Error('Minimum withdrawal is 1 AZM.');
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

                    const accrued = parseFloat(employee.accruedWages);
                    const alreadyWithdrawn = parseFloat(employee.withdrawnEarly);
                    const maxAvailable = accrued * 0.30;
                    const remaining = maxAvailable - alreadyWithdrawn;

                    if (withdrawAmount > remaining) {
                        throw new Error(
                            `Amount exceeds available EWA balance. Max: ${Math.max(0, remaining).toFixed(2)} AZM`,
                        );
                    }

                    const fee = withdrawAmount * 0.01;
                    const netToEmployee = withdrawAmount - fee;

                    const guardWhere = {
                        id: employeeId,
                        status: 'ACTIVE',
                        ewaEligible: true,
                        withdrawnEarly: { lte: maxAvailable - withdrawAmount },
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

                    await tx.user.update({
                        where: { id: employee.userId },
                        data: {
                            azmBalance: { increment: netToEmployee },
                        },
                    });

                    await tx.transactionHistory.create({
                        data: {
                            userId: employee.userId,
                            type: 'EWA_WITHDRAWAL',
                            amountUsdc: netToEmployee,
                            feeUsdc: fee,
                            status: 'COMPLETED',
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount,
                                destination: destination || 'AZM_BALANCE',
                                source: 'BUSINESS_OS_EWA',
                            },
                        },
                    });

                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId: employee.businessProfileId,
                            type: 'PAYROLL',
                            category: 'EWA Withdrawal',
                            description: `EWA withdrawal by employee ${employeeId}`,
                            amount: -withdrawAmount,
                            sourceType: 'EWA',
                            sourceId: employeeId,
                            metadata: {
                                employeeId,
                                grossAmount: withdrawAmount,
                                fee,
                                netToEmployee,
                                destination: destination || 'AZM_BALANCE',
                            },
                        },
                    });

                    const finalEmployee = scopedBusinessProfileId
                        ? await tx.businessEmployee.findFirst({
                            where: { id: employeeId, businessProfileId: scopedBusinessProfileId },
                        })
                        : await tx.businessEmployee.findUnique({ where: { id: employeeId } });

                    return {
                        success: true,
                        grossAmount: withdrawAmount,
                        fee,
                        netToEmployee,
                        remainingWithdrawable: Math.max(0, remaining - withdrawAmount),
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

    // ── Get EWA History for Employee ───────────────────────────────────────
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

        const totalAccrued = employees.reduce((s, e) => s + parseFloat(e.accruedWages), 0);
        const totalWithdrawn = employees.reduce((s, e) => s + parseFloat(e.withdrawnEarly), 0);

        return {
            totalEmployees: employees.length,
            totalAccrued,
            totalWithdrawn,
            totalOutstanding: totalAccrued - totalWithdrawn,
            employees: employees.map(e => ({
                id: e.id,
                username: e.user.username,
                accrued: parseFloat(e.accruedWages),
                withdrawn: parseFloat(e.withdrawnEarly),
                available: Math.max(0, parseFloat(e.accruedWages) * 0.30 - parseFloat(e.withdrawnEarly)),
            })),
        };
    }
}

module.exports = { EwaService };
