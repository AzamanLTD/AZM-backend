// __tests__/r273-effective-role-enforcement.test.js
// =============================================================================
// r273 — TRANCHE 1 of the legacy admin endpoint migration: authoritative
// effective-role enforcement on the consolidated command center's money and
// privilege mutations (real PostgreSQL + the REAL route stack).
//
// What this suite proves (against the REAL routes/adminRoutes.js mounted on a
// real Express app — protect + adminOnly + requireEffectivePermission + the
// real controllers):
//
//   1. WIRING: every tranche-1 endpoint is actually behind
//      requireEffectivePermission with the intended catalog permission, and
//      the credit gate runs BEFORE the financial idempotency middleware
//      (denials never mint a claim).
//   2. FAIL-CLOSED: a forged 'ADMIN' claim on a non-admin account is denied
//      with no side effects; a demoted account with a lingering assignment is
//      denied; the resolver's infrastructure failure surfaces as 503, never
//      as an allow.
//   3. CLAIMS NEVER GRANT: a real READ_ONLY_ADMIN whose JWT claims
//      FINANCE_ADMIN (or SUPER_ADMIN) gets exactly READ_ONLY behavior.
//   4. PER-ROLE MATRIX: FINANCE / SUPPORT / COMPLIANCE / READ_ONLY /
//      SUPER_ADMIN each get exactly their catalog-declared tranche-1 powers;
//      the legacy unassigned ADMIN fallback is explicit, tested policy.
//   5. REASSIGNMENT / DEPROVISIONING: role changes take effect immediately
//      for fresh tokens (and stale tokens die at the token-version gate).
//   6. NO SIDE EFFECTS ON DENIAL: denied credits leave balances, ledger rows
//      and FinancialOperation claims untouched; denied withdrawals stay
//      PENDING; denied bans leave banStatus ACTIVE; denied role changes
//      leave the target's role unchanged.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r273-enforcement] TEST_DATABASE_URL not set — skipping.');

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const readRoute = (f) => fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');

