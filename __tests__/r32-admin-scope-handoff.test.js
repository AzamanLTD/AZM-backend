// __tests__/r32-admin-scope-handoff.test.js
// =============================================================================
// r32 audit item A — ADMIN BUSINESS-SCOPE AUTHORITY: the middleware →
// requirePermission handoff, proven end-to-end against real PostgreSQL.
//
// Historical defect: adminBusinessScope.js set req.adminScopedBusiness while
// requirePermission.js read req.adminBusinessScope — the contract mismatch
// silently disabled the entire admin Business OS impersonation path.
//
// Canonical contract (fixed in this round):
//   • middleware sets EXACTLY ONE property: req.adminBusinessScope =
//     { businessProfileId, business } — and does NOT write req.businessProfileId.
//   • requirePermission / banGuard / businessOSRoutes read that canonical
//     property, re-validate ADMIN role + business existence, and derive
//     req.businessProfileId, req.businessContext, req.resolvedPermissions
//     and isAdminImpersonation from it.
//
// Proofs (mirroring the review brief):
//   1. admin + valid scoped business → ['*'] + correct business context
//   2. admin + nonexistent business → no scoped context
//   3. ordinary user + admin header → header ignored
//   4. employee + admin header → employee's authoritative business remains
//   5. owner + admin header → normal owner context (unless user IS ADMIN)
//   6. middleware and requirePermission use the same durable scope property
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { adminBusinessScope } = require('../middleware/adminBusinessScope');
const { requirePermission } = require('../middleware/requirePermission');

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[r32-scope-handoff] TEST_DATABASE_URL not set — skipping.');
const describeIf = hasDb ? describe : describe.skip;

let prisma;
let adminUser, plainOwner, employeeUser, otherOwner, adminOwner;
let businessA, businessB; // businessA: plainOwner; businessB: otherOwner

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

// Build a request that mirrors the real global chain: the scope middleware is
// app-level (before per-route `protect`), so production requests arrive with
// only headers; `protect` later attaches req.user. Both shapes are exercised.
function makeReq({ user = null, token = null, headers = {} }) {
    const authorization = token ? `Bearer ${token}` : undefined;
    return {
        user,
        headers: { ...(authorization ? { authorization } : {}), ...headers },
        app: { get: (k) => (k === 'prisma' ? prisma : undefined) },
        method: 'GET',
        path: '/api/business-os/shifts',
        params: {},
    };
}

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(b) { this.body = b; return this; },
    };
}

function runScope(req) {
    return new Promise((resolve) => {
        adminBusinessScope(req, makeRes(), () => resolve());
    });
}

function runPermission(key, req) {
    // Deterministic: the middleware EITHER calls next() (allowed) OR writes a
    // response via res.json() (denied/failed). Whichever happens first wins.
    return new Promise((resolve) => {
        let settled = false;
        const res = makeRes();
        res.json = (b) => { res.body = b; if (!settled) { settled = true; resolve({ allowed: false, res }); } return res; };
        requirePermission(key)(req, res, () => {
            if (!settled) { settled = true; resolve({ allowed: true, res }); }
        });
    });
}

// The full chain exactly as production orders it: global scope middleware,
// then requirePermission on the SAME request object.
async function runChain({ user, token, headers, key = 'shifts.view' }) {
    const req = makeReq({ user, token, headers });
    await runScope(req);
    const result = await runPermission(key, req);
    return { req, ...result };
}

beforeAll(async () => {
    prisma = new PrismaClient();
    adminUser = await mkUser('r32admin', 'ADMIN');
    plainOwner = await mkUser('r32powner');
    employeeUser = await mkUser('r32emp', 'USER');
    otherOwner = await mkUser('r32oowner');
    adminOwner = await mkUser('r32aowner', 'ADMIN'); // a genuine ADMIN who owns a business
    businessA = await mkBusiness(plainOwner, 'R32 Scope Biz A');
    businessB = await mkBusiness(otherOwner, 'R32 Scope Biz B');
});

