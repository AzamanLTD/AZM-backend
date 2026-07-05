// 📁 services/businessOS/payrollService.js
// services/businessOS/payrollService.js
// =============================================================================
// Payroll Service — process payroll for employees, integrate with Smart Routes
// for automatic disbursement, and track payroll history.
//
// Key features:
// - Process monthly/hourly payroll for all active employees
// - Smart Route integration: employees set their own payment splitting
// - EWA deduction: subtract early withdrawals from net pay
// - Business ledger integration: every payroll entry creates a ledger record
// - TransactionHistory records created for all balance movements (atomic ledger compliance)
// =============================================================================

class PayrollService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Process Payroll for a Single Employee ──────────────────────────────
    async processEmployeePayroll({ businessProfileId, employeeId, period }) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');
        if (employee.businessProfileId !== businessProfileId) {
            throw new Error('Employee does not belong to this business.');
        }
        if (employee.status !== 'ACTIVE' && employee.status !== 'ON_LEAVE') {
            throw new Error('Employee is not active.');
        }

        // Check if payroll already exists for this period
        const existing = await this.prisma.payrollRecord.findUnique({
            where: { employeeId_period: { employeeId, period } },
        });
        if (existing && existing.status === 'PROCESSED') {
            throw new Error(`Payroll for period ${period} already processed.`);
        }

        // Get all shifts for this period
        const [year, month] = period.split('-').map(Number);
        const periodStart = new Date(year, month - 1, 1);
        const periodEnd = new Date(year, month, 0, 23, 59, 59);

        const shifts = await this.prisma.shift.findMany({
            where: {
                employeeId,
                shiftDate: { gte: periodStart, lte: periodEnd },
                status: 'CLOCKED_OUT',
            },
        });

        // Calculate earnings
        let baseAmount = 0;
        let totalHours = 0;
        let overtimeHours = 0;

        if (employee.payrollType === 'SALARY') {
            baseAmount = parseFloat(employee.salaryAmount) || 0;
            // For salary employees, hours are informational
            totalHours = shifts.reduce((sum, s) => {
                if (s.actualMinutes) {
                    return sum + Math.max(0, (s.actualMinutes - s.breakMinutes) / 60);
                }
                return sum;
            }, 0);
        } else if (employee.payrollType === 'HOURLY') {
            const rate = parseFloat(employee.hourlyRate) || 0;
            shifts.forEach(s => {
                if (s.actualMinutes) {
                    const workedHours = Math.max(0, (s.actualMinutes - s.breakMinutes) / 60);
                    totalHours += workedHours;
                    // Overtime: anything over 8 hours per shift or 160 hours/month
                    const dailyOvertime = Math.max(0, workedHours - 8);
                    overtimeHours += dailyOvertime;
                    baseAmount += workedHours * rate;
                }
            });
            // Overtime is paid at 1.5x
            // (already included in baseAmount at regular rate, add the 0.5x bonus)
        }

        const overtimeAmount = overtimeHours * (parseFloat(employee.hourlyRate) || 0) * 0.5;

        // EWA deduction
        const ewaDeduction = parseFloat(employee.withdrawnEarly);

        // Other deductions (tax, etc.) — simplified for now
        const taxAmount = 0; // placeholder for tax calculation
        const deductionAmount = 0; // placeholder for other deductions

        const grossAmount = baseAmount + overtimeAmount;
        const netAmount = grossAmount - ewaDeduction - taxAmount - deductionAmount;

        // Create or update payroll record
        const payroll = await this.prisma.payrollRecord.upsert({
            where: { employeeId_period: { employeeId, period } },
            create: {
                businessProfileId,
                employeeId,
                userId: employee.userId,
                period,
                payrollType: employee.payrollType,
                grossAmount,
                netAmount,
                baseAmount,
                overtimeAmount,
                ewaDeduction,
                taxAmount,
                deductionAmount,
                totalHours: Math.round(totalHours * 100) / 100,
                overtimeHours: Math.round(overtimeHours * 100) / 100,
                status: 'PENDING',
                breakdown: {
                    shifts: shifts.length,
                    regularHours: Math.round((totalHours - overtimeHours) * 100) / 100,
                    overtimeHours: Math.round(overtimeHours * 100) / 100,
                    ewaWithdrawn: ewaDeduction,
                },
            },
            update: {
                grossAmount,
                netAmount,
                baseAmount,
                overtimeAmount,
                ewaDeduction,
                taxAmount,
                deductionAmount,
                totalHours: Math.round(totalHours * 100) / 100,
                overtimeHours: Math.round(overtimeHours * 100) / 100,
                breakdown: {
                    shifts: shifts.length,
                    regularHours: Math.round((totalHours - overtimeHours) * 100) / 100,
                    overtimeHours: Math.round(overtimeHours * 100) / 100,
                    ewaWithdrawn: ewaDeduction,
                },
            },
        });

        return payroll;
    }

    // ── Process Payroll for All Employees ──────────────────────────────────
    async processAllPayroll(businessProfileId, period) {
        const employees = await this.prisma.businessEmployee.findMany({
            where: { businessProfileId, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
        });

        const results = [];
        for (const employee of employees) {
            try {
                const payroll = await this.processEmployeePayroll({
                    businessProfileId,
                    employeeId: employee.id,
                    period,
                });
                results.push({ employeeId: employee.id, status: 'success', payroll });
            } catch (err) {
                results.push({ employeeId: employee.id, status: 'error', error: err.message });
            }
        }

        return results;
    }

    // ── Disburse Payroll (execute payment) ─────────────────────────────────
    // This integrates with Smart Routes for automatic payment splitting.
    // The employee's Smart Route determines where the money goes.
    async disbursePayroll(payrollId) {
        const payroll = await this.prisma.payrollRecord.findUnique({
            where: { id: payrollId },
            include: { employee: true },
        });
        if (!payroll) throw new Error('Payroll record not found.');
        if (payroll.status === 'PROCESSED') throw new Error('Payroll already disbursed.');

        const netAmount = parseFloat(payroll.netAmount);
        if (netAmount <= 0) {
            // Nothing to pay — mark as processed
            return this.prisma.payrollRecord.update({
                where: { id: payrollId },
                data: {
                    status: 'PROCESSED',
                    paidAt: new Date(),
                    failureReason: 'Net amount was zero or negative after deductions.',
                },
            });
        }

        try {
            // Check if employee has a Smart Route configured
            if (payroll.employee.smartRouteId) {
                // Execute via Smart Route — this handles the splitting automatically
                // The Smart Route worker will handle the actual execution
                await this.prisma.payrollRecord.update({
                    where: { id: payrollId },
                    data: {
                        status: 'PROCESSED',
                        smartRouteId: payroll.employee.smartRouteId,
                        paidAt: new Date(),
                    },
                });
            } else {
                // Direct payment to employee's Azaman balance
                // Credit the employee's azmBalance AND create TransactionHistory record
                // (atomic ledger compliance — every USDC/AZM movement must be tracked)
                await this.prisma.$transaction([
                    // Credit employee's AZM balance
                    this.prisma.user.update({
                        where: { id: payroll.userId },
                        data: {
                            azmBalance: { increment: netAmount },
                        },
                    }),
                    // Record in TransactionHistory for ledger reconciliation
                    this.prisma.transactionHistory.create({
                        data: {
                            userId: payroll.userId,
                            type: 'PAYROLL_DISBURSEMENT',
                            amountUsdc: netAmount,
                            feeUsdc: 0,
                            status: 'COMPLETED',
                            metadata: {
                                employeeId: payroll.employeeId,
                                period: payroll.period,
                                payrollId,
                                source: 'BUSINESS_OS_PAYROLL',
                            },
                        },
                    }),
                ]);

                await this.prisma.payrollRecord.update({
                    where: { id: payrollId },
                    data: {
                        status: 'PROCESSED',
                        paidAt: new Date(),
                    },
                });
            }

            // Create ledger entry
            await this.prisma.businessLedgerEntry.create({
                data: {
                    businessProfileId: payroll.businessProfileId,
                    type: 'PAYROLL',
                    category: 'Salary Payment',
                    description: `Payroll for ${payroll.period}`,
                    amount: -netAmount,
                    sourceType: 'PAYROLL',
                    sourceId: payrollId,
                    metadata: { employeeId: payroll.employeeId, period: payroll.period },
                },
            });

            // Reset employee's accrued wages and EWA withdrawn
            await this.prisma.businessEmployee.update({
                where: { id: payroll.employeeId },
                data: {
                    accruedWages: 0.0,
                    withdrawnEarly: 0.0,
                },
            });

            return this.prisma.payrollRecord.findUnique({
                where: { id: payrollId },
            });
        } catch (err) {
            await this.prisma.payrollRecord.update({
                where: { id: payrollId },
                data: {
                    status: 'FAILED',
                    failureReason: err.message,
                },
            });
            throw err;
        }
    }

    // ── Disburse All Payroll for a Period ──────────────────────────────────
    async disburseAllPayroll(businessProfileId, period) {
        const records = await this.prisma.payrollRecord.findMany({
            where: { businessProfileId, period, status: 'PENDING' },
        });

        const results = [];
        for (const record of records) {
            try {
                const result = await this.disbursePayroll(record.id);
                results.push({ payrollId: record.id, status: 'success' });
            } catch (err) {
                results.push({ payrollId: record.id, status: 'error', error: err.message });
            }
        }

        return results;
    }

    // ── Get Payroll Records ────────────────────────────────────────────────
    async getPayrollRecords(businessProfileId, { period, employeeId, status } = {}) {
        const where = { businessProfileId };
        if (period) where.period = period;
        if (employeeId) where.employeeId = employeeId;
        if (status) where.status = status;

        return this.prisma.payrollRecord.findMany({
            where,
            include: {
                employee: {
                    include: { user: { select: { username: true, email: true } } },
                },
            },
            orderBy: { period: 'desc' },
        });
    }

    // ── Get Payroll Summary for a Period ───────────────────────────────────
    async getPayrollSummary(businessProfileId, period) {
        const records = await this.prisma.payrollRecord.findMany({
            where: { businessProfileId, period },
        });

        const summary = {
            period,
            totalEmployees: records.length,
            totalGross: records.reduce((s, r) => s + parseFloat(r.grossAmount), 0),
            totalNet: records.reduce((s, r) => s + parseFloat(r.netAmount), 0),
            totalEwa: records.reduce((s, r) => s + parseFloat(r.ewaDeduction), 0),
            totalOvertime: records.reduce((s, r) => s + parseFloat(r.overtimeAmount), 0),
            pending: records.filter(r => r.status === 'PENDING').length,
            processed: records.filter(r => r.status === 'PROCESSED').length,
            failed: records.filter(r => r.status === 'FAILED').length,
        };

        return summary;
    }
}

module.exports = { PayrollService };
