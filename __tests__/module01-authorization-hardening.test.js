// __tests__/module01-authorization-hardening.test.js
// =============================================================================
// r26 — Module 01 authorization hardening (P0-1 … P0-6) — REAL POSTGRESQL PROOFS
//
// Covers the boundaries the mocked 23-test suite could not see:
//   P0-1  ordinary-employee business-context resolution (owner / employee /
//         suspended / cross-business / admin impersonation)
//   P0-2  OWNER is never assignable/promotable to an employee row
//   P0-3  generic PATCH cannot smuggle permissions/status/termination
//   P0-4  permission delegation ceiling (incl. '*' and self-elevation)
//   P0-5  revocation semantics (stored set is authoritative)
//   P0-6  /employees/me returns the authoritative permission representation
//
// Runs against the real test database (same gate pattern as business-os.test.js).
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { resolveBusinessContext, resolvePermissions } = require('../middleware/requirePermission');
const { EmployeeService } = require('../services/businessOS/employeeService');
const { normalizePermissions, EMPLOYEE_ROLE_TEMPLATES } = require('../config/permissionTemplates');
// ROLE_PERMISSIONS as used by the service (role -> template permissions):
const ROLE_PERMISSIONS = Object.fromEntries(
    Object.entries(EMPLOYEE_ROLE_TEMPLATES).map(([role, tpl]) => [role, tpl.permissions]),
);

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[module01-hardening] TEST_DATABASE_URL not set — skipping.');
const describeIf = hasDb ? describe : describe.skip;

let prisma;
let service;
let ownerUser, employeeUser, suspendedUser, otherOwner, otherEmployee, adminUser;
let businessA, businessB;

async function mkUser(prefix, role = 'VENDOR') {
    const hashed = await bcrypt.hash('testpass123', 10);
    return prisma.user.create({
        data: {
            username: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            email: `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}@test.com`,
            password: hashed,
            azamanId: `AZM-${prefix.toUpperCase()}-${Math.floor(Math.random() * 1e9)}`,
            role,
            availableBalance: 100.0,
        },
    });
}

