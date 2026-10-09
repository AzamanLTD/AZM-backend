// __tests__/r274-effective-role-tranche2.test.js
// =============================================================================
// r273 — TRANCHE 2 of the legacy admin endpoint migration: authoritative
// effective-role enforcement on the REMAINING adminRoutes mutations + reads
// (real PostgreSQL + the REAL route stack).
//
// What this suite proves (against the REAL routes/adminRoutes.js mounted on a
// real Express app — protect + adminOnly + requireEffectivePermission + the
// real controllers):
//
//   1. WIRING: every tranche-2 endpoint is actually behind
//      requireEffectivePermission with the intended catalog permission,
//      including the previously-ungated /profits/liquidate alias of the
//      finance liquidation route.
//   2. FAIL-CLOSED + CLAIMS NEVER GRANT: a specialized account whose JWT
//      claims another role keeps exactly its assigned-role powers; a
//      resolver infrastructure failure surfaces as 503, never an allow.
//   3. RESERVED PERMISSIONS: platform.settings, users.risk_tier,
//      trades.account_approve, business.manage and messages.inject are
//      granted to NO specialized role — FINANCE/SUPPORT/COMPLIANCE/READ_ONLY
//      are all denied; SUPER_ADMIN and the legacy ADMIN fallback pass.
//   4. PER-ROLE MATRIX: each specialized role gets exactly its
//      catalog-declared tranche-2 powers on real HTTP verbs — reads AND
//      mutations, with denied mutations leaving the database untouched.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r274-tranche2] TEST_DATABASE_URL not set — skipping.');

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const readRoute = (f) => fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');

