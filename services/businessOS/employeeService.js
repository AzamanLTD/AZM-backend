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
const { EMPLOYEE_ROLE_TEMPLATES, normalizePermissions, ASSIGNABLE_EMPLOYEE_ROLES, ALL_PERMISSION_KEYS } = require('../../config/permissionTemplates');

// r26/P0-2 — OWNER is never assignable through the employee service. The
// business owner's authority derives from BusinessProfile ownership
// (bp.userId), not from an employee row; the OWNER template's own contract
// says "Cannot be assigned to non-owners", and this is where that contract
// is ENFORCED (fail closed at the authoritative service boundary — never
// only in the UI).
const assertAssignableRole = (role) => {
    if (role === 'OWNER') {
        throw new Error('OWNER is not an assignable employee role — owner authority derives from business ownership. Refusing.');
    }
    if (!ASSIGNABLE_EMPLOYEE_ROLES.includes(role)) {
        throw new Error(`Unknown employee role "${role}". Allowed: ${ASSIGNABLE_EMPLOYEE_ROLES.join(', ')}`);
    }
    return role;
};

// r26/P0-3 — the generic employee PATCH (employees.update authority) may only
// touch profile/compensation/role fields. Permission mutations belong to the
// dedicated permission-authority method (employees.permissions); status and
// termination transitions belong to the terminate authority
// (employees.terminate). Smuggling any of these through the generic update is
// a hard, explicit failure — never a silent ignore.
const EMPLOYEE_UPDATE_FORBIDDEN_FIELDS = ['permissions', 'status', 'terminationDate'];
const EMPLOYEE_UPDATE_ALLOWED_FIELDS = ['role', 'title', 'department', 'payrollType', 'salaryAmount', 'hourlyRate', 'paymentPreference', 'emergencyContact', 'notes', 'ewaEligible'];

// Default permissions by role
// ── Role defaults (Module 01) ─────────────────────────────────────────────────
// Dotted-key permission defaults sourced from the canonical catalog
// (config/permissionTemplates.js). The previous legacy snake_case vocabulary
// ("manage_employees", "view_finance", ...) never matched any
// requirePermission('employees.manage') route key, so seeded defaults were
// inert — employees created with them could not pass any permission check.
const ROLE_PERMISSIONS = Object.fromEntries(
    Object.entries(EMPLOYEE_ROLE_TEMPLATES).map(([role, tpl]) => [role, tpl.permissions]),
);

