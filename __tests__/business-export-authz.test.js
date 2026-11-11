// __tests__/business-export-authz.test.js
// =============================================================================
// Route-level proof for the AUTHORIZATION boundary on GET /api/business-os/export.
//
// business-export-route.test.js mocks requirePermission and authMiddleware, so it
// proves the handler and the archive but not that `settings.manage` is enforced,
// nor that the tenant is derived from the user's own relationships.
//
// This file mounts the REAL router with the REAL middleware: real `protect`
// (signature + live-user check), real `protectActive`, real `requirePermission`
// (context resolution + permission resolution). Only Prisma is stubbed, because
// the point is the authorization contract, not the database.
// =============================================================================

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-for-export-authz';

jest.mock('../src/config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

// ── Fixtures: two separate tenants ─────────────────────────────────────────
const OWNER = { id: 1, tokenVersion: 0, banStatus: 'ACTIVE', isDeleted: false };
const EMPLOYEE_ALLOWED = { id: 2, tokenVersion: 0, banStatus: 'ACTIVE', isDeleted: false };
const EMPLOYEE_DENIED = { id: 3, tokenVersion: 0, banStatus: 'ACTIVE', isDeleted: false };
const NO_BUSINESS = { id: 4, tokenVersion: 0, banStatus: 'ACTIVE', isDeleted: false };
const ATTACKER = { id: 5, tokenVersion: 0, banStatus: 'ACTIVE', isDeleted: false };

const BIZ_A = { id: 'biz-A', userId: 1, name: 'Alpha Traders' };
const BIZ_B = { id: 'biz-B', userId: 99, name: 'Beta Holdings' };

const EMPLOYMENTS = {
    'biz-A:2': { businessProfileId: 'biz-A', userId: 2, status: 'ACTIVE', role: 'MANAGER', permissions: ['settings.manage', 'employees.read'] },
    'biz-B:2': null,
    'biz-A:3': { businessProfileId: 'biz-A', userId: 3, status: 'ACTIVE', role: 'STAFF', permissions: ['orders.read'] },
    'biz-A:5': { businessProfileId: 'biz-A', userId: 5, status: 'ACTIVE', role: 'STAFF', permissions: ['settings.manage'] },
};

const USERS = { 1: OWNER, 2: EMPLOYEE_ALLOWED, 3: EMPLOYEE_DENIED, 4: NO_BUSINESS, 5: ATTACKER };

function buildPrisma() {
    const calls = { findMany: [] };
    const prisma = {
        user: {
            findUnique: jest.fn(async ({ where }) => {
                const u = USERS[where.id];
                return u ? { tokenVersion: u.tokenVersion, banStatus: u.banStatus, isDeleted: u.isDeleted } : null;
            }),
        },
        businessProfile: {
            // resolveBusinessContext: owner lookup by userId
            findFirst: jest.fn(async ({ where }) => {
                if (where.userId !== undefined) {
                    const owned = [BIZ_A, BIZ_B].find((b) => b.userId === where.userId);
                    return owned ? { id: owned.id, userId: owned.userId } : null;
                }
                // resolvePermissions: owner check by business id
                const biz = [BIZ_A, BIZ_B].find((b) => b.id === where.id);
                return biz ? { userId: biz.userId } : null;
            }),
            findUnique: jest.fn(async ({ where }) => [BIZ_A, BIZ_B].find((b) => b.id === where.id) || null),
        },
        businessEmployee: {
            findFirst: jest.fn(async ({ where }) => {
                if (!where.userId) return null;
                const key = Object.keys(EMPLOYMENTS).find((k) => k.endsWith(`:${where.userId}`) && EMPLOYMENTS[k]);
                return key ? { businessProfileId: EMPLOYMENTS[key].businessProfileId, businessProfile: { id: EMPLOYMENTS[key].businessProfileId } } : null;
            }),
            findUnique: jest.fn(async ({ where }) => {
                const w = where.businessProfileId_userId || {};
                return EMPLOYMENTS[`${w.businessProfileId}:${w.userId}`] || null;
            }),
            findMany: jest.fn(async ({ where }) => {
                calls.findMany.push(['businessEmployee', where]);
                return [{ id: 'emp-1', businessProfileId: where.businessProfileId }];
            }),
        },
    };
    for (const model of ['businessOrder', 'businessInvoice', 'businessReview', 'businessProduct']) {
        prisma[model] = {
            findMany: jest.fn(async ({ where }) => {
                calls.findMany.push([model, where]);
                return [{ id: `${model}-in-${where.businessProfileId}`, businessProfileId: where.businessProfileId }];
            }),
        };
    }
    return { prisma, calls };
}

function buildApp(prisma) {
    // The router itself applies protect + protectActive and the route applies
    // requirePermission. Nothing here is a stand-in for the real boundary.
    const app = express();
    app.set('prisma', prisma);
    app.use(express.json());
    app.use('/api/business-os', require('../routes/businessOSRoutes'));
    return app;
}

const tokenFor = (user, extra = {}) => jwt.sign({ id: user.id, tokenVersion: user.tokenVersion, ...extra }, SECRET);

describe('export authorization — real middleware', () => {
    test('an unauthenticated request is refused before the handler', async () => {
        const { prisma } = buildPrisma();
        const res = await request(buildApp(prisma)).get('/api/business-os/export');
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/No Bearer token found/);
        expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
    });

    test('a token signed with the wrong secret is refused', async () => {
        const { prisma } = buildPrisma();
        const forged = jwt.sign({ id: 1, tokenVersion: 0 }, 'not-the-secret');
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .set('Authorization', `Bearer ${forged}`);
        expect(res.status).toBe(401);
        expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
    });

    test('an authenticated user with no business context is refused with 403', async () => {
        const { prisma } = buildPrisma();
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .set('Authorization', `Bearer ${tokenFor(NO_BUSINESS)}`);
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('No business context found for this account.');
        expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
    });

    test('an employee WITHOUT settings.manage is refused with the exact contract', async () => {
        const { prisma } = buildPrisma();
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .set('Authorization', `Bearer ${tokenFor(EMPLOYEE_DENIED)}`);
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('You do not have permission to perform this action. Required: settings.manage');
        expect(res.body.requiredPermission).toBe('settings.manage');
        expect(prisma.businessOrder.findMany).not.toHaveBeenCalled();
    });

    test('an employee WITH settings.manage gets a zip', async () => {
        const { prisma } = buildPrisma();
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .set('Authorization', `Bearer ${tokenFor(EMPLOYEE_ALLOWED)}`)
            .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/zip');
        expect(Buffer.from(res.body).slice(0, 2).toString()).toBe('PK');
    });

    test('the owner gets a zip', async () => {
        const { prisma } = buildPrisma();
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .set('Authorization', `Bearer ${tokenFor(OWNER)}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/zip');
    });

    test('a caller-supplied business id cannot redirect the export to another tenant', async () => {
        const { prisma, calls } = buildPrisma();
        const res = await request(buildApp(prisma))
            .get('/api/business-os/export')
            .query({ businessProfileId: 'biz-B', businessId: 'biz-B', tenant: 'biz-B' })
            .set('Authorization', `Bearer ${tokenFor(ATTACKER)}`)
            .set('x-admin-business-id', 'biz-B')
            .set('x-business-id', 'biz-B');
        // The attacker is an ordinary employee of biz-A holding settings.manage.
        expect(res.status).toBe(200);
        expect(calls.findMany.length).toBeGreaterThan(0);
        for (const [model, where] of calls.findMany) {
            expect(`${model}:${where.businessProfileId}`).toMatch(/:biz-A$/);
        }
        const allIds = JSON.stringify(calls.findMany);
        expect(allIds).not.toContain('biz-B');
    });

    test('the owner cannot pull another tenant by naming it in the body', async () => {
        const { prisma, calls } = buildPrisma();
        await request(buildApp(prisma))
            .get('/api/business-os/export')
            .send({ businessProfileId: 'biz-B' })
            .set('Authorization', `Bearer ${tokenFor(OWNER)}`)
            .set('Content-Type', 'application/json');
        for (const [, where] of calls.findMany) expect(where.businessProfileId).toBe('biz-A');
    });
});
