// 📁 services/businessOS/employeeService.js
// services/businessOS/employeeService.js
// =============================================================================
// Employee Management Service — core CRUD, role/permission management,
// EWA (Earned Wage Access), and employee stats tracking.
//
// All methods take a PrismaClient as the first arg so they can be used
// from both route controllers and test suites.
// =============================================================================

const logger = require('../../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const { EwaService } = require('./ewaService');

// Default permissions by role
const ROLE_PERMISSIONS = {
    OWNER:     ['*'], // all permissions
    MANAGER:   ['manage_employees', 'view_finance', 'process_payroll', 'manage_shifts', 'manage_operations', 'approve_swaps', 'approve_timeoff', 'view_ledger', 'create_ledger_entry'],
    SUPERVISOR:['manage_shifts', 'approve_swaps', 'view_finance', 'manage_operations'],
    STAFF:     ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out'],
    DRIVER:    ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'scan_boarding'],
    HOUSEKEEPER:['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'update_housekeeping'],
    WAITER:    ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'take_orders', 'send_kitchen_order'],
    CHEF:      ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'update_kitchen_order'],
    RECEPTIONIST:['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'manage_reservations', 'check_in_guest'],
    CONCIERGE: ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out', 'assist_guest'],
    SECURITY:  ['view_own_shifts', 'request_swap', 'request_timeoff', 'clock_in_out'],
};

