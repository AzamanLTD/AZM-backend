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

class EwaService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Check EWA Eligibility ──────────────────────────────────────────────
    async checkEligibility(employeeId) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
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
    // Uses an atomic conditional update to prevent TOCTOU double-withdrawal bugs.
    // Two concurrent requests cannot both pass the eligibility check and withdraw
    // beyond the 30% limit because the updateMany enforces a WHERE guard.
    async requestWithdrawal({ employeeId, amount, destination }) {
        const eligibility = await this.checkEligibility(employeeId);
        if (!eligibility.eligible) {
            throw new Error('Not eligible for EWA withdrawal.');
        }

        const withdrawAmount = parseFloat(amount);
        if (withdrawAmount < 1) {
            throw new Error('Minimum withdrawal is 1 AZM.');
        }
        if (withdrawAmount > eligibility.remainingWithdrawable) {
            throw new Error(
                `Amount exceeds available EWA balance. Max: ${eligibility.remainingWithdrawable.toFixed(2)} AZM`
            );
        }

        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });

        // Calculate fee (1%)
        const fee = withdrawAmount * 0.01;
        const netToEmployee = withdrawAmount - fee;

        // ── CONCURRENCY GUARD ──────────────────────────────────────────────
        // Atomically increment withdrawnEarly ONLY if the current value + amount
        // does not exceed maxAvailable. This prevents double-withdrawal races.
        const maxAvailable = parseFloat(employee.accruedWages) * 0.30;
        const guardResult = await this.prisma.businessEmployee.updateMany({
            where: {
                id: employeeId,
                withdrawnEarly: { lte: maxAvailable - withdrawAmount },
            },
            data: {
                withdrawnEarly: { increment: withdrawAmount },
            },
        });

        if (guardResult.count !== 1) {
            throw new Error('EWA withdrawal failed — insufficient available balance (concurrent withdrawal detected).');
        }

        // Process the withdrawal — credit employee's balance immediately
        // Azaman fronts the cash; business settles on payday
        const [updatedEmployee] = await this.prisma.$transaction([
            // Credit employee's AZM balance
            this.prisma.user.update({
                where: { id: employee.userId },
                data: {
                    azmBalance: { increment: netToEmployee },
                },
            }),
            // Record the EWA transaction in TransactionHistory (atomic ledger compliance)
            // Every USDC/AZM movement MUST have a TransactionHistory record for reconciliation.
            this.prisma.transactionHistory.create({
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
            }),
            // Record the EWA transaction in the business ledger
            this.prisma.businessLedgerEntry.create({
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
            }),
        ]);

        // Fetch the updated employee (withdrawnEarly was already incremented by the guard)
        const finalEmployee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });

        return {
            success: true,
            grossAmount: withdrawAmount,
            fee,
            netToEmployee,
            remainingWithdrawable: eligibility.remainingWithdrawable - withdrawAmount,
            employee: finalEmployee,
        };
    }

    // ── Get EWA History for Employee ───────────────────────────────────────
    async getEwaHistory(employeeId) {
        return this.prisma.businessLedgerEntry.findMany({
            where: {
                sourceType: 'EWA',
                sourceId: employeeId,
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    // ── Get EWA Summary for Business ───────────────────────────────────────
    async getEwaSummary(businessProfileId) {
        const employees = await this.prisma.businessEmployee.findMany({
            where: { businessProfileId, status: 'ACTIVE' },
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
                available: parseFloat(e.accruedWages) * 0.30 - parseFloat(e.withdrawnEarly),
            })),
        };
    }
}

module.exports = { EwaService };
