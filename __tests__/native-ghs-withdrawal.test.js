// __tests__/native-ghs-withdrawal.test.js
// =============================================================================
// Native-GHS withdrawal leg — issue #389 (Agent A). Real-PostgreSQL proof.
//
// PROVES:
//   A. Flag OFF (default) — the route refuses 503 with ZERO mutation.
//   B. Flag ON, GHS-only — the customer's native GHS wallet is debited in
//      EXACT pesewas, USDC availableBalance is NEVER touched, the §P.4
//      posting D ghs:user:{id}:liability / C fiat:momo:ghs commits under the
//      durable key, the P5-D GHS reservation is single-winner, and the
//      provider dispatch carries the EXACT GHS amount once.
//   C. GHS-only NEVER depends on an FX rate: with a STALE canonical rate the
//      payout still settles (while the shortfall quote fails closed).
//   D. Shortfall — no quote means 409 with zero mutation; a consented quote
//      funds EXACTLY the shortfall and is consumed ONCE (replay refused).
//   E. Dust/precision — 0.00 and sub-pesewa inputs are refused before any
//      mutation.
//   F. Provider rejection — the reservation reverses ONCE (GHS restored, the
//      USDC funding restored, reservation released, rows FAILED); a second
//      reversal is refused.
//   G. Concurrency — two payouts racing cannot overdraw native GHS.
//   H. Middleware order — 2FA is enforced BEFORE the idempotency claim.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-withdrawal.test] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
}

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const { Prisma } = require('@prisma/client');

