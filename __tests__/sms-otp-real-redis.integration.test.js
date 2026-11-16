'use strict';

/**
 * Phone-verification OTP against a REAL Redis, end to end.
 *
 * app-unlock-redis.integration.test.js proves the unlock-challenge path against
 * a real server. The customer-facing phone verification (sendOTP / verifyOTP)
 * had no real-Redis proof at all — only the in-process fallback, which cannot
 * show the one thing that matters in production: a pending code surviving a
 * restart.
 *
 * Skips with an explicit reason when REDIS_URL is absent. Point either
 * REDIS_URL_LIVE (local or hosted) or REDIS_URL at a real server:
 *
 *   REDIS_URL=redis://127.0.0.1:6399 npx jest __tests__/sms-otp-real-redis.integration.test.js
 *
 * The service is constructed with the mock SMS provider so no carrier is
 * contacted, but REDIS_URL is set, so the DURABLE path is what executes.
 */

const REDIS_URL = process.env.REDIS_URL_LIVE || process.env.REDIS_URL || '';
const skipReason = REDIS_URL
    ? null
    : 'REDIS_URL not set — the durable OTP path is UNVERIFIED in this run (in-process fallback only)';

describe('phone OTP against a real Redis', () => {
    if (skipReason) {
        test.skip(`skipped: ${skipReason}`, () => {});
        return;
    }

    let Redis;
    let SMSService;
    let redis;
    let svc;
    let phoneSeq = 0;

    // A fresh number per case: the send throttle is per phone and deliberately
    // sticky for 30s, so sharing numbers would test the throttle, not the store.
    const nextPhone = () => `+2332${String(Date.now()).slice(-6)}${phoneSeq++}`;

    const newService = () => {
        // A NEW instance is the point: it has no memory of the previous one, so
        // anything that verifies across instances lived in Redis.
        const Svc = require('../services/smsService');
        return new Svc();
    };

    beforeAll(async () => {
        Redis = require('ioredis');
        redis = new Redis(REDIS_URL);
        process.env.REDIS_URL = REDIS_URL;
        delete process.env.NODE_ENV;          // development: mock provider, no carrier
        process.env.SMS_PROVIDER = 'mock';
        process.env.OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-only-otp-digest-secret-32chars';
        const stale = await redis.keys('otp:*');
        if (stale.length) await redis.del(stale);
        SMSService = require('../services/smsService');
        svc = new SMSService();
    });

    afterAll(async () => {
        const stale = await redis.keys('otp:*');
        if (stale.length) await redis.del(stale);
        await redis.quit();
        delete process.env.REDIS_URL;
    });

    test('the durable store is actually in use, not the Map', () => {
        expect(svc._redisClient).toBeTruthy();
        expect(svc.otpStore.size).toBe(0);
    });

    test('a sent code lands in Redis as a DIGEST, never as the plaintext', async () => {
        const phone = nextPhone();
        const sent = await svc.sendOTP(phone);
        expect(sent.success).toBe(true);

        const raw = await redis.get(`otp:${phone}`);
        expect(raw).toBeTruthy();                       // it is in Redis
        expect(raw).not.toContain(sent.otp);            // never the plaintext code
        const record = JSON.parse(raw);
        expect(record.codeHash).toBeTruthy();
        expect(record.expiresAtMs).toBeGreaterThan(Date.now());
        expect(record.attempts).toBe(0);
    });

    test('the code verifies exactly once against the real server', async () => {
        const phone = nextPhone();
        const sent = await svc.sendOTP(phone);

        const first = await svc.verifyOTP(phone, sent.otp);
        expect(first.success).toBe(true);

        const second = await svc.verifyOTP(phone, sent.otp);
        expect(second.success).toBe(false);             // single use
        expect(await redis.get(`otp:${phone}`)).toBeNull();
    });

    test('a code issued by one instance verifies on a FRESH instance — the spin-down case', async () => {
        const phone = nextPhone();
        const sent = await svc.sendOTP(phone);

        // Simulate a Render spin-down: the object that issued the code is gone.
        const afterRestart = newService();
        expect(afterRestart).not.toBe(svc);
        expect(afterRestart.otpStore.size).toBe(0);     // holds nothing in memory

        const verified = await afterRestart.verifyOTP(phone, sent.otp);
        expect(verified.success).toBe(true);
    });

    test('wrong codes burn the attempt budget in Redis and then lock out', async () => {
        const phone = nextPhone();
        const sent = await svc.sendOTP(phone);
        const wrong = sent.otp === '000000' ? '111111' : '000000';

        const a = await svc.verifyOTP(phone, wrong);
        expect(a.success).toBe(false);
        expect(a.message).toMatch(/invalid/i);

        // Attempts are persisted, not counted in the caller's memory.
        const record = JSON.parse(await redis.get(`otp:${phone}`));
        expect(record.attempts).toBe(1);

        await svc.verifyOTP(phone, wrong);
        const third = await svc.verifyOTP(phone, wrong);
        expect(third.success).toBe(false);
        expect(third.message).toMatch(/maximum/i);

        // The correct code is now useless — the lock is authoritative.
        const tooLate = await svc.verifyOTP(phone, sent.otp);
        expect(tooLate.success).toBe(false);
    });

    test('the resend throttle is enforced by Redis, not by process memory', async () => {
        const phone = nextPhone();
        await svc.sendOTP(phone);

        // A different instance still sees the reservation: the limit is shared.
        const other = newService();
        await expect(other.sendOTP(phone)).rejects.toMatchObject({ code: 'OTP_RESEND_TOO_SOON' });
    });

    test('verifying an unknown number is a clean not-found, not an error', async () => {
        const result = await svc.verifyOTP('+233299999999', '123456');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no otp/i);
    });
});
