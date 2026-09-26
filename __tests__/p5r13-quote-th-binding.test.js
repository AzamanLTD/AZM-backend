// __tests__/p5r13-quote-th-binding.test.js
//
// §P.5-E audit r13 (§1, §8): TransactionHistory ↔ TransactionQuote binding.
//
// The mounted initiation stamps the quote it created into the deposit's own
// persisted metadata (TransactionHistory.metadata.quoteId) in the SAME
// transaction that creates both — that persisted binding is the deposit's
// quote authority. The primitive previously verified every ECONOMIC property
// of the supplied quote (user, amounts, rate, USDC, route) but never that the
// quote WAS the deposit's own: a second quote with byte-identical economics
// for the same user could stand in for the deposit's quote (e.g. replay
// masking, cross-deposit quote substitution). r13 adds the binding check
// BEFORE any mutation with a dedicated fail-closed code, plus DB-enforced
// exactly-once identity (audit §8): UNIQUE(quoteId) and
// UNIQUE(transactionHistoryId) on ModelBSettlement.
//
// Only non-DB boundaries (audit, journal, notifications, logger) and the
// external Moolre provider are stubbed. Skips cleanly without
// TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r13-binding.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E r13: TransactionHistory ↔ TransactionQuote binding (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const inventory = require('../services/inventoryService');
    const modelBSettlement = require('../services/modelBSettlementService');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { consumeTransactionQuote } = require('../src/services/transactionQuoteService');
    const { Prisma } = require('@prisma/client');
    const Decimal = Prisma.Decimal;
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_p5e';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_p5e';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    }, 30000);

    afterAll(async () => {
        if (prisma) {
            // Restore the rollout flags to the production default so any
            // suite that runs AFTER this one inherits a clean slate.
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            }).catch(() => null);
            await prisma.$disconnect();
        }
    }, 30000);

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ModelBSettlement", "InventoryLotConsumption", "InventoryLot", "LedgerTransaction", "LedgerAccount", "JournalEntry", "TransactionQuote", "TransactionHistory", "FiatProviderEvent", "FiatLiquidityReceipt", "SystemFiatPool", "User" RESTART IDENTITY CASCADE'
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
        await prisma.globalSettings.update({ where: { id: 1 }, data: { modelBSettlementEnabled: true, fiatLiquidityAuthorityEnabled: true } });
    }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    // ── harness (mirrors the mounted initiation + webhook exactly) ───────────
    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-R13-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    async function initiateDeposit(user, amountGhs = 100) {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        // r14 §S harness integrity: TransactionHistory ids are UUIDs — ordering
        // by them is lexical coin-flip, and this helper used findFirst(id desc)
        // to guess "the deposit I just created". With two PENDING deposits the
        // guess silently returned the WRONG (or the same) row ~50% of runs.
        // The 201 body names the exact row — bind to it deterministically.
        const reference = res.payload?.data?.reference;
        expect(reference).toBeTruthy();
        return await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    }

    async function acquireEligibleLot(quantity = '500', cost = '6000') {
        await prisma.$transaction(async (tx) => {
            const lot = await inventory.acquireLot(tx, {
                acquisitionKey: `lot:r13bind:${Math.random().toString(36).slice(2)}`,
                sourceType: 'CORPORATE_PURCHASE', sourceReference: 'purchase-log:r13',
                quantity, costBasisGhs: cost, acquisitionRate: '12',
            });
            await tx.inventoryLot.update({ where: { id: lot.lot.id }, data: { eligibleForModelBSettlement: true } });
        });
    }

    // direct-primitive seed: a fully legitimate settlement scenario EXCEPT the
    // caller may substitute a different (same-user, same-economics) quote.
    async function seedScenario({ amountGhs = 100 } = {}) {
        await acquireEligibleLot();
        const user = await seedUser(prisma, { availableBalance: 0 });
        const pending = await initiateDeposit(user, amountGhs);
        const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
        const th = await prisma.transactionHistory.update({ where: { id: pending.id }, data: { status: 'COMPLETED', amountUsdc: quote.usdcAmount } });
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', providerRef: 'PR-R13-EV',
            dedupKey: `event:moolre-collection:${pending.txHash}`, amountGhs, relatedReference: pending.txHash, raw: null,
        });
        return { user, pending, quote, th };
    }

    // a SECOND quote for the SAME user with byte-identical economics — created
    // exactly the way the mounted initiation creates quotes, persisted and
    // consumed like deposit #1's.
    async function seedTwinQuote(user, amountGhs = 100) {
        // NOTE: TransactionHistory.id is a UUID — id ordering is arbitrary.
        // The twin is identified by status PENDING + newest created_date.
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        const newest = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
        });
        expect(newest).not.toBeNull();
        expect(newest.status).toBe('PENDING');
        const quote2 = await consumeTransactionQuote({ prisma, quoteId: newest.metadata.quoteId, userId: user.id, purpose: 'deposit' });
        return { pending2: newest, quote2 };
    }

    const baseParams = (d) => ({
        reference: d.pending.txHash, transactionHistoryId: d.th.id, userId: d.user.id, quoteId: d.quote.id,
        quotedGhs: d.quote.amountGhs, quotedRateGhsPerUsdc: d.quote.rateGhsPerUsdc, quotedUsdc: d.quote.usdcAmount,
        settledGhs: d.quote.amountGhs, settledUsdc: d.th.amountUsdc,
        selectedRoute: d.quote.selectedRoute, routeProviderRail: d.quote.routeProviderRail, routePolicyVersion: d.quote.routePolicyVersion,
        provider: 'MOOLRE', providerRef: 'PR-R13-EV', evidenceDedupKey: `event:moolre-collection:${d.pending.txHash}`,
    });

    const snapshot = (d) => async () => ({
        settlements: await prisma.modelBSettlement.count(),
        consumptions: await prisma.inventoryLotConsumption.count(),
        balance: new Decimal((await prisma.user.findUnique({ where: { id: d.user.id } })).availableBalance).toFixed(8),
        lotRemaining: new Decimal((await prisma.inventoryLot.findFirst()).quantityRemaining).toFixed(8),
        ledgerTxns: await prisma.ledgerTransaction.count(),
    });

    // =========================================================================
    // A. the attack: an identically-economic SECOND quote can never settle
    //    another deposit — the persisted TH↔quote binding is the authority.
    // =========================================================================
    describe('A. second-quote substitution (direct primitive, zero mutation)', () => {
        test('settling deposit #1 with the SAME-USER twin quote fails closed — MODEL_B_TX_QUOTE_BINDING_MISMATCH, zero mutation', async () => {
            const d = await seedScenario();
            const { quote2 } = await seedTwinQuote(d.user);

            // the twin is byte-identical in every ECONOMIC dimension —
            // every pre-r13 check would accept it.
            expect(String(quote2.amountGhs)).toBe(String(d.quote.amountGhs));
            expect(String(quote2.rateGhsPerUsdc)).toBe(String(d.quote.rateGhsPerUsdc));
            expect(String(quote2.usdcAmount)).toBe(String(d.quote.usdcAmount));
            expect(quote2.userId).toBe(d.quote.userId);

            const before = await snapshot(d)();
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                ...baseParams(d), quoteId: quote2.id,
            }))).rejects.toMatchObject({ code: 'MODEL_B_TX_QUOTE_BINDING_MISMATCH' });
            expect(await snapshot(d)()).toEqual(before);
        });

        test('a deposit whose persisted metadata.quoteId was hand-cleared (no binding) fails closed — never settles on an unbound quote', async () => {
            const d = await seedScenario();
            await prisma.transactionHistory.update({
                where: { id: d.th.id },
                data: { metadata: { ...d.th.metadata, quoteId: null } },
            });
            const before = await snapshot(d)();
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d))))
                .rejects.toMatchObject({ code: 'MODEL_B_TX_QUOTE_BINDING_MISMATCH' });
            expect(await snapshot(d)()).toEqual(before);
        });

        test("sanity: the deposit's OWN quote still settles and replay converges on the binding", async () => {
            const d = await seedScenario();
            const first = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(first.replayed).toBe(false);
            const replay = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(replay.replayed).toBe(true);
            expect(replay.settlement.id).toBe(first.settlement.id);
            expect(await prisma.modelBSettlement.count()).toBe(1);
        });
    });

    // =========================================================================
    // B. DB-enforced exactly-once identity (audit §8): even a future code
    //    path that bypassed every service check cannot create a second
    //    settlement for one quote or one settled deposit.
    // =========================================================================
    describe('B. DB unique identity indexes (§8)', () => {
        test('a second ModelBSettlement row with the SAME quoteId is rejected by the database (unique index)', async () => {
            const d = await seedScenario();
            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(settlement.quoteId).toBe(d.quote.id);

            await expect(prisma.modelBSettlement.create({
                data: {
                    reference: `OTHER-REF-${Date.now()}`,
                    transactionHistoryId: '99999999-9999-4999-8999-999999999999',
                    quoteId: d.quote.id, userId: d.user.id,
                    provider: 'MOOLRE', providerRef: null, evidenceDedupKey: 'event:other',
                    quotedGhs: d.quote.amountGhs, quotedRateGhsPerUsdc: d.quote.rateGhsPerUsdc, quotedUsdc: d.quote.usdcAmount,
                    settledGhs: d.quote.amountGhs, settledUsdc: d.th.amountUsdc,
                    costBasisGhsTotal: '0', costAllocationResidualGhs: '0', marginGhs: '0',
                    conversionIdentity: `conv-${Date.now()}`, conversionLedgerTxnId: 'x', depositLedgerTxnId: 'y',
                    lotAllocations: [],
                },
            })).rejects.toMatchObject({ code: 'P2002' });
            expect(await prisma.modelBSettlement.count()).toBe(1);
        });

        test('a second ModelBSettlement row with the SAME transactionHistoryId is rejected by the database (unique index)', async () => {
            const d = await seedScenario();
            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(settlement.transactionHistoryId).toBe(d.th.id);

            await expect(prisma.modelBSettlement.create({
                data: {
                    reference: `OTHER-REF-${Date.now()}`,
                    transactionHistoryId: d.th.id,
                    quoteId: settlement.quoteId, userId: d.user.id,
                    provider: 'MOOLRE', providerRef: null, evidenceDedupKey: 'event:other2',
                    quotedGhs: d.quote.amountGhs, quotedRateGhsPerUsdc: d.quote.rateGhsPerUsdc, quotedUsdc: d.quote.usdcAmount,
                    settledGhs: d.quote.amountGhs, settledUsdc: d.th.amountUsdc,
                    costBasisGhsTotal: '0', costAllocationResidualGhs: '0', marginGhs: '0',
                    conversionIdentity: `conv2-${Date.now()}`, conversionLedgerTxnId: 'x2', depositLedgerTxnId: 'y2',
                    lotAllocations: [],
                },
            })).rejects.toMatchObject({ code: 'P2002' });
            expect(await prisma.modelBSettlement.count()).toBe(1);
        });
    });

    // =========================================================================
    // C. mounted surface: the webhook settles each deposit on ITS OWN quote.
    //    Two concurrent webhooks for two identical deposits never cross-wire.
    // =========================================================================
    describe('C. mounted cross-deposit isolation', () => {
        test('two deposits, same user, identical amounts — each settles exactly once on its own quote', async () => {
            await acquireEligibleLot('1000', '12000');
            const user = await seedUser(prisma, { availableBalance: 0 });
            const p1 = await initiateDeposit(user, 100);
            const p2 = await initiateDeposit(user, 100);
            expect(p1.metadata.quoteId).not.toBe(p2.metadata.quoteId);

            const webhook = (txHash) => {
                const res = mockResponse();
                return moolreQuoteDepositController.webhook({
                    app: makeApp(),
                    headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                    body: { status: 1, code: 'P01', data: { externalref: txHash, amount: 100, payer: '0241234567' } },
                }, res).then(() => res);
            };
            const [r1, r2] = await Promise.all([webhook(p1.txHash), webhook(p2.txHash)]);
            expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);

            const settlements = await prisma.modelBSettlement.findMany();
            expect(settlements).toHaveLength(2);
            expect(new Set(settlements.map((s) => s.quoteId)).size).toBe(2);
            expect(new Set(settlements.map((s) => s.transactionHistoryId)).size).toBe(2);
            const u = await prisma.user.findUnique({ where: { id: user.id } });
            const q1 = await prisma.$queryRaw`SELECT "usdcAmount"::text AS u FROM "TransactionQuote" WHERE "id" = ${p1.metadata.quoteId}::uuid`;
            const q2 = await prisma.$queryRaw`SELECT "usdcAmount"::text AS u FROM "TransactionQuote" WHERE "id" = ${p2.metadata.quoteId}::uuid`;
            const expected = new Decimal(q1[0].u).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).plus(new Decimal(q2[0].u).toDecimalPlaces(8, Decimal.ROUND_HALF_UP));
            expect(new Decimal(u.availableBalance).toFixed(8)).toBe(expected.toFixed(8));
        });
    });
});
