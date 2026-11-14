// __tests__/totp-step-clock-divergence.pg.test.js
// =============================================================================
// §WP-F REGRESSION — verification and the recorded claim MUST share ONE
// captured instant.
//
// THE DEFECT THIS PINS DOWN
// `verifyAndClaimTotp()` computed the claim step as `currentStep(now) + delta`
// but called `speakeasy.totp.verifyDelta()` WITHOUT passing `time`, so the delta
// came from a second, independent clock read. Crossing a 30-second boundary
// between the two reads shifts the two counters apart by one: the row then
// records a step that never matched, and the step that DID match stays unspent,
// so the same authenticator code is accepted again on the next pass.
//
// These tests are deterministic: they inject `now` and (where needed) move
// `Date.now()` to a different instant, which is exactly the divergence window.
// They never depend on wall-clock timing.
//
// FAIL CLOSED: without TEST_DATABASE_URL this suite FAILS in CI rather than
// skipping. A skipped replay proof must never look like a passing build.
// =============================================================================
'use strict';

const express = require('express');
const request = require('supertest');
const speakeasy = require('speakeasy');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const DB_URL = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (!DB_URL && IS_CI) {
    test('WP-F requires TEST_DATABASE_URL in CI', () => {
        throw new Error(
            'TEST_DATABASE_URL is not set in CI. The TOTP clock-divergence proofs cannot run, and a '
            + 'skipped suite must not be reported as a passing build.'
        );
    });
}

const run = DB_URL ? describe : describe.skip;

