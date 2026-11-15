/**
 * Money settings — route authority through the REAL middleware chain.
 *
 * admin-money-settings.pg.test.js proves the service and the role catalog. It
 * cannot prove that an HTTP caller is actually stopped: that decision is made by
 * requireEffectivePermission resolving the acting admin from database state.
 * This suite mounts the real admin router, signs real JWTs and asserts the
 * denial is real — not just a 403 status, but that nothing was written.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[money-settings-authority] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('money settings route authority (real PostgreSQL)', () => {
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    let prisma;
    let app;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = JWT_SECRET;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('socketio', { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }), emit: () => {} });
        app.set('emitBalanceUpdate', async () => {});
        app.set('notificationService', { sendNotification: async () => {} });
        app.set('payoutBatchWorker', null);
        app.use('/api/admin', require('../routes/adminRoutes'));
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "AdminRoleAssignment", "GlobalSettings", ' +
            '"AdminSettingsAuditLog", "AuditLog", "AdminMoneySettingRevision" RESTART IDENTITY CASCADE'
        );
    }, 20000);

    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mkAssigned = async (assignedRole) => {
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `ms_${u}`, email: `ms_${u}@test.local`, password: 'x', role: 'ADMIN' },
        });
        await prisma.adminRoleAssignment.create({ data: { userId: user.id, role: assignedRole } });
        return user;
    };
    const mkLegacyAdmin = async () => {
        const u = uniq();
        return prisma.user.create({
            data: { username: `msl_${u}`, email: `msl_${u}@test.local`, password: 'x', role: 'ADMIN' },
        });
    };
    const bearer = (user) => `Bearer ${jwt.sign({ id: user.id, role: 'ADMIN', tokenVersion: 0 }, JWT_SECRET)}`;
    const body = { value: 120, note: 'authority test' };
    const revisions = () => prisma.adminMoneySettingRevision.count();

    const URL_BASE = '/api/admin/money-settings';

    it('FINANCE_ADMIN can read the snapshot', async () => {
        const finance = await mkAssigned('FINANCE_ADMIN');
        const res = await request(app).get(URL_BASE).set('Authorization', bearer(finance));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.settings)).toBe(true);
        expect(res.body.flags).toBeDefined();
    });

    it('FINANCE_ADMIN can write and the revision is real', async () => {
        const finance = await mkAssigned('FINANCE_ADMIN');
        const res = await request(app).put(`${URL_BASE}/quoteTtl.payment_topup`).set('Authorization', bearer(finance)).send(body);
        expect(res.status).toBeLessThan(300);
        expect(await revisions()).toBe(1);
    });

    it('READ_ONLY_ADMIN may read but CANNOT write — and nothing is stored', async () => {
        const auditor = await mkAssigned('READ_ONLY_ADMIN');
        const read = await request(app).get(URL_BASE).set('Authorization', bearer(auditor));
        expect(read.status).toBe(200);

        const write = await request(app).put(`${URL_BASE}/quoteTtl.payment_topup`).set('Authorization', bearer(auditor)).send(body);
        expect(write.status).toBe(403);
        expect(write.body.success).toBe(false);
        expect(await revisions()).toBe(0);
    });

    it('SUPPORT_ADMIN is denied even the read — a reports viewer is not a money viewer', async () => {
        const support = await mkAssigned('SUPPORT_ADMIN');
        const read = await request(app).get(URL_BASE).set('Authorization', bearer(support));
        expect(read.status).toBe(403);
        const write = await request(app).put(`${URL_BASE}/quoteTtl.bucket_convert`).set('Authorization', bearer(support)).send(body);
        expect(write.status).toBe(403);
        expect(await revisions()).toBe(0);
    });

    it('the history surface is gated the same way as the snapshot', async () => {
        const finance = await mkAssigned('FINANCE_ADMIN');
        const support = await mkAssigned('SUPPORT_ADMIN');
        const ok = await request(app).get(`${URL_BASE}/quoteTtl.payment_topup/history`).set('Authorization', bearer(finance));
        expect(ok.status).toBe(200);
        const denied = await request(app).get(`${URL_BASE}/quoteTtl.payment_topup/history`).set('Authorization', bearer(support));
        expect(denied.status).toBe(403);
    });

    it('no token is rejected before any money-settings logic runs', async () => {
        const res = await request(app).get(URL_BASE);
        expect([401, 403]).toContain(res.status);
        expect(await revisions()).toBe(0);
    });

    it('legacy ADMIN retains access (existing fallback policy, asserted so it is reviewable)', async () => {
        const legacy = await mkLegacyAdmin();
        const res = await request(app).put(`${URL_BASE}/stepUpThresholdGhs`).set('Authorization', bearer(legacy)).send({ value: '25.00', note: 'legacy admin' });
        expect(res.status).toBeLessThan(300);
        expect(await revisions()).toBe(1);
    });

    it('the owner-resolved headline mode cannot be flipped by FINANCE_ADMIN over HTTP', async () => {
        const finance = await mkAssigned('FINANCE_ADMIN');
        const res = await request(app).put(`${URL_BASE}/balanceHeadlineMode`).set('Authorization', bearer(finance)).send({ value: 'NATIVE_ONLY', note: 'try to reverse' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MONEY_SETTING_OWNER_RESOLVED');
        expect(await revisions()).toBe(0);
        const snapshot = await request(app).get(URL_BASE).set('Authorization', bearer(finance));
        const headline = snapshot.body.settings.find((s) => s.key === 'balanceHeadlineMode');
        expect(headline.value).toBe('COMBINED_ESTIMATE');
    });
});