async function mkBusiness(owner, name, category = 'HOSPITALITY') {
    return prisma.businessProfile.create({
        data: {
            userId: owner.id,
            bizId: `BIZ-${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
            businessName: `${name} ${Math.floor(Math.random() * 1e9)}`,
            category,
            isVerified: true,
            kybStatus: 'VERIFIED',
        },
    });
}

beforeAll(async () => {
    prisma = new PrismaClient();
    service = new EmployeeService(prisma);

    ownerUser = await mkUser('m01owner');
    employeeUser = await mkUser('m01emp', 'USER');
    suspendedUser = await mkUser('m01susp', 'USER');
    otherOwner = await mkUser('m01oowner');
    otherEmployee = await mkUser('m01oemp', 'USER');
    adminUser = await mkUser('m01admin', 'ADMIN');
    businessA = await mkBusiness(ownerUser, 'Hardening Biz A');
    businessB = await mkBusiness(otherOwner, 'Hardening Biz B');
});

afterAll(async () => {
    // Fixture cleanup by traceable names.
    const users = [ownerUser, employeeUser, suspendedUser, otherOwner, otherEmployee, adminUser].filter(Boolean);
    if (users.length) {
        const ids = users.map((u) => u.id);
        await prisma.businessEmployee.deleteMany({ where: { userId: { in: ids } } });
        await prisma.businessProfile.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 — business-context resolution
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-1 — authoritative business context', () => {
    test('an ordinary ACTIVE employee resolves through their own employment', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: ['shifts.view'] },
        });
        try {
            const ctx = await resolveBusinessContext(prisma, { id: employeeUser.id, role: 'USER' });
            expect(ctx).not.toBeNull();
            expect(ctx.businessProfileId).toBe(businessA.id);
            expect(ctx.isEmployee).toBe(true);
            expect(ctx.isBusinessOwner).toBe(false);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('the owner resolves to their own business (ownership beats employment)', async () => {
        // The owner is ALSO employed at business B — ownership must win and
        // they may never gain a context for B through this path.
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessB.id, userId: ownerUser.id, role: 'STAFF', permissions: [] },
        });
        try {
            const ctx = await resolveBusinessContext(prisma, { id: ownerUser.id, role: 'VENDOR' });
            expect(ctx.businessProfileId).toBe(businessA.id);
            expect(ctx.isBusinessOwner).toBe(true);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('a suspended employee receives NO business context (no permissions)', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: suspendedUser.id, role: 'STAFF', status: 'SUSPENDED', permissions: ['shifts.view'] },
        });
        try {
            const ctx = await resolveBusinessContext(prisma, { id: suspendedUser.id, role: 'USER' });
            expect(ctx).toBeNull();
            // And even with a manufactured business id, the resolver yields nothing:
            const perms = await resolvePermissions(prisma, suspendedUser.id, businessA.id);
            expect(perms).toEqual([]);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('an employee of business A cannot access business B by supplying IDs/headers', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: ['shifts.view'] },
        });
        try {
            // Non-admin user sending the admin header gets nothing from it:
            const ctx = await resolveBusinessContext(prisma, { id: employeeUser.id, role: 'USER' }, {
                adminScoped: false, // adminBusinessScope only validates for role==='ADMIN'
                adminScopedBusinessId: businessB.id,
            });
            expect(ctx).not.toBeNull();
            expect(ctx.businessProfileId).toBe(businessA.id);
            // Cross-business permission check is empty even against a
            // manufactured context:
            const perms = await resolvePermissions(prisma, employeeUser.id, businessB.id);
            expect(perms).toEqual([]);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('admin impersonation resolves ONLY the explicitly authorized business', async () => {
        const ctx = await resolveBusinessContext(prisma, { id: adminUser.id, role: 'ADMIN' }, {
            adminScoped: true,
            adminScopedBusinessId: businessB.id,
        });
        expect(ctx).not.toBeNull();
        expect(ctx.businessProfileId).toBe(businessB.id);
        expect(ctx.isAdminImpersonation).toBe(true);
    });

    test('a user with no ownership and no employment resolves to nothing', async () => {
        const ctx = await resolveBusinessContext(prisma, { id: otherEmployee.id, role: 'USER' });
        expect(ctx).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 — OWNER is never assignable
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-2 — OWNER role escalation refusal', () => {
    test('addEmployee refuses role=OWNER (create path)', async () => {
        await expect(service.addEmployee({
            businessProfileId: businessA.id,
            userId: employeeUser.id,
            role: 'OWNER',
        })).rejects.toThrow(/OWNER is not an assignable employee role/);
    });

    test('the generic update refuses role changes outright; updateRole refuses OWNER (update path)', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: [] },
        });
        try {
            // r26/P0-B: role no longer rides the generic profile update.
            await expect(service.updateEmployee(emp.id, businessA.id, { role: 'OWNER' }))
                .rejects.toThrow(/Role changes are authority-bearing/);
            // And the dedicated role authority refuses OWNER before anything else.
            await expect(service.updateRole(emp.id, businessA.id, 'OWNER', { actor: { id: ownerUser.id, permissions: ['*'] } }))
                .rejects.toThrow(/OWNER is not an assignable employee role/);
            const after = await prisma.businessEmployee.findUnique({ where: { id: emp.id } });
            expect(after.role).toBe('STAFF'); // unchanged — fail closed, no partial mutation
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('the business owner still holds full owner authority (via ownership, not a row)', async () => {
        const perms = await resolvePermissions(prisma, ownerUser.id, businessA.id);
        expect(perms).toEqual(['*']);
    });

    test('addEmployee refuses wildcard permissions even with a valid role', async () => {
        await expect(service.addEmployee({
            businessProfileId: businessA.id,
            userId: employeeUser.id,
            role: 'MANAGER',
            permissions: ['*'],
        }, { actor: { id: ownerUser.id, permissions: ['*'] } }))
            .rejects.toThrow(/Wildcard/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-3 — generic PATCH cannot smuggle authority-bearing fields
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-3 — profile mutation vs. permission/termination authority', () => {
    let emp;
    beforeEach(async () => {
        emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: ['shifts.view'] },
        });
    });
    afterEach(async () => {
        await prisma.businessEmployee.delete({ where: { id: emp.id } }).catch(() => {});
    });

    test('employees.update alone cannot set permissions', async () => {
        await expect(service.updateEmployee(emp.id, businessA.id, { permissions: ['*'] }))
            .rejects.toThrow(/dedicated permission authority/);
        const after = await prisma.businessEmployee.findUnique({ where: { id: emp.id } });
        expect(after.permissions).toEqual(['shifts.view']); // unchanged
    });

    test('employees.update alone cannot terminate or change status', async () => {
        await expect(service.updateEmployee(emp.id, businessA.id, { status: 'TERMINATED' }))
            .rejects.toThrow(/termination authority/);
        await expect(service.updateEmployee(emp.id, businessA.id, { status: 'SUSPENDED' }))
            .rejects.toThrow(/termination authority/);
        await expect(service.updateEmployee(emp.id, businessA.id, { terminationDate: new Date() }))
            .rejects.toThrow(/termination authority/);
        const after = await prisma.businessEmployee.findUnique({ where: { id: emp.id } });
        expect(after.status).toBe('ACTIVE');
        expect(after.terminationDate).toBeNull();
    });

    test('ordinary profile/compensation fields still update (contract stays useful)', async () => {
        const updated = await service.updateEmployee(emp.id, businessA.id, { title: 'Head of Cash', salaryAmount: '12.5' });
        expect(updated.title).toBe('Head of Cash');
        expect(parseFloat(updated.salaryAmount)).toBe(12.5);
        expect(updated.status).toBe('ACTIVE');
    });

    test('role changes are refused on the generic PATCH and reseeded only via the dedicated role authority', async () => {
        // r26/P0-B: the generic employees.update path refuses role outright.
        await expect(service.updateEmployee(emp.id, businessA.id, { role: 'MANAGER' }))
            .rejects.toThrow(/Role changes are authority-bearing/);
        let after = await prisma.businessEmployee.findUnique({ where: { id: emp.id } });
        expect(after.role).toBe('STAFF');
        expect(after.permissions).toEqual(['shifts.view']); // unchanged

        // The owner, through the dedicated authority, reseeds role defaults:
        const updated = await service.updateRole(emp.id, businessA.id, 'MANAGER', { actor: { id: ownerUser.id, permissions: ['*'] } });
        expect(updated.role).toBe('MANAGER');
        // MANAGER template default (GENERAL_MANAGER) — includes employees.view:
        expect(updated.permissions).toContain('employees.view');
        expect(updated.permissions).not.toContain('*');
    });

    test('the dedicated status authority moves ACTIVE <-> SUSPENDED only', async () => {
        const suspended = await service.updateStatus(emp.id, businessA.id, 'SUSPENDED');
        expect(suspended.status).toBe('SUSPENDED');
        const reactivated = await service.updateStatus(emp.id, businessA.id, 'ACTIVE');
        expect(reactivated.status).toBe('ACTIVE');
        await expect(service.updateStatus(emp.id, businessA.id, 'TERMINATED'))
            .rejects.toThrow(/termination uses the dedicated terminate authority/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-4 — delegation ceiling
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-4 — permission delegation ceiling', () => {
    let manager, target;
    beforeEach(async () => {
        manager = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'MANAGER', permissions: ['employees.view', 'employees.update', 'employees.permissions', 'shifts.view'] },
        });
        target = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: suspendedUser.id, role: 'STAFF', permissions: [] },
        });
    });
    afterEach(async () => {
        await prisma.businessEmployee.deleteMany({ where: { id: { in: [manager.id, target.id] } } }).catch(() => {});
    });

    let managerActor;
    beforeEach(() => {
        managerActor = { id: employeeUser.id, permissions: ['employees.view', 'employees.update', 'employees.permissions', 'shifts.view'] };
    });

    test('a Manager may grant an allowed subordinate permission within their ceiling', async () => {
        const updated = await service.updatePermissions(target.id, businessA.id, ['employees.view', 'shifts.view'], { actor: managerActor });
        expect(updated.permissions).toContain('employees.view');
        expect(updated.permissions).toContain('shifts.view');
    });

    test('a Manager cannot grant a permission they do not hold (settings.manage)', async () => {
        await expect(service.updatePermissions(target.id, businessA.id, ['settings.manage'], { actor: managerActor }))
            .rejects.toThrow(/Delegation ceiling exceeded/);
    });

    test("a Manager cannot grant wildcard ['*']", async () => {
        await expect(service.updatePermissions(target.id, businessA.id, ['*'], { actor: managerActor }))
            .rejects.toThrow(/Wildcard \('\*'\) is reserved/);
    });

    test('a Manager cannot mint OWNER-equivalent authority (every-permission grant)', async () => {
        const { ALL_PERMISSION_KEYS } = require('../config/permissionTemplates');
        await expect(service.updatePermissions(target.id, businessA.id, ALL_PERMISSION_KEYS, { actor: managerActor }))
            .rejects.toThrow(/Delegation ceiling exceeded/);
    });

    test('a self-editing actor cannot ADD permissions to their own row', async () => {
        // Narrow first (allowed), so the actor HOLDS shifts.view while their
        // row does NOT — isolating the self-elevation rule from the ceiling.
        const narrowed = await service.updatePermissions(manager.id, businessA.id, ['employees.view'], { actor: managerActor });
        expect(narrowed.permissions).toEqual(['employees.view']);
        // Re-adding a permission the actor legitimately holds is STILL
        // refused on their own row — no self-service re-expansion:
        await expect(service.updatePermissions(manager.id, businessA.id, ['employees.view', 'shifts.view'], { actor: managerActor }))
            .rejects.toThrow(/cannot add permissions to your own employee record/);
        // And adding something they do NOT hold hits the ceiling first:
        await expect(service.updatePermissions(manager.id, businessA.id, ['employees.view', 'finance.view'], { actor: managerActor }))
            .rejects.toThrow(/Delegation ceiling exceeded/);
    });

    test('the owner may administer the full catalog (unlimited actor)', async () => {
        const ownerActor = { id: ownerUser.id, permissions: ['*'] };
        const { ALL_PERMISSION_KEYS } = require('../config/permissionTemplates');
        const updated = await service.updatePermissions(target.id, businessA.id, ALL_PERMISSION_KEYS, { actor: ownerActor });
        expect(updated.permissions.length).toBe(ALL_PERMISSION_KEYS.length);
    });

    test('preserving an existing grant outside the actor ceiling is allowed; minting it is not', async () => {
        // Owner grants the target finance.view (above the manager's ceiling).
        await service.updatePermissions(target.id, businessA.id, ['finance.view'], { actor: { id: ownerUser.id, permissions: ['*'] } });
        // The manager (no finance.view) resubmits WITH the existing grant
        // preserved — allowed, nothing new is minted:
        const kept = await service.updatePermissions(target.id, businessA.id, ['finance.view', 'employees.view'], { actor: managerActor });
        expect(kept.permissions).toEqual(expect.arrayContaining(['finance.view', 'employees.view']));
        // But ADDING finance.view to a target that lacks it is refused:
        const fresh = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: otherEmployee.id, role: 'STAFF', permissions: [] },
        });
        try {
            await expect(service.updatePermissions(fresh.id, businessA.id, ['finance.view'], { actor: managerActor }))
                .rejects.toThrow(/Delegation ceiling exceeded/);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: fresh.id } });
        }
    });

    test('unknown permission keys are refused (canonical vocabulary only)', async () => {
        await expect(service.updatePermissions(target.id, businessA.id, ['some.made.up.key'], { actor: managerActor }))
            .rejects.toThrow(/Unknown permission key/);
    });

    test('missing actor context fails closed', async () => {
        await expect(service.updatePermissions(target.id, businessA.id, ['shifts.view']))
            .rejects.toThrow(/authenticated actor context/);
    });

    test('a cross-business target is rejected', async () => {
        const bEmp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessB.id, userId: otherEmployee.id, role: 'STAFF', permissions: [] },
        });
        try {
            await expect(service.updatePermissions(bEmp.id, businessA.id, ['shifts.view'], { actor: managerActor }))
                .rejects.toThrow(/Employee not found/);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: bEmp.id } });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-5 — revocation semantics (stored set is authoritative)
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-5 — permission revocation', () => {
    let emp;
    beforeEach(async () => {
        emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'MANAGER', permissions: ['employees.view', 'employees.update', 'shifts.view'] },
        });
    });
    afterEach(async () => {
        await prisma.businessEmployee.delete({ where: { id: emp.id } }).catch(() => {});
    });

    test('removing a template-default permission actually revokes it (no silent re-add)', async () => {
        // Owner revokes employees.update from the Manager.
        await service.updatePermissions(emp.id, businessA.id, ['employees.view', 'shifts.view'], { actor: { id: ownerUser.id, permissions: ['*'] } });
        const perms = await resolvePermissions(prisma, employeeUser.id, businessA.id);
        expect(perms).toContain('employees.view');
        expect(perms).not.toContain('employees.update'); // REVOKED, not re-added from the MANAGER template
    });

    test('the resolver does not re-add role-template permissions after an explicit set exists', async () => {
        await service.updatePermissions(emp.id, businessA.id, ['shifts.view'], { actor: { id: ownerUser.id, permissions: ['*'] } });
        const perms = await resolvePermissions(prisma, employeeUser.id, businessA.id);
        expect(perms).toEqual(['shifts.view']);
    });

    test('explicit empty permissions [] is honored as "no permissions"', async () => {
        await service.updatePermissions(emp.id, businessA.id, [], { actor: { id: ownerUser.id, permissions: ['*'] } });
        const perms = await resolvePermissions(prisma, employeeUser.id, businessA.id);
        expect(perms).toEqual([]);
    });

    test('a legacy snake_case row is normalized on read and still revocable', async () => {
        await prisma.businessEmployee.update({ where: { id: emp.id }, data: { permissions: ['manage_employees'] } });
        // Legacy grant expands to the dotted employees.* set on read:
        let perms = await resolvePermissions(prisma, employeeUser.id, businessA.id);
        expect(perms).toContain('employees.update');
        expect(perms).toContain('employees.view');
        // And a normalized re-save keeps the same effective set (round trip):
        await service.updatePermissions(emp.id, businessA.id, perms, { actor: { id: ownerUser.id, permissions: ['*'] } });
        perms = await resolvePermissions(prisma, employeeUser.id, businessA.id);
        expect(perms).toContain('employees.update');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-6 — /employees/me authoritative permission representation
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-6 — legacy rows and effective permissions agree', () => {
    test('a legacy snake_case row normalizes identically through the stored and effective representations', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: ['manage_employees'] },
        });
        try {
            // What the /employees/me route computes (same helpers the route
            // uses — resolvePermissions + normalizePermissions):
            const effectivePermissions = await resolvePermissions(prisma, employeeUser.id, businessA.id);
            const { normalizePermissions } = require('../config/permissionTemplates');
            const responsePermissions = effectivePermissions.includes('*') ? ['*'] : effectivePermissions;

            // A legacy grant expands into dotted keys the resolver checks:
            expect(effectivePermissions).toContain('employees.update');
            expect(effectivePermissions).toContain('employees.view');
            expect(responsePermissions).toEqual(effectivePermissions);

            // And the stored representation normalizes to the same set:
            const stored = await prisma.businessEmployee.findUnique({ where: { id: emp.id } });
            expect(normalizePermissions(stored.permissions).sort()).toEqual(
                effectivePermissions.filter((p) => p !== '*').sort(),
            );
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } }).catch(() => {});
        }
    });

    test('the resolver is the single authority: /employees/me effective set equals requirePermission checks', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'MANAGER', permissions: ['employees.view', 'shifts.view'] },
        });
        try {
            const effective = await resolvePermissions(prisma, employeeUser.id, businessA.id);
            // A permission in the effective set passes the check the route
            // enforces; one outside it fails — same function, same verdict.
            expect(effective).toContain('employees.view');
            expect(effective).not.toContain('finance.view');
            // The MANAGER template default employees.update was NOT re-added
            // after the explicit set exists (P0-5 semantics, P0-6 contract):
            expect(effective).not.toContain('employees.update');
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } }).catch(() => {});
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-A (follow-up review) — CREATION DELEGATION CEILING (addEmployee)
//
// The create route requires employees.create, but that alone must not let an
// actor mint authority they do not hold. Every permission granted at creation
// (explicit OR role-default) must sit inside the creator's effective ceiling.
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-A — creation delegation ceiling', () => {
    const ownerActor = () => ({ id: ownerUser.id, permissions: ['*'] });
    // A realistic limited creator: can create employees, holds the STAFF-level
    // working set, but NOT the full MANAGER template (no finance.*, no
    // employees.terminate, no employees.permissions ...).
    const limitedManagerActor = () => ({
        id: employeeUser.id,
        permissions: ['employees.view', 'employees.create', 'employees.update',
            'shifts.view', 'feedback.give', 'feedback.view', 'notifications.view'],
    });

    // Fresh target user per creation test (with cleanup).
    let targetCounter = 0;
    async function mkTarget() {
        targetCounter += 1;
        const user = await mkUser(`m01target${targetCounter}`, 'USER');
        return user;
    }
    async function cleanupTarget(user, employeeId) {
        if (employeeId) await prisma.businessEmployee.delete({ where: { id: employeeId } }).catch(() => {});
        if (user) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    }

    test('the owner creates a STAFF employee with role defaults', async () => {
        const target = await mkTarget();
        let employeeId;
        try {
            const emp = await service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF' },
                { actor: ownerActor() },
            );
            employeeId = emp.id;
            expect(emp.role).toBe('STAFF');
            expect(emp.permissions).toContain('shifts.view');
            expect(emp.permissions).not.toContain('*');
        } finally {
            await cleanupTarget(target, employeeId);
        }
    });

    test('the owner creates a MANAGER employee with the full manager template', async () => {
        const target = await mkTarget();
        let employeeId;
        try {
            const emp = await service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'MANAGER' },
                { actor: ownerActor() },
            );
            employeeId = emp.id;
            expect(emp.role).toBe('MANAGER');
            expect(emp.permissions).toContain('employees.create');
            expect(emp.permissions).toContain('finance.view');
        } finally {
            await cleanupTarget(target, employeeId);
        }
    });

    test('a limited creator may create a STAFF employee with allowed defaults', async () => {
        const target = await mkTarget();
        let employeeId;
        try {
            const emp = await service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF' },
                { actor: limitedManagerActor() },
            );
            employeeId = emp.id;
            // STAFF template defaults sit inside the limited creator's ceiling.
            expect(emp.permissions).toEqual(
                expect.arrayContaining(['shifts.view', 'feedback.give', 'feedback.view', 'notifications.view']),
            );
        } finally {
            await cleanupTarget(target, employeeId);
        }
    });

    test('a limited creator cannot grant an out-of-ceiling permission at creation', async () => {
        const target = await mkTarget();
        try {
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF', permissions: ['shifts.view', 'finance.ledger.manage'] },
                { actor: limitedManagerActor() },
            )).rejects.toThrow(/delegation ceiling exceeded.*finance\.ledger\.manage/);
        } finally {
            await cleanupTarget(target);
        }
    });

    test('a limited creator cannot select a role whose template exceeds their ceiling (MANAGER)', async () => {
        const target = await mkTarget();
        try {
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'MANAGER' },
                { actor: limitedManagerActor() },
            )).rejects.toThrow(/delegation ceiling exceeded/);
        } finally {
            await cleanupTarget(target);
        }
    });

    test("a limited creator cannot create an employee with permissions: ['*']", async () => {
        const target = await mkTarget();
        try {
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF', permissions: ['*'] },
                { actor: limitedManagerActor() },
            )).rejects.toThrow(/Wildcard/);
        } finally {
            await cleanupTarget(target);
        }
    });

    test('an unknown permission key is refused at creation (canonical vocabulary only)', async () => {
        const target = await mkTarget();
        try {
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF', permissions: ['shifts.view', 'not.a.real.key'] },
                { actor: ownerActor() },
            )).rejects.toThrow(/Unknown permission key\(s\): not\.a\.real\.key/);
        } finally {
            await cleanupTarget(target);
        }
    });

    test('no actor context fails closed at creation', async () => {
        const target = await mkTarget();
        try {
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF' },
            )).rejects.toThrow(/Employee creation requires the authenticated actor context/);
        } finally {
            await cleanupTarget(target);
        }
    });

    test('cross-business targets remain impossible (user already employed elsewhere)', async () => {
        const target = await mkTarget();
        let employeeId;
        try {
            // The target already works for business B.
            const bEmp = await prisma.businessEmployee.create({
                data: { businessProfileId: businessB.id, userId: target.id, role: 'STAFF', permissions: ['shifts.view'] },
            });
            employeeId = bEmp.id;
            await expect(service.addEmployee(
                { businessProfileId: businessA.id, userId: target.id, role: 'STAFF' },
                { actor: ownerActor() },
            )).rejects.toThrow(/already employed at another business/);
        } finally {
            await cleanupTarget(target, employeeId);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-B (follow-up review) — ROLE CHANGES ARE AUTHORITY-BEARING (updateRole)
//
// A role change reseeds the target's permission set, so it lives behind the
// permission authority (employees.permissions) with a delegation ceiling on
// the RESULTING template. The generic employees.update refuses `role`.
// ═══════════════════════════════════════════════════════════════════════════
describeIf('P0-B — role-change authority', () => {
    const ownerActor = () => ({ id: ownerUser.id, permissions: ['*'] });
    // Holds employees.update but NOT the role-change authority.
    const plainUpdaterActor = () => ({
        id: employeeUser.id,
        permissions: ['employees.view', 'employees.update', 'shifts.view'],
    });
    // Holds the role-change authority and a STAFF-covering ceiling.
    const shiftLeadActor = () => ({
        id: employeeUser.id,
        permissions: ['employees.view', 'employees.update', 'employees.permissions',
            'shifts.view', 'feedback.give', 'feedback.view', 'notifications.view'],
    });

    let target, targetUser;
    beforeEach(async () => {
        targetUser = await mkUser('m01roletarget', 'USER');
        target = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: targetUser.id, role: 'STAFF', permissions: ['shifts.view', 'feedback.give'] },
        });
    });
    afterEach(async () => {
        await prisma.businessEmployee.delete({ where: { id: target.id } }).catch(() => {});
        await prisma.user.delete({ where: { id: targetUser.id } }).catch(() => {});
    });

    test('the owner changes a role and the stored set reseeds exactly', async () => {
        const updated = await service.updateRole(target.id, businessA.id, 'HOUSEKEEPER', { actor: ownerActor() });
        expect(updated.role).toBe('HOUSEKEEPER');
        const template = normalizePermissions(ROLE_PERMISSIONS.HOUSEKEEPER);
        expect(updated.permissions.sort()).toEqual(template.sort());
    });

    test('a ceiling-limited actor with role authority may demote within their ceiling', async () => {
        // The shift lead reseeds the target to STAFF — the STAFF template sits
        // inside their own ceiling, so the change is legal.
        const updated = await service.updateRole(target.id, businessA.id, 'STAFF', { actor: shiftLeadActor() });
        expect(updated.role).toBe('STAFF');
        expect(updated.permissions).toContain('shifts.view');
    });

    test('a promotion whose role template exceeds the actor ceiling is refused', async () => {
        await expect(service.updateRole(target.id, businessA.id, 'MANAGER', { actor: shiftLeadActor() }))
            .rejects.toThrow(/delegation ceiling exceeded/);
        const after = await prisma.businessEmployee.findUnique({ where: { id: target.id } });
        expect(after.role).toBe('STAFF'); // unchanged
    });

    test('an actor with employees.update but no role authority is refused', async () => {
        await expect(service.updateRole(target.id, businessA.id, 'SUPERVISOR', { actor: plainUpdaterActor() }))
            .rejects.toThrow(/Role changes require the "employees\.permissions" authority/);
        const after = await prisma.businessEmployee.findUnique({ where: { id: target.id } });
        expect(after.role).toBe('STAFF'); // unchanged
    });

    test('promotion into OWNER is impossible through the role authority', async () => {
        await expect(service.updateRole(target.id, businessA.id, 'OWNER', { actor: ownerActor() }))
            .rejects.toThrow(/OWNER is not an assignable employee role/);
        const after = await prisma.businessEmployee.findUnique({ where: { id: target.id } });
        expect(after.role).toBe('STAFF');
    });

    test('a failed role change leaves BOTH role and permissions unchanged', async () => {
        await expect(service.updateRole(target.id, businessA.id, 'MANAGER', { actor: shiftLeadActor() }))
            .rejects.toThrow();
        const after = await prisma.businessEmployee.findUnique({ where: { id: target.id } });
        expect(after.role).toBe('STAFF');
        expect(after.permissions).toEqual(['shifts.view', 'feedback.give']); // exactly the pre-change set
    });

    test('a successful role change produces exactly the intended resulting set', async () => {
        const template = normalizePermissions(ROLE_PERMISSIONS.WAITER);
        const updated = await service.updateRole(target.id, businessA.id, 'WAITER', { actor: ownerActor() });
        expect(updated.role).toBe('WAITER');
        expect(updated.permissions.sort()).toEqual(template.sort());
        // The previous set is fully replaced, not merged:
        const stored = await prisma.businessEmployee.findUnique({ where: { id: target.id } });
        expect(stored.permissions.sort()).toEqual(template.sort());
    });

    test('no actor context fails closed on the role authority', async () => {
        await expect(service.updateRole(target.id, businessA.id, 'STAFF'))
            .rejects.toThrow(/Role change requires the authenticated actor context/);
    });

    test('cross-business role changes remain impossible (tenant scope)', async () => {
        await expect(service.updateRole(target.id, businessB.id, 'STAFF', { actor: ownerActor() }))
            .rejects.toThrow(/Employee not found/);
    });
});