class EmployeeService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Create / Add Employee ──────────────────────────────────────────────
    // The business owner adds an employee by their Azaman user ID (or AZM-ID).
    // This links the user's consumer account to the business as an employee.
    async addEmployee({ businessProfileId, userId, role = 'STAFF', title, department, payrollType = 'SALARY', salaryAmount, hourlyRate, paymentPreference = 'AZAMAN_BALANCE', permissions, emergencyContact, notes }) {
        // Check if user is already an employee of this business
        const existing = await this.prisma.businessEmployee.findUnique({
            where: { businessProfileId_userId: { businessProfileId, userId } },
        });
        if (existing) {
            throw new Error('User is already an employee of this business.');
        }

        // Check if user is already an employee of ANOTHER business (cross-business guard)
        const existingElsewhere = await this.prisma.businessEmployee.findFirst({
            where: { userId, NOT: { businessProfileId } },
        });
        if (existingElsewhere) {
            throw new Error('User is already employed at another business.');
        }

        // Verify the user exists
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found.');

        // Set default permissions based on role
        const finalPermissions = permissions || ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.STAFF;

        // Convert salaryAmount/hourlyRate to Decimal
        const salaryDecimal = salaryAmount ? parseFloat(salaryAmount) : null;
        const hourlyDecimal = hourlyRate ? parseFloat(hourlyRate) : null;

        const employee = await this.prisma.businessEmployee.create({
            data: {
                businessProfileId,
                userId,
                role,
                title,
                department,
                payrollType,
                salaryAmount: salaryDecimal,
                hourlyRate: hourlyDecimal,
                paymentPreference,
                permissions: finalPermissions,
                emergencyContact,
                notes,
            },
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
        });

        return employee;
    }

    // ── Get Employee by ID ─────────────────────────────────────────────────
    // Business profile is part of the authorization boundary; callers must
    // provide the server-derived tenant ID instead of relying on employee ID.
    async getEmployee(employeeId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business context required.');
        return this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            include: {
                user: { select: { id: true, username: true, email: true } },
                shifts: { orderBy: { shiftDate: 'desc' }, take: 10 },
                payrollRecords: { orderBy: { period: 'desc' }, take: 5 },
            },
        });
    }

    // ── Get Employee by Business + User ────────────────────────────────────
    async getEmployeeByUser(businessProfileId, userId) {
        return this.prisma.businessEmployee.findUnique({
            where: { businessProfileId_userId: { businessProfileId, userId } },
        });
    }

    // ── List Employees for a Business ──────────────────────────────────────
    async listEmployees(businessProfileId, { status, role, department } = {}) {
        const where = { businessProfileId };
        if (status) where.status = status;
        if (role) where.role = role;
        if (department) where.department = department;

        return this.prisma.businessEmployee.findMany({
            where,
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
            orderBy: [
                { status: 'asc' }, // ACTIVE first
                { role: 'asc' },
                { hireDate: 'desc' },
            ],
        });
    }

    // ── Update Employee ────────────────────────────────────────────────────
    async updateEmployee(employeeId, businessProfileId, updates) {
        if (!businessProfileId) throw new Error('Business context required.');
        const allowed = ['role', 'title', 'department', 'payrollType', 'salaryAmount', 'hourlyRate', 'paymentPreference', 'permissions', 'status', 'emergencyContact', 'notes', 'terminationDate', 'ewaEligible'];
        const data = {};
        for (const key of allowed) {
            if (key in updates) {
                if (key === 'salaryAmount' || key === 'hourlyRate') {
                    data[key] = updates[key] !== null ? parseFloat(updates[key]) : null;
                } else {
                    data[key] = updates[key];
                }
            }
        }

        // If role changed, update default permissions if not custom
        if (updates.role && !updates.permissions) {
            data.permissions = ROLE_PERMISSIONS[updates.role] || ROLE_PERMISSIONS.STAFF;
        }

        // If status is TERMINATED, set terminationDate
        if (updates.status === 'TERMINATED' && !updates.terminationDate) {
            data.terminationDate = new Date();
        }

        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw new Error('Employee not found.');

        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data,
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
        });
    }

    // ── Remove / Terminate Employee ────────────────────────────────────────
    async terminateEmployee(employeeId, businessProfileId, reason) {
        if (!businessProfileId) throw new Error('Business context required.');
        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw new Error('Employee not found.');

        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data: {
                status: 'TERMINATED',
                terminationDate: new Date(),
                notes: reason ? `Terminated: ${reason}` : undefined,
            },
        });
    }

    // Route-compatible alias used by the Business OS API.
    async removeEmployee(employeeId, businessProfileId, reason) {
        return this.terminateEmployee(employeeId, businessProfileId, reason);
    }

    // ── Re-activate Employee ───────────────────────────────────────────────
    async reactivateEmployee(employeeId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business context required.');
        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw new Error('Employee not found.');

        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data: {
                status: 'ACTIVE',
                terminationDate: null,
            },
        });
    }

    // ── Permission Management ──────────────────────────────────────────────
    async updatePermissions(employeeId, businessProfileId, permissions) {
        if (!businessProfileId) throw new Error('Business context required.');
        if (!Array.isArray(permissions)) throw new Error('Permissions must be an array.');

        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw new Error('Employee not found.');

        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data: { permissions },
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
        });
    }

    // ── Check Permission ───────────────────────────────────────────────────
    hasPermission(employee, permission) {
        if (!employee) return false;
        if (employee.permissions.includes('*')) return true;
        return employee.permissions.includes(permission);
    }

    // ── Get Employees by Role ──────────────────────────────────────────────
    async getEmployeesByRole(businessProfileId, role) {
        return this.prisma.businessEmployee.findMany({
            where: { businessProfileId, role, status: 'ACTIVE' },
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
        });
    }

    // ── Get Employee Stats ─────────────────────────────────────────────────
    async getEmployeeStats(employeeId, businessProfileId) {
        if (!businessProfileId) throw new Error('Business context required.');
        const employee = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!employee) throw new Error('Employee not found.');

        const [shifts, feedbacks, payroll] = await Promise.all([
            this.prisma.shift.count({ where: { employeeId: employee.id, businessProfileId } }),
            this.prisma.employeeFeedback.findMany({
                where: { receiverEmployeeId: employee.id, businessProfileId },
                select: { rating: true, tags: true },
            }),
            this.prisma.payrollRecord.findMany({
                where: { employeeId: employee.id, businessProfileId },
                select: { grossAmount: true, netAmount: true, period: true, status: true },
                orderBy: { period: 'desc' },
                take: 12,
            }),
        ]);

        const avgRating = feedbacks.length > 0
            ? feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length
            : 5.0;

        const totalEarned = payroll.reduce((sum, p) => sum + parseFloat(p.netAmount), 0);

        // Tag frequency
        const tagCounts = {};
        feedbacks.forEach(f => {
            f.tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        });

        return {
            totalShifts: shifts,
            avgRating: Math.round(avgRating * 100) / 100,
            feedbackCount: feedbacks.length,
            totalEarned,
            recentPayroll: payroll,
            topTags: Object.entries(tagCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([tag, count]) => ({ tag, count })),
        };
    }

    // ── EWA: Earned Wage Access ────────────────────────────────────────────
    // Keep the legacy service method as a compatibility boundary for worker
    // callers, but route every money mutation through the canonical EWA engine.
    async requestEWA(employeeId, amount) {
        const result = await new EwaService(this.prisma).requestWithdrawal({
            employeeId,
            amount,
            destination: 'AZM_BALANCE',
        });

        // Preserve the legacy response fields consumed by the worker endpoint
        // while exposing the canonical fee/net fields as well.
        return {
            ...result,
            withdrawn: result.grossAmount,
            remainingEwa: result.remainingWithdrawable,
        };
    }

    // ── Update Accrued Wages (called after clock-out or by a worker) ───────
    async updateAccruedWages(employeeId, hoursWorked) {
        const employee = await this.prisma.businessEmployee.findUnique({
            where: { id: employeeId },
        });
        if (!employee) throw new Error('Employee not found.');

        let accrued = 0;
        if (employee.payrollType === 'HOURLY' && employee.hourlyRate) {
            accrued = hoursWorked * parseFloat(employee.hourlyRate);
        } else if (employee.payrollType === 'SALARY' && employee.salaryAmount) {
            // Pro-rate monthly salary by hours worked (assuming 160 hours/month)
            const hourlyEquivalent = parseFloat(employee.salaryAmount) / 160;
            accrued = hoursWorked * hourlyEquivalent;
        }

        await this.prisma.businessEmployee.update({
            where: { id: employeeId },
            data: {
                accruedWages: { increment: accrued },
                totalHours: { increment: hoursWorked },
            },
        });

        return accrued;
    }

    // ── Get Employee Dashboard Data (for worker sub-portal) ────────────────
    async getWorkerDashboard(userId) {
        const employee = await this.prisma.businessEmployee.findFirst({
            where: { userId, status: 'ACTIVE' },
            include: {
                businessProfile: {
                    select: { id: true, businessName: true, category: true, logoUrl: true },
                },
            },
        });
        if (!employee) return null;

        // Get next shift
        const now = new Date();
        const nextShift = await this.prisma.shift.findFirst({
            where: {
                employeeId: employee.id,
                shiftDate: { gte: now },
                status: { in: ['SCHEDULED', 'LATE'] },
            },
            orderBy: { startTime: 'asc' },
        });

        // Get current shift (if clocked in)
        const currentShift = await this.prisma.shift.findFirst({
            where: {
                employeeId: employee.id,
                status: 'CLOCKED_IN',
            },
        });

        // Get team members on duty now
        const teamOnDuty = await this.prisma.shift.findMany({
            where: {
                businessProfileId: employee.businessProfileId,
                status: 'CLOCKED_IN',
            },
            include: {
                employee: {
                    include: {
                        user: { select: { username: true, email: true } },
                    },
                },
            },
        });

        // Get upcoming team (next shift after current)
        const upcomingTeam = await this.prisma.shift.findFirst({
            where: {
                businessProfileId: employee.businessProfileId,
                shiftDate: { gte: now },
                status: 'SCHEDULED',
            },
            orderBy: { startTime: 'asc' },
            include: {
                employee: {
                    include: {
                        user: { select: { username: true, email: true } },
                    },
                },
            },
        });

        // Calculate salary countdown
        const salaryInfo = this._calculateSalaryCountdown(employee);

        // EWA available
        const ewaAvailable = parseFloat(employee.accruedWages) * 0.30 - parseFloat(employee.withdrawnEarly);

        // Recent feedback
        const recentFeedback = await this.prisma.employeeFeedback.findMany({
            where: { receiverEmployeeId: employee.id },
            orderBy: { createdAt: 'desc' },
            take: 3,
            include: {
                giverEmployee: {
                    include: { user: { select: { username: true } } },
                },
            },
        });

        return {
            employee,
            nextShift,
            currentShift,
            teamOnDuty: teamOnDuty.map(s => ({
                                name: s.employee.user.username,
                role: s.employee.role,
                shiftLabel: s.shiftLabel,
            })),
            upcomingTeam: upcomingTeam ? {
                name: upcomingTeam.employee.user.username,
                role: upcomingTeam?.employee?.role,
                startTime: upcomingTeam.startTime,
            } : null,
            salaryInfo,
            ewaAvailable: Math.max(0, ewaAvailable),
            recentFeedback,
        };
    }

    // ── Helper: Calculate Salary Countdown ─────────────────────────────────
    _calculateSalaryCountdown(employee) {
        const now = new Date();
        const accrued = parseFloat(employee.accruedWages);
        const withdrawn = parseFloat(employee.withdrawnEarly);
        const netAccrued = accrued - withdrawn;

        if (employee.payrollType === 'SALARY' && employee.salaryAmount) {
            // Monthly salary — countdown to end of month
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
            const daysUntilPayday = Math.ceil((endOfMonth - now) / (1000 * 60 * 60 * 24));
            const monthlySalary = parseFloat(employee.salaryAmount);
            // Pro-rate accrual based on day of month
            const dayOfMonth = now.getDate();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const expectedAccrued = (monthlySalary / daysInMonth) * dayOfMonth;

            return {
                type: 'SALARY',
                monthlySalary,
                expectedAccrued: Math.round(expectedAccrued * 100) / 100,
                netAccrued: Math.round(netAccrued * 100) / 100,
                daysUntilPayday,
                payday: endOfMonth,
            };
        } else if (employee.payrollType === 'HOURLY' && employee.hourlyRate) {
            return {
                type: 'HOURLY',
                hourlyRate: parseFloat(employee.hourlyRate),
                totalHours: parseFloat(employee.totalHours),
                netAccrued: Math.round(netAccrued * 100) / 100,
            };
        }

        return { type: 'NONE', netAccrued: 0 };
    }
}

module.exports = { EmployeeService, ROLE_PERMISSIONS };
