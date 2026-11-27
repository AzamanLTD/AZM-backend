// __tests__/tp-trade-accept-kyc.pg.test.js
// =============================================================================
// §D #383 — trade ACCEPTANCE is a KYC action boundary, proved ECONOMICALLY.
//
// Knowing the route name is not proof. This suite drives the REAL mounted route
// (POST /api/trades/accept) over supertest against real PostgreSQL and asserts
// the money did NOT move for an unverified vendor, then that it DOES move once
// the vendor is verified. A gate that refuses everybody, or one that is mounted
// but never reached, cannot pass both halves.
//
// Why accept, not just initiate: acceptTrade runs as the VENDOR and, on a SELL
// ad, decrements that vendor's vendorUnallocatedBalance and increments
// escrowLockedBalance — the acceptor locks their OWN funds into escrow, so the
// initiator's KYC at /initiate says nothing about this boundary.
// =============================================================================
'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Accepting a trade locks escrow, so the route carries a second factor
// (require2FA). The vendor has no TOTP, so its factor is its password, as a
// real client sends it. The fixture therefore stores a real bcrypt hash.
const VENDOR_PASSWORD = 'TradeVendor1!secure';
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);

const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('#383 trade acceptance is a KYC economic boundary (real PostgreSQL)', () => {
    let app;
    let prisma;
    let vendor;
    let initiator;
    let trade;

    const ESCROW = 10; // USDC the vendor locks
    const tokenFor = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    beforeAll(async () => {
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_exactly_32_characters_long';
        process.env.DATABASE_URL = DB_URL;
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        app = require('../server');

        vendor = await prisma.user.create({
            data: {
                username: `tp_vendor_${RUN}`,
                email: `tp_vendor_${RUN}@example.test`,
                password: await bcrypt.hash(VENDOR_PASSWORD, 4),
                kycStatus: 'UNVERIFIED',
                vendorUnallocatedBalance: 100,
                escrowLockedBalance: 0,
            },
        });
        initiator = await prisma.user.create({
            data: {
                username: `tp_init_${RUN}`,
                email: `tp_init_${RUN}@example.test`,
                password: 'x'.repeat(20),
                kycStatus: 'VERIFIED',
                availableBalance: 100,
            },
        });
        trade = await prisma.trade.create({
            data: {
                crypto: 'USDC',
                amountCrypto: ESCROW,
                amountFiat: 130,
                rate: 13,
                type: 'SELL',
                status: 'PENDING',
                vendorId: vendor.id,
                userId: initiator.id,
                expiresAt: new Date(Date.now() + 3600_000),
            },
        });
    }, 60000);

    afterAll(async () => {
        if (!prisma) return;
        await prisma.ledgerTransaction.deleteMany({
            where: { idempotencyKey: { contains: `escrow-lock:${trade?.id}` } },
        }).catch(() => {});
        await prisma.transactionHistory.deleteMany({
            where: { userId: { in: [vendor?.id, initiator?.id].filter(Boolean) } },
        }).catch(() => {});
        await prisma.trade.deleteMany({ where: { id: trade?.id } }).catch(() => {});
        // Identities stay: other suites' ledger rows may reference them.
        await prisma.$disconnect();
    }, 60000);

    test('an UNVERIFIED vendor is refused at the real route with a typed KYC code', async () => {
        const res = await request(app)
            .post('/api/trades/accept')
            .set('Authorization', `Bearer ${tokenFor(vendor)}`)
            .send({ tradeId: trade.id });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('KYC_REQUIRED');
        expect(res.body.requiredFor).toBe('trade');
    }, 60000);

    test('the refusal happens BEFORE any balance, escrow or ledger mutation', async () => {
        const after = await prisma.user.findUnique({
            where: { id: vendor.id },
            select: { vendorUnallocatedBalance: true, escrowLockedBalance: true },
        });
        expect(String(after.vendorUnallocatedBalance)).toBe('100');
        expect(String(after.escrowLockedBalance)).toBe('0');

        const stillPending = await prisma.trade.findUnique({ where: { id: trade.id }, select: { status: true } });
        expect(stillPending.status).toBe('PENDING');

        const ledgerRows = await prisma.ledgerTransaction.count({
            where: { idempotencyKey: { contains: `escrow-lock:${trade.id}` } },
        }).catch(() => 0);
        expect(ledgerRows).toBe(0);

        const historyRows = await prisma.transactionHistory.count({
            where: { userId: { in: [vendor.id, initiator.id] } },
        });
        expect(historyRows).toBe(0);
    }, 60000);

    test('a KYC-VERIFIED vendor retains the valid acceptance path and the funds DO move', async () => {
        await prisma.user.update({ where: { id: vendor.id }, data: { kycStatus: 'VERIFIED' } });

        const res = await request(app)
            .post('/api/trades/accept')
            .set('Authorization', `Bearer ${tokenFor(vendor)}`)
            // The idempotency middleware sits AFTER the KYC gate and demands a
            // key. The unverified call got 403 without ever reaching it, which
            // is the ordering being asserted; this call must satisfy it.
            .set('Idempotency-Key', `tp-accept-${RUN}`)
            .send({ tradeId: trade.id, password: VENDOR_PASSWORD });

        expect(res.status).toBe(200);

        const after = await prisma.user.findUnique({
            where: { id: vendor.id },
            select: { vendorUnallocatedBalance: true, escrowLockedBalance: true },
        });
        expect(Number(after.vendorUnallocatedBalance)).toBe(100 - ESCROW);
        expect(Number(after.escrowLockedBalance)).toBe(ESCROW);

        const accepted = await prisma.trade.findUnique({ where: { id: trade.id }, select: { status: true } });
        expect(accepted.status).not.toBe('PENDING');
    }, 60000);

    test('no alternate trades route reaches the accept handler without the KYC gate', () => {
        // Structural companion to the economic proof. Express 5 no longer
        // exposes app._router, so inspect the trades Router itself: every POST
        // route on the accept path must carry kycGate in its chain, positioned
        // before the idempotency layer and before the terminal handler. A
        // second alias added later fails here instead of silently bypassing
        // the boundary.
        const tradeRoutes = require('../routes/tradeRoutes');
        const found = [];
        for (const layer of tradeRoutes.stack) {
            if (!layer.route) continue;
            const path = layer.route.path;
            if (!/accept/i.test(String(path))) continue;
            const names = layer.route.stack.map((fn) => fn.name);
            found.push({ path, methods: layer.route.methods, names });
        }
        expect(found.length).toBeGreaterThan(0);
        for (const r of found) {
            const gateAt = r.names.indexOf('kycGate');
            const idemAt = r.names.findIndex((n) => /idempot/i.test(n));
            const terminalAt = r.names.length - 1;
            // kycGate present, and strictly before the terminal handler.
            expect({ path: r.path, gated: gateAt >= 0, beforeHandler: gateAt >= 0 && gateAt < terminalAt })
                .toEqual({ path: r.path, gated: true, beforeHandler: true });
            // and before idempotency when that layer exists (ordering contract).
            if (idemAt >= 0) expect(gateAt).toBeLessThan(idemAt);
        }
    });
});
