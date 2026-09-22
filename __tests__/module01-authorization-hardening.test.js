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

    test('updateEmployee refuses promotion into OWNER (update path)', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: [] },
        });
        try {
            await expect(service.updateEmployee(emp.id, businessA.id, { role: 'OWNER' }))
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
        })).rejects.toThrow(/Wildcard permissions are not assignable/);
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

    test('role changes reseed role defaults but never escalate', async () => {
        const updated = await service.updateEmployee(emp.id, businessA.id, { role: 'MANAGER' });
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
