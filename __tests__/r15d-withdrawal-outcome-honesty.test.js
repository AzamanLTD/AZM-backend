// __tests__/r15d-withdrawal-outcome-honesty.test.js
// =============================================================================
// r15 R15-D — withdrawal dispatch outcome honesty (real PostgreSQL)
//
// THE DEFECT (proven by reading the mounted code path):
// controllers/withdrawalController.fiatWithdraw treated ANY initiateTransfer
// throw as "cash never left" and auto-refunded the withdrawal. A provider
// TIMEOUT (UNKNOWN_OUTCOME) can occur AFTER the provider accepted the payout —
// auto-refunding then double-spends: the user receives the MoMo payout AND
// gets the balance restored. A failover re-instruction double-disburses.
//
// THE FIX (this suite pins it):
//   • UNKNOWN_OUTCOME / DUPLICATE_REFERENCE → NO refund, withdrawal stays
//     PENDING, honest 202, ReconciliationException + admin alert recorded.
//   • DEFINITIVE_REJECTION → provably safe unwind (refund + FAILED row).
//   • The failover chain is never re-instructed on an ambiguous outcome.
//
// Mirrors the withdrawal-fee-discount-atomicity harness for the seeded state.
// =============================================================================

jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/fraudDetectionService', () => ({ evaluate: jest.fn().mockResolvedValue({ allowed: true, triggeredRules: [] }) }));

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const financeService = require('../services/finance.service');
const { AzmSpendService } = require('../services/azmSpendService');
const { fiatWithdrawal } = require('../controllers/withdrawalController');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15d-withdrawal-outcome-honesty] TEST_DATABASE_URL not set — skipping real-DB suite.');

const START_USDC = 500.0;
const WITHDRAWAL = 50.0;

describeOrSkip('r15 R15-D: withdrawal dispatch outcome honesty (real PostgreSQL)', () => {
    let prisma;
    let azm;

    beforeAll(() => { prisma = new PrismaClient(); azm = new AzmSpendService(prisma); });

    beforeEach(async () => {
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: 100_000.0 },
            create: { id: 1, balance: 100_000.0 }
        });
        await prisma.systemMasterCrypto.upsert({
            where: { id: 1 },
            update: { balance: 0.0 },
            create: { id: 1, balance: 0.0 }
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false }
        });
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 150));
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Withdrawal", "ReconciliationException", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    afterAll(async () => { await prisma.$disconnect(); });

    const freshUser = (id) =>
        prisma.user.findUnique({ where: { id }, select: { availableBalance: true, azmBalance: true } });

    /** Build a mounted fake request/response pair with a typed-throwing provider. */
    function makeHarness(providerImpl) {
        const appMap = new Map([
            ['prisma', prisma],
            ['azmSpendService', azm],
            ['paymentFailoverService', providerImpl],
            ['emitBalanceUpdate', async () => {}],
            ['emailService', null],
            ['smsService', null],
            ['adminAlertService', null],
            ['socketio', null],
        ]);
        const app = { get: (k) => (appMap.has(k) ? appMap.get(k) : null) };
        const res = {
            statusCode: null,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; },
        };
        return { app, res };
    }

    async function runWithdrawal(user, { app, res }, phone = '0244556677') {
        const req = {
            app,
            ip: '127.0.0.1',
            headers: {},
            body: { amount: String(WITHDRAWAL), payoutMethod: 'MTN_MOMO', recipientPhone: phone },
            user: { id: user.id, username: 'r15d', createdAt: new Date(Date.now() - 90 * 86400000) },
        };
        await fiatWithdrawal(req, res);
        return res;
    }

    function typedThrowingProvider(outcome) {
        return {
            name: 'r15d-provider',
            _calls: [],
            newReferenceId: () => 'r15d-ref',
            async initiateTransfer(payload) {
                this._calls.push(payload);
                const err = new Error(`provider failed (${outcome})`);
                err.providerOutcome = outcome;
                throw err;
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
    }

    // ── THE P0 INVARIANT: ambiguous outcome NEVER auto-refunds ──────────────
    test('UNKNOWN_OUTCOME: NO refund, withdrawal stays PENDING, honest 202 + exception row', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = typedThrowingProvider('UNKNOWN_OUTCOME');
        const { app, res } = makeHarness(provider);

        await runWithdrawal(user, { app, res });

        // Honest 202 contract — outcome unresolved, do NOT retry.
        expect(res.statusCode).toBe(202);
        expect(res.body.code).toBe('DISPATCH_OUTCOME_UNKNOWN');
        expect(res.body.retryable).toBe(false);

        // The provider was instructed EXACTLY ONCE — no failover re-instruct.
        expect(provider._calls).toHaveLength(1);

        // THE double-spend guard: the debit was NOT auto-refunded.
        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC - WITHDRAWAL - 1.0, 6); // debit + 2% exit fee held, NOT refunded

        // The withdrawal mirror row is NOT marked FAILED. r16c: the
        // dispatch claim moved it to DISPATCHING before provider I/O —
        // the honest state for an attempted-but-unresolved payout. A
        // PENDING mirror here would mean the claim never happened (the
        // race r16c closes); it stays protected from admin rejection and
        // worker claims until reconciliation resolves it.
        const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(mirror).not.toBeNull();
        expect(mirror.status).toBe('DISPATCHING');

        // Durable exception evidence for the recon team.
        // ReconciliationException has no Prisma model (raw-SQL service).
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT * FROM "ReconciliationException" WHERE "reason" = $1', 'DISPATCH_OUTCOME_UNKNOWN_NO_REFUND'
        );
        const exception = exceptions[0] || null;
        expect(exception).not.toBeNull();
        expect(exception.details.outcome).toBe('UNKNOWN_OUTCOME');
    });

    test('DUPLICATE_REFERENCE: NO refund, 202 MOOLRE_DUPLICATE_REFERENCE — the provider already holds the reference', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = typedThrowingProvider('DUPLICATE_REFERENCE');
        const { app, res } = makeHarness(provider);

        await runWithdrawal(user, { app, res });

        expect(res.statusCode).toBe(202);
        expect(res.body.code).toBe('MOOLRE_DUPLICATE_REFERENCE');
        expect(provider._calls).toHaveLength(1);

        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC - WITHDRAWAL - 1.0, 6); // debit + 2% exit fee held, NOT refunded
    });

    // ── Provably-safe outcomes still unwind — availability preserved ────────
    test('DEFINITIVE_REJECTION: provably safe — ledger unwound, balance restored, mirror FAILED', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = typedThrowingProvider('DEFINITIVE_REJECTION');
        const { app, res } = makeHarness(provider);

        await runWithdrawal(user, { app, res });

        expect(res.body.success).toBe(false);
        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC, 6);

        const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(mirror.status).toBe('FAILED');
    });

    test('NOT_DISPATCHED: provably safe — ledger unwound exactly once', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = typedThrowingProvider('NOT_DISPATCHED');
        const { app, res } = makeHarness(provider);

        await runWithdrawal(user, { app, res });

        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC, 6);
    });
});