afterAll(async () => {
    const users = [adminUser, plainOwner, employeeUser, otherOwner, adminOwner].filter(Boolean);
    if (users.length) {
        const ids = users.map((u) => u.id);
        await prisma.businessEmployee.deleteMany({ where: { userId: { in: ids } } });
        await prisma.businessProfile.deleteMany({ where: { userId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
});

describeIf('r32 A — admin business-scope handoff (middleware → requirePermission)', () => {
    test('1. admin + valid scoped business → ["*"], correct business context, impersonation flagged', async () => {
        // Real production shape: no req.user yet, JWT in the Authorization
        // header, business id in x-admin-business-id.
        const token = jwt.sign({ id: adminUser.id, role: 'ADMIN' }, process.env.JWT_SECRET || 'test_secret_exactly_32_characters_long');
        const { req, allowed, res } = await runChain({
            token,
            headers: { 'x-admin-business-id': businessA.id },
            key: 'shifts.view',
        });

        expect(allowed).toBe(true);
        expect(res.statusCode).toBeNull();
        expect(req.adminBusinessScope).toMatchObject({ businessProfileId: businessA.id });
        expect(req.businessProfileId).toBe(businessA.id);
        expect(req.businessContext).toMatchObject({
            businessProfileId: businessA.id,
            isAdminImpersonation: true,
            isBusinessOwner: false,
            isEmployee: false,
        });
        expect(req.resolvedPermissions).toEqual(['*']);
        // The scoped context is the admin's chosen business, NOT an owned one.
        expect(req.businessContext.businessProfileId).not.toBe(businessB.id);
    });

    test('2. admin + nonexistent business → no scoped context (403, no fallback scope)', async () => {
        const { req, allowed, res } = await runChain({
            user: { id: adminUser.id, role: 'ADMIN' },
            headers: { 'x-admin-business-id': 'does-not-exist-9999' },
            key: 'shifts.view',
        });

        expect(req.adminBusinessScope).toBeUndefined();
        // This admin owns no business and is employed nowhere → no context.
        expect(allowed).toBe(false);
        expect(res.statusCode).toBe(403);
    });

    test('3. ordinary user + admin header → header completely ignored', async () => {
        const { req, allowed } = await runChain({
            user: { id: plainOwner.id, role: 'VENDOR' },
            headers: { 'x-admin-business-id': businessB.id }, // not their business
            key: 'shifts.view',
        });

        expect(req.adminBusinessScope).toBeUndefined();
        expect(allowed).toBe(true);
        // Resolved to their OWN business — the header did NOT grant B.
        expect(req.businessProfileId).toBe(businessA.id);
        expect(req.businessContext.isAdminImpersonation).toBe(false);
        expect(req.businessContext.isBusinessOwner).toBe(true);
    });

    test('4. employee + admin header → their authoritative employment business remains in force', async () => {
        const emp = await prisma.businessEmployee.create({
            data: { businessProfileId: businessA.id, userId: employeeUser.id, role: 'STAFF', permissions: ['shifts.view'] },
        });
        try {
            const { req, allowed } = await runChain({
                user: { id: employeeUser.id, role: 'USER' },
                headers: { 'x-admin-business-id': businessB.id },
                key: 'shifts.view',
            });

            expect(allowed).toBe(true);
            expect(req.businessProfileId).toBe(businessA.id); // own employment
            expect(req.businessContext.isAdminImpersonation).toBe(false);
            expect(req.businessContext.isEmployee).toBe(true);
            expect(req.resolvedPermissions).toEqual(['shifts.view']);
        } finally {
            await prisma.businessEmployee.delete({ where: { id: emp.id } });
        }
    });

    test('5a. non-admin owner + admin header → normal owner context', async () => {
        const { req, allowed } = await runChain({
            user: { id: plainOwner.id, role: 'VENDOR' },
            headers: { 'x-admin-business-id': businessB.id },
            key: 'retail.manage',
        });
        expect(allowed).toBe(true);
        expect(req.businessProfileId).toBe(businessA.id);
        expect(req.businessContext.isBusinessOwner).toBe(true);
        expect(req.businessContext.isAdminImpersonation).toBe(false);
    });

    test('5b. ADMIN who owns a business + admin header → impersonation of the chosen business', async () => {
        // An authenticated ADMIN may scope to ANY real business — including
        // their own — and the resolved context is the one they selected.
        const ownedBiz = await mkBusiness(adminOwner, 'R32 AdminOwned');
        try {
            const { req, allowed } = await runChain({
                user: { id: adminOwner.id, role: 'ADMIN' },
                headers: { 'x-admin-business-id': ownedBiz.id },
                key: 'retail.manage',
            });
            expect(allowed).toBe(true);
            expect(req.businessContext.isAdminImpersonation).toBe(true);
            expect(req.businessProfileId).toBe(ownedBiz.id);
            expect(req.resolvedPermissions).toEqual(['*']);
        } finally {
            await prisma.businessProfile.delete({ where: { id: ownedBiz.id } });
        }
    });

    test('6. the middleware writes EXACTLY ONE canonical scope property', async () => {
        // The old defect: middleware wrote req.adminScopedBusiness while the
        // consumer read req.adminBusinessScope. The fixed contract has one
        // property, and the middleware no longer writes req.businessProfileId
        // — requirePermission derives it at the authoritative boundary.
        const req = makeReq({
            user: { id: adminUser.id, role: 'ADMIN' },
            headers: { 'x-admin-business-id': businessA.id },
        });
        await runScope(req);

        expect(req.adminBusinessScope).toMatchObject({ businessProfileId: businessA.id, business: expect.objectContaining({ id: businessA.id }) });
        expect(req.adminScopedBusiness).toBeUndefined(); // legacy property is GONE
        expect(req.businessProfileId).toBeUndefined(); // derived later, by requirePermission
    });

    test('6b. a non-admin JWT cannot manufacture scope through the header (full JWT path)', async () => {
        const token = jwt.sign({ id: plainOwner.id, role: 'VENDOR' }, process.env.JWT_SECRET || 'test_secret_exactly_32_characters_long');
        const { req, allowed } = await runChain({
            token,
            headers: { 'x-admin-business-id': businessB.id },
            key: 'shifts.view',
        });

        expect(req.adminBusinessScope).toBeUndefined();
        expect(allowed).toBe(true);
        expect(req.businessProfileId).toBe(businessA.id);
        expect(req.businessContext.isAdminImpersonation).toBe(false);
    });

    test('admin without the header resolves no impersonation (scope is opt-in per request)', async () => {
        const { req, allowed, res } = await runChain({
            user: { id: adminUser.id, role: 'ADMIN' },
            headers: {},
            key: 'shifts.view',
        });
        expect(req.adminBusinessScope).toBeUndefined();
        expect(allowed).toBe(false);
        expect(res.statusCode).toBe(403);
    });
});