describe('native-GHS withdrawal leg (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let seedUser, TEST_PASSWORD;
    let svc;
    let planner;

    const RATE = 13.42;

    function buildApp(dispatcher) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        if (dispatcher) app.set('paymentFailoverService', dispatcher);
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    async function setSettings({ withdrawal = true, freshRate = true } = {}) {
        const data = {
            liveRetailRate: RATE,
            liveUsdToGhs: RATE,
            liveRateSource: 'KOTANI_PAY',
            lastExternalSync: freshRate ? new Date() : new Date(Date.now() - 60 * 60 * 1000),
            fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false,
            nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: withdrawal,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        // P5-D provider liquidity: fund the GHS float so the single-winner
        // reservation can actually claim (the same seeding the p5d suite uses).
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });
    }

    async function ghsUser({ ghs = 500, usdc = 1000 } = {}) {
        const user = await seedUser(prisma, { availableBalance: usdc });
        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: new Prisma.Decimal(String(ghs)) } });
        return user;
    }

    const ghsPost = (app, user, body = {}, key = randomUUID()) => request(app)
        .post('/api/withdraw/ghs')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .set('Idempotency-Key', key)
        .send({ password: TEST_PASSWORD, destination: '233241234567', network: 'MTN', ...body });

    const quotePost = (app, user, body = {}, key = randomUUID()) => request(app)
        .post('/api/withdraw/ghs/quote')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .set('Idempotency-Key', key)
        .send({ destination: '233241234567', ...body });


    // Post-response dispatch is asynchronous by contract (the 202 is emitted
    // at the commit boundary). Wait for the single-winner claim to move the
    // canonical row out of PENDING before asserting dispatch facts.
    async function waitForDispatch(reference, ms = 4000) {
        const started = Date.now();
        while (Date.now() - started < ms) {
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
            if (!row || row.status !== 'PENDING') return row?.status ?? null;
            await new Promise((r) => setTimeout(r, 25));
        }
        return 'TIMEOUT';
    }

    const ledgerKeys = async (prefix) => prisma.ledgerTransaction.findMany({ where: { idempotencyKey: { startsWith: prefix } } });

    beforeAll(async () => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        planner = require('../src/services/ghsFundingPlanner');
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { nativeGhsWithdrawalEnabled: false, nativeGhsSettlementEnabled: false, modelBSettlementEnabled: false },
            }).catch(() => {});
            await prisma.$disconnect();
        }
    });

    // ── A. flag OFF ─────────────────────────────────────────────────────────
    test('flag OFF: the route refuses 503 with ZERO mutation', async () => {
        await setSettings({ withdrawal: false });
        const user = await ghsUser({ ghs: 300 });
        const before = await prisma.ledgerTransaction.count();
        const res = await ghsPost(buildApp(), user, { amountGhs: '50.00' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('NATIVE_GHS_WITHDRAWAL_DISABLED');
        expect(await prisma.ledgerTransaction.count()).toBe(before);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true, availableBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('300.00');
        expect(after.availableBalance.toFixed(8)).toBe('1000.00000000');
    });

    // ── E. dust / precision ─────────────────────────────────────────────────
    test('dust and sub-pesewa amounts are refused before any mutation', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 300 });
        const app = buildApp();
        const zero = await ghsPost(app, user, { amountGhs: '0.00' });
        expect([400, 422]).toContain(zero.status);
        const subPesewa = await ghsPost(app, user, { amountGhs: '1.005' });
        expect([400, 422]).toContain(subPesewa.status);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('300.00');
    });

    // ── B. GHS-only happy path ──────────────────────────────────────────────
    test('GHS-only: exact GHS debit, USDC untouched, canonical posting + reservation + one dispatch', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 300, usdc: 1000 });
        const dispatcher = { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-GHS-1' })) };
        const res = await ghsPost(buildApp(dispatcher), user, { amountGhs: '50.00' });
        expect(res.status).toBe(202);
        const { reference } = res.body;
        await waitForDispatch(reference);
        expect(res.body.data.amountGhs).toBe('50.00');
        expect(res.body.data.settlementCurrency).toBe('GHS_NATIVE');
        expect(res.body.data.feeGhs).toBe('0.00');

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true, availableBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('250.00');
        expect(after.availableBalance.toFixed(8)).toBe('1000.00000000');

        const [posting] = await ledgerKeys(`ledger:wallet:withdrawal-ghs:${reference}`);
        expect(posting).toBeTruthy();
        const lines = await prisma.journalEntry.findMany({ where: { ledgerTransactionId: posting.id } });
        const debitLine = lines.find((l) => l.account === `ghs:user:${user.id}:liability`);
        const creditLine = lines.find((l) => l.account === 'fiat:momo:ghs');
        expect(new Prisma.Decimal(debitLine.debit).toFixed(2)).toBe('50.00');
        expect(new Prisma.Decimal(creditLine.credit).toFixed(2)).toBe('50.00');

        const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id, settlementCurrency: 'GHS_NATIVE' } });
        expect(mirror).toBeTruthy();
        expect(mirror.amountGhs.toFixed(2)).toBe('50.00');
        expect(mirror.amount.toFixed(8)).toBe('0.00000000');

        const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(reservation).toBeTruthy();
        expect(reservation.amountGhs.toFixed(2)).toBe('50.00');

        expect(dispatcher.initiateTransfer).toHaveBeenCalledTimes(1);
        expect(Number(dispatcher.initiateTransfer.mock.calls[0][0].amountGhs)).toBe(50);
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.settlementCurrency).toBe('GHS_NATIVE');
        expect(['PENDING', 'DISPATCHING']).toContain(canonical.status);
    });

    // ── C. no FX dependency ────────────────────────────────────────────────
    test('GHS-only does NOT depend on FX: a STALE canonical rate still pays out; the shortfall quote fails closed', async () => {
        await setSettings({ freshRate: false });
        const user = await ghsUser({ ghs: 300 });
        const dispatcher = { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-GHS-2' })) };
        const app = buildApp(dispatcher);
        const res = await ghsPost(app, user, { amountGhs: '40.00' });
        expect(res.status).toBe(202);
        await waitForDispatch(res.body.reference);
        expect(dispatcher.initiateTransfer).toHaveBeenCalledTimes(1);
        const quote = await quotePost(app, user, { amountGhs: '900.00' });
        expect(quote.status).toBeGreaterThanOrEqual(400);
        expect(quote.status).toBeLessThan(500);
    });

    // ── D. shortfall ────────────────────────────────────────────────────────
    test('shortfall without consent: 409 + plan, zero mutation', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 20, usdc: 1000 });
        const before = await prisma.ledgerTransaction.count();
        const res = await ghsPost(buildApp(), user, { amountGhs: '50.00' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('GHS_SHORTFALL_QUOTE_REQUIRED');
        expect(res.body.plan.shortfallGhs).toBe('30.00');
        expect(await prisma.ledgerTransaction.count()).toBe(before);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true, availableBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('20.00');
        expect(after.availableBalance.toFixed(8)).toBe('1000.00000000');
    });

    test('consented shortfall quote funds EXACTLY the shortfall and is consumed once', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 20, usdc: 1000 });
        const app = buildApp({ initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-GHS-3' })) });

        const quoted = await quotePost(app, user, { amountGhs: '50.00' });
        expect(quoted.status).toBe(200);
        const quoteId = quoted.body.quote.quoteId;
        const usdcDebit = new Prisma.Decimal(quoted.body.quote.usdcDebitExact);
        expect(quoteId).toBeTruthy();
        expect(quoted.body.quote.shortfallGhs).toBe('30.00');

        // quote creation is NOT a money movement
        const preQuote = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true, nativeGhsBalance: true } });
        expect(preQuote.availableBalance.toFixed(8)).toBe('1000.00000000');
        expect(preQuote.nativeGhsBalance.toFixed(2)).toBe('20.00');

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId });
        expect(res.status).toBe(202);
        const { reference } = res.body;
        await waitForDispatch(reference);
        expect(res.body.data.funding.mode).toBe('USDC_SHORTFALL_FUNDED');

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true, nativeGhsBalance: true } });
        expect(after.availableBalance.toFixed(8)).toBe(new Prisma.Decimal(1000).minus(usdcDebit).toFixed(8));
        expect(after.nativeGhsBalance.toFixed(2)).toBe('0.00');

        const [conversion] = await ledgerKeys(`ledger:wallet:withdrawal-ghs-funding:${reference}`);
        expect(conversion).toBeTruthy();
        expect(conversion.entryType).toBe('ASSET_CONVERSION');

        // replay with a NEW reference: the quote is one-time
        const replay = await ghsPost(app, user, { amountGhs: '50.00', quoteId });
        expect(replay.status).toBeGreaterThanOrEqual(400);
        expect(replay.status).toBeLessThan(500);
        const final = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(final.availableBalance.toFixed(8)).toBe(after.availableBalance.toFixed(8));
    });

    // ── F. amplification: rejection reverses once ──────────────────────────
    test('definitive provider rejection reverses ONCE: GHS + USDC restored, reservation released', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 300, usdc: 1000 });
        const dispatcher = { initiateTransfer: jest.fn(async () => { throw new Error('provider rejected before acceptance'); }) };
        const app = buildApp(dispatcher);
        const res = await ghsPost(app, user, { amountGhs: '75.00' });
        expect(res.status).toBe(202);
        const { reference } = res.body;
        await waitForDispatch(reference);

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true, availableBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('300.00');
        expect(after.availableBalance.toFixed(8)).toBe('1000.00000000');
        const [reversal] = await ledgerKeys(`ledger:reversal:withdrawal-ghs:${reference}`);
        expect(reversal).toBeTruthy();
        const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(reservation.status).toBe('RELEASED');
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');

        const second = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'replay' });
        expect(second.reversed).toBe(false);
        const still = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(still.nativeGhsBalance.toFixed(2)).toBe('300.00');
    });

    // ── G. concurrency ─────────────────────────────────────────────────────
    test('two racing GHS payouts cannot overdraw the native wallet', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 100 });
        const dispatcher = { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-RACE' })) };
        const app = buildApp(dispatcher);
        const [a, b] = await Promise.all([
            ghsPost(app, user, { amountGhs: '70.00' }),
            ghsPost(app, user, { amountGhs: '70.00' }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toContain(202);
        expect([202, 400, 409, 422]).toContain(statuses[0] === 202 ? statuses[1] : statuses[0]);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        const accepted = [a, b].filter((r) => r.status === 202).length;
        expect(after.nativeGhsBalance.toFixed(2)).toBe((100 - 70 * accepted).toFixed(2));
        expect(after.nativeGhsBalance.greaterThanOrEqualTo(0)).toBe(true);
    });

    // ── H. middleware order ───────────────────────────────────────────────
    test('2FA is enforced BEFORE any idempotency claim', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 300 });
        const probeKey = randomUUID();
        const res = await request(buildApp())
            .post('/api/withdraw/ghs')
            .set('Authorization', `Bearer ${tokenFor(user)}`)
            .set('Idempotency-Key', probeKey)
            .send({ amountGhs: '10.00', destination: '233241234567' }); // no password
        expect(res.status).toBe(401);
        expect(['2FA_REQUIRED', 'PASSWORD_REQUIRED']).toContain(res.body.code);
        // Scoped to THIS request's key: a rejected pre-economics request must
        // never leave a committed claim behind.
        const claims = await prisma.financialOperation.count({ where: { userId: user.id, key: probeKey } });
        expect(claims).toBe(0);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(after.nativeGhsBalance.toFixed(2)).toBe('300.00');
    });
});
