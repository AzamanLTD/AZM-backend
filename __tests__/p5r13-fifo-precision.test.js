// __tests__/p5r13-fifo-precision.test.js
//
// §P.5-E audit r13 (§3): FIFO cost-basis proration precision.
//
// The proration basis × take / original previously ran in decimal.js's
// DEFAULT 20-significant-digit context. Verified counterexample class: the
// intermediate product of two DECIMAL(20,8) magnitudes carries ~24 significant
// digits — default-precision truncation silently rounds the product BEFORE the
// division, and the 8dp HALF_UP projection of the share then lands on the
// WRONG CENT (either direction) at permitted schema magnitudes. r13 computes
// the share in a 60-significant-digit context, projects ONCE at the 8dp ledger
// authority, records the true remainder as shareResidualGhs (12dp), and fails
// closed with TYPED errors when aggregate totals would exceed the durable
// DECIMAL(20,8)/(20,12) bounds.
//
// Fixtures below were found programmatically so that the exact share and the
// 20-significant-digit share PROVABLY disagree at the 8th decimal.
// Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r13-fifo.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E r13: FIFO cost-basis proration precision (real PostgreSQL)', () => {
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

    // ── harness ──────────────────────────────────────────────────────────────
    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-R13F-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });
    async function acquireLotDirect({ quantity, costBasisGhs }) {
        return prisma.$transaction(async (tx) => {
            const lot = await inventory.acquireLot(tx, {
                acquisitionKey: `lot:r13f:${Math.random().toString(36).slice(2)}`,
                sourceType: 'CORPORATE_PURCHASE', sourceReference: 'purchase-log:r13',
                quantity, costBasisGhs, acquisitionRate: null,
            });
            await tx.inventoryLot.update({ where: { id: lot.lot.id }, data: { eligibleForModelBSettlement: true } });
            return lot.lot;
        });
    }

    // The quote side of the fixtures: 9000123456.78 GHS @ 13.42 →
    // settledUsdc (take) = 670650034.03725782 EXACTLY (verified 12dp→8dp).
    const AMOUNT_GHS = '9000123456.78';
    const TAKE = '670650034.03725782';

    async function seedSettleable({ amountGhs = AMOUNT_GHS } = {}) {
        const user = await seedUser(prisma, { availableBalance: 0 });
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
                // r14 §S harness integrity: TransactionHistory ids are UUIDs — ordering by
        // them is a lexical coin-flip. Bind to the 201 body's reference instead of
        // guessing the newest PENDING row (two same-user pending deposits made the
        // old findFirst(id desc) return the wrong/same row ~50% of runs).
        expect(res.payload?.data?.reference).toBeTruthy();
        const pending = await prisma.transactionHistory.findUnique({ where: { txHash: res.payload.data.reference } });
        const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
        // the mounted webhook's committed amount: the EXACT 8dp projection
        const th = await prisma.transactionHistory.update({
            where: { id: pending.id },
            data: { status: 'COMPLETED', amountUsdc: TAKE },
        });
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', providerRef: 'PR-R13F-EV',
            dedupKey: `event:moolre-collection:${pending.txHash}`, amountGhs, relatedReference: pending.txHash, raw: null,
        });
        const params = {
            reference: pending.txHash, transactionHistoryId: th.id, userId: user.id, quoteId: quote.id,
            quotedGhs: quote.amountGhsExact, quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact, quotedUsdc: quote.usdcAmountExact,
            settledGhs: amountGhs, settledUsdc: TAKE,
            selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
            provider: 'MOOLRE', providerRef: 'PR-R13F-EV',
            evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
        };
        return { user, pending, quote, th, params };
    }

    // =========================================================================
    // A. the exact share vs the 20-significant-digit share — provably different
    //    at the 8th decimal (the audit's counterexample class, at realizable
    //    schema-valid magnitudes).
    // =========================================================================
    describe('A. proration exactness (audit counterexample class)', () => {
        // fixture 1 (programmatic): exact 8dp .76607368, 20-sig 8dp .76607369
        const FIX1 = {
            basis: '640703605733.52775700', original: '992923312741.46421900',
            exact8: '432750333.76607368', wrong8: '432750333.76607369',
        };
        // fixture 2 (programmatic): exact 8dp .30792547, 20-sig 8dp .30792548
        const FIX2 = {
            basis: '708241758546.98428179', original: '375196926743.26398496',
            exact8: '1265954824.30792547', wrong8: '1265954824.30792548',
        };

        test.each([
            ['fixture 1 (exact rounds DOWN, truncated rounds UP)', FIX1],
            ['fixture 2 (exact rounds DOWN, truncated rounds UP)', FIX2],
        ])('%s — the recorded share is the EXACT 60-digit projection, and the residual closes the identity', async (_label, F) => {
            await acquireLotDirect({ quantity: F.original, costBasisGhs: F.basis });
            const d = await seedSettleable();

            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params));

            const allocation = settlement.lotAllocations[0];
            expect(allocation.quantity).toBe(TAKE); // partial take
            expect(allocation.costShareGhs).toBe(F.exact8);
            expect(allocation.costShareGhs).not.toBe(F.wrong8);

            // the residual identity: costShareGhs + shareResidualGhs == the
            // exact rational share (whenever representable at 12dp)
            const HP = Decimal.clone({ precision: 60 });
            const shareExact = new HP(F.basis).times(new HP(TAKE)).div(new HP(F.original));
            // NOTE: the identity sum itself needs >20 significant digits —
            // compute it in the HP context (the exactness the service uses).
            const identity = new HP(allocation.costShareGhs).plus(new HP(allocation.shareResidualGhs));
            expect(identity.toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toFixed(12)).toBe(shareExact.toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toFixed(12));

            // the durable total is the EXACT sum of the recorded 8dp shares
            expect(new Decimal(settlement.costBasisGhsTotal).toFixed(8)).toBe(F.exact8);
            // margin is exact GHS-denominated economics
            const margin = new Decimal(AMOUNT_GHS).minus(new Decimal(F.exact8));
            expect(new Decimal(settlement.marginGhs).toFixed(8)).toBe(margin.toFixed(8));

            // lot remaining is exact 8dp arithmetic
            const lot = await prisma.inventoryLot.findFirst();
            expect(new Decimal(lot.quantityRemaining).toFixed(8)).toBe(new Decimal(F.original).minus(new Decimal(TAKE)).toFixed(8));
        });

        test('a FULL lot take realizes the basis EXACTLY with zero residual (no proration)', async () => {
            // lot smaller than the take: quantity 100e6 fully consumed, then a
            // second lot covers the rest — the first claim is proration-free
            await acquireLotDirect({ quantity: '100000000', costBasisGhs: '120000000' });
            await acquireLotDirect({ quantity: '800000000', costBasisGhs: '960000000' });
            const d = await seedSettleable();

            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params));
            const [a1, a2] = settlement.lotAllocations;

            // first claim: full take of the lot — share == basis, residual 0
            expect(a1.quantity).toBe('100000000.00000000');
            expect(a1.costShareGhs).toBe('120000000.00000000');
            expect(new Decimal(a1.shareResidualGhs).toFixed(12)).toBe('0.000000000000');

            // second claim: prorated remainder — the identity still closes
            const HP = Decimal.clone({ precision: 60 });
            const share2Exact = new HP('960000000').times(new HP(TAKE).minus(new HP('100000000'))).div(new HP('800000000'));
            const share2Exact8 = share2Exact.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            expect(new Decimal(a2.costShareGhs).toFixed(8)).toBe(share2Exact8.toFixed(8));
            const identity = new HP(a2.costShareGhs).plus(new HP(a2.shareResidualGhs));
            expect(identity.toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toFixed(12)).toBe(share2Exact.toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toFixed(12));

            // the durable total is the exact sum of both recorded shares
            const total = new Decimal(a1.costShareGhs).plus(new Decimal(a2.costShareGhs));
            expect(new Decimal(settlement.costBasisGhsTotal).toFixed(8)).toBe(total.toFixed(8));
        });
    });

    // =========================================================================
    // B. aggregate overflow guards — typed fail-closed errors, zero mutation,
    //    for multi-lot takes whose recorded totals exceed the durable bounds.
    // =========================================================================
    describe('B. aggregate overflow (typed, fail-closed)', () => {
        test('a two-lot take whose recorded cost total exceeds DECIMAL(20,8) fails closed — MODEL_B_AGGREGATE_OVERFLOW, zero mutation', async () => {
            // take spans both lots: 6e11 + ~4.06e11 = ~1.006e12 > 1e12
            await acquireLotDirect({ quantity: '400000000', costBasisGhs: '600000000000' });
            await acquireLotDirect({ quantity: '400000000', costBasisGhs: '600000000000' });
            const d = await seedSettleable();

            const before = {
                settlements: await prisma.modelBSettlement.count(),
                consumptions: await prisma.inventoryLotConsumption.count(),
            };
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params)))
                .rejects.toMatchObject({ code: 'MODEL_B_AGGREGATE_OVERFLOW' });
            expect(await prisma.modelBSettlement.count()).toBe(before.settlements);
            expect(await prisma.inventoryLotConsumption.count()).toBe(before.consumptions);
            // no ledger rows from the aborted attempt
            expect(await prisma.ledgerTransaction.count()).toBe(2); // only the two acquisitions
        });
    });
});
