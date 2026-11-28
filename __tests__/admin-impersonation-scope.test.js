// __tests__/admin-impersonation-scope.test.js
// =============================================================================
// Acting AS a business through x-admin-business-id is scoped by the acting
// admin's EFFECTIVE role (database state), not by the ADMIN-role JWT claim.
//
//   • SUPER_ADMIN / legacy ADMIN (no specialised assignment): full access.
//   • Specialised roles (finance, support, compliance, read-only): reads only;
//     every mutation (payroll, EWA, ledger, refunds, payouts) is refused 403.
//   • No resolvable role: refused.
//   • Role resolution failure: 503, never an allow.
// =============================================================================
'use strict';

const rbac = require('../controllers/adminRbacController');
const { requirePermission } = require('../middleware/requirePermission');

function run({ method = 'POST', role }) {
    const spy = jest.spyOn(rbac, 'resolveEffectiveAdminRole');
    if (role instanceof Error) spy.mockRejectedValue(role); else spy.mockResolvedValue(role);
    const prisma = {
        businessProfile: { findFirst: jest.fn(async () => ({ id: 'biz-1', userId: 77 })) },
    };
    const req = {
        method,
        path: '/payroll/disburse',
        originalUrl: '/api/business-os/payroll/disburse',
        user: { id: 5, role: 'ADMIN' },
        adminBusinessScope: { businessProfileId: 'biz-1' },
        app: { get: () => prisma },
        params: {},
    };
    const res = {
        statusCode: null, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    let passed = false;
    return requirePermission('payroll.manage')(req, res, () => { passed = true; })
        .then(() => ({ req, res, passed }));
}

afterEach(() => jest.restoreAllMocks());

test.each(['SUPER_ADMIN', 'ADMIN'])('%s keeps full access to mutate', async (role) => {
    const { req, passed } = await run({ role });
    expect(passed).toBe(true);
    expect(req.resolvedPermissions).toEqual(['*']);
});

test.each(['READ_ONLY_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'COMPLIANCE_ADMIN'])(
    '%s cannot mutate a business it impersonates', async (role) => {
        const { res, passed } = await run({ role });
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('ADMIN_IMPERSONATION_FORBIDDEN');
    },
);

test('a specialised role may still read', async () => {
    const { req, passed } = await run({ role: 'READ_ONLY_ADMIN', method: 'GET' });
    expect(passed).toBe(true);
    expect(req.resolvedPermissions).toEqual([]);
});

test('no resolvable admin role is refused, even for reads', async () => {
    const { res, passed } = await run({ role: null, method: 'GET' });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
});

test('a resolution failure is 503, never an allow', async () => {
    const { res, passed } = await run({ role: new Error('db down') });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(503);
});
