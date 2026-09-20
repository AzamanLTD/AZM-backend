// __tests__/p5r13-exact-quote-propagation.test.js
//
// §P.5-E audit r13 (§2, §5, §6): exact quote-authority propagation.
//
// §2 — the persisted TransactionQuote is the deposit's USDC authority at its
//      native numeric(30,12) scale, but every authoritative write on the
//      mounted settlement path derived from the LOSSY Number projection
//      (verified: Number('67890123.123456789012') === 67890123.12345679) —
//      TransactionHistory.amountUsdc, the balance credit, the Model B quote
//      binding. r13 threads the exact persisted strings end-to-end.
// §5 — the Moolre provider request amount is the CANONICAL quoted GHS (exact
//      2dp), never the raw unnormalized input float (a sub-pesewa input like
//      100.005 used to reach Moolre verbatim while the quote normalized it).
// §6 — the 2dp money normalization is exact decimal HALF_UP (the float
//      Math.round((v+EPSILON)*100)/100 silently changed 41958.285 → 41958.28).
//
// Only non-DB boundaries are stubbed. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r13-exact.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E r13: exact quote-authority propagation (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const inventory = require('../services/inventoryService');
    const modelBSettlement = require('../services/modelBSettlementService');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { consumeTransactionQuote, roundMoney, roundMoneyExact } = require('../src/services/transactionQuoteService');
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

    // provider mock that CAPTURES the exact request amount (§5)
    let providerRefCounter = 0;
    let lastProviderRequest = null;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async (req) => {
                    lastProviderRequest = req;
                    return { requiresOtp: false, providerRef: `PR-R13X-${++providerRefCounter}` };
                }),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });
    const initiate = async (userId, amountGhs) => {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: userId }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        const pending = await prisma.transactionHistory.findFirst({ where: { userId, type: 'DEPOSIT_FIAT', status: 'PENDING' }, orderBy: { id: 'desc' } });
        expect(pending).not.toBeNull();
        return pending;
    };
    const moolreWebhook = (txHash, amount) => {
        const res = mockResponse();
        return moolreQuoteDepositController.webhook({
            app: makeApp(),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: txHash, amount, payer: '0241234567' } },
        }, res).then(() => res);
    };
    const rawQuote = async (quoteId) => (await prisma.$queryRaw`
        SELECT "amountGhs"::text AS "amountGhs", "usdcAmount"::text AS "usdcAmount",
               "rateGhsPerUsdc"::text AS "rate", "feeGhs"::text AS "feeGhs", "netGhs"::text AS "netGhs"
        FROM "TransactionQuote" WHERE "id" = ${quoteId}::uuid`)[0];
    const acquireEligibleLot = async (quantity = '500', cost = '6000') => prisma.$transaction(async (tx) => {
        const lot = await inventory.acquireLot(tx, {
            acquisitionKey: `lot:r13x:${Math.random().toString(36).slice(2)}`,
            sourceType: 'CORPORATE_PURCHASE', sourceReference: 'purchase-log:r13',
            quantity, costBasisGhs: cost, acquisitionRate: '12',
        });
        await tx.inventoryLot.update({ where: { id: lot.lot.id }, data: { eligibleForModelBSettlement: true } });
    });

    // =========================================================================
    // §6 — exact 2dp money normalization (unit level)
    // =========================================================================
    describe('§6: exact 2dp HALF_UP normalization', () => {
        test('the float-tie corruption is fixed: 8.575 → 8.58 exact HALF_UP (the OLD Math.round path gave 8.57)', () => {
            // Binary-float ties are build-dependent (41958.285*100 happens to
            // land on 4195828.5 in this V8), but 8.575*100 lands on
            // 857.4999999999999 — the OLD formula provably rounds it DOWN.
            expect(Math.round((8.575 + Number.EPSILON) * 100) / 100).toBe(8.57); // the OLD broken behavior
            expect(roundMoney(8.575)).toBe(8.58);
            expect(roundMoneyExact(8.575).toFixed(2)).toBe('8.58');
            expect(roundMoneyExact(41958.285).toFixed(2)).toBe('41958.29');
        });

        test('sub-pesewa inputs normalize HALF_UP exactly across the scale', () => {
            expect(roundMoney(100.005)).toBe(100.01);
            expect(roundMoney(100.004)).toBe(100.00);
            expect(roundMoney(0.005)).toBe(0.01);
            expect(roundMoney('123.455')).toBe(123.46);
        });

        test('large-magnitude ties stay exact (no float cents loss)', () => {
            expect(roundMoney(999999999999.985)).toBe(999999999999.99);
            expect(roundMoneyExact(999999999999.984).toFixed(2)).toBe('999999999999.98');
            expect(roundMoneyExact(999999999999.985).toFixed(2)).toBe('999999999999.99');
        });
    });

    // =========================================================================
    // §5 — canonical 2dp amount to the provider (mounted initiation)
    // =========================================================================
    describe('§5: canonical provider request amount', () => {
        test('a sub-pesewa input reaches Moolre as the CANONICAL quoted 2dp string — never the raw float', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiate(user.id, 100.005);

            // the quote authority normalized the input to 2dp HALF_UP
            const q = await rawQuote(pending.metadata.quoteId);
            expect(new Decimal(q.amountGhs).toFixed(2)).toBe('100.01');

            // the provider request, the pending metadata and the persisted
            // quote agree exactly at the GHS 2dp authority
            expect(lastProviderRequest.amountGhs).toBe('100.01');
            expect(pending.metadata.amountGhsExact).toBe('100.01');
            expect(String(lastProviderRequest.amountGhs)).toBe(new Decimal(q.amountGhs).toFixed(2));
        });

        test('canonical-normalized deposit settles on the canonical amount and REJECTS the raw-input amount', async () => {
            await acquireEligibleLot();
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiate(user.id, 100.005); // canonicalized to 100.01

            // Moolre collects the CANONICAL amount → settles
            const ok = await moolreWebhook(pending.txHash, 100.01);
            expect(ok.statusCode).toBe(200);
            expect(await prisma.modelBSettlement.count()).toBe(1);

            // a different deposit whose provider collected the RAW input
            // (Moolre never would — but prove the surface agrees with the
            // quote authority, not the input float)
            const pending2 = await initiate(user.id, 200.005); // canonicalized to 200.01
            const bad = await moolreWebhook(pending2.txHash, 200.00);
            expect(bad.statusCode).toBe(409); // amount ≠ quote → fail closed
            expect(await prisma.transactionHistory.findUnique({ where: { id: pending2.id } }).then((t) => t.status)).toBe('PENDING');
        });
    });

    // =========================================================================
    // §2 — exact 12dp persisted quote through the whole settlement path.
    // Magnitude chosen so the Number projection of the 12dp USDC amount
    // provably differs from the exact value at the 8dp ledger projection
    // (verified: 9000123456.78 GHS @ 13.42 → 670650034.037257824140,
    // exact 8dp .03725782 vs Number-projected .03725780).
    // =========================================================================
    describe('§2: exact 12dp USDC authority at magnitude', () => {
        const AMOUNT_GHS = '9000123456.78';
        const usdc12 = () => new Decimal(AMOUNT_GHS).div(new Decimal('13.42')).toDecimalPlaces(12, Decimal.ROUND_HALF_UP);
        const exact8 = () => usdc12().toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
        const lossy8 = () => new Decimal(Number(usdc12().toFixed(12))).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);

        test('the fixture loses precision in the Number projection (proves the test exercises exactness)', () => {
            expect(exact8().toFixed(8)).toBe('670650034.03725782');
            expect(lossy8().toFixed(8)).toBe('670650034.03725780');
            expect(lossy8().eq(exact8())).toBe(false);
        });

        test('a large-magnitude quote settles EXACTLY end-to-end (TH, balance, Model B)', async () => {
            await acquireEligibleLot('671000000', '8052000000');
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiate(user.id, AMOUNT_GHS);
            const quoteId = pending.metadata.quoteId;

            // persisted 12dp authority agrees with the fixture
            const q = await rawQuote(quoteId);
            expect(new Decimal(q.usdcAmount).toFixed(12)).toBe(usdc12().toFixed(12));

            const res = await moolreWebhook(pending.txHash, AMOUNT_GHS);
            expect(res.statusCode).toBe(200);

            // TH.amountUsdc derives from the EXACT 12dp string — NOT the
            // lossy Number projection the pre-r13 controller threaded.
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(new Decimal(th.amountUsdc).toFixed(8)).toBe(exact8().toFixed(8));
            expect(new Decimal(th.amountUsdc).toFixed(8)).not.toBe(lossy8().toFixed(8));

            // the balance credit is the same exact 8dp ledger authority
            const u = await prisma.user.findUnique({ where: { id: user.id } });
            expect(new Decimal(u.availableBalance).toFixed(8)).toBe(exact8().toFixed(8));

            // the Model B settlement bound the exact 12dp quote authority
            const settlement = await prisma.modelBSettlement.findFirst({ where: { reference: pending.txHash } });
            expect(settlement).not.toBeNull();
            expect(settlement.quoteId).toBe(quoteId);
            expect(new Decimal(settlement.quotedUsdc).toFixed(8)).toBe(exact8().toFixed(8));
            expect(new Decimal(settlement.settledUsdc).toFixed(8)).toBe(exact8().toFixed(8));
        });

        test('a LOSSY caller projection of the quote is rejected by the exact binding (direct primitive)', async () => {
            await acquireEligibleLot('671000000', '8052000000');
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiate(user.id, AMOUNT_GHS);
            const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
            expect(quote.usdcAmountExact).toBe(usdc12().toFixed(12));

            // mount what the webhook would have done — but with the committed
            // TH amount equal to the LOSSY 8dp Number projection (exactly what
            // the pre-r13 mounted path would have produced).
            const lossy = lossy8();
            const th = await prisma.transactionHistory.update({
                where: { id: pending.id },
                data: { status: 'COMPLETED', amountUsdc: lossy.toFixed(8) },
            });
            expect(lossy.eq(exact8())).toBe(false); // the loss bites

            // durable provider evidence at the canonical GHS
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', providerRef: 'PR-R13X-EV',
                dedupKey: `event:moolre-collection:${pending.txHash}`, amountGhs: AMOUNT_GHS, relatedReference: pending.txHash, raw: null,
            });

            const before = await prisma.modelBSettlement.count();
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                reference: pending.txHash, transactionHistoryId: th.id, userId: user.id, quoteId: quote.id,
                quotedGhs: quote.amountGhsExact, quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact,
                quotedUsdc: quote.usdcAmountExact,
                settledGhs: AMOUNT_GHS, settledUsdc: th.amountUsdc,
                selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
                provider: 'MOOLRE', providerRef: 'PR-R13X-EV',
                evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'MODEL_B_QUOTE_USDC_MISMATCH' });
            expect(await prisma.modelBSettlement.count()).toBe(before);
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
        });

        test('the same scenario with the EXACT 8dp committed amount settles cleanly', async () => {
            await acquireEligibleLot('671000000', '8052000000');
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiate(user.id, AMOUNT_GHS);
            const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
            const th = await prisma.transactionHistory.update({
                where: { id: pending.id },
                data: { status: 'COMPLETED', amountUsdc: exact8().toFixed(8) },
            });
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', providerRef: 'PR-R13X-EV2',
                dedupKey: `event:moolre-collection:${pending.txHash}`, amountGhs: AMOUNT_GHS, relatedReference: pending.txHash, raw: null,
            });
            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                reference: pending.txHash, transactionHistoryId: th.id, userId: user.id, quoteId: quote.id,
                quotedGhs: quote.amountGhsExact, quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact,
                quotedUsdc: quote.usdcAmountExact,
                settledGhs: AMOUNT_GHS, settledUsdc: th.amountUsdc,
                selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
                provider: 'MOOLRE', providerRef: 'PR-R13X-EV2',
                evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
            }));
            expect(settlement.quoteId).toBe(quote.id);
            // the primitive's own outputs: inventory consumed + ledger posted
            // exactly (the balance credit is the mounted controller's
            // post-settlement step, asserted in the mounted test above).
            expect(await prisma.inventoryLotConsumption.count()).toBeGreaterThan(0);
            const lot = await prisma.inventoryLot.findFirst();
            expect(new Decimal(lot.quantityRemaining).toFixed(8)).toBe(new Decimal('671000000').minus(exact8()).toFixed(8));
        });
    });
});
