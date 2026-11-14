'use strict';

/**
 * WP-I acceptance matrix, cases 2-9 — CALLBACK AUTHENTICATION AND EVIDENCE
 * IDENTITY, proven on the MOUNTED Moolre collection controller against real
 * PostgreSQL.
 *
 * The provider contract documented for these callbacks is a body `secret`
 * field plus an IP allowlist; no signature specification has been published.
 * This suite therefore exercises the mechanism the contract supports and the
 * credentials the code actually accepts. It deliberately does NOT invent an
 * HMAC contract: where a signature is tested (case 2) it is the code's
 * existing path, and a wrong one must simply fail.
 *
 * Every negative case asserts the same three things the matrix requires:
 *   no receipt reaches AVAILABLE, FiatLiquidityState.availableGhs is
 *   unchanged, and no second economic effect occurs.
 */

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[wp-i-callback-authentication.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('WP-I matrix cases 2-9 — callback authentication and evidence identity (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const controller = require('../controllers/moolreQuoteDepositController');
    const { Prisma } = require('@prisma/client');
    const SECRET = 'wp_i_callback_secret';

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.MOOLRE_WEBHOOK_SECRET = SECRET;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ModelBSettlement", "InventoryLotConsumption", "InventoryLot", "LedgerTransaction", "LedgerAccount", "JournalEntry", "TransactionQuote", "TransactionHistory", "FiatProviderEvent", "FiatLiquidityReceipt", "ReconciliationException", "SystemFiatPool", "User" RESTART IDENTITY CASCADE'
    );

    beforeEach(async () => {
        await TRUNCATE_ALL();
        await prisma.$executeRawUnsafe('DELETE FROM "FiatLiquidityState" WHERE "id" = 1');
        await prisma.fiatLiquidityState.create({
            data: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
        });
    }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    let refCounter = 0;
    const makeApp = () => ({
        get: (key) => ({
            prisma,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-WPI-${++refCounter}` })),
            },
        })[key],
    });
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    async function newDeposit(amountGhs = 100) {
        const user = await seedUser(prisma, { availableBalance: 0 });
        const res = mockResponse();
        await controller.initiate({
            app: makeApp(), user: { id: user.id }, headers: {},
            body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' },
        }, res);
        expect(res.statusCode).toBe(201);
        const reference = res.payload?.data?.reference;
        expect(reference).toBeTruthy();
        return { user, reference };
    }

    const p01 = (reference, amount = 100, payer = '0241234567') =>
        ({ status: 1, code: 'P01', data: { externalref: reference, amount, payer } });

    async function deliver(body, headers = { 'x-moolre-webhook-secret': SECRET }) {
        const res = mockResponse();
        await controller.webhook({ app: makeApp(), headers, body }, res);
        return res;
    }

    const availableGhs = async () => {
        const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        return new Prisma.Decimal(state.availableGhs).toFixed(2);
    };
    const depositOf = async (reference) => prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    const eventCount = () => prisma.fiatProviderEvent.count();
    const receiptCount = () => prisma.fiatLiquidityReceipt.count();

    // ── 2. Invalid signature ────────────────────────────────────────────────
    test('2: an invalid signature is refused 401 with NO row and no mutation', async () => {
        const { reference } = await newDeposit(100);
        const res = await deliver(p01(reference), { 'x-moolre-signature': 'deadbeef' });

        expect(res.statusCode).toBe(401);
        expect(await eventCount()).toBe(0);
        expect(await availableGhs()).toBe('0.00');
        expect((await depositOf(reference)).status).toBe('PENDING');
    });

    // ── 3. No credential at all ─────────────────────────────────────────────
    test('3: no credential at all is refused 401 with NO row', async () => {
        const { reference } = await newDeposit(100);
        const res = await deliver(p01(reference), {});

        expect(res.statusCode).toBe(401);
        expect(await eventCount()).toBe(0);
        expect(await availableGhs()).toBe('0.00');
        expect((await depositOf(reference)).status).toBe('PENDING');
    });

    // ── 4. Static header valid, body asserts a DIFFERENT secret ─────────────
    test('4: a body asserting the wrong secret is refused 401 even when a header credential is valid', async () => {
        const { reference } = await newDeposit(100);
        const res = await deliver({ ...p01(reference), secret: 'not-the-configured-secret' });

        expect(res.statusCode).toBe(401);
        expect(await eventCount()).toBe(0);
        expect(await availableGhs()).toBe('0.00');
        expect((await depositOf(reference)).status).toBe('PENDING');
    });

    test('4b: a body asserting the CORRECT secret is accepted (the documented path still works)', async () => {
        const { reference } = await newDeposit(100);
        const res = await deliver({ ...p01(reference), secret: SECRET });

        expect(res.statusCode).toBe(200);
        expect((await depositOf(reference)).status).toBe('COMPLETED');
    });

    // ── 5. Altered amount ───────────────────────────────────────────────────
    test('5: a properly authenticated callback whose amount differs from the quote is refused and never credits', async () => {
        const { reference } = await newDeposit(100);
        const res = await deliver(p01(reference, 250));

        expect(res.statusCode).toBe(409);
        expect(res.payload.message).toMatch(/does not match the transaction quote/i);
        expect(await availableGhs()).toBe('0.00');
        expect(await receiptCount()).toBe(0);
        expect((await depositOf(reference)).status).toBe('PENDING');
    });

    // ── 6. Altered reference ────────────────────────────────────────────────
    test('6: an authenticated callback for an unknown reference is refused and writes nothing', async () => {
        const res = await deliver(p01(`NO_SUCH_REFERENCE_${Date.now()}`, 100));

        expect(res.statusCode).toBe(404);
        expect(await availableGhs()).toBe('0.00');
        expect(await receiptCount()).toBe(0);
    });

    // ── 7. Replay ───────────────────────────────────────────────────────────
    test('7: replaying an identical callback produces exactly ONE economic effect', async () => {
        const { reference, user } = await newDeposit(100);
        const first = await deliver(p01(reference));
        expect(first.statusCode).toBe(200);

        const afterFirst = await prisma.user.findUnique({ where: { id: user.id } });
        const firstBalance = new Prisma.Decimal(afterFirst.availableBalance).toFixed(2);

        const replay = await deliver(p01(reference));
        expect(replay.statusCode).toBe(200);

        const afterReplay = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Prisma.Decimal(afterReplay.availableBalance).toFixed(2)).toBe(firstBalance);
        expect(await eventCount()).toBe(1);
        expect((await depositOf(reference)).status).toBe('COMPLETED');
    });

    // ── 8. Byte-different, economically identical ───────────────────────────
    test('8: a byte-different but economically identical callback converges on the same single effect', async () => {
        const { reference, user } = await newDeposit(100);
        expect((await deliver(p01(reference, 100))).statusCode).toBe(200);
        const afterFirst = await prisma.user.findUnique({ where: { id: user.id } });
        const firstBalance = new Prisma.Decimal(afterFirst.availableBalance).toFixed(2);

        // Different bytes — a different decimal spelling and a different payer —
        // same economic observation.
        const res = await deliver(p01(reference, '100.00', '0231111111'));
        expect(res.statusCode).toBe(200);

        const afterSecond = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Prisma.Decimal(afterSecond.availableBalance).toFixed(2)).toBe(firstBalance);
        expect(await eventCount()).toBe(1);
        expect((await depositOf(reference)).status).toBe('COMPLETED');
    });

    // ── 9. Contradictory repeated observation ───────────────────────────────
    test('9: a contradictory repeat is retained as DISTINCT evidence, typed, and never absorbed', async () => {
        const { reference } = await newDeposit(100);
        expect((await deliver(p01(reference, 100))).statusCode).toBe(200);
        const eventsAfterFirst = await eventCount();

        const res = await deliver(p01(reference, 120));

        expect(res.statusCode).toBe(409);
        expect(res.payload.message).toMatch(/contradictory/i);
        // The contradiction is a NEW durable observation, not a silent overwrite.
        expect(await eventCount()).toBe(eventsAfterFirst + 1);
        // The committed observation and the credited amount are untouched.
        expect((await depositOf(reference)).status).toBe('COMPLETED');
        expect(await availableGhs()).toBe('0.00');
    });
});
