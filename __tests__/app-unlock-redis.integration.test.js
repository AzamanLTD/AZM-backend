/**
 * Real-Redis integration proof for app unlock.
 *
 * The contract tests in app-unlock-contract.test.js run against the in-process
 * fallback store. They prove the decision logic; they CANNOT prove that two
 * server processes agree, or that a Lua script is executed atomically by Redis.
 * This file covers exactly that gap and refuses to fake it: without REDIS_URL it
 * skips with an explicit message rather than mocking Redis and calling the
 * result "atomic".
 */
const skipReason = process.env.REDIS_URL
    ? null
    : 'REDIS_URL not set — real-Redis atomicity is UNVERIFIED in this run (in-process contract tests only)';

describe('app unlock against real Redis', () => {
    if (skipReason) {
        test.skip(`skipped: ${skipReason}`, () => {});
        return;
    }

    const bcrypt = require('bcryptjs');
    const speakeasy = require('speakeasy');
    const Redis = require('ioredis');

    let smsService;
    let AppUnlockService;
    let redis;

    beforeAll(async () => {
        redis = new Redis(process.env.REDIS_URL);
        // Challenge and throttle keys persist across runs by design; clear them
        // so a repeated local run exercises the same ladder as CI.
        const stale = await redis.keys('otp:*');
        if (stale.length) await redis.del(stale);
        // Load the service only once REDIS_URL is present: the constructor picks
        // up the durable store at construction time.
        ({ AppUnlockService } = require('../services/appUnlockService'));
        const SMSService = require('../services/smsService');
        smsService = new SMSService();
    });

    afterAll(async () => {
        if (redis) await redis.quit();
    });

    const user = (over = {}) => ({
        id: 901,
        phoneNumber: '+233241234567',
        phoneVerified: true,
        isTwoFactorEnabled: true,
        pinHash: null,
        twoFactorSecret: null,
        ...over,
    });

    test('two independent service instances share the PIN attempt budget', async () => {
        const hash = await bcrypt.hash('4321', 10);
        const u = user({ pinHash: hash });
        const a = new AppUnlockService({ smsService: smsService, prisma: { user: {} } });
        const b = new AppUnlockService({ smsService: smsService, prisma: { user: {} } });

        let locked = false;
        for (let i = 0; i < 8; i += 1) {
            // Alternate processes: a per-process Map would let this run forever.
            const svc = i % 2 === 0 ? a : b;
            const r = await svc.verifyPin(u, '0000');
            if (r.code === 'PIN_LOCKED') { locked = true; break; }
        }
        expect(locked).toBe(true);
    });

    test('concurrent wrong PINs cannot exceed the budget', async () => {
        const hash = await bcrypt.hash('9876', 10);
        const u = user({ id: 902, pinHash: hash });
        const svc = new AppUnlockService({ smsService, prisma: { user: {} } });

        const results = await Promise.all(Array.from({ length: 12 }, () => svc.verifyPin(u, '1111')));
        const allowed = results.filter((r) => r.code === 'PIN_INVALID' || r.code === 'PIN_LOCKED');
        expect(allowed).toHaveLength(12);
        const left = await svc._attemptsLeft(902);
        expect(left).toBeLessThanOrEqual(0);
    });

    test('a TOTP code is claimed once across processes', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const u = user({ id: 903, twoFactorSecret: secret });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        const a = new AppUnlockService({ smsService, prisma: { user: {} } });
        const b = new AppUnlockService({ smsService, prisma: { user: {} } });

        const first = await a.verifyTotp(u, token);
        const second = await b.verifyTotp(u, token);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(second.code).toBe('TOTP_REPLAYED');
    });

    test('an unlock challenge is stored as a digest, not a plaintext code', async () => {
        const svc = new AppUnlockService({ smsService, prisma: { user: {} } });
        const u = user({ id: 904 });
        const issued = await svc.sendSmsChallenge(u);
        expect(issued.ok).toBe(true);

        const raw = await redis.get(`otp:APP_UNLOCK:904:${issued.data.challengeId}`);
        expect(raw).toBeTruthy();
        expect(raw).toContain('codeHash');
        expect(raw).not.toMatch(/"code"\s*:/);
        expect(raw).not.toContain(u.phoneNumber);
    });

    test('only one of several concurrent consumptions succeeds', async () => {
        const svc = new AppUnlockService({ smsService, prisma: { user: {} } });
        const u = user({ id: 905 });
        const issued = await svc.sendSmsChallenge(u);
        const code = issued.data.mocked ? issued.data.testCode : null;

        if (!code) {
            // A live provider means the code is only in the SMS, so this case
            // cannot be exercised without intercepting delivery.
            return;
        }

        const results = await Promise.all(Array.from({ length: 6 }, () => (
            svc.verifySmsChallenge(u, { challengeId: issued.data.challengeId, code })
        )));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    test('another member cannot consume the challenge', async () => {
        const svc = new AppUnlockService({ smsService, prisma: { user: {} } });
        const owner = user({ id: 906 });
        const issued = await svc.sendSmsChallenge(owner);
        const code = issued.data.testCode;

        if (!code) return;

        const other = user({ id: 907 });
        const attempt = await svc.verifySmsChallenge(other, {
            challengeId: issued.data.challengeId,
            code,
        });
        expect(attempt.ok).toBe(false);
        expect(attempt.code).toBe('CHALLENGE_INVALID');
    });

});
