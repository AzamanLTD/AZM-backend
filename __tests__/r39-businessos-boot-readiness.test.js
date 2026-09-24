// __tests__/r39-businessos-boot-readiness.test.js
// =============================================================================
// r39/P1 — BUSINESS OS BOOT READINESS (real boot contract, real HTTP).
//
// The reviewer's finding: src/boot/treasury.js invoked
// infra/install-business-os-overlay.js directly and SWALLOWED failure, so
// money-bearing /api/business-os routes could serve against an unverified
// schema. The chosen contract mirrors retailCheckoutIntegrityReady:
//
//   • businessOSReady starts false, set synchronously before any await;
//   • only real overlay convergence flips it true;
//   • in production the businessOSReadiness middleware fails the entire
//     /api/business-os surface closed with a retryable 503 while false;
//   • test/dev environments are explicitly not gated;
//   • the rest of the platform keeps serving while Business OS initializes.
//
// Proofs:
//   1. overlay convergence failure keeps the gate false and never throws
//      (degraded availability, not a crash, not a silent success);
//   2. overlay convergence flips the gate true;
//   3. production + not-ready: /api/business-os answers retryable 503 and
//      the handler is never reached (zero mutation surface);
//   4. production + ready: the request reaches the router (non-503);
//   5. non-production (test) environments are never gated;
//   6. bootTreasury's synchronous prelude closes the race window: the flag
//      exists and is false before any await happens;
//   7. the gate protects only the Business OS — other mounts serve
//      normally while Business OS is not ready.
// =============================================================================
const request = require('supertest');
const express = require('express');

const { businessOSReadiness, bootBusinessOSOverlay } = require('../src/boot/businessOS');
const { bootTreasury } = require('../src/boot/treasury');

describe('r39/P1 — Business OS boot readiness', () => {
    const mkApp = () => {
        const app = express();
        app.use(express.json());
        return app;
    };

    // A representative /api/business-os mount with an observable handler.
    const mountBusinessOS = (app, seen) => {
        app.use('/api/business-os', businessOSReadiness, (req, res) => {
            seen.touched = true;
            res.json({ success: true });
        });
    };

    afterEach(() => { process.env.NODE_ENV = 'test'; });

    test('1. overlay convergence failure keeps the gate false and never throws', async () => {
        const app = mkApp();
        const result = await bootBusinessOSOverlay(app, { exec: async () => { throw new Error('installer crashed'); } });
        expect(result).toBe(false);
        expect(app.get('businessOSReady')).toBe(false);
    });

    test('2. overlay convergence flips the gate true', async () => {
        const app = mkApp();
        const result = await bootBusinessOSOverlay(app, { exec: async () => {} });
        expect(result).toBe(true);
        expect(app.get('businessOSReady')).toBe(true);
    });

    test('3. production + not-ready: retryable 503, handler never reached', async () => {
        process.env.NODE_ENV = 'production';
        const app = mkApp();
        app.set('businessOSReady', false);
        const seen = { touched: false };
        mountBusinessOS(app, seen);
        const res = await request(app).get('/api/business-os/employees/me');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.retryable).toBe(true);
        expect(seen.touched).toBe(false);
    });

    test('4. production + ready: the request reaches the router', async () => {
        process.env.NODE_ENV = 'production';
        const app = mkApp();
        app.set('businessOSReady', true);
        const seen = { touched: false };
        mountBusinessOS(app, seen);
        const res = await request(app).get('/api/business-os/employees/me');
        expect(res.status).toBe(200);
        expect(seen.touched).toBe(true);
    });

    test('5. non-production environments are never gated', async () => {
        process.env.NODE_ENV = 'test';
        const app = mkApp();
        app.set('businessOSReady', false); // even explicitly un-ready
        const seen = { touched: false };
        mountBusinessOS(app, seen);
        const res = await request(app).get('/api/business-os/employees/me');
        expect(res.status).toBe(200);
        expect(seen.touched).toBe(true);
    });

    test('6. bootTreasury closes the startup race: the flag is false before any await', async () => {
        process.env.NODE_ENV = 'production';
        // Force the REAL bootTreasury through its failure path: the overlay
        // installer throws, so convergence must leave the gate closed (and
        // never run the real installer against the disposable test DB).
        const cp = require('child_process');
        const boom = new Error('installer unavailable');
        const orig = cp.execSync;
        cp.execSync = () => { throw boom; };
        try {
            const app = mkApp();
            const prisma = {
                user: { findUnique: async () => null },
                $disconnect: async () => {},
            };
            const booting = bootTreasury(app, prisma);
            // The synchronous prelude has already executed — proven WITHOUT
            // awaiting: a startup-racing request sees both gates closed.
            expect(app.get('businessOSReady')).toBe(false);
            expect(app.get('retailCheckoutIntegrityReady')).toBe(false);
            await booting; // must never throw
            // Overlay convergence failed — the gate stays fail-closed.
            expect(app.get('businessOSReady')).toBe(false);
        } finally {
            cp.execSync = orig;
        }
    });

    test('7. the gate protects only Business OS; other mounts keep serving', async () => {
        process.env.NODE_ENV = 'production';
        const app = mkApp();
        app.set('businessOSReady', false);
        const seen = { touched: false };
        mountBusinessOS(app, seen);
        app.get('/api/wallet/balance', (_req, res) => { res.json({ success: true, mount: 'wallet' }); });
        const bizRes = await request(app).get('/api/business-os/employees/me');
        expect(bizRes.status).toBe(503);
        const walletRes = await request(app).get('/api/wallet/balance');
        expect(walletRes.status).toBe(200);
        expect(walletRes.body.mount).toBe('wallet');
    });
});
