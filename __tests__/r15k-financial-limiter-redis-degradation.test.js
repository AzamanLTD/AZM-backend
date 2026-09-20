// __tests__/r15k-financial-limiter-redis-degradation.test.js
// r15 follow-up: the financial tier previously shared the fail-open posture of
// the other tiers — when the shared Redis store was unavailable (e.g. Upstash
// quota exhaustion, which in practice lasted DAYS), financial rate limiting was
// DISABLED ENTIRELY: trade/withdraw/escrow endpoints became unlimited for
// attackers for as long as Redis was down.
//
// The corrected contract: the financial tier FAILS SAFE. When Redis is
// unavailable it degrades to an in-process memory limiter with the SAME
// thresholds — the documented no-Redis posture (per-instance bound; N
// instances → N× the cap, the same class as single-box dev) — instead of an
// unbounded no-protection window.
//
// The degraded state is driven through the module's test hook (__setRedis-
// ErroringForTest), which flips exactly the flag a quota-exhausted or
// partitioned Upstash produces. No real Redis handle is needed to prove the
// routing contract: the hook feeds the same fallback the real store error
// takes (the fast path and the error path both call it).

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const middleware = require('../middleware/rateLimitMiddleware');

const buildApp = () => {
    const app = express();
    app.use('/api/fin', middleware.financialLimiter, (req, res) => res.json({ ok: true }));
    return app;
};

describe('r15k: financial tier degradation when Redis is unavailable', () => {
    afterEach(() => middleware.__setRedisErroringForTest(false));

    test('DEGRADED: financial endpoints are STILL limited — 10 pass, the 11th gets 429 (never unlimited)', async () => {
        middleware.__setRedisErroringForTest(true);
        const app = buildApp();
        const statuses = [];
        for (let i = 0; i < 11; i++) {
            statuses.push((await request(app).get('/api/fin')).status);
        }
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
        expect(statuses[10]).toBe(429);
    });

    test('DEGRADED: the verified-identity bucket contract is preserved (per-user buckets)', async () => {
        middleware.__setRedisErroringForTest(true);
        const app = buildApp();
        const SECRET = process.env.JWT_SECRET;
        const token = jwt.sign({ id: 9931 }, SECRET, { expiresIn: '1h' });
        let last = 0;
        for (let i = 0; i < 12; i++) {
            last = (await request(app).get('/api/fin').set('Authorization', `Bearer ${token}`)).status;
        }
        expect(last).toBe(429); // memory fallback enforces the same 10/min cap
    });

    test('DEGRADED: two different users keep independent buckets', async () => {
        middleware.__setRedisErroringForTest(true);
        const app = buildApp();
        const SECRET = process.env.JWT_SECRET;
        const t1 = jwt.sign({ id: 9941 }, SECRET, { expiresIn: '1h' });
        const t2 = jwt.sign({ id: 9942 }, SECRET, { expiresIn: '1h' });
        for (let i = 0; i < 10; i++) {
            expect((await request(app).get('/api/fin').set('Authorization', `Bearer ${t1}`)).status).toBe(200);
        }
        expect((await request(app).get('/api/fin').set('Authorization', `Bearer ${t1}`)).status).toBe(429);
        expect((await request(app).get('/api/fin').set('Authorization', `Bearer ${t2}`)).status).toBe(200);
    });

    test('RECOVERED: clearing the error flag returns the tier to its normal limiter', async () => {
        middleware.__setRedisErroringForTest(true);
        const app = buildApp();
        // Degraded limiter throttles at cap...
        let last = 0;
        for (let i = 0; i < 11; i++) {
            last = (await request(app).get('/api/fin/degraded-recovery-check')).status;
        }
        expect(last).toBe(429);
        // ...and the flag clears without side effects (new window via the
        // distinct path key; the normal limiter must operate again).
        middleware.__setRedisErroringForTest(false);
        last = (await request(app).get('/api/fin/recovered-check')).status;
        expect(last).toBe(200);
    });
});