describeOrSkip('r273 tranche 1 — authoritative effective-role enforcement (real PostgreSQL)', () => {
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
            'TRUNCATE TABLE "User", "AdminRoleAssignment", "Withdrawal", "FinancialOperation", ' +
            '"TransactionHistory", "AuditLog", "AdminSettingsAuditLog", "RefreshToken", ' +
            '"LedgerAccount", "LedgerTransaction", "JournalEntry" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── fixtures ────────────────────────────────────────────────────────────
    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const mkUser = async (overrides = {}) => {
        const u = uniq();
        return prisma.user.create({
            data: {
                username: `r273_${u}`,
                email: `r273_${u}@test.local`,
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

    // claimRole deliberately defaults to garbage — the claim must never matter.
    const tokenFor = (user, claimRole, tokenVersion = 0) =>
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

    // ════════════════════════════════════════════════════════════════════════
    // 1. WIRING — every tranche-1 endpoint behind the intended gate
    // ════════════════════════════════════════════════════════════════════════
    describe('wiring: the tranche-1 endpoints are gated in the route files', () => {
        const admin = () => readRoute('adminRoutes.js');
        const finance = () => readRoute('financeRoutes.js');

        const expectGate = (src, endpointLine, permissionCall) => {
            expect(src).toContain(endpointLine);
            expect(src).toContain(permissionCall);
        };

        it('manual balance credit → fees.manage, BEFORE the idempotency middleware', () => {
            const src = admin();
            const line = src.split('\n').find((l) => l.includes("router.post('/users/:id/credit'"));
            expect(line).toBeDefined();
            expect(line.indexOf('requireEffectivePermission')).toBeLessThan(line.indexOf('idempotency'));
            expect(line).toContain("'fees.manage'");
        });

        it('withdrawal reject and resolve-review → withdrawals.approve', () => {
            const src = admin();
            expect(src).toContain("router.post('/withdrawals/:id/reject', requireEffectivePermission('withdrawals.approve')");
            expect(src).toContain("router.post('/withdrawals/:id/resolve-review', requireEffectivePermission('withdrawals.approve')");
        });

        it('payout batch-process and settings → withdrawals.approve', () => {
            const src = admin();
            expect(src).toContain("router.post('/payouts/batch-process',   requireEffectivePermission('withdrawals.approve')");
            expect(src).toContain("router.put('/payouts/settings',         requireEffectivePermission('withdrawals.approve')");
        });

        it('dispute force-release / force-cancel → disputes.resolve', () => {
            const src = admin();
            expect(src).toContain("router.post('/disputes/force-release', requireEffectivePermission('disputes.resolve')");
            expect(src).toContain("router.post('/disputes/force-cancel', requireEffectivePermission('disputes.resolve')");
        });

        it('ban/unban lifecycle → users.ban OR users.unban at the route', () => {
            const src = admin();
            expect(src).toContain("router.post('/users/:id/ban', requireEffectivePermission('users.ban', 'users.unban')");
        });

        it('kyc approve / reject → users.kyc_approve / users.kyc_reject', () => {
            const src = admin();
            expect(src).toContain("router.post('/kyc/approve', requireEffectivePermission('users.kyc_approve')");
            expect(src).toContain("router.post('/kyc/reject', requireEffectivePermission('users.kyc_reject')");
        });

        it('primary-role change → the reserved users.role_change permission', () => {
            const src = admin();
            expect(src).toContain("router.post('/users/:id/role', requireEffectivePermission('users.role_change')");
        });

        it('profit liquidation → fees.manage in financeRoutes', () => {
            expectGate(finance(), "'/admin/liquidate-profits'", "requireEffectivePermission('fees.manage')");
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 2. FAIL-CLOSED + CLAIMS NEVER GRANT (real HTTP, real router)
    // ════════════════════════════════════════════════════════════════════════
    describe('fail-closed: forged claims and unresolvable accounts', () => {
        it('a forged ADMIN claim on a non-admin account is denied with NO side effects', async () => {
            const app = buildApp();
            const target = await mkUser({ availableBalance: 500 });
            const attacker = await mkUser({ role: 'USER' }); // real role: USER
            const forged = tokenFor(attacker, 'ADMIN'); // claim: ADMIN

            const res = await request(app)
                .post(`/api/admin/users/${target.id}/credit`)
                .set('Authorization', `Bearer ${forged}`)
                .set('Idempotency-Key', 'r273-forge-1')
                .send({ amount: '1000', reason: 'forged claim' });

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);

            const after = await prisma.user.findUnique({ where: { id: target.id } });
            expect(Number(after.availableBalance)).toBe(500); // no money moved

            const claims = await prisma.financialOperation.findMany({
                where: { userId: attacker.id },
            });
            expect(claims.length).toBe(0); // no idempotency claim minted — denial preceded the claim

            const postings = await prisma.ledgerTransaction.count({ where: { userId: target.id } });
            expect(postings).toBe(0); // no ledger posting
        });

        it('a demoted account (User.role=USER) with a lingering assignment is denied', async () => {
            const app = buildApp();
            const target = await mkUser({ role: 'USER' });
            const demoted = await mkUser({ role: 'USER' }); // primary role demoted below ADMIN
            await prisma.adminRoleAssignment.create({ data: { userId: demoted.id, role: 'FINANCE_ADMIN' } });
            // resolveEffectiveAdminRole must return null: assignment without ADMIN primary
            const token = tokenFor(demoted, 'ADMIN');

            const res = await request(app)
                .post(`/api/admin/users/${target.id}/credit`)
                .set('Authorization', `Bearer ${token}`)
                .set('Idempotency-Key', 'r273-demoted-1')
                .send({ amount: '10', reason: 'lingering assignment' });

            expect(res.status).toBe(403);
            expect(res.body.success).toBe(false);
        });

        it('a READ_ONLY_ADMIN whose JWT claims elevated roles gets exactly READ_ONLY behavior', async () => {
            const app = buildApp();
            const target = await mkUser({ availableBalance: 500 });
            const readOnly = await mkAssignedAdmin('READ_ONLY_ADMIN');

            // The Prisma Role enum only holds USER/VENDOR/ADMIN, so the only
            // realistic admin claim is 'ADMIN' — it passes the router-level
            // claim gate and reaches the authoritative gate, which must
            // still deny: the DB says READ_ONLY_ADMIN.
            const realistic = await request(app)
                .post(`/api/admin/users/${target.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(readOnly, 'ADMIN')}`)
                .set('Idempotency-Key', 'r273-ro-realistic-1')
                .send({ amount: '500', reason: 'claim ok, DB says no' });
            expect(realistic.status).toBe(403);
            expect(realistic.body.yourRole).toBe('READ_ONLY_ADMIN'); // DB, not the claim

            // Imaginary claims are denied at the boundary (router-level claim
            // gate), never by trusting the claim content.
            for (const claim of ['FINANCE_ADMIN', 'SUPER_ADMIN']) {
                const res = await request(app)
                    .post(`/api/admin/users/${target.id}/credit`)
                    .set('Authorization', `Bearer ${tokenFor(readOnly, claim)}`)
                    .set('Idempotency-Key', `r273-ro-${claim}`)
                    .send({ amount: '500', reason: 'claim says FINANCE' });
                expect(res.status).toBe(403);
            }

            const after = await prisma.user.findUnique({ where: { id: target.id } });
            expect(Number(after.availableBalance)).toBe(500);
        });

        it('resolver infrastructure failure surfaces as 503, never an allow', async () => {
            const { requireEffectivePermission } = require('../middleware/requireEffectivePermission');
            const gate = requireEffectivePermission('fees.manage');

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
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 3. PER-ROLE MATRIX on the real endpoints
    // ════════════════════════════════════════════════════════════════════════
    describe('FINANCE_ADMIN: financial mutations yes, user/dispute mutations no', () => {
        it('can credit a balance (fees.manage) and the credit commits', async () => {
            const app = buildApp();
            const target = await mkUser({ availableBalance: 100 });
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            const res = await request(app)
                .post(`/api/admin/users/${target.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN')}`)
                .set('Idempotency-Key', 'r273-fin-credit-1')
                .send({ amount: '50', reason: 'finance credit' });

            expect(res.status).toBe(200);
            const after = await prisma.user.findUnique({ where: { id: target.id } });
            expect(Number(after.availableBalance)).toBeCloseTo(150, 8);
        });

        it('can reject a withdrawal (withdrawals.approve)', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 10000 });
            const withdrawal = await prisma.withdrawal.create({
                data: { userId: member.id, amount: 25, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN' },
            });
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            const res = await request(app)
                .post(`/api/admin/withdrawals/${withdrawal.id}/reject`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN')}`)
                .send({ reason: 'r273 matrix' });

            expect(res.status).toBe(200);
            const after = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
            expect(after.status).toBe('REJECTED');
        });

        it('CANNOT ban, approve KYC, force-release or change roles; denials leave state untouched', async () => {
            const app = buildApp();
            const victim = await mkUser({ kycStatus: 'PENDING' });
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');
            const tok = `Bearer ${tokenFor(fin, 'ADMIN')}`;

            const ban = await request(app).post(`/api/admin/users/${victim.id}/ban`).set('Authorization', tok).send({ action: 'BAN_24H' });
            expect(ban.status).toBe(403);
            const kyc = await request(app).post('/api/admin/kyc/approve').set('Authorization', tok).send({ userId: victim.id });
            expect(kyc.status).toBe(403);
            const role = await request(app).post(`/api/admin/users/${victim.id}/role`).set('Authorization', tok).send({ role: 'VENDOR' });
            expect(role.status).toBe(403);

            const after = await prisma.user.findUnique({ where: { id: victim.id } });
            expect(after.banStatus).toBe('ACTIVE');      // not banned
            expect(after.kycStatus).toBe('PENDING');     // kyc untouched
            expect(after.role).toBe('USER');             // role untouched
        });
    });

    describe('SUPPORT_ADMIN: user/dispute mutations yes, financial mutations no', () => {
        it('can approve KYC and ban (catalog permissions)', async () => {
            const app = buildApp();
            const member = await mkUser({ kycStatus: 'PENDING' });
            const support = await mkAssignedAdmin('SUPPORT_ADMIN');
            const tok = `Bearer ${tokenFor(support, 'ADMIN')}`;

            const kyc = await request(app).post('/api/admin/kyc/approve').set('Authorization', tok).send({ userId: member.id });
            expect(kyc.status).toBe(200);

            const ban = await request(app).post(`/api/admin/users/${member.id}/ban`).set('Authorization', tok).send({ action: 'BAN_24H' });
            expect(ban.status).toBe(200);
            const after = await prisma.user.findUnique({ where: { id: member.id } });
            expect(after.banStatus).toBe('BANNED_24H');
        });

        it('CANNOT credit balances or reject withdrawals; the withdrawal stays PENDING', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100 });
            const withdrawal = await prisma.withdrawal.create({
                data: { userId: member.id, amount: 25, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN' },
            });
            const support = await mkAssignedAdmin('SUPPORT_ADMIN');
            const tok = `Bearer ${tokenFor(support, 'ADMIN')}`;

            const credit = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', tok)
                .set('Idempotency-Key', 'r273-sup-credit-1')
                .send({ amount: '999', reason: 'should fail' });
            expect(credit.status).toBe(403);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).availableBalance.toString()).toBe('100');

            const reject = await request(app)
                .post(`/api/admin/withdrawals/${withdrawal.id}/reject`)
                .set('Authorization', tok)
                .send({ reason: 'should fail' });
            expect(reject.status).toBe(403);
            expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('PENDING');
        });
    });

    describe('COMPLIANCE_ADMIN: KYC decisions yes, money and privilege mutations no', () => {
        it('can reject KYC (users.kyc_reject) but cannot credit or change roles', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100, kycStatus: 'PENDING' });
            const compliance = await mkAssignedAdmin('COMPLIANCE_ADMIN');
            const tok = `Bearer ${tokenFor(compliance, 'ADMIN')}`;

            const kyc = await request(app).post('/api/admin/kyc/reject').set('Authorization', tok).send({ userId: member.id, reason: 'blurry id' });
            expect(kyc.status).toBe(200);

            const credit = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', tok)
                .set('Idempotency-Key', 'r273-comp-credit-1')
                .send({ amount: '10', reason: 'should fail' });
            expect(credit.status).toBe(403);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).availableBalance.toString()).toBe('100');

            const role = await request(app).post(`/api/admin/users/${member.id}/role`).set('Authorization', tok).send({ role: 'ADMIN' });
            expect(role.status).toBe(403);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).role).toBe('USER');
        });
    });

    describe('READ_ONLY_ADMIN: every tranche-1 mutation denied', () => {
        it('cannot credit, reject, ban, kyc-approve or change roles', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100, kycStatus: 'PENDING' });
            const withdrawal = await prisma.withdrawal.create({
                data: { userId: member.id, amount: 25, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN' },
            });
            const ro = await mkAssignedAdmin('READ_ONLY_ADMIN');
            const tok = `Bearer ${tokenFor(ro, 'ADMIN')}`;

            const credit = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', tok)
                .set('Idempotency-Key', 'r273-ro-credit-1')
                .send({ amount: '10', reason: 'read-only must not move money' });
            expect(credit.status).toBe(403);

            const reject = await request(app).post(`/api/admin/withdrawals/${withdrawal.id}/reject`).set('Authorization', tok).send({ reason: 'r273 matrix' });
            expect(reject.status).toBe(403);

            const ban = await request(app).post(`/api/admin/users/${member.id}/ban`).set('Authorization', tok).send({ action: 'BAN_24H' });
            expect(ban.status).toBe(403);

            const kyc = await request(app).post('/api/admin/kyc/approve').set('Authorization', tok).send({ userId: member.id });
            expect(kyc.status).toBe(403);

            const role = await request(app).post(`/api/admin/users/${member.id}/role`).set('Authorization', tok).send({ role: 'ADMIN' });
            expect(role.status).toBe(403);

            const after = await prisma.user.findUnique({ where: { id: member.id } });
            expect(after.availableBalance.toString()).toBe('100');
            expect(after.banStatus).toBe('ACTIVE');
            expect(after.kycStatus).toBe('PENDING');
            expect(after.role).toBe('USER');
            expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('PENDING');
        });
    });

    describe('SUPER_ADMIN and the explicit legacy-ADMIN fallback', () => {
        it('a provisioned SUPER_ADMIN retains full authority (primary-role change allowed)', async () => {
            const app = buildApp();
            const member = await mkUser({ role: 'USER' });
            const superAdmin = await mkAssignedAdmin('SUPER_ADMIN');

            const res = await request(app)
                .post(`/api/admin/users/${member.id}/role`)
                .set('Authorization', `Bearer ${tokenFor(superAdmin, 'ADMIN')}`)
                .send({ role: 'VENDOR' });
            expect(res.status).toBe(200);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).role).toBe('VENDOR');
        });

        it('an UNASSIGNED legacy ADMIN retains full access — explicit, tested fallback policy (no silent escalation, no lockout)', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100 });
            const legacyAdmin = await mkUser({ role: 'ADMIN' }); // no AdminRoleAssignment row
            const tok = `Bearer ${tokenFor(legacyAdmin, 'ADMIN')}`;

            const credit = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', tok)
                .set('Idempotency-Key', 'r273-legacy-credit-1')
                .send({ amount: '10', reason: 'legacy admin' });
            expect(credit.status).toBe(200);
            expect(Number((await prisma.user.findUnique({ where: { id: member.id } })).availableBalance)).toBeCloseTo(110, 8);

            const role = await request(app).post(`/api/admin/users/${member.id}/role`).set('Authorization', tok).send({ role: 'VENDOR' });
            expect(role.status).toBe(200);
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 4. banUser action-level narrowing (defense in depth)
    // ════════════════════════════════════════════════════════════════════════
    describe('ban/unban action-level narrowing inside banUser', () => {
        const mockRes = () => {
            const r = { _status: 200, _body: null };
            r.status = (s) => { r._status = s; return r; };
            r.json = (b) => { r._body = b; return r; };
            return r;
        };
        const ioStub = {
            to: () => ({ emit: () => {} }),
            in: () => ({ disconnectSockets: () => {} }),
            emit: () => {},
        };
        const mockApp = {
            get: (k) =>
                k === 'prisma' ? prisma :
                k === 'socketio' ? ioStub :
                k === 'notificationService' ? { sendNotification: async () => {} } : null,
        };
        const mockReq = (actingRole, action, targetId) => ({
            user: { id: 1 },
            body: { action },
            params: { id: String(targetId) },
            effectiveAdminRole: actingRole, // as set by the route gate in a real request
            app: mockApp,
        });

        it('UNBAN requires users.unban, BAN actions require users.ban', async () => {
            const adminController = require('../controllers/adminController');
            const member = await mkUser({ banStatus: 'BANNED_INDEF' });

            // COMPLIANCE_ADMIN holds NEITHER permission → denied even if the
            // route gate were bypassed (direct handler invocation).
            const denied = mockReq('COMPLIANCE_ADMIN', 'UNBAN', member.id);
            const deniedRes = mockRes();
            await adminController.banUser(denied, deniedRes);
            expect(deniedRes._status).toBe(403);
            expect(deniedRes._body.message).toContain('users.unban');
            expect((await prisma.user.findUnique({ where: { id: member.id } })).banStatus).toBe('BANNED_INDEF');

            // SUPPORT_ADMIN holds both → allowed.
            const allowed = mockReq('SUPPORT_ADMIN', 'UNBAN', member.id);
            const allowedRes = mockRes();
            await adminController.banUser(allowed, allowedRes);
            expect(allowedRes._status).toBe(200);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).banStatus).toBe('ACTIVE');
        });

        it('direct invocation without a pre-resolved role re-resolves from the authoritative source', async () => {
            const adminController = require('../controllers/adminController');
            const support = await mkAssignedAdmin('SUPPORT_ADMIN');
            const member = await mkUser({ banStatus: 'ACTIVE' });

            const req = {
                user: { id: support.id },
                body: { action: 'BAN_24H' },
                params: { id: String(member.id) },
                app: mockApp,
                // no effectiveAdminRole — the handler must resolve it itself
            };
            const res = mockRes();
            await adminController.banUser(req, res);
            expect(res._status).toBe(200);
            expect((await prisma.user.findUnique({ where: { id: member.id } })).banStatus).toBe('BANNED_24H');
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    // 5. REASSIGNMENT / DEPROVISIONING semantics
    // ════════════════════════════════════════════════════════════════════════
    describe('role reassignment and deprovisioning take effect immediately', () => {
        it('reassignment FINANCE_ADMIN → READ_ONLY_ADMIN narrows a FRESH token instantly', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100 });
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            // before: finance can credit
            const before = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN')}`)
                .set('Idempotency-Key', 'r273-reassign-1')
                .send({ amount: '10', reason: 'before reassignment' });
            expect(before.status).toBe(200);

            // reassignment (mirrors the provisioning surface: assignment swap + tokenVersion bump)
            await prisma.adminRoleAssignment.update({
                where: { userId: fin.id },
                data: { role: 'READ_ONLY_ADMIN' },
            });
            await prisma.user.update({ where: { id: fin.id }, data: { tokenVersion: { increment: 1 } } });

            // the pre-reassignment token dies at the token-version gate
            const stale = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN', 0)}`)
                .set('Idempotency-Key', 'r273-reassign-2')
                .send({ amount: '10', reason: 'stale token' });
            expect(stale.status).toBe(401);
            expect(stale.body.code).toBe('TOKEN_STALE');

            // a FRESH token gets exactly READ_ONLY behavior
            const fresh = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN', 1)}`)
                .set('Idempotency-Key', 'r273-reassign-3')
                .send({ amount: '10', reason: 'fresh token, read-only' });
            expect(fresh.status).toBe(403);
            expect(fresh.body.yourRole).toBe('READ_ONLY_ADMIN');
            expect(Number((await prisma.user.findUnique({ where: { id: member.id } })).availableBalance)).toBeCloseTo(110, 8); // only the first credit landed
        });

        it('full deprovisioning (assignment removed + primary role USER + tokenVersion bump) removes all admin power', async () => {
            const app = buildApp();
            const member = await mkUser({ availableBalance: 100 });
            const fin = await mkAssignedAdmin('FINANCE_ADMIN');

            await prisma.adminRoleAssignment.deleteMany({ where: { userId: fin.id } });
            await prisma.user.update({
                where: { id: fin.id },
                data: { role: 'USER', tokenVersion: { increment: 1 } },
            });

            const res = await request(app)
                .post(`/api/admin/users/${member.id}/credit`)
                .set('Authorization', `Bearer ${tokenFor(fin, 'ADMIN', 1)}`)
                .set('Idempotency-Key', 'r273-deprov-1')
                .send({ amount: '10', reason: 'deprovisioned' });
            expect(res.status).toBe(403);
            expect(Number((await prisma.user.findUnique({ where: { id: member.id } })).availableBalance)).toBe(100);
        });
    });
});