class EmployeeService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Create / Add Employee ──────────────────────────────────────────────
    // The business owner adds an employee by their Azaman user ID (or AZM-ID).
    // This links the user's consumer account to the business as an employee.
    async addEmployee({ businessProfileId, userId, azmId, role = 'STAFF', title, department, payrollType = 'SALARY', salaryAmount, hourlyRate, paymentPreference = 'AZAMAN_BALANCE', permissions, emergencyContact, notes }) {
        // r26/P0-2: an employee row may never carry OWNER (fail closed).
        assertAssignableRole(role);
        if (Array.isArray(permissions) && permissions.includes('*')) {
            throw new Error('Wildcard permissions are not assignable to employees. Refusing.');
        }
        // ── Module 01: resolve the worker's identity ─────────────────────────
        // The portal's "AZM-ID" field is the worker's Azaman @username (or
        // email). Accept a numeric userId as before, and additionally resolve
        // a string handle (username first, then email) to the real user row.
        let resolvedUserId = userId;
        if (typeof userId !== 'number') {
            const handle = String(azmId ?? userId ?? '').trim().replace(/^@/, '');
            if (!handle) throw new Error('User not found. Provide the employee\'s Azaman username, email, or user ID.');
            let user = await this.prisma.user.findUnique({ where: { username: handle } });
            if (!user && handle.includes('@')) {
                user = await this.prisma.user.findUnique({ where: { email: handle } });
            }
            if (!user) throw new Error(`No Azaman account found for "${handle}".`);
            resolvedUserId = user.id;
        }
        userId = resolvedUserId;

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
        // Normalize into dotted-key space: legacy strings expand, dedupe applies.
        const finalPermissions = normalizePermissions(
            permissions || ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.STAFF,
        );

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

        // r26/P0-3 — the generic PATCH has an EXPLICIT, narrow contract.
        // Authority-bearing fields are refused loudly here so the
        // route-level permission split cannot be bypassed through the body.
        for (const forbidden of EMPLOYEE_UPDATE_FORBIDDEN_FIELDS) {
            if (forbidden in updates && updates[forbidden] !== undefined) {
                if (forbidden === 'permissions') {
                    throw new Error('Permission changes require the dedicated permission authority (employees.permissions).');
                }
                throw new Error(`Employee status/termination changes require the termination authority (employees.terminate). Refusing field "${forbidden}".`);
            }
        }
        if (updates.role !== undefined) {
            // r26/P0-2: promotion into OWNER is impossible through any path.
            assertAssignableRole(updates.role);
        }

        const data = {};
        for (const key of EMPLOYEE_UPDATE_ALLOWED_FIELDS) {
            if (key in updates) {
                if (key === 'salaryAmount' || key === 'hourlyRate') {
                    data[key] = updates[key] !== null ? parseFloat(updates[key]) : null;
                } else {
                    data[key] = updates[key];
                }
            }
        }

        // Role changes reseed the role defaults into the stored set (the
        // stored set remains authoritative for everything after that).
        if (updates.role && !('permissions' in data)) {
            data.permissions = normalizePermissions(ROLE_PERMISSIONS[updates.role] || ROLE_PERMISSIONS.STAFF);
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
    // ── r26/P0-4 — DEDICATED PERMISSION AUTHORITY (with delegation ceiling) ──
    //
    // Actor semantics (passed by the route from the server-resolved context —
    // never from the request body):
    //   • actor.id            — the authenticated user performing the grant
    //   • actor.permissions   — the actor's EFFECTIVE permission set
    //                            (['*'] for owners/admins)
    //
    // Ceiling invariants:
    //   • owner/admin (['*']) may administer the full authorized catalog
    //     (wildcard allowed);
    //   • any other actor may grant ONLY permissions they themselves hold —
    //     a subset check, so a Manager can never mint authority outside their
    //     own effective ceiling, can never grant '*', and can never elevate
    //     themselves or anyone else beyond it;
    //   • every grant must be a known catalog key (unknown strings are
    //     rejected, not stored as inert noise).
    async updatePermissions(employeeId, businessProfileId, permissions, { actor } = {}) {
        if (!businessProfileId) throw new Error('Business context required.');
        if (!Array.isArray(permissions)) throw new Error('Permissions must be an array.');

        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true, userId: true, permissions: true },
        });
        if (!existing) throw new Error('Employee not found.');
        // The target's CURRENT grants (authoritative stored set, normalized).
        const currentSet = new Set(normalizePermissions(existing.permissions || []));

        const normalized = normalizePermissions(permissions);

        // A target employee row may never hold wildcard authority.
        if (normalized.includes('*')) {
            throw new Error("Wildcard ('*') is reserved for business owners and admins — it cannot be granted to an employee. Refusing.");
        }
        // Grants must speak the canonical vocabulary.
        const unknown = normalized.filter((p) => !ALL_PERMISSION_KEYS.includes(p));
        if (unknown.length > 0) {
            throw new Error(`Unknown permission key(s): ${unknown.join(', ')}. Grants must use the canonical catalog.`);
        }

        if (actor && actor.id != null) {
            const actorPerms = Array.isArray(actor.permissions) ? actor.permissions : [];
            const actorIsUnlimited = actorPerms.includes('*');
            if (!actorIsUnlimited) {
                // Delegation ceiling: NEW grants must be permissions the actor
                // holds. PRESERVING a permission the target already holds is
                // allowed (the actor may keep or drop an existing grant, but
                // cannot mint one) — so a ceiling-limited manager touching a
                // heavily-granted employee cannot silently destroy grants
                // made above their ceiling.
                const ceiling = new Set(normalizePermissions(actorPerms));
                const additions = normalized.filter((p) => !currentSet.has(p));
                const beyond = additions.filter((p) => !ceiling.has(p));
                if (beyond.length > 0) {
                    throw new Error(`Delegation ceiling exceeded: you cannot grant permission(s) you do not hold (${beyond.join(', ')}).`);
                }
                // Self-service narrowing is allowed; self-elevation is
                // impossible by the additions check above. Editing your own
                // row cannot create authority outside your own ceiling.
                if (existing.userId === actor.id) {
                    if (additions.length > 0) {
                        throw new Error('You cannot add permissions to your own employee record. Refusing self-elevation.');
                    }
                }
            }
        } else {
            // No actor context: fail closed. The authority path must prove who
            // is granting.
            throw new Error('Permission updates require the authenticated actor context. Refusing.');
        }

        // Store the normalized dotted-key set: the stored set IS the effective
        // set (revocation is real — see resolvePermissions).
        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data: { permissions: normalized },
            include: {
                user: { select: { id: true, username: true, email: true } },
            },
        });
    }

    // ── r26/P0-3 — DEDICATED STATUS AUTHORITY (employees.terminate) ────────
    // ACTIVE <-> SUSPENDED transitions live behind the termination authority;
    // TERMINATED itself goes through terminateEmployee (the DELETE route).
    // This is the ONLY path (besides termination) that may write `status`.
    async updateStatus(employeeId, businessProfileId, status) {
        if (!businessProfileId) throw new Error('Business context required.');
        if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
            throw new Error('Status must be ACTIVE or SUSPENDED (termination uses the dedicated terminate authority).');
        }
        const existing = await this.prisma.businessEmployee.findFirst({
            where: { id: employeeId, businessProfileId },
            select: { id: true },
        });
        if (!existing) throw new Error('Employee not found.');
        return this.prisma.businessEmployee.update({
            where: { id: existing.id },
            data: { status },
            include: { user: { select: { id: true, username: true, email: true } } },
        });
    }

    // ── Check Permission ───────────────────────────────────────────────────
    hasPermission(employee, permission) {
        if (!employee || !Array.isArray(employee.permissions)) return false;
        if (employee.permissions.includes('*')) return true;
        // Module 01: also honor legacy snake_case grants stored on the row.
        return normalizePermissions(employee.permissions).includes(permission);
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
    async requestEWA(employeeId, amount, idempotencyKey) {
        const result = await new EwaService(this.prisma).requestWithdrawal({
            employeeId,
            amount,
            destination: 'AZAMAN_BALANCE',
            idempotencyKey,
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

        // Get current shift (both on-time and late starts are still active)
        const currentShift = await this.prisma.shift.findFirst({
            where: {
                employeeId: employee.id,
                status: { in: ['CLOCKED_IN', 'LATE'] },
            },
        });

        // Get team members on duty now; LATE is an active attendance state too.
        const teamOnDuty = await this.prisma.shift.findMany({
            where: {
                businessProfileId: employee.businessProfileId,
                status: { in: ['CLOCKED_IN', 'LATE'] },
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