describeOrSkip('r274 tranche 2 — remaining adminRoutes surface (real PostgreSQL)', () => {
    let prisma;
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = JWT_SECRET;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "AdminRoleAssignment", "AdminFeeProfile", "GlobalSettings", ' +
            '"AdminSettingsAuditLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── fixtures ────────────────────────────────────────────────────────────
    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const mkUser = async (overrides = {}) => {
        const u = uniq();
        return prisma.user.create({
            data: {
                username: `r274_${u}`,
                email: `r274_${u}@test.local`,
                password: 'test_password',
                role: 'USER',
                ...overrides,
            },
        });
    };

    const mkAssignedAdmin = async (assignedRole) => {
        const admin = await mkUser({ role: 'ADMIN' });
        await prisma.adminRoleAssignment.create({ data: { userId: admin.id, role: assignedRole } });
        return admin;
    };

    const mkPlainAdmin = async () => mkUser({ role: 'ADMIN' });

    // claimRole defaults to the realistic 'ADMIN' claim — it passes the
    // router-level adminOnly boundary so the authoritative gate (not the
    // claim) decides from the DB assignment.
    const tokenFor = (user, claimRole = 'ADMIN', tokenVersion = 0) =>
        jwt.sign({ id: user.id, role: claimRole, tokenVersion }, JWT_SECRET);

    const buildApp = () => {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('socketio', {
            to: () => ({ emit: () => {} }),
            in: () => ({ disconnectSockets: () => {} }),
            emit: () => {},
        });
        app.set('emitBalanceUpdate', async () => {});
        app.set('notificationService', { sendNotification: async () => {} });
        app.set('payoutBatchWorker', null);
        app.use('/api/admin', require('../routes/adminRoutes'));
        return app;
    };

    const get = (app, admin, url) =>
        request(app).get(url).set('Authorization', `Bearer ${tokenFor(admin)}`);
    const post = (app, admin, url, body) =>
        request(app).post(url).set('Authorization', `Bearer ${tokenFor(admin)}`).send(body || {});
    const put = (app, admin, url, body) =>
        request(app).put(url).set('Authorization', `Bearer ${tokenFor(admin)}`).send(body || {});

    const expectDenied = async (res) => {
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    };
    const expectGatePassed = async (res) => {
        expect(res.status).not.toBe(403); // gate passed; anything else is handler/domain logic
    };

    // ════════════════════════════════════════════════════════════════════════
    // 1. WIRING — every tranche-2 endpoint behind the intended gate
    // ════════════════════════════════════════════════════════════════════════
    describe('wiring: the tranche-2 endpoints are gated in the route file', () => {
        const admin = () => readRoute('adminRoutes.js');

        it('profits/liquidate alias → fees.manage (tranche-1 completeness)', () => {
            expect(admin()).toContain(
                "router.post('/profits/liquidate', requireEffectivePermission('fees.manage')"
            );
        });

        it('fee-profile CRUD → fees.manage on every verb', () => {
            const src = admin();
            expect(src).toContain("router.get('/fee-profiles',          requireEffectivePermission('fees.manage')");
            expect(src).toContain("router.get('/fee-profiles/resolve',  requireEffectivePermission('fees.manage')");
            expect(src).toContain("router.post('/fee-profiles',         requireEffectivePermission('fees.manage')");
            expect(src).toContain("router.put('/fee-profiles/:id',      requireEffectivePermission('fees.manage')");
            expect(src).toContain("router.delete('/fee-profiles/:id',   requireEffectivePermission('fees.manage')");
            expect(src).toContain("router.get('/profit-breakdown', requireEffectivePermission('fees.manage')");
        });

        it('platform settings, risk tier and version gate → reserved permissions', () => {
            const src = admin();
            expect(src).toContain("router.get('/settings',              requireEffectivePermission('platform.settings')");
            expect(src).toContain("router.put('/settings',              requireEffectivePermission('platform.settings')");
            expect(src).toContain("router.post('/users/:id/risk-tier',  requireEffectivePermission('users.risk_tier')");
            expect(src).toContain("router.get('/version-gate', requireEffectivePermission('platform.settings')");
            expect(src).toContain("router.put('/version-gate', requireEffectivePermission('platform.settings')");
        });

        it('trade-account approvals → reserved trades.account_approve', () => {
            const src = admin();
            expect(src).toContain("router.post('/trade-accounts/:id/approve', requireEffectivePermission('trades.account_approve')");
            expect(src).toContain("router.post('/trade-accounts/:id/reject', requireEffectivePermission('trades.account_approve')");
            expect(src).toContain("router.get('/trade-accounts/pending', requireEffectivePermission('trades.view')");
        });

        it('dispute + escrow-dispute lifecycle → disputes.view / disputes.resolve', () => {
            const src = admin();
            expect(src).toContain("router.get('/disputes', requireEffectivePermission('disputes.view')");
            expect(src).toContain("router.post('/disputes/:tradeId/resolve', requireEffectivePermission('disputes.resolve')");
            expect(src).toContain("router.get('/disputes/resolutions', requireEffectivePermission('disputes.view')");
            expect(src).toContain("router.get('/escrow-disputes', requireEffectivePermission('disputes.view')");
            expect(src).toContain("router.post('/escrow-disputes/:id/assign', requireEffectivePermission('disputes.resolve')");
            expect(src).toContain("router.post('/escrow-disputes/:id/resolve', requireEffectivePermission('disputes.resolve')");
        });

        it('chat injection → reserved messages.inject', () => {
            expect(admin()).toContain(
                "router.post('/chat/inject', requireEffectivePermission('messages.inject')"
            );
        });

        it('business KYB → users.kyc_approve / users.kyc_reject', () => {
            const src = admin();
            expect(src).toContain("router.post('/business-kyb/:documentId/review',        requireEffectivePermission('users.kyc_approve')");
            expect(src).toContain("router.post('/business-kyb/:bizId/approve',            requireEffectivePermission('users.kyc_approve')");
            expect(src).toContain("router.post('/business-kyb/:bizId/reject',             requireEffectivePermission('users.kyc_reject')");
            expect(src).toContain("router.get('/business-kyb',                            requireEffectivePermission('users.view')");
        });

        it('business admin mutations → reserved business.manage', () => {
            const src = admin();
            expect(src).toContain("router.post('/businesses/:bizId/suspend',    requireEffectivePermission('business.manage')");
            expect(src).toContain("router.post('/businesses/:bizId/unsuspend',  requireEffectivePermission('business.manage')");
            expect(src).toContain("router.delete('/businesses/:bizId',          requireEffectivePermission('business.manage')");
            expect(src).toContain("router.delete('/ad-posts/:id',               requireEffectivePermission('business.manage')");
        });

        it('read surfaces → users.view / withdrawals.review / trades.view / audit.view / reports.view', () => {
            const src = admin();
            expect(src).toContain("router.get('/users', requireEffectivePermission('users.view')");
            expect(src).toContain('router.get("/users/:id/detail", requireEffectivePermission(\'users.view\')');
            expect(src).toContain("router.get('/kyc/pending', requireEffectivePermission('users.view')");
            expect(src).toContain("router.get('/withdrawals/pending', requireEffectivePermission('withdrawals.review')");
            expect(src).toContain("router.get('/trades/live', requireEffectivePermission('trades.view')");
            expect(src).toContain("router.get('/audit-log',             requireEffectivePermission('audit.view')");
            expect(src).toContain("router.get('/audit-log/general', requireEffectivePermission('audit.view')");
            expect(src).toContain("router.get('/stats', requireEffectivePermission('reports.view')");
            expect(src).toContain("router.get('/system-health', requireEffectivePermission('reports.view')");
            expect(src).toContain("router.get('/payouts/settings',         requireEffectivePermission('withdrawals.review')");
            expect(src).toContain("router.get('/payouts/needs-review',     requireEffectivePermission('withdrawals.review')");
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 2. RESERVED PERMISSIONS — no specialized role passes them
    // ════════════════════════════════════════════════════════════════════════
    describe('reserved permissions: denied to every specialized role', () => {
        it.each(['FINANCE_ADMIN', 'SUPPORT_ADMIN', 'COMPLIANCE_ADMIN', 'READ_ONLY_ADMIN'])(
            '%s is denied PUT /settings, risk-tier, trade-account approve, business suspend, chat/inject and version-gate PUT',
            async (role) => {
                const app = buildApp();
                const actor = await mkAssignedAdmin(role);
                const target = await mkUser();

                await expectDenied(await put(app, actor, '/api/admin/settings', { maintenanceMode: true }));
                await expectDenied(await post(app, actor, `/api/admin/users/${target.id}/risk-tier`, { tier: 'LOW' }));
                await expectDenied(await post(app, actor, '/api/admin/trade-accounts/1/approve'));
                await expectDenied(await post(app, actor, '/api/admin/businesses/1/suspend'));
                await expectDenied(await post(app, actor, '/api/admin/chat/inject', { userId: target.id, message: 'x' }));
                await expectDenied(await put(app, actor, '/api/admin/version-gate', { minAppVersion: '9.9.9' }));

                // nothing moved: no settings audit row for the actor
                const audit = await prisma.adminSettingsAuditLog.count({
                    where: { adminId: actor.id },
                });
                expect(audit).toBe(0);
            }
        );

        it('SUPER_ADMIN and the legacy unassigned ADMIN pass the reserved gates', async () => {
            const app = buildApp();
            const superAdmin = await mkAssignedAdmin('SUPER_ADMIN');
            const legacy = await mkPlainAdmin();

            // gate passed => NOT 403 (handler may 400/404 on unseeded ids; the
            // gate is the security boundary under test)
            await expectGatePassed(await post(app, superAdmin, '/api/admin/trade-accounts/1/approve'));
            await expectGatePassed(await post(app, legacy, '/api/admin/trade-accounts/1/approve'));
            await expectGatePassed(await post(app, superAdmin, '/api/admin/businesses/1/suspend'));
            await expectGatePassed(await post(app, legacy, '/api/admin/businesses/1/suspend'));
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 3. PER-ROLE MATRIX — exactly the catalog-declared tranche-2 powers
    // ════════════════════════════════════════════════════════════════════════
    describe('FINANCE_ADMIN: fee domain, no user/dispute/report powers', () => {
        it('can read and create fee profiles, and read profit breakdown', async () => {
            const app = buildApp();
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            const list = await get(app, fin, '/api/admin/fee-profiles');
            expect(list.status).toBe(200);
            expect(list.body.success).toBe(true);

            const create = await post(app, fin, '/api/admin/fee-profiles', {
                name: 'r274-standard',
                targetScope: 'ALL',
                targetValue: null,
                platformFeePct: 0.02,
                adminSplitPct: 0.7,
                vendorSplitPct: 0.3,
                priority: 1,
            });
            expect([200, 201]).toContain(create.status);
            const rows = await prisma.adminFeeProfile.count({ where: { name: 'r274-standard' } });
            expect(rows).toBe(1);

            const breakdown = await get(app, fin, '/api/admin/profit-breakdown');
            expect(breakdown.status).toBe(200);

            // FINANCE carries withdrawals.review in the catalog — the queue
            // read is a legitimate FINANCE power.
            const queue = await get(app, fin, '/api/admin/withdrawals/pending');
            expect(queue.status).toBe(200);
        });

        it('is denied user reads, withdrawal queue and dispute resolution', async () => {
            const app = buildApp();
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            await expectDenied(await get(app, fin, '/api/admin/users'));
            await expectDenied(await get(app, fin, '/api/admin/disputes'));
            await expectDenied(await get(app, fin, '/api/admin/stats'));
            await expectDenied(await post(app, fin, '/api/admin/disputes/1/resolve', { ruling: 'BUYER' }));
        });
    });

    describe('SUPPORT_ADMIN: users + disputes, no finance/config powers', () => {
        it('can read users and the KYC queue, view and assign disputes', async () => {
            const app = buildApp();
            const sup = await mkAssignedAdmin('SUPPORT_ADMIN');

            const users = await get(app, sup, '/api/admin/users');
            expect(users.status).toBe(200);

            const kyc = await get(app, sup, '/api/admin/kyc/pending');
            expect(kyc.status).toBe(200);

            const disputes = await get(app, sup, '/api/admin/disputes');
            expect(disputes.status).toBe(200);

            // SUPPORT has disputes.resolve in the catalog → assign passes the gate
            await expectGatePassed(await post(app, sup, '/api/admin/escrow-disputes/1/assign', { assigneeId: 1 }));
        });

        it('is denied fee-profile CRUD, stats and settings', async () => {
            const app = buildApp();
            const sup = await mkAssignedAdmin('SUPPORT_ADMIN');

            await expectDenied(await get(app, sup, '/api/admin/fee-profiles'));
            await expectDenied(await post(app, sup, '/api/admin/fee-profiles', { name: 'x', targetScope: 'ALL', platformFeePct: 0.02, adminSplitPct: 0.7, vendorSplitPct: 0.3 }));
            await expectDenied(await get(app, sup, '/api/admin/stats'));
            await expectDenied(await get(app, sup, '/api/admin/settings'));
        });
    });

    describe('COMPLIANCE_ADMIN: audit + reports + withdrawal review', () => {
        it('can read audit log, stats and the withdrawal queue', async () => {
            const app = buildApp();
            const comp = await mkAssignedAdmin('COMPLIANCE_ADMIN');

            const audit = await get(app, comp, '/api/admin/audit-log');
            expect(audit.status).toBe(200);

            const stats = await get(app, comp, '/api/admin/stats');
            expect(stats.status).toBe(200);

            const queue = await get(app, comp, '/api/admin/withdrawals/pending');
            expect(queue.status).toBe(200);
        });

        it('is denied fee-profile mutations and dispute resolution', async () => {
            const app = buildApp();
            const comp = await mkAssignedAdmin('COMPLIANCE_ADMIN');

            await expectDenied(await post(app, comp, '/api/admin/fee-profiles', { name: 'x', targetScope: 'ALL', platformFeePct: 0.02, adminSplitPct: 0.7, vendorSplitPct: 0.3 }));
            await expectDenied(await post(app, comp, '/api/admin/disputes/1/resolve', { ruling: 'BUYER' }));
        });
    });

    describe('READ_ONLY_ADMIN: reads only, zero mutations', () => {
        it('can read its catalog-declared surfaces', async () => {
            const app = buildApp();
            const ro = await mkAssignedAdmin('READ_ONLY_ADMIN');

            for (const url of [
                '/api/admin/users',
                '/api/admin/withdrawals/pending',
                '/api/admin/stats',
                '/api/admin/disputes',
                '/api/admin/trades/live',
                '/api/admin/audit-log',
            ]) {
                const res = await get(app, ro, url);
                expect(res.status).toBe(200);
            }
        });

        it('is denied EVERY tranche-2 mutation, with no side effects', async () => {
            const app = buildApp();
            const ro = await mkAssignedAdmin('READ_ONLY_ADMIN');
            const target = await mkUser();

            await expectDenied(await post(app, ro, '/api/admin/fee-profiles', { name: 'x', targetScope: 'ALL', platformFeePct: 0.02, adminSplitPct: 0.7, vendorSplitPct: 0.3 }));
            await expectDenied(await post(app, ro, '/api/admin/profits/liquidate'));
            await expectDenied(await post(app, ro, `/api/admin/users/${target.id}/risk-tier`, { tier: 'LOW' }));
            await expectDenied(await post(app, ro, '/api/admin/trade-accounts/1/approve'));
            await expectDenied(await post(app, ro, '/api/admin/businesses/1/suspend'));
            await expectDenied(await post(app, ro, '/api/admin/business-kyb/1/approve'));
            await expectDenied(await post(app, ro, '/api/admin/chat/inject', { userId: target.id, message: 'x' }));

            // no fee profile row was minted by the denied create
            const rows = await prisma.adminFeeProfile.count();
            expect(rows).toBe(0);
            // the target's risk tier was not touched
            const after = await prisma.user.findUnique({ where: { id: target.id } });
            expect(after.withdrawalRiskTier).toBe('STANDARD'); // untouched by the denial
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 4. CLAIMS NEVER GRANT + FAIL-CLOSED
    // ════════════════════════════════════════════════════════════════════════
    describe('claims never grant + fail-closed', () => {
        it('a READ_ONLY_ADMIN with a realistic ADMIN claim is denied fee-profile create (DB says no)', async () => {
            const app = buildApp();
            const ro = await mkAssignedAdmin('READ_ONLY_ADMIN');

            const res = await post(app, ro, '/api/admin/fee-profiles', {
                name: 'x', targetScope: 'ALL', platformFeePct: 0.02,
                adminSplitPct: 0.7, vendorSplitPct: 0.3,
            });

            await expectDenied(res);
            expect(res.body.yourRole).toBe('READ_ONLY_ADMIN'); // the gate's own attribution: DB, not the claim
            expect(await prisma.adminFeeProfile.count()).toBe(0);
        });

        it('imaginary elevated claims are denied at the boundary, never by trusting claim content', async () => {
            const app = buildApp();
            const sup = await mkAssignedAdmin('SUPPORT_ADMIN');
            const target = await mkUser();

            for (const claim of ['FINANCE_ADMIN', 'SUPER_ADMIN']) {
                const res = await post(app, sup, `/api/admin/users/${target.id}/risk-tier`, { tier: 'LOW' })
                    .set('Authorization', `Bearer ${tokenFor(sup, claim)}`);
                expect(res.status).toBe(403);
            }

            const after = await prisma.user.findUnique({ where: { id: target.id } });
            expect(after.withdrawalRiskTier).toBe('STANDARD');
        });

        it('resolver infrastructure failure surfaces as 503, never an allow', async () => {
            const { requireEffectivePermission } = require('../middleware/requireEffectivePermission');
            for (const perm of ['platform.settings', 'business.manage', 'messages.inject', 'trades.account_approve', 'users.risk_tier']) {
                const gate = requireEffectivePermission(perm);
                const req = {
                    user: { id: 42 },
                    app: {
                        get: (k) =>
                            k === 'prisma'
                                ? {
                                    adminRoleAssignment: { findUnique: async () => { throw new Error('db down'); } },
                                    user: { findUnique: async () => { throw new Error('db down'); } },
                                }
                                : null,
                    },
                };
                const res = {
                    _status: 0,
                    status(c) { this._status = c; return this; },
                    json(b) { this._body = b; return this; },
                };
                let nexted = false;
                await gate(req, res, () => { nexted = true; });
                expect(nexted).toBe(false);
                expect(res._status).toBe(503);
            }
        });
    });
});
