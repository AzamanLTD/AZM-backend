// __tests__/business-permissions-catalog.test.js
// =============================================================================
// Module 01 — Permissions system (business portal governance)
//
// Module 01 closed three real defects:
//   1. Vocabulary split: routes check dotted keys ("employees.manage") while
//      EmployeeService seeded legacy snake_case strings ("manage_employees")
//      that never matched — every non-owner employee failed ALL permission
//      checks. Fixed via dotted defaults + normalizePermissions().
//   2. Role-template lookup miss: resolvePermissions() looked templates up by
//      EmployeeRole enum values (MANAGER, STAFF, ...) in ROLE_TEMPLATES, which
//      is keyed by portal roles (GENERAL_MANAGER, BRANCH_MANAGER, ...) — so
//      template defaults NEVER applied. Fixed via EMPLOYEE_ROLE_TEMPLATES.
//   3. No drift guard: requirePermission() keys were free-form strings.
//      Now every route key must exist in the canonical catalog.
// =============================================================================
const fs = require('fs');
const path = require('path');

const {
    ALL_KEYS,
    EMPLOYEE_ROLE_TEMPLATES,
    LEGACY_ALIASES,
    normalizePermissions,
} = require('../config/permissionTemplates');

const EMPLOYEE_ROLES = [
    'OWNER', 'MANAGER', 'SUPERVISOR', 'STAFF', 'DRIVER',
    'HOUSEKEEPER', 'WAITER', 'CHEF', 'RECEPTIONIST', 'CONCIERGE', 'SECURITY',
];

describe('Module 01 — permissions catalog', () => {
    describe('normalization', () => {
        test('legacy snake_case strings expand to their dotted equivalents', () => {
            expect(normalizePermissions(['manage_employees'])).toEqual([
                'employees.view', 'employees.create', 'employees.update', 'employees.terminate',
            ]);
        });

        test('a legacy manager grant now authorizes the manager route keys', () => {
            const dotted = normalizePermissions(['manage_employees', 'view_finance', 'process_payroll']);
            expect(dotted).toContain('employees.update');
            expect(dotted).toContain('finance.view');
            expect(dotted).toContain('payroll.process');
        });

        test('dotted keys pass through untouched and dedupe', () => {
            expect(normalizePermissions(['finance.view', 'finance.view', 'shifts.view']))
                .toEqual(['finance.view', 'shifts.view']);
        });

        test('unknown strings pass through unchanged (never granted, never crash)', () => {
            expect(normalizePermissions(['some_unknown_permission'])).toEqual(['some_unknown_permission']);
        });

        test('wildcard collapses everything to ["*"]', () => {
            expect(normalizePermissions(['finance.view', '*', 'shifts.view'])).toEqual(['*']);
        });

        test('non-array input yields []', () => {
            expect(normalizePermissions(undefined)).toEqual([]);
            expect(normalizePermissions(null)).toEqual([]);
            expect(normalizePermissions('finance.view')).toEqual([]);
        });

        test('every legacy alias expands only to known dotted keys (or wildcard)', () => {
            for (const [legacy, dotted] of Object.entries(LEGACY_ALIASES)) {
                for (const key of dotted) {
                    if (key === '*') continue; // wildcard is not a catalog key
                    expect(ALL_KEYS).toContain(key);
                }
            }
        });
    });

    describe('employee-role templates', () => {
        test('every EmployeeRole enum value has a template', () => {
            for (const role of EMPLOYEE_ROLES) {
                expect(EMPLOYEE_ROLE_TEMPLATES[role]).toBeDefined();
                expect(Array.isArray(EMPLOYEE_ROLE_TEMPLATES[role].permissions)).toBe(true);
            }
        });

        test('every template permission is a known catalog key (or wildcard)', () => {
            for (const role of EMPLOYEE_ROLES) {
                for (const perm of EMPLOYEE_ROLE_TEMPLATES[role].permissions) {
                    if (perm === '*') continue; // OWNER wildcard
                    expect(ALL_KEYS).toContain(perm);
                }
            }
        });

        test('MANAGER defaults actually authorize the routes MANAGERS use', () => {
            const m = EMPLOYEE_ROLE_TEMPLATES.MANAGER.permissions;
            expect(m).toContain('employees.create');
            expect(m).toContain('employees.update');
            expect(m).toContain('employees.terminate');
            expect(m).toContain('employees.permissions');
            expect(m).toContain('shifts.create');
            expect(m).toContain('shifts.approve_swap');
            expect(m).toContain('shifts.approve_timeoff');
            expect(m).toContain('payroll.process');
            expect(m).toContain('finance.view');
        });

        test('STAFF defaults cannot touch employer-only surfaces', () => {
            const s = EMPLOYEE_ROLE_TEMPLATES.STAFF.permissions;
            expect(s).not.toContain('employees.create');
            expect(s).not.toContain('employees.permissions');
            expect(s).not.toContain('payroll.process');
            expect(s).not.toContain('finance.view');
        });
    });

    describe('route-key drift guard — every requirePermission key must be in the catalog', () => {
        test('no route checks a permission key unknown to the catalog', () => {
            const routesDir = path.join(__dirname, '..', 'routes');
            const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
            expect(files.length).toBeGreaterThan(0);

            const keyRe = /requirePermission\('([^']+)'\)/g;
            const unknown = [];
            for (const file of files) {
                const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
                let match;
                while ((match = keyRe.exec(src)) !== null) {
                    if (!ALL_KEYS.includes(match[1])) {
                        unknown.push(`${file}: ${match[1]}`);
                    }
                }
            }
            expect(unknown).toEqual([]);
        });
    });
});

