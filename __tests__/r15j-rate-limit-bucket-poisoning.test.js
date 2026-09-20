// __tests__/r15j-rate-limit-bucket-poisoning.test.js
// r15 follow-up: the financial rate-limit tier keyed its per-user bucket on an
// UNVERIFIED jwt.decode of the Authorization header. Any client could forge a
// token claiming a victim's id and exhaust the victim's 10/min financial
// bucket — a targeted denial-of-service on withdrawals/trades/savings/escrow.
//
// These proofs pin the corrected contract: only a cryptographically VERIFIED
// claim (signature + expiry) may consume a user's bucket; a forged claim falls
// back to the requester's own IP bucket.

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { financialLimiter } = require('../middleware/rateLimitMiddleware');

const SECRET = process.env.JWT_SECRET || 'test_secret_exactly_32_characters_long';

const buildApp = () => {
    const app = express();
    // Mirrors the mounted contract: financial routes sit behind financialLimiter.
    app.use('/api/fin', financialLimiter, (req, res) => res.json({ ok: true }));
    return app;
};

const signFor = (id) => jwt.sign({ id }, SECRET, { expiresIn: '1h' });

describe('r15j: financial rate-limit bucket poisoning', () => {
    test('a VERIFIED token claims its user bucket: 10 pass, the 11th is refused (429)', async () => {
        const app = buildApp();
        const token = signFor(9901);
        for (let i = 0; i < 10; i++) {
            const res = await request(app).get('/api/fin').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(200);
        }
        const res = await request(app).get('/api/fin').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(429);
    });

    test('FORGED tokens claiming a victim id CANNOT poison the victim bucket (the exploit is closed)', async () => {
        const app = buildApp();
        const victimToken = signFor(9902); // the real, verified token

        // The attack: forged headers claiming the victim's id, sent by someone
        // who does not hold the signing secret. Old behavior: these requests
        // consumed `user_9902` directly from jwt.decode. New behavior: they are
        // unverified → they fall to the attacker's IP bucket.
        const forged = jwt.sign({ id: 9902 }, 'attacker-does-not-know-the-secret');
        for (let i =  0; i < 20; i++) {
            await request(app).get('/api/fin').set('Authorization', `Bearer ${forged}`);
        }

        // The victim's own verified request is unaffected: their bucket was
        // never touched by the forged traffic.
        const res = await request(app).get('/api/fin').set('Authorization', `Bearer ${victimToken}`);
        expect(res.status).toBe(200);
    });

    test('the attacker still gets limited: forged traffic exhausts their own IP bucket (429)', async () => {
        const app = buildApp();
        const forged = jwt.sign({ id: 9903 }, 'attacker-does-not-know-the-secret');
        let lastStatus = 0;
        for (let i = 0; i < 15; i++) {
            const res = await request(app).get('/api/fin').set('Authorization', `Bearer ${forged}`);
            lastStatus = res.status;
        }
        expect(lastStatus).toBe(429); // IP bucket cap reached — attacker throttled
    });

    test('an EXPIRED but correctly signed token no longer claims the user bucket (falls to IP)', async () => {
        const app = buildApp();
        const expired = jwt.sign({ id: 9904 }, SECRET, { expiresIn: '-1h' });
        // Downstream `protect` would reject it; the key generator must not let
        // it consume user_9904 either — it falls to the IP key.
        const fresh = signFor(9904);
        for (let i = 0; i < 20; i++) {
            await request(app).get('/api/fin').set('Authorization', `Bearer ${expired}`);
        }
        const res = await request(app).get('/api/fin').set('Authorization', `Bearer ${fresh}`);
        expect(res.status).toBe(200); // the user's bucket was never poisoned
    });

    test('requests with no Authorization header key on IP (unchanged behavior)', async () => {
        const app = buildApp();
        let lastStatus = 0;
        for (let i = 0; i < 12; i++) {
            const res = await request(app).get('/api/fin');
            lastStatus = res.status;
        }
        expect(lastStatus).toBe(429);
    });
});