run('WP-F — one captured instant for TOTP verification and its claim (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { seedUser } = require('./helpers/factories');
    const {
        verifyAndClaimTotp,
        TotpClaimStoreUnavailableError,
        TOTP_CODES,
    } = require('../src/services/totpStepClaimService');

    const STEP_MS = 30 * 1000;
    const STEP_SECONDS = 30;

    let prisma;

    const stepOfMs = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);
    // speakeasy 2.0.0 `_counter()` multiplies `time` by 1000: unit is SECONDS.
    const codeForStep = (secret, step) => speakeasy.totp({
        secret,
        encoding: 'base32',
        time: step * STEP_SECONDS,
    });

    const makeUser = async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        // Identity is random, never clock-derived: these tests mock Date.now, so
        // a timestamp-based fixture would collide on re-runs of the same step.
        const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const user = await seedUser(prisma, {
            isTwoFactorEnabled: true,
            twoFactorSecret: secret,
            username: `wpf_${tag}`,
            email: `wpf_${tag}@test.local`,
            azamanId: `AZM-WPF-${tag}`,
        });
        return { user, secret };
    };

    /** An instant comfortably inside step `step`, never near a boundary. */
    const insideStep = (step) => new Date(step * STEP_MS + 5000);

    beforeAll(async () => {
        prisma = new PrismaClient();
        await prisma.$connect();
        // The production DDL path is the release installer, not db push.
        execFileSync('node', ['infra/install-app-unlock-totp-claim.js'], {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'ignore',
        });
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── 1. the fix itself ────────────────────────────────────────────────────
    test('1. verification is called with the SAME instant that sets the claim step', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);
        const spy = jest.spyOn(speakeasy.totp, 'verifyDelta');

        const verdict = await verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: codeForStep(secret, step), now,
        });

        expect(verdict).toMatchObject({ ok: true, step });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toEqual(expect.objectContaining({
            time: Math.floor(now.getTime() / 1000),
        }));
        // And the pinned instant is in seconds, not milliseconds: a millisecond
        // value would push the counter ~31,000x into the future and never match.
        expect(spy.mock.calls[0][0].time * 1000).toBeLessThan(now.getTime() + 1000);
    });

    // ── 2. the divergence the fix removes, shown on raw speakeasy ─────────────
    test('2. an unpinned verification one step ahead yields the OFF-BY-ONE step (the old bug)', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const step = stepOfMs(Date.now());
        const now = insideStep(step);
        const code = codeForStep(secret, step);

        // What verification saw while reading its own clock, one step later.
        const skewed = speakeasy.totp.verifyDelta({
            secret,
            encoding: 'base32',
            token: code,
            window: 1,
            time: Math.floor((now.getTime() + STEP_MS) / 1000),
        });
        expect(skewed).toEqual({ delta: -1 });

        // old recorded step = currentStep(now) + delta = step - 1, which never matched
        expect(stepOfMs(now.getTime()) + skewed.delta).toBe(step - 1);

        // the pinned call, same clock skew on the machine, records the real step
        jest.spyOn(Date, 'now').mockReturnValue(now.getTime() + STEP_MS);
        const { user } = await makeUser();
        const verdict = await verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: code, now,
        });
        expect(verdict).toMatchObject({ ok: true, step });
    });

    // ── 3. a boundary crossing cannot move the recorded step ──────────────────
    test('3. the clock crossing a 30s boundary mid-call cannot move the claimed step', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);

        // Machine clock one full step ahead of the injected instant: the widest
        // possible divergence between "when we looked" and "when we claimed".
        jest.spyOn(Date, 'now').mockReturnValue(now.getTime() + STEP_MS);

        const verdict = await verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: codeForStep(secret, step), now,
        });
        expect(verdict).toMatchObject({ ok: true, step });

        const rows = await prisma.totpStepClaim.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].step).toBe(step);
    });

    // ── 4. and therefore the code cannot be spent twice ───────────────────────
    test('4. the same code cannot be accepted twice, even if the first claim crossed a boundary', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);
        const code = codeForStep(secret, step);

        jest.spyOn(Date, 'now').mockReturnValue(now.getTime() + STEP_MS);
        const first = await verifyAndClaimTotp({ prisma, userId: user.id, secret, token: code, now });
        expect(first).toMatchObject({ ok: true, step });

        jest.restoreAllMocks();
        // Second presentation, still inside the same step, normal clock.
        const second = await verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: code, now: new Date(now.getTime() + 1000),
        });
        expect(second).toEqual({ ok: false, code: TOTP_CODES.REPLAYED, step });

        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(1);
    });

    // ── 5. concurrency ────────────────────────────────────────────────────────
    test('5. concurrent submissions of one code: exactly one winner', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);
        const code = codeForStep(secret, step);

        const verdicts = await Promise.all(Array.from({ length: 5 }, () => verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: code, now,
        })));

        expect(verdicts.filter((v) => v.ok)).toHaveLength(1);
        expect(verdicts.filter((v) => v.code === TOTP_CODES.REPLAYED)).toHaveLength(4);
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(1);
    });

    // ── 6. window policy retained: previous / current / next ─────────────────
    test('6. previous, current and next window each claim their own matched step', async () => {
        const step = stepOfMs(Date.now());
        const now = insideStep(step);

        for (const offset of [-1, 0, 1]) {
            const { user, secret } = await makeUser();
            const verdict = await verifyAndClaimTotp({
                prisma, userId: user.id, secret, token: codeForStep(secret, step + offset), now,
            });
            expect(verdict).toMatchObject({ ok: true, step: step + offset });
        }

        // two steps outside the window is simply invalid, unchanged policy
        const { user, secret } = await makeUser();
        const far = await verifyAndClaimTotp({
            prisma, userId: user.id, secret, token: codeForStep(secret, step + 2), now,
        });
        expect(far).toEqual({ ok: false, code: TOTP_CODES.INVALID });
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(0);
    });

    // ── 7. an adjacent claimed step is still unusable ────────────────────────
    test('7. a claimed next-window step cannot be presented again', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);

        expect(await verifyAndClaimTotp({ prisma, userId: user.id, secret, token: codeForStep(secret, step), now }))
            .toMatchObject({ ok: true, step });
        expect(await verifyAndClaimTotp({ prisma, userId: user.id, secret, token: codeForStep(secret, step + 1), now }))
            .toMatchObject({ ok: true, step: step + 1 });
        expect(await verifyAndClaimTotp({ prisma, userId: user.id, secret, token: codeForStep(secret, step + 1), now }))
            .toEqual({ ok: false, code: TOTP_CODES.REPLAYED, step: step + 1 });
    });

    // ── 8. per-user isolation ────────────────────────────────────────────────
    test('8. one user spending a step does not spend it for another user', async () => {
        const step = stepOfMs(Date.now());
        const now = insideStep(step);
        const a = await makeUser();
        const b = await makeUser();

        expect(await verifyAndClaimTotp({ prisma, userId: a.user.id, secret: a.secret, token: codeForStep(a.secret, step), now }))
            .toMatchObject({ ok: true, step });
        expect(await verifyAndClaimTotp({ prisma, userId: b.user.id, secret: b.secret, token: codeForStep(b.secret, step), now }))
            .toMatchObject({ ok: true, step });
    });

    // ── 9. missing table fails closed ────────────────────────────────────────
    test('9. a missing claim table is a typed unavailability, never a success', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const now = insideStep(step);

        await prisma.$executeRawUnsafe('ALTER TABLE "AppUnlockTotpClaim" RENAME TO "AppUnlockTotpClaim_hidden"');
        try {
            await expect(verifyAndClaimTotp({
                prisma, userId: user.id, secret, token: codeForStep(secret, step), now,
            })).rejects.toBeInstanceOf(TotpClaimStoreUnavailableError);
        } finally {
            await prisma.$executeRawUnsafe('ALTER TABLE "AppUnlockTotpClaim_hidden" RENAME TO "AppUnlockTotpClaim"');
        }
        // and the code is still unspent, so nothing was claimed by the failure
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(0);
    });

    // ── 10. a failed claim cannot let an economic action proceed ─────────────
    test('10. a failed claim store blocks the action behind require2FA (idempotency never reached)', async () => {
        const { user, secret } = await makeUser();
        const step = stepOfMs(Date.now());
        const code = codeForStep(secret, step);
        const { require2FA } = require('../middleware/require2FA');

        let idempotencyRuns = 0;
        const buildApp = (client) => {
            const a = express();
            a.use(express.json());
            a.set('prisma', client);
            // protect is stubbed: it needs a JWT session, not a TOTP.
            a.use((req, _res, next) => { req.user = { id: user.id }; next(); });
            a.post('/money', require2FA(), (_req, _res, next) => { idempotencyRuns += 1; next(); }, (_req, res) => {
                res.status(200).json({ success: true });
            });
            return a;
        };

        // (a) claim store broken -> 503, economic middleware never runs
        const brokenClient = {
            user: prisma.user,
            totpStepClaim: {
                deleteMany: async () => {},
                create: async () => { throw Object.assign(new Error('connection lost'), { code: 'P1001' }); },
            },
        };
        const broken = await request(buildApp(brokenClient)).post('/money').send({ totpToken: code });
        expect(broken.status).toBe(503);
        expect(broken.body.code).toBe(TOTP_CODES.UNAVAILABLE);
        expect(idempotencyRuns).toBe(0);

        // (b) replay -> 409, economic middleware never runs
        const first = await request(buildApp(prisma)).post('/money').send({ totpToken: code });
        expect(first.status).toBe(200);
        expect(idempotencyRuns).toBe(1);
        const second = await request(buildApp(prisma)).post('/money').send({ totpToken: code });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe(TOTP_CODES.REPLAYED);
        expect(idempotencyRuns).toBe(1);
    });
});
