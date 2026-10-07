// __tests__/r271d-late-deposit-settlement.test.js
// =============================================================================
// §271 late-deposit-settlement policy — real-PostgreSQL proof (issue #271).
//
// The quote's own economics are the binding contract; the grace window only
// moves the auto-settle / ops-handoff boundary, NEVER the price:
//
//   A. Config resolver: default 24h, env-overridable, bounded [1h, 168h],
//      malformed/out-of-range falls back to the safe default, and there is
//      deliberately NO "off" value.
//   B. Late-but-within-grace webhook: the deposit settles at the ORIGINAL
//      quoted USDC — even when the CURRENT oracle rate has moved wildly since
//      the quote. metadata.lateSettlement=true records the event durably.
//   C. Beyond-grace webhook: deterministic 409
//      LATE_DEPOSIT_SETTLEMENT_REQUIRES_RECONCILIATION, the deposit stays
//      PENDING (never a silent trap), no credit, and a durable
//      ReconciliationException (reason LATE_DEPOSIT_SETTLEMENT_BEYOND_GRACE)
//      is recorded. Replaying the webhook converges: the same 409 and the
//      same single exception row (idempotent upsert).
//   D. On-time settlement is untouched: no lateSettlement marker.
//
// Prisma is NEVER mocked. The generic webhook surface is driven directly
// (the controller invocation contract used by stale-rate-gate.test.js).
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r271d-late-deposit-settlement.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('271D late-deposit-settlement policy (real PostgreSQL)', () => {
    let prisma;
    let quoteFiatDepositController;
    const { seedUser: _seedUser } = require('./helpers/factories');
    const _myUserIds = [];
    const seedUser = async (prisma, overrides = {}) => {
        const u = await _seedUser(prisma, overrides);
        _myUserIds.push(u.id);
        return u;
    };

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_271d';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionQuote" WHERE "userId" = ANY($1::int[])', _myUserIds);
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory" WHERE "userId" = ANY($1::int[])', _myUserIds);
            await prisma.user.deleteMany({ where: { id: { in: _myUserIds } } });
            await prisma.$disconnect();
        }
    });

    afterEach(async () => {
        // This suite creates deposit references with its own random suffixes;
        // sweep ALL its rows (and their quote/exception children) so nothing
        // leaks into other suites. ReconciliationException and
        // FiatProviderEvent live outside the generated client.
        await prisma.$executeRawUnsafe('DELETE FROM "TransactionQuote" WHERE "userId" = ANY($1::int[])', _myUserIds);
        await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory" WHERE "userId" = ANY($1::int[])', _myUserIds);
        await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException" WHERE "entityId" LIKE \'271D-%\'');
        await prisma.$executeRawUnsafe('DELETE FROM "FiatProviderEvent" WHERE "relatedReference" LIKE \'271D-%\'');
        await prisma.$executeRawUnsafe('DELETE FROM "LedgerAccount" WHERE 1=1');
    });

    // ---- helpers -------------------------------------------------------------

    async function seedSettings(overrides = {}) {
        const base = {
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveCorporateRate: 13.22,
            liveRateSource: 'KOTANI_PAY',
            lastRateSync: new Date(Date.now() - 60 * 1000),
            lastExternalSync: new Date(Date.now() - 60 * 1000),
            lastAdminSetAt: null,
            lastEchoAt: null,
            fiatLiquidityAuthorityEnabled: false,
            modelBSettlementEnabled: false,
        };
        const data = { ...base, ...overrides };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        return data;
    }

    function makeApp(services = {}) {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: { initiatePayment: jest.fn().mockResolvedValue({ requiresOtp: false, providerRef: 'PR-271D' }) },
            ...services,
        };
        return { get: (key) => registry[key] };
    }

    function mockResponse() {
        return {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return this; },
        };
    }

    async function initiateGeneric(user, amountGhs) {
        const res = mockResponse();
        await quoteFiatDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO' }, ip: '127.0.0.1' },
            res
        );
        return res;
    }

    async function webhook(reference, amountGhs) {
        const res = mockResponse();
        await quoteFiatDepositController.webhook(
            {
                app: makeApp(),
                headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
                body: { reference, amountGhs, status: 'SUCCESS' },
            },
            res
        );
        return res;
    }

    const exceptionRows = (reference) =>
        prisma.$queryRawUnsafe('SELECT * FROM "ReconciliationException" WHERE "entityId" = $1', reference);

    // Backdate the deposit's quote: the quote behaves as if it was issued
    // `expiresSecondsAgo` + TTL ago and expired `expiresSecondsAgo` ago.
    async function backdateQuote(userId, expiresSecondsAgo, ttlSeconds = 600) {
        await prisma.$executeRawUnsafe(
            "UPDATE \"TransactionQuote\" SET \"expiresAt\" = NOW() - ($1::int || ' seconds')::interval, " +
            "\"createdAt\" = NOW() - (((($1::int) + ($2::int)) || ' seconds')::interval) WHERE \"userId\" = $3",
            String(expiresSecondsAgo), String(ttlSeconds), userId
        );
    }

    // =========================================================================
    // A. Config resolver
    // =========================================================================

    describe('late-deposit-settlement grace config resolution', () => {
        const {
            resolveLateDepositSettlementGraceHours,
            DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
            MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
            MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS,
        } = require('../src/config/lateDepositSettlement');
        const logger = require('../src/config/logger');

        beforeEach(() => logger.warn.mockClear());

        test('absent -> safe default 24h, no warning', () => {
            expect(resolveLateDepositSettlementGraceHours({})).toBe(24);
            expect(DEFAULT_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS).toBe(24);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        test('valid in-range values are honored (bounds inclusive)', () => {
            expect(resolveLateDepositSettlementGraceHours({ LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS: '1' })).toBe(1);
            expect(resolveLateDepositSettlementGraceHours({ LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS: '168' })).toBe(168);
            expect(resolveLateDepositSettlementGraceHours({ LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS: '3.5' })).toBe(3.5);
            expect(MIN_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS).toBe(1);
            expect(MAX_LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS).toBe(168);
        });

        test('malformed / non-finite / out-of-range fall back to 24h with a warning', () => {
            for (const bad of ['not-a-number', 'NaN', 'Infinity', '0', '-4', '169', '9999']) {
                expect(resolveLateDepositSettlementGraceHours({ LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS: bad })).toBe(24);
            }
            expect(logger.warn).toHaveBeenCalled();
        });

        test('there is deliberately NO off value — grace 0 (the stranded-deposit trap) is not selectable', () => {
            for (const off of ['0', '-1', 'off', 'false', 'none', '']) {
                expect(resolveLateDepositSettlementGraceHours({ LATE_DEPOSIT_SETTLEMENT_GRACE_HOURS: off })).toBe(24);
            }
        });
    });

    // =========================================================================
    // B/C/D. Webhook behavior at the grace boundary (real DB)
    // =========================================================================

    describe('generic webhook settlement at the grace boundary', () => {
        test('B: late-but-within-grace settles at the ORIGINAL quoted terms (never repriced)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await seedSettings();

            const initiated = await initiateGeneric(user, 134.20);
            expect(initiated.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, status: 'PENDING' } });
            const quoteRows = await prisma.$queryRawUnsafe('SELECT "usdcAmount", "expiresAt" FROM "TransactionQuote" WHERE "userId" = $1', user.id);
            expect(quoteRows).toHaveLength(1);
            const quotedUsdc = Number(quoteRows[0].usdcAmount);

            // The quote expired 2 minutes ago — INSIDE the 24h grace window.
            await backdateQuote(user.id, 120);

            // The CURRENT oracle rate has moved wildly since the quote. The
            // settlement must NOT reprice: the deposit credits the ORIGINAL
            // quoted USDC, not recomputed economics at the current rate.
            await seedSettings({ liveRetailRate: 51.30, liveUsdToGhs: 51.30, lastExternalSync: new Date(), lastRateSync: new Date() });

            const settled = await webhook(pending.txHash, 134.20);
            expect(settled.statusCode).toBe(200);
            expect(settled.payload.data.usdcEquivalent).toBeCloseTo(quotedUsdc, 6);

            // Credited exactly the quote's own USDC — provenance intact.
            const after = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(after.availableBalance)).toBeCloseTo(quotedUsdc, 6);

            // Durable late marker on the deposit, and no exception.
            const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(row.status).toBe('COMPLETED');
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            expect(meta.lateSettlement).toBe(true);
            expect(meta.quoteExpiredAt).toBeDefined();
            expect(meta.settlementRate).toBeCloseTo(13.42, 4); // the QUOTED rate, not the moved oracle
            expect(await exceptionRows(pending.txHash)).toHaveLength(0);
        });

        test('C: beyond-grace webhook is a deterministic 409 with a durable reconciliation record', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await seedSettings();

            const initiated = await initiateGeneric(user, 134.20);
            expect(initiated.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, status: 'PENDING' } });

            // Expired 26 hours ago — BEYOND the 24h grace window.
            await backdateQuote(user.id, 26 * 3600);

            const rejected = await webhook(pending.txHash, 134.20);
            expect(rejected.statusCode).toBe(409);
            expect(rejected.payload.code).toBe('LATE_DEPOSIT_SETTLEMENT_REQUIRES_RECONCILIATION');

            // Durable ops record with the reconciliation terms spelled out.
            const exceptions = await exceptionRows(pending.txHash);
            expect(exceptions).toHaveLength(1);
            expect(exceptions[0].reason).toBe('LATE_DEPOSIT_SETTLEMENT_BEYOND_GRACE');

            // Fail-closed everywhere: deposit stays PENDING (not a silent
            // trap, but never settled without ops), no credit, quote NOT
            // consumed (reconciliation settles at the SAME terms later).
            const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(row.status).toBe('PENDING');
            const after = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(after.availableBalance)).toBe(0);
            const q = await prisma.$queryRawUnsafe('SELECT "consumedAt" FROM "TransactionQuote" WHERE "userId" = $1', user.id);
            expect(q[0].consumedAt).toBeNull();

            // Replay converges: same deterministic 409, still ONE exception row.
            const replay = await webhook(pending.txHash, 134.20);
            expect(replay.statusCode).toBe(409);
            expect(replay.payload.code).toBe('LATE_DEPOSIT_SETTLEMENT_REQUIRES_RECONCILIATION');
            expect(await exceptionRows(pending.txHash)).toHaveLength(1);
            expect((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance.toFixed(6)).toBe('0.000000');
        });

        test('D: an on-time settlement carries no late marker', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await seedSettings();

            const initiated = await initiateGeneric(user, 50.00);
            expect(initiated.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, status: 'PENDING' } });

            const settled = await webhook(pending.txHash, 50.00);
            expect(settled.statusCode).toBe(200);

            const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(row.status).toBe('COMPLETED');
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            expect(meta.lateSettlement).toBeUndefined();
            expect(await exceptionRows(pending.txHash)).toHaveLength(0);
        });
    });
});
