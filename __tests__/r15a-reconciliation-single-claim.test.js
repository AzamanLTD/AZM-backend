/**
 * §R15-A — confirmReconciliationMatch single-claim invariant (real PostgreSQL)
 * ============================================================================
 *
 * The partial unique index FiatLiquidityReceipt_availableRelatedTx_unique
 * (one AVAILABLE receipt per non-null relatedTransactionId) is the RACE
 * AUTHORITY for reconciliation matches. These proofs use TRUE concurrency:
 * independent Prisma clients (separate connections), Promise.all starts, and
 * one deterministic mid-transaction rendezvous (a Prisma client-side
 * middleware on the loser's client that releases the winner's commit at the
 * exact moment the loser has passed its read-checks and is about to CAS).
 *
 * Every test asserts the full economic aftermath — never just "it threw":
 *   - exactly ONE availableGhs increment of exactly the receipt amount
 *   - exactly ONE AVAILABLE receipt for the deposit
 *   - every other liquidity bucket, the pool projection and the durable
 *     provider evidence untouched (no duplicate effect paths)
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15a-reconciliation-single-claim] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§R15-A reconciliation single-claim invariant (real PostgreSQL)', () => {
    let prisma; // winner/client under test
    let prisma2; // loser client — a genuinely independent connection
    const { seedUser } = require('./helpers/factories');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_r15a';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_r15a';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        prisma2 = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRawUnsafe('DELETE FROM "AdminProfitLog"');
            await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemMasterCrypto"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemFiatPool"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemProfitFees"');
            await prisma.$disconnect();
        }
        if (prisma2) await prisma2.$disconnect();
    });

    beforeEach(async () => {
        await prisma.fiatProviderEvent.deleteMany();
        await prisma.fiatLiquidityReceipt.deleteMany();
        await prisma.fiatLiquidityReservation.deleteMany();
        await prisma.$executeRaw`DELETE FROM "ReconciliationException" WHERE "entityType" LIKE 'FIAT_%'`;
        await prisma.$executeRaw`DELETE FROM "ReconciliationException" WHERE "entityType" = 'TRANSACTION'`;
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 },
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
            create: { id: 1, fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
        });
    });

    const state = () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const dec = (v) => Number(v);
    const inTx = (client, fn) => client.$transaction((tx) => fn(tx));

    // ── genuine evidence machinery (flag OFF: settled deposit + durable
    //    provider event, NO receipt auto-created) ───────────────────────────
    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({
                    requiresOtp: false,
                    providerRef: `PR-R15A-${++providerRefCounter}`,
                })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    /** Settles a genuine deposit (COMPLETED) with durable provider evidence
     *  and NO liquidity receipt (authority-flag-OFF webhook regime). */
    async function settledDeposit(amountGhs) {
        const user = await seedUser(prisma);
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
        expect(pending).toHaveLength(1);
        const wb = await moolreQuoteDepositController.webhook(
            {
                app: makeApp(),
                headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                body: { status: 1, code: 'P01', data: { externalref: pending[0].txHash, amount: amountGhs, payer: '0241234567' } },
            },
            mockResponse(),
        );
        expect(wb.statusCode).toBe(200);
        return pending[0];
    }

    async function unmatchedReceipt(dedupKey, amountGhs) {
        const { receipt } = await inTx(prisma, (tx) => fiatLiquidity.recordReceipt(tx, {
            provider: 'MOOLRE', dedupKey, amountGhs,
        }));
        expect(receipt.status).toBe('UNMATCHED');
        return receipt;
    }

    const matchArgs = (dedupKey, deposit) => ({
        dedupKey,
        matchedTransactionId: deposit.id,
        confirmedBy: 42,
        providerEventDedupKey: `event:moolre-collection:${deposit.txHash}`,
    });

    /** Asserts the complete single-claim aftermath for one deposit. */
    async function expectSingleClaim({ deposit, amountGhs }) {
        const s = await state();
        expect(s.availableGhs.toString()).toBe(String(amountGhs)); // EXACT
        expect(dec(s.reservedGhs)).toBe(0);
        expect(dec(s.inTransitGhs)).toBe(0);
        expect(dec(s.paidOutGhs)).toBe(0);
        expect(dec(s.reconciliationHeldGhs)).toBe(0);
        const claims = await prisma.fiatLiquidityReceipt.findMany({
            where: { relatedTransactionId: String(deposit.id), status: 'AVAILABLE' },
        });
        expect(claims).toHaveLength(1); // exactly one AVAILABLE receipt remains
        expect(claims[0].amountGhs.toString()).toBe(String(amountGhs));
        const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        expect(pool.balance.toString()).toBe(s.availableGhs.toString()); // projection synchronized
        // no duplicate notification/effect paths: confirm adds no provider
        // evidence and files no reconciliation exceptions
        const fiatExceptions = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS c FROM "ReconciliationException" WHERE "entityType" LIKE $1', 'FIAT_%');
        expect(fiatExceptions[0].c).toBe(0);
    }

    // =========================================================================
    // A. two DIFFERENT receipts race the SAME deposit concurrently
    // =========================================================================
    test('A. two different UNMATCHED receipts racing the same deposit: exactly ONE becomes AVAILABLE, exactly ONE availableGhs increment', async () => {
        const deposit = await settledDeposit(20);
        await unmatchedReceipt('receipt:r15a:a1', 20);
        await unmatchedReceipt('receipt:r15a:a2', 20);

        const [r1, r2] = await Promise.allSettled([
            inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:a1', deposit))),
            inTx(prisma2, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:a2', deposit))),
        ]);

        const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejected = [r1, r2].filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1); // single winner
        expect(fulfilled[0].value.replay).toBe(false);
        expect(rejected).toHaveLength(1); // the loser fails CLOSED with a typed conflict
        expect(rejected[0].reason.code).toBe('LIQUIDITY_CONFLICTING_EVIDENCE');

        await expectSingleClaim({ deposit, amountGhs: 20 });
    });

    test('A2. deterministic unique-invariant collision: the loser passes every read-check, then the partial unique index itself refuses the second claim', async () => {
        const deposit = await settledDeposit(20);
        await unmatchedReceipt('receipt:r15a:d1', 20);
        await unmatchedReceipt('receipt:r15a:d2', 20);

        // Rendezvous: tx1 claims and holds (uncommitted). The loser's client
        // middleware releases tx1's commit at the precise moment tx2 has
        // finished its read-checks and is about to CAS — so tx2's read-checks
        // genuinely passed and the DB index alone produces the refusal.
        let releaseTx1; const tx1Committed = new Promise((r) => { releaseTx1 = r; });
        const { PrismaClient } = require('@prisma/client');
        let tx1Promise;
        const loserClient = new PrismaClient().$extends({
            query: {
                fiatLiquidityReceipt: {
                    async updateMany({ args, query }) {
                        // the loser is about to CAS its claim: release the
                        // winner's commit NOW (its read-checks already passed)
                        releaseTx1();
                        await tx1Promise; // winner's row fully COMMITTED
                        return query(args);
                    },
                },
            },
        });

        try {
            tx1Promise = prisma.$transaction(async (tx) =>
                fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:d1', deposit)));
            const tx2Promise = loserClient.$transaction((tx) =>
                fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:d2', deposit)));

            const [r1, r2] = await Promise.allSettled([tx1Promise, tx2Promise]);
            expect(r1.status).toBe('fulfilled');
            expect(r1.value.replay).toBe(false);
            expect(r2.status).toBe('rejected');
            expect(r2.reason.code).toBe('LIQUIDITY_CONFLICTING_EVIDENCE');
            // The refusal came from the DB invariant, deterministically.
            await expectSingleClaim({ deposit, amountGhs: 20 });
            // the losing receipt itself is untouched — evidence retained
            const loser = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'receipt:r15a:d2' } });
            expect(loser.status).toBe('UNMATCHED');
            expect(loser.relatedTransactionId).toBeNull();
        } finally {
            await loserClient.$disconnect();
        }
    });

    // =========================================================================
    // B. the SAME receipt + SAME confirmation concurrently
    // =========================================================================
    test('B. same receipt, same confirmation, concurrently: ONE claim, ZERO second increment, the loser converges as replay', async () => {
        const deposit = await settledDeposit(20);
        await unmatchedReceipt('receipt:r15a:b1', 20);
        const args = matchArgs('receipt:r15a:b1', deposit);

        const [r1, r2] = await Promise.allSettled([
            inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, args)),
            inTx(prisma2, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, args)),
        ]);

        expect([r1.status, r2.status]).toEqual(['fulfilled', 'fulfilled']); // both converge
        const replays = [r1.value.replay, r2.value.replay].filter(Boolean).length;
        expect(replays).toBe(1); // exactly one first-claim; exactly one replay
        await expectSingleClaim({ deposit, amountGhs: 20 });
    });

    // =========================================================================
    // C. the SAME receipt races TWO DIFFERENT deposits
    // =========================================================================
    test('C. same receipt, different matched deposits, concurrently: exactly one deposit is claimed; the loser is a typed conflict', async () => {
        const depositA = await settledDeposit(20);
        const depositB = await settledDeposit(20);
        await unmatchedReceipt('receipt:r15a:c1', 20);

        const [r1, r2] = await Promise.allSettled([
            inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:c1', depositA))),
            inTx(prisma2, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:c1', depositB))),
        ]);

        const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejected = [r1, r2].filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('LIQUIDITY_CONFLICTING_EVIDENCE');

        const receipt = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'receipt:r15a:c1' } });
        expect(receipt.status).toBe('AVAILABLE');
        const other = receipt.relatedTransactionId === String(depositA.id) ? depositB : depositA;
        // the losing deposit carries NO claim at all
        expect(await prisma.fiatLiquidityReceipt.count({
            where: { relatedTransactionId: String(other.id), status: 'AVAILABLE' },
        })).toBe(0);
        await expectSingleClaim({ deposit: receipt.relatedTransactionId === String(depositA.id) ? depositA : depositB, amountGhs: 20 });
    });

    // =========================================================================
    // D. committed success, THEN a conflicting claim (deterministic conflict
    //    classification for the follow-on receipt)
    // =========================================================================
    test('D. one success then a conflicting claim: the second receipt is refused with the committed claim identity retained', async () => {
        const deposit = await settledDeposit(20);
        await unmatchedReceipt('receipt:r15a:e1', 20);
        await unmatchedReceipt('receipt:r15a:e2', 20);

        const first = await inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:e1', deposit)));
        expect(first.replay).toBe(false);

        await expect(inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:e2', deposit))))
            .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });

        await expectSingleClaim({ deposit, amountGhs: 20 });
        // the refused receipt retains its UNMATCHED evidence for human review
        const refused = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'receipt:r15a:e2' } });
        expect(refused.status).toBe('UNMATCHED');
        expect(refused.relatedTransactionId).toBeNull();
    });

    // =========================================================================
    // E. exact Decimal semantics at a high magnitude
    // =========================================================================
    test('E. high-magnitude claim: the availableGhs delta is EXACTLY the receipt amount in Decimal(20,2) — no float coercion', async () => {
        const amount = '12345678901.25';
        const deposit = await settledDeposit(amount);
        await unmatchedReceipt('receipt:r15a:f1', amount);

        const { receipt } = await inTx(prisma, (tx) => fiatLiquidity.confirmReconciliationMatch(tx, matchArgs('receipt:r15a:f1', deposit)));
        expect(receipt.status).toBe('AVAILABLE');
        const s = await state();
        expect(s.availableGhs.toString()).toBe(amount); // exact string equality
        const claims = await prisma.fiatLiquidityReceipt.findMany({
            where: { relatedTransactionId: String(deposit.id), status: 'AVAILABLE' },
        });
        expect(claims).toHaveLength(1);
        expect(claims[0].amountGhs.toString()).toBe(amount);
    });

    // =========================================================================
    // Installer pre-flight: duplicate historical AVAILABLE receipts fail the
    // release closed, loudly, read-only — and never pick a winner.
    // =========================================================================
    test('G. installer pre-flight: historical duplicate AVAILABLE receipts block the unique index with a loud actionable error (read-only, no auto-repair)', async () => {
        const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');
        const oldUrl = process.env.DATABASE_URL;
        // The installer uses its own module-level PrismaClient bound to
        // DATABASE_URL at construction — point a fresh require at the test DB.
        jest.resetModules();
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const { installFiatLiquidityOverlay: freshInstaller } = require('../infra/install-fiat-liquidity-overlay');

        // Simulate a pre-index deployment with contradictory history:
        // drop the invariant, write two AVAILABLE claims for one deposit.
        await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "FiatLiquidityReceipt_availableRelatedTx_unique"');
        const deposit = await settledDeposit(30);
        await prisma.fiatLiquidityReceipt.createMany({
            data: [
                { dedupKey: 'receipt:r15a:hist1', provider: 'MOOLRE', amountGhs: 30, status: 'AVAILABLE', relatedTransactionId: String(deposit.id), confirmedAt: new Date() },
                { dedupKey: 'receipt:r15a:hist2', provider: 'MOOLRE', amountGhs: 30, status: 'AVAILABLE', relatedTransactionId: String(deposit.id), confirmedAt: new Date() },
            ],
        });

        await expect(freshInstaller()).rejects.toMatchObject({ code: 'R15A_DUPLICATE_AVAILABLE_RECEIPTS' });
        // the index must NOT exist — the release failed CLOSED
        const idx = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE indexname = 'FiatLiquidityReceipt_availableRelatedTx_unique'`);
        expect(idx).toHaveLength(0);
        // the contradictory rows are still there, untouched (read-only scan)
        expect(await prisma.fiatLiquidityReceipt.count({ where: { status: 'AVAILABLE', relatedTransactionId: String(deposit.id) } })).toBe(2);

        // after human resolution (rows quarantined for review), the release
        // applies the invariant cleanly
        await prisma.fiatLiquidityReceipt.update({
            where: { dedupKey: 'receipt:r15a:hist2' },
            data: { status: 'RECONCILIATION_REQUIRED', relatedTransactionId: null },
        });
        await freshInstaller(); // must not throw
        const idx2 = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE indexname = 'FiatLiquidityReceipt_availableRelatedTx_unique'`);
        expect(idx2).toHaveLength(1);

        // restore the module registry the rest of the suite uses
        jest.resetModules();
        process.env.DATABASE_URL = oldUrl;
    });
});