describe('Module 01 — resolvePermissions behavior (unit, mocked prisma)', () => {
    const { requirePermission } = require('../middleware/requirePermission');

    // r26: the middleware now resolves the business context AUTHORITATIVELY:
    // a non-owner user resolves through their ACTIVE employment row
    // (businessEmployee.findFirst), then permissions resolve from the same
    // row via findUnique. The mocks mirror a real employee of business-a
    // whose BusinessProfile is owned by user 999.
    const makePrismaWithEmployee = (employee) => ({
        businessProfile: {
            findFirst: jest.fn().mockImplementation(({ where }) => {
                if (where.userId) return Promise.resolve(null); // not an owner
                return Promise.resolve({ id: where.id, userId: 999 });
            }),
        },
        businessEmployee: {
            findFirst: jest.fn().mockResolvedValue({
                businessProfileId: 'business-a',
                businessProfile: { id: 'business-a' },
            }),
            findUnique: jest.fn().mockResolvedValue(employee),
        },
    });

    const invoke = (key, prisma) => new Promise((resolve) => {
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        // Denial returns via res.json without calling next(); allow both ends.
        const settle = (allowed) => () => resolve({ allowed, res });
        res.json.mockImplementation(() => resolve({ allowed: false, res }));
        requirePermission(key)({
            user: { id: 202, role: 'USER' },
            app: { get: jest.fn().mockReturnValue(prisma) },
        }, res, () => { resolve({ allowed: true, res }); });
        void settle;
    });

    test('a MANAGER row SEEDED with template defaults passes employees.create (creation-time seeding)', async () => {
        const seeded = EMPLOYEE_ROLE_TEMPLATES.MANAGER.permissions;
        const prisma = makePrismaWithEmployee({ permissions: seeded, status: 'ACTIVE', role: 'MANAGER' });
        const { allowed, res } = await invoke('employees.create', prisma);
        expect(allowed).toBe(true);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('r26: an EXPLICIT empty set on a MANAGER row has no permissions (stored set is authoritative)', async () => {
        const prisma = makePrismaWithEmployee({ permissions: [], status: 'ACTIVE', role: 'MANAGER' });
        const { allowed, res } = await invoke('employees.create', prisma);
        expect(allowed).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('a STAFF role employee is denied employees.create', async () => {
        const prisma = makePrismaWithEmployee({ permissions: [], status: 'ACTIVE', role: 'STAFF' });
        const { allowed, res } = await invoke('employees.create', prisma);
        expect(allowed).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requiredPermission: 'employees.create' }));
    });

    test('legacy DB rows ("manage_employees") still authorize "employees.update"', async () => {
        const prisma = makePrismaWithEmployee({
            permissions: ['manage_employees'], status: 'ACTIVE', role: 'STAFF',
        });
        const { allowed, res } = await invoke('employees.update', prisma);
        expect(allowed).toBe(true);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('suspended employees have no permissions even with wildcard', async () => {
        const prisma = makePrismaWithEmployee({ permissions: ['*'], status: 'SUSPENDED', role: 'MANAGER' });
        const { allowed, res } = await invoke('shifts.view', prisma);
        expect(allowed).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('r26: the explicit stored set REPLACES template defaults (revocation is real)', async () => {
        const prisma = makePrismaWithEmployee({
            permissions: ['finance.ledger.manage'], status: 'ACTIVE', role: 'SUPERVISOR',
        });
        // SUPERVISOR's template default shifts.approve_swap was explicitly
        // removed from the stored set — the resolver must NOT re-add it:
        const a = await invoke('shifts.approve_swap', prisma);
        const b = await invoke('finance.ledger.manage', prisma);
        expect(a.allowed).toBe(false);
        expect(b.allowed).toBe(true);
    });
});

describe('Module 01 — EmployeeService permission storage', () => {
    const { EmployeeService } = require('../services/businessOS/employeeService');

    const makePrisma = () => ({
        businessEmployee: {
            findUnique: jest.fn().mockResolvedValue(null),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'emp-1' }),
            update: jest.fn().mockResolvedValue({ id: 'emp-1' }),
        },
        user: { findUnique: jest.fn().mockResolvedValue({ id: 42, username: 'kofi' }) },
    });

    test('addEmployee stores dotted defaults for MANAGER', async () => {
        const prisma = makePrisma();
        const svc = new EmployeeService(prisma);
        await svc.addEmployee({ businessProfileId: 'b1', userId: 42, role: 'MANAGER' });
        const stored = prisma.businessEmployee.create.mock.calls[0][0].data.permissions;
        expect(stored).toContain('employees.create');
        expect(stored).toContain('payroll.process');
    });

    test('addEmployee normalizes explicitly supplied legacy permissions', async () => {
        const prisma = makePrisma();
        const svc = new EmployeeService(prisma);
        await svc.addEmployee({
            businessProfileId: 'b1', userId: 42, role: 'STAFF',
            permissions: ['manage_reservations'],
        });
        const stored = prisma.businessEmployee.create.mock.calls[0][0].data.permissions;
        expect(stored).toEqual(['reservations.manage']);
    });

    test('r26: updateEmployee REFUSES a permissions PATCH (dedicated authority)', async () => {
        const prisma = makePrisma();
        prisma.businessEmployee.findFirst.mockResolvedValue({ id: 'emp-1' });
        const svc = new EmployeeService(prisma);
        await expect(svc.updateEmployee('emp-1', 'b1', { permissions: ['approve_swaps', 'approve_swaps'] }))
            .rejects.toThrow(/dedicated permission authority/);
        expect(prisma.businessEmployee.update).not.toHaveBeenCalled();
    });

    test('addEmployee resolves an AZM-ID handle (@username) to the real user', async () => {
        const prisma = makePrisma();
        prisma.user.findUnique
            .mockResolvedValueOnce({ id: 77, username: 'ama' })   // username lookup
            .mockResolvedValueOnce({ id: 77, username: 'ama' });  // post-guard findUnique
        prisma.businessEmployee.findUnique.mockResolvedValue(null);
        prisma.businessEmployee.findFirst.mockResolvedValue(null);
        const svc = new EmployeeService(prisma);
        await svc.addEmployee({ businessProfileId: 'b1', azmId: '@ama', role: 'STAFF' });
        expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { username: 'ama' } });
        const data = prisma.businessEmployee.create.mock.calls[0][0].data;
        expect(data.userId).toBe(77);
    });

    test('addEmployee throws an honest error for an unknown AZM-ID', async () => {
        const prisma = makePrisma();
        prisma.user.findUnique.mockResolvedValue(null);
        const svc = new EmployeeService(prisma);
        await expect(svc.addEmployee({ businessProfileId: 'b1', azmId: 'nobody' }))
            .rejects.toThrow('No Azaman account found for "nobody".');
    });

    test('hasPermission honors legacy rows and rejects invalid employees', () => {
        const svc = new EmployeeService({});
        expect(svc.hasPermission({ permissions: ['manage_shifts'] }, 'shifts.update')).toBe(true);
        expect(svc.hasPermission({ permissions: ['shifts.view'] }, 'shifts.update')).toBe(false);
        expect(svc.hasPermission({ permissions: ['*'] }, 'anything.at.all')).toBe(true);
        expect(svc.hasPermission(null, 'shifts.view')).toBe(false);
        expect(svc.hasPermission({ permissions: undefined }, 'shifts.view')).toBe(false);
    });
});
