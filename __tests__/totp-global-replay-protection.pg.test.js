// __tests__/totp-global-replay-protection.pg.test.js
// =============================================================================
// §WP-F — ONE USER, ONE MATCHED TOTP STEP, ONE USE, ACROSS EVERY PATH.
//
// This suite drives the REAL Prisma client against a REAL disposable PostgreSQL
// database and the REAL middleware/controller stacks (only auth, which needs a
// JWT session, is stubbed). It is the cross-path proof that no verification
// route kept a private accept path: a code accepted on one route is refused on
// every other route for that user and that matched step.
//
// FAIL CLOSED: without TEST_DATABASE_URL this suite FAILS in CI rather than
// skipping. A skipped replay proof must never look like a passing build.
// =============================================================================
'use strict';

const express = require('express');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { execFileSync } = require('child_process');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (!DB_URL && IS_CI) {
    test('WP-F requires TEST_DATABASE_URL in CI', () => {
        throw new Error(
            'TEST_DATABASE_URL is not set in CI. The global TOTP replay proofs cannot run, and a skipped '
            + 'suite must not be reported as a passing build.'
        );
    });
}

const run = DB_URL ? describe : describe.skip;

run('WP-F — global TOTP replay protection (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { seedUser } = require('./helpers/factories');
    const require2FAModule = require('../middleware/require2FA');
    const appUnlockController = require('../controllers/appUnlockController');
    const securityController = require('../controllers/securityController');
    const savedMomoController = require('../controllers/savedMomoController');
    const walletController = require('../controllers/walletController');
    const claimService = require('../src/services/totpStepClaimService');

    const STEP_SECONDS = 30;
    let prisma;
    let app;
    let idempotencyRuns = 0;

    const stepOf = (date) => Math.floor(date.getTime() / 1000 / STEP_SECONDS);
    const codeAt = (secret, offsetSteps, at = Date.now()) => speakeasy.totp({
        secret,
        encoding: 'base32',
        // speakeasy 2.0.0 `_counter()` multiplies `time` by 1000: it expects
        // SECONDS. Passing milliseconds silently yields a far-future step.
        time: (at + offsetSteps * STEP_SECONDS * 1000) / 1000,
    });

    const makeUser = async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await seedUser(prisma, {
            isTwoFactorEnabled: true,
            twoFactorSecret: secret,
        });
        return { user, secret };
    };

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', prisma);
        a.set('logger', { error: () => {}, warn: () => {} });
        a.set('momoNameLookupService', { resolveName: async () => ({ ok: false }) });
        a.use((req, _res, next) => { req.user = { id: Number(req.headers['x-user-id']), role: 'ADMIN' }; next(); });

        // The B5 order that must be preserved: require2FA BEFORE idempotency.
        a.post('/mfa/wired',
            require2FAModule.require2FA(),
            (req, _res, next) => { idempotencyRuns += 1; next(); },
            (req, res) => res.status(200).json({ success: true, idempotencyRuns }));

        a.post('/security/2fa/verify', securityController.verify2FA);
        a.post('/security/2fa/disable', securityController.disable2FA);
        a.post('/saved-momo', savedMomoController.create);
        a.post('/wallet/payout-address', walletController.addSavedWallet);
        a.post('/app-unlock/totp', appUnlockController.verifyAppUnlockTotp);
        return a;
    };

    const post = (url, body, user) => request(app).post(url).set('x-user-id', String(user.id)).send(body);

    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        await prisma.$connect();
        app = buildApp();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    beforeEach(async () => {
        idempotencyRuns = 0;
        await prisma.totpStepClaim.deleteMany({});
    });

    // ── 14. baseline: a fresh code still authenticates normally ──────────────
    test('14. a fresh valid code is still accepted on every path', async () => {
        const { user, secret } = await makeUser();
        const res = await post('/mfa/wired', { totpToken: codeAt(secret, 0) }, user);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(idempotencyRuns).toBe(1);
    });

    test('14b. a wrong code is still refused with the original status and body', async () => {
        const { user } = await makeUser();
        const res = await post('/mfa/wired', { totpToken: '000000' }, user);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ success: false, message: 'Invalid 2FA token.' });
        expect(idempotencyRuns).toBe(0);
    });

    // ── 1 + 2. app-unlock and the general middleware share one claim ─────────
    test('1. app-unlock first, then require2FA: the second use is refused', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);

        const first = await post('/app-unlock/totp', { token: code }, user);
        expect(first.status).toBe(200);

        const second = await post('/mfa/wired', { totpToken: code }, user);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('TOTP_REPLAYED');
        expect(idempotencyRuns).toBe(0); // refused BEFORE the idempotency claim
    });

    test('2. require2FA first, then app-unlock: the second use is refused', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);

        expect((await post('/mfa/wired', { totpToken: code }, user)).status).toBe(200);

        const second = await post('/app-unlock/totp', { token: code }, user);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('TOTP_REPLAYED');
    });

    // ── 3. financial middleware, then a sensitive 2FA-disable action ─────────
    test('3. require2FA first, then 2FA-disable: refused, and 2FA stays enabled', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);

        expect((await post('/mfa/wired', { totpToken: code }, user)).status).toBe(200);

        const disable = await post('/security/2fa/disable', { token: code }, user);
        expect(disable.status).toBe(409);
        expect(disable.body.code).toBe('TOTP_REPLAYED');

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { isTwoFactorEnabled: true } });
        expect(after.isTwoFactorEnabled).toBe(true);
    });

    // ── 4. payout address, then saved-MoMo ──────────────────────────────────
    test('4. payout-address verification first, then saved-MoMo: refused', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);

        const addr = await post('/wallet/payout-address', {
            type: 'MOMO', label: 'Test', address: '+233241234567', totpToken: code,
        }, user);
        // The wallet surface has its own destination validation AFTER the TOTP
        // gate; this test is about the claim, so it asserts the gate accepted
        // (never a TOTP refusal) and that the step was really consumed.
        expect(addr.status).not.toBe(401);
        expect(addr.status).not.toBe(409);
        expect(addr.status).not.toBe(503);
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id, step: stepOf(new Date()) } })).toBe(1);

        const momo = await post('/saved-momo', {
            nickname: 'Test', provider: 'MTN', phoneNumber: '+233241234567', totpToken: code,
        }, user);
        expect(momo.status).toBe(409);
        expect(momo.body.code).toBe('TOTP_REPLAYED');
    });

    // ── 5. two admin TOTP actions with the same step ────────────────────────
    test('5. one admin action spends the step; the next admin action is refused', async () => {
        const { user, secret } = await makeUser();
        await prisma.user.update({ where: { id: user.id }, data: { isTwoFactorEnabled: false } });
        const code = codeAt(secret, 0);

        const enable = await post('/security/2fa/verify', { token: code }, user);
        expect(enable.status).toBe(200);

        const disable = await post('/security/2fa/disable', { token: code }, user);
        expect(disable.status).toBe(409);
        expect(disable.body.code).toBe('TOTP_REPLAYED');
    });

    // ── 6. two simultaneous submissions, different routes ───────────────────
    test('6. two simultaneous submissions of one code: exactly one succeeds', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);

        const [a, b] = await Promise.all([
            post('/mfa/wired', { totpToken: code }, user),
            post('/security/2fa/verify', { token: code }, user),
        ]);
        const statuses = [a.status, b.status].sort((x, y) => x - y);
        expect(statuses.filter((s) => s === 200 || s === 409)).toHaveLength(2);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(1);

        const claims = await prisma.totpStepClaim.count({ where: { userId: user.id } });
        expect(claims).toBe(1);
    });

    // ── 7, 8, 9, 10. matched-step boundaries ────────────────────────────────
    test('7. a previous-window code is claimed at the PREVIOUS step', async () => {
        const { user, secret } = await makeUser();
        const expected = stepOf(new Date()) - 1;
        const res = await post('/mfa/wired', { totpToken: codeAt(secret, -1) }, user);
        expect(res.status).toBe(200);
        const claim = await prisma.totpStepClaim.findFirst({ where: { userId: user.id } });
        expect(claim.step).toBe(expected);
    });

    test('8. a current-window code is claimed at the CURRENT step', async () => {
        const { user, secret } = await makeUser();
        const expected = stepOf(new Date());
        expect((await post('/mfa/wired', { totpToken: codeAt(secret, 0) }, user)).status).toBe(200);
        const claim = await prisma.totpStepClaim.findFirst({ where: { userId: user.id } });
        expect(claim.step).toBe(expected);
    });

    test('9. a next-window code is accepted by the existing policy and claimed at the NEXT step', async () => {
        const { user, secret } = await makeUser();
        const expected = stepOf(new Date()) + 1;
        expect((await post('/mfa/wired', { totpToken: codeAt(secret, 1) }, user)).status).toBe(200);
        const claim = await prisma.totpStepClaim.findFirst({ where: { userId: user.id } });
        expect(claim.step).toBe(expected);
    });

    test('10. an already-claimed adjacent step cannot be reused inside its window', async () => {
        const { user, secret } = await makeUser();
        const previousCode = codeAt(secret, -1);
        expect((await post('/mfa/wired', { totpToken: previousCode }, user)).status).toBe(200);
        // Same code again: still inside the acceptance window, already spent.
        const replay = await post('/security/2fa/verify', { token: previousCode }, user);
        expect(replay.status).toBe(409);
        expect(replay.body.code).toBe('TOTP_REPLAYED');
    });

    test('10b. a code two steps outside the window is simply invalid', async () => {
        const { user, secret } = await makeUser();
        const res = await post('/mfa/wired', { totpToken: codeAt(secret, 2) }, user);
        expect(res.status).toBe(401);
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(0);
    });

    // ── 11. users do not block each other ──────────────────────────────────
    test('11. two users can each spend the same time-step with their own secret', async () => {
        const one = await makeUser();
        const two = await makeUser();
        const step = stepOf(new Date());

        expect((await post('/mfa/wired', { totpToken: codeAt(one.secret, 0) }, one.user)).status).toBe(200);
        expect((await post('/mfa/wired', { totpToken: codeAt(two.secret, 0) }, two.user)).status).toBe(200);

        const claims = await prisma.totpStepClaim.findMany({ where: { step } });
        expect(claims.map((c) => c.userId).sort()).toEqual([one.user.id, two.user.id].sort());
    });

    // ── 12. missing table fails closed ─────────────────────────────────────
    test('12. a missing claim table answers 503, never success', async () => {
        const { user, secret } = await makeUser();
        await prisma.$executeRawUnsafe('ALTER TABLE "AppUnlockTotpClaim" RENAME TO "AppUnlockTotpClaim_hidden"');
        try {
            const res = await post('/mfa/wired', { totpToken: codeAt(secret, 0) }, user);
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('TOTP_CLAIM_STORE_UNAVAILABLE');
            expect(res.body.success).toBe(false);
            expect(idempotencyRuns).toBe(0);
        } finally {
            await prisma.$executeRawUnsafe('ALTER TABLE "AppUnlockTotpClaim_hidden" RENAME TO "AppUnlockTotpClaim"');
        }
    });

    // ── 13. a database error while claiming is not success ─────────────────
    test('13. a claim-store write failure throws a typed unavailable error, never success', async () => {
        const broken = {
            totpStepClaim: {
                deleteMany: async () => ({ count: 0 }),
                create: async () => { const e = new Error('connection reset'); e.code = 'P1001'; throw e; },
            },
        };
        const verdict = claimService.verifyAndClaimTotp({
            prisma: broken,
            userId: 1,
            secret: speakeasy.generateSecret({ length: 20 }).base32,
            token: '000000',
        });
        // Invalid code short-circuits before the store is touched.
        await expect(verdict).resolves.toMatchObject({ ok: false, code: 'TOTP_INVALID' });

        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const withValidCode = claimService.verifyAndClaimTotp({
            prisma: broken,
            userId: 1,
            secret,
            token: codeAt(secret, 0),
        });
        await expect(withValidCode).rejects.toMatchObject({ code: 'TOTP_CLAIM_STORE_UNAVAILABLE', statusCode: 503 });
    });

    // ── 15. no credential material stored or logged ────────────────────────
    test('15. the stored claim carries no code, digest or secret, and logs carry none either', async () => {
        const { user, secret } = await makeUser();
        const code = codeAt(secret, 0);
        const warns = [];
        const spyWarn = jest.spyOn(require('../src/config/logger'), 'warn').mockImplementation((...a) => { warns.push(JSON.stringify(a)); });
        const spyError = jest.spyOn(require('../src/config/logger'), 'error').mockImplementation((...a) => { warns.push(JSON.stringify(a)); });
        try {
            expect((await post('/mfa/wired', { totpToken: code }, user)).status).toBe(200);
            expect((await post('/mfa/wired', { totpToken: code }, user)).status).toBe(409);
        } finally {
            spyWarn.mockRestore();
            spyError.mockRestore();
        }

        const claim = await prisma.totpStepClaim.findFirst({ where: { userId: user.id } });
        expect(Object.keys(claim).sort()).toEqual(['createdAt', 'id', 'step', 'userId']);
        expect(JSON.stringify(claim)).not.toContain(code);
        expect(JSON.stringify(claim)).not.toContain(secret);

        const logText = warns.join(' ');
        expect(logText).not.toContain(code);
        expect(logText).not.toContain(secret);
    });

    // ── 17. the production installer preserves existing claims ─────────────
    test('17. re-running the release installer keeps every existing claim', async () => {
        const { user, secret } = await makeUser();
        expect((await post('/mfa/wired', { totpToken: codeAt(secret, 0) }, user)).status).toBe(200);
        const before = await prisma.totpStepClaim.findMany({ where: { userId: user.id } });

        execFileSync(process.execPath, [path.join(__dirname, '..', 'infra', 'install-app-unlock-totp-claim.js')], {
            env: { ...process.env, DATABASE_URL: DB_URL },
            stdio: 'pipe',
        });

        const after = await prisma.totpStepClaim.findMany({ where: { userId: user.id } });
        expect(after).toEqual(before);
    });
});
