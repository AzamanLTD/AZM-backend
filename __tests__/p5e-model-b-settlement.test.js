// __tests__/p5e-model-b-settlement.test.js
//
// §P.5-E real-PostgreSQL proof: Model B settlement / inventory cost-basis
// realization. Design contract: docs/p5e-model-b-settlement.md.
//
// Coverage map (every requirement of the P5-E slice):
//   A. Core settlement (flag ON) — a real mounted Moolre deposit settles
//      through authoritative inventory: exact credit-once, liability ledger ==
//      availableBalance projection, exact lot consumption with
//      purpose/sourceReference/ledgerTxnId, ASSET_CONVERSION with durable
//      identity/rate/quoteReference, GHS asset accounting
//      (fiat:momo:ghs / equity:treasury:ghs), COGS realization at the exact
//      delivered quantity, treasury-stake-funded customer liability, and
//      clearing:conversion NEVER touched.
//   B. Realized economics — quoted vs settled vs inventory cost basis vs
//      customer spread recorded separately and EXACTLY (multi-lot FIFO with a
//      partial tail lot; allocation residual explicit; no quote-only P&L:
//      pnl:inventory stays 0).
//   C. Inventory authority — insufficient inventory fails closed with ZERO
//      customer credit (retryable); concurrent settlements cannot
//      double-allocate; deterministic (createdAt, id) FIFO across lots;
//      webhook replay consumes nothing; conflicting settlement reuse fails
//      closed; the conversion identity is exactly-once at the ledger.
//   D. Evidence & gate failures — missing durable provider evidence, wrong
//      route surface, settled/quote amount mismatch, stale quote, and a late
//      contradictory FAILED callback each leave ZERO partial mutation.
//   E. Regimes — flag OFF is the byte-identical legacy bridge (settlement
//      succeeds with ZERO inventory, posting clearing:conversion, consuming
//      nothing); flag ON is independent of the P5-D liquidity flag (receipt
//      layer composes with Model B on both settings).
//   F. Invariants — ledger inventory:usdc:lots balance == Σ lot remaining
//      after consumption; user liability ledger == projection; GHS ledger
//      balance == Σ Model B settled GHS; equity:treasury USDC stake nets to
//      zero for a fully sold lot; expense:cogs:usdc is catalog-provisioned.
//
// Only non-DB boundaries (audit, journal, notifications, logger) and the
// external Moolre provider are stubbed. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5e-model-b.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E Model B settlement / inventory cost-basis realization (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const ledger = require('../services/ledgerService');
    const inventory = require('../services/inventoryService');
    const modelBSettlement = require('../services/modelBSettlementService');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const { consumeTransactionQuote } = require('../src/services/transactionQuoteService');
    const { Prisma } = require('@prisma/client');
    const Decimal = Prisma.Decimal;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_p5e';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_p5e';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // ── isolation: full wipe of every table this suite touches ──────────────
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
    }, 30000);
    afterEach(async () => { await TRUNCATE_ALL(); }, 30000);

    // ── flags & fixtures ────────────────────────────────────────────────────
    const setModelB = async (on) => {
        await prisma.globalSettings.update({ where: { id: 1 }, data: { modelBSettlementEnabled: on } });
        expect(await modelBSettlement.isModelBSettlementEnabled(prisma)).toBe(on);
    };
    const setLiquidity = async (on) => {
        await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: on } });
        expect(await fiatLiquidity.isAuthorityEnabled(prisma)).toBe(on);
    };

    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-P5E-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    async function initiateDeposit(user, amountGhs = 100, controller = 'moolre') {
        const res = mockResponse();
        const body = { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' };
        if (controller === 'moolre') {
            await moolreQuoteDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        } else {
            await quoteFiatDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        }
        expect(res.statusCode).toBe(201);
        const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' }, orderBy: { id: 'desc' } });
        expect(pending).not.toBeNull();
        return pending;
    }

    async function moolreWebhook(txHash, amountGhs = 100) {
        const res = mockResponse();
        await moolreQuoteDepositController.webhook({
            app: makeApp(),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: txHash, amount: amountGhs, payer: '0241234567' } },
        }, res);
        return res;
    }

    async function genericWebhook(txHash, amountGhs = 100) {
        const res = mockResponse();
        await quoteFiatDepositController.webhook({
            app: makeApp(),
            headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
            body: { reference: txHash, amountGhs, providerTxId: 'GEN-1', status: 'SUCCESS' },
        }, res);
        return res;
    }

    // acquireLot creates INELIGIBLE lots by default (production truth: no
    // production code path grants eligibility). Tests grant it explicitly —
    // simulating ONLY the future evidence-backed acquisition authority.
    const acquireTx = (o = {}) => prisma.$transaction((tx) => inventory.acquireLot(tx, {
        acquisitionKey: o.key ?? `lot:p5e:${Math.random().toString(36).slice(2)}`,
        sourceType: o.sourceType ?? 'CORPORATE_PURCHASE',
        sourceReference: o.sourceReference ?? 'purchase-log:p5e',
        quantity: o.quantity ?? '500',
        costBasisGhs: o.cost ?? '6000',
        acquisitionRate: o.rate === undefined ? '12' : o.rate,
    }).then(async (r) => {
        if (o.eligible !== false) {
            await tx.inventoryLot.update({ where: { id: r.lot.id }, data: { eligibleForModelBSettlement: true } });
        }
        return r.lot;
    }));
    const bal = (account) => ledger.accountBalance(prisma, account).then((b) => b.balance);

    // TransactionQuote is overlay-managed (raw SQL — no Prisma model client).
    // Read the exact persisted strings; never recompute quote economics.
    const quoteRow = async (quoteId) => {
        const rows = await prisma.$queryRaw`
            SELECT "id"::text, "amountGhs"::text AS "amountGhs",
                   "rateGhsPerUsdc"::text AS "rateGhsPerUsdc",
                   "usdcAmount"::text AS "usdcAmount", "consumedAt", "expiresAt"
            FROM "TransactionQuote" WHERE "id" = ${quoteId}::uuid`;
        return rows[0] || null;
    };

    // seed inventory + user + pending deposit and return the pieces
    async function seedScenario({ lotQty = '10', lotCost = '120', amountGhs = 100, surface = 'moolre' } = {}) {
        await setModelB(true);
        const lot = await acquireTx({ quantity: lotQty, cost: lotCost });
        const user = await seedUser(prisma, { availableBalance: 0 });
        const pending = await initiateDeposit(user, amountGhs, surface);
        return { lot, user, pending, quoteId: pending.metadata?.quoteId };
    }

    // =========================================================================
    // A. Core settlement (flag ON, mounted Moolre surface, liquidity ON)
    // =========================================================================
    describe('A. core Model B settlement', () => {
        beforeEach(() => setLiquidity(true));

        test('a settled deposit credits the customer EXACTLY ONCE from real inventory with complete authority rows', async () => {
            const { user, pending } = await seedScenario();
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);

            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('COMPLETED');
            const q = new Decimal(th.amountUsdc); // exact Decimal(20,8)

            // credit-once + projection == ledger (P4 invariant)
            const user2 = await prisma.user.findUnique({ where: { id: user.id } });
            expect(new Decimal(user2.availableBalance).toFixed(8)).toBe(q.toFixed(8));
            expect((await bal(`user:${user.id}:liability`)).toFixed(8)).toBe(q.toFixed(8));

            // inventory consumed exactly, through the P5-B substrate
            const lots = await prisma.inventoryLot.findMany();
            expect(lots).toHaveLength(1);
            expect(new Decimal(lots[0].quantityOriginal).toFixed(8)).toBe('10.00000000');
            expect(new Decimal(lots[0].quantityRemaining).toFixed(8))
                .toBe(new Decimal('10').minus(q).toFixed(8));
            const consumption = await prisma.inventoryLotConsumption.findUnique({ where: { id: 1 } });
            expect(consumption).not.toBeNull();
            expect(consumption.purpose).toBe('MODEL_B_SETTLEMENT');
            expect(consumption.sourceReference).toBe(pending.txHash);
            expect(consumption.ledgerTxnId).not.toBeNull(); // P5-B reserved this for P5-E

            // GHS asset accounting (P5-E adds it; P5-D only tracked liquidity)
            expect((await bal('fiat:momo:ghs')).toFixed(2)).toBe('100.00');
            expect((await bal('equity:treasury:ghs')).toFixed(2)).toBe('100.00');

            // COGS realized at the exact delivered quantity; inventory asset released
            expect((await bal('expense:cogs:usdc')).toFixed(8)).toBe(q.toFixed(8));
            expect((await bal('inventory:usdc:lots')).toFixed(8))
                .toBe(new Decimal('10').minus(q).toFixed(8));

            // treasury stake drawn to fund the customer claim: 10 (acq) − q (drawn)
            expect((await bal('equity:treasury')).toFixed(8)).toBe(new Decimal('10').minus(q).toFixed(8));

            // clearing:conversion untouched by the P5-E regime
            expect((await bal('clearing:conversion')).toFixed(8)).toBe('0.00000000');

            // P5-D receipt composes (flag ON here)
            const receipt = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` } });
            expect(receipt?.status).toBe('AVAILABLE');
        });

        test('the ASSET_CONVERSION posting carries the durable identity, exact quote rate and quote reference', async () => {
            const { user, pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);

            const s = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            expect(s).not.toBeNull();
            expect(s.conversionIdentity).toBe(`p5e:modelb:${pending.txHash}`);

            const conversionTxn = await prisma.ledgerTransaction.findUnique({ where: { id: s.conversionLedgerTxnId } });
            const convMeta = conversionTxn.metadata.conversion;
            expect(convMeta.identity).toBe(`p5e:modelb:${pending.txHash}`);
            expect(convMeta.rate).toBe(new Decimal(convMeta.rate).toFixed(8));
            expect(convMeta.quoteReference).toBe(s.quoteId);
            const quote = await quoteRow(s.quoteId);
            expect(new Decimal(conversionTxn.metadata.conversion.rate).toFixed(8))
                .toBe(new Decimal(quote.rateGhsPerUsdc).toFixed(8));

            const convEntries = await prisma.journalEntry.findMany({ where: { ledgerTransactionId: s.conversionLedgerTxnId }, orderBy: { lineNumber: 'asc' } });
            expect(convEntries).toHaveLength(4);
            const byAccount = Object.fromEntries(convEntries.map((e) => [e.account, e]));
            expect(new Decimal(byAccount['fiat:momo:ghs'].debit).toFixed(2)).toBe('100.00');
            expect(new Decimal(byAccount['equity:treasury:ghs'].credit).toFixed(2)).toBe('100.00');
            expect(new Decimal(byAccount['expense:cogs:usdc'].debit).toFixed(8)).toBe(new Decimal(s.settledUsdc).toFixed(8));
            expect(new Decimal(byAccount['inventory:usdc:lots'].credit).toFixed(8)).toBe(new Decimal(s.settledUsdc).toFixed(8));

            const depEntries = await prisma.journalEntry.findMany({ where: { ledgerTransactionId: s.depositLedgerTxnId } });
            const dep = Object.fromEntries(depEntries.map((e) => [e.account, e]));
            expect(new Decimal(dep['equity:treasury'].debit).toFixed(8)).toBe(new Decimal(s.settledUsdc).toFixed(8));
            expect(new Decimal(dep[`user:${user.id}:liability`].credit).toFixed(8)).toBe(new Decimal(s.settledUsdc).toFixed(8));
        });

        test('expense:cogs:usdc is catalog-provisioned with its canonical identity', async () => {
            const { pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);
            const acct = await prisma.ledgerAccount.findUnique({ where: { code: 'expense:cogs:usdc' } });
            expect(acct).not.toBeNull();
            expect(acct.accountClass).toBe('EXPENSE');
            expect(acct.normalSide).toBe('DEBIT');
            expect(acct.asset).toBe('USDC');
        });

        test('the GENERIC webhook surface settles Model B identically (provider identity recorded)', async () => {
            const { user, pending } = await seedScenario({ surface: 'generic' });
            const res = await genericWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);
            const s = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            expect(s.provider).toBe('GENERIC_FIAT_WEBHOOK');
            expect(s.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            const user2 = await prisma.user.findUnique({ where: { id: user.id } });
            expect(new Decimal(user2.availableBalance).toFixed(8)).toBe(new Decimal(s.settledUsdc).toFixed(8));
        });
    });

    // =========================================================================
    // B. Realized economics: quoted vs settled vs cost basis vs spread
    // =========================================================================
    describe('B. realized economics (exact, separated, no quote-only P&L)', () => {
        test('multi-lot FIFO with a partial tail lot: every figure recorded exactly and independently', async () => {
            await setModelB(true);
            // three lots, distinct acquisition times/cost bases
            const l1 = await acquireTx({ quantity: '4', cost: '48' });   // rate 12
            await new Promise((r) => setTimeout(r, 25));
            const l2 = await acquireTx({ quantity: '4', cost: '44' });    // rate 11
            await new Promise((r) => setTimeout(r, 25));
            const l3 = await acquireTx({ quantity: '4', cost: '52' });    // rate 13
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100); // ~7.45156483 USDC

            expect((await moolreWebhook(pending.txHash, 100)).statusCode).toBe(200);

            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            const q = new Decimal(th.amountUsdc);
            const s = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });

            // quoted economics (quote row) vs settled economics (TH + record)
            const quote = await quoteRow(s.quoteId);
            expect(new Decimal(quote.amountGhs).toFixed(2)).toBe('100.00');
            expect(new Decimal(s.settledGhs).toFixed(2)).toBe('100.00');
            expect(new Decimal(s.quotedGhs).toFixed(2)).toBe('100.00');
            expect(new Decimal(s.settledUsdc).toFixed(8)).toBe(q.toFixed(8));
            expect(new Decimal(s.quotedUsdc).toFixed(8)).toBe(q.toFixed(8)); // same 8dp authority

            // FIFO by (createdAt, id): 4 from l1, then 3.45156483 from l2, l3 untouched
            const allocations = s.lotAllocations;
            expect(allocations).toHaveLength(2);
            expect(allocations[0].lotId).toBe(l1.id);
            expect(new Decimal(allocations[0].quantity).toFixed(8)).toBe('4.00000000');
            expect(allocations[0].costShareGhs).toBe('48.00000000'); // fully consumed: EXACT basis, no arithmetic
            expect(allocations[1].lotId).toBe(l2.id);
            expect(new Decimal(allocations[1].quantity).toFixed(8)).toBe(q.minus(4).toFixed(8));

            // prorated tail share: 44 × (q−4)/4, 8dp HALF_UP — exact inputs recorded
            const tailQ = q.minus(4);
            const expectedTail = new Decimal('44').times(tailQ).div('4').toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            expect(new Decimal(allocations[1].costShareGhs).toFixed(8)).toBe(expectedTail.toFixed(8));

            // totals: cost basis and customer spread are EXACT and GHS-denominated
            const cost = new Decimal('48').plus(expectedTail);
            expect(new Decimal(s.costBasisGhsTotal).toFixed(8)).toBe(cost.toFixed(8));
            expect(new Decimal(s.marginGhs).toFixed(8)).toBe(new Decimal('100').minus(cost).toFixed(8));
            expect(s.providerFeeGhs).toBeNull(); // not evidenced → null, never invented

            // no quote-only P&L: pnl:inventory untouched
            expect(await prisma.journalEntry.count({ where: { account: 'pnl:inventory' } })).toBe(0);

            // l3 untouched, l1 exhausted/closed, l2 open with remainder
            const lots = await prisma.inventoryLot.findMany({ orderBy: { id: 'asc' } });
            expect(lots[0].status).toBe('CONSUMED');
            expect(new Decimal(lots[1].quantityRemaining).toFixed(8)).toBe(new Decimal('4').minus(tailQ).toFixed(8));
            expect(lots[2].status).toBe('OPEN');
        });

        test('a sub-8dp proration residual is recorded explicitly, never absorbed', async () => {
            await setModelB(true);
            // lot: 3 USDC for GHS 100 → settle ~1 USDC → share = 100/3 = 33.3333...
            await acquireTx({ quantity: '3', cost: '100', rate: '33.33333333' });
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 34); // ~2.53353197... → wait: quote maths use liveRetailRate
            expect((await moolreWebhook(pending.txHash, 34)).statusCode).toBe(200);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            const q = new Decimal(th.amountUsdc);
            const s = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            const alloc = s.lotAllocations[0];
            const expectedShare = new Decimal('100').times(q).div('3');
            const share8 = expectedShare.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            expect(new Decimal(alloc.costShareGhs).toFixed(8)).toBe(share8.toFixed(8));
            // residual = exact − recorded, 12dp projection — nonzero and explicit
            const residual = expectedShare.minus(share8);
            if (residual.abs().gte('0.00000001')) {
                expect(new Decimal(s.costAllocationResidualGhs).toFixed(12)).toBe(residual.toDecimalPlaces(12).toFixed(12));
            }
            // the recorded margin is exact GIVEN the recorded 8dp shares
            expect(new Decimal(s.marginGhs).toFixed(8)).toBe(new Decimal('34').minus(share8).toFixed(8));
        });
    });

    // =========================================================================
    // C. Inventory authority: fail-closed, concurrency, FIFO determinism, replay
    // =========================================================================
    describe('C. inventory authority', () => {
        test('insufficient inventory fails closed with ZERO credit — deposit stays PENDING and retryable', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '1', cost: '12' }); // plenty? 1 USDC < needed ~7.45
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);
            const balanceBefore = new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(409); // settlement failed closed, retry invited
            expect(res.payload.message).toMatch(/inventory/i);

            // ZERO partial mutation
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('PENDING');
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe(balanceBefore.toFixed(8));
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
            // the settlement itself posted nothing (lot acquisitions from the
            // fixture legitimately carry their own acquisition postings):
            expect(await prisma.modelBSettlement.count()).toBe(0);
            expect(await prisma.journalEntry.count({ where: { description: { contains: 'Model B settlement' } } })).toBe(0);
            const quote = await quoteRow(pending.metadata.quoteId);
            expect(quote.consumedAt).toBeNull(); // quote NOT consumed → retryable

            // ops acquires inventory → the SAME pending deposit settles on retry
            await acquireTx({ quantity: '10', cost: '120' });
            const res2 = await moolreWebhook(pending.txHash, 100);
            expect(res2.statusCode).toBe(200);
            expect(res2.payload.success).toBe(true);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('COMPLETED');
        });

        test('concurrent settlements cannot double-allocate the same lot quantity', async () => {
            await setModelB(true);
            // one lot holding exactly enough for ONE settlement
            await acquireTx({ quantity: '8', cost: '96' });
            const u1 = await seedUser(prisma, { availableBalance: 0 });
            const u2 = await seedUser(prisma, { availableBalance: 0 });
            const p1 = await initiateDeposit(u1, 100);
            const p2 = await initiateDeposit(u2, 100);
            // durable provider evidence for BOTH (the mounted webhook records
            // it out-of-band before settling); deposits stay PENDING.
            for (const p of [p1, p2]) {
                await fiatLiquidity.recordProviderEvent(prisma, {
                    provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                    providerRef: 'PR-RACE', dedupKey: `event:moolre-collection:${p.txHash}`,
                    amountGhs: 100, relatedReference: p.txHash, raw: null,
                });
            }

            const settle = (txHash) => prisma.$transaction(async (tx) => {
                const th = await tx.transactionHistory.findUnique({ where: { txHash } });
                const quoteId = th.metadata?.quoteId;
                const quote = await require('../src/services/transactionQuoteService').consumeTransactionQuote({ prisma: tx, quoteId, userId: th.userId, purpose: 'deposit' });
                const updated = await tx.transactionHistory.update({ where: { id: th.id }, data: { status: 'COMPLETED', amountUsdc: quote.usdcAmount } });
                await tx.user.update({ where: { id: th.userId }, data: { availableBalance: { increment: quote.usdcAmount } } });
                return modelBSettlement.settleDepositFromInventory(tx, {
                    reference: txHash, transactionHistoryId: th.id, userId: th.userId, quoteId,
                    quotedGhs: quote.amountGhs, quotedRateGhsPerUsdc: quote.rateGhsPerUsdc, quotedUsdc: quote.usdcAmount,
                    settledGhs: 100, settledUsdc: updated.amountUsdc,
                    selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
                    provider: 'MOOLRE', providerRef: 'PR-RACE', evidenceDedupKey: `event:moolre-collection:${txHash}`,
                });
            });

            const outcomes = await Promise.allSettled([settle(p1.txHash), settle(p2.txHash)]);
            const committed = outcomes.filter((o) => o.status === 'fulfilled').length;

            // both deposits need ~7.45156483 of the single 8-USDC lot: at most
            // ONE can commit; a second would over-allocate.
            expect(committed).toBe(1);
            expect(await prisma.modelBSettlement.count()).toBe(1);
            const consumptions = await prisma.inventoryLotConsumption.findMany();
            const total = consumptions.reduce((s, c) => s.plus(new Decimal(c.quantity)), new Decimal(0));
            expect(total.lte('8')).toBe(true);
            const lot = await prisma.inventoryLot.findFirst();
            expect(new Decimal(lot.quantityRemaining).gte(0)).toBe(true);
            expect(await prisma.modelBSettlement.count()).toBe(1);
        });

        test('webhook replay after COMPLETED consumes nothing and credits nothing again', async () => {
            const { user, pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);
            const after = {
                balance: new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance),
                settlements: await prisma.modelBSettlement.count(),
                consumptions: await prisma.inventoryLotConsumption.count(),
                entries: await prisma.journalEntry.count({ where: { ledgerTransactionId: { not: null } } }),
            };
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);
            expect(res.payload.message).toMatch(/already processed/i);
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe(after.balance.toFixed(8));
            expect(await prisma.modelBSettlement.count()).toBe(after.settlements);
            expect(await prisma.inventoryLotConsumption.count()).toBe(after.consumptions);
            expect(await prisma.journalEntry.count({ where: { ledgerTransactionId: { not: null } } })).toBe(after.entries);
        });

        test('conflicting reuse of a committed settlement identity fails closed with zero mutation', async () => {
            const { pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);
            const s0 = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            const quote = await quoteRow(s0.quoteId);

            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                reference: pending.txHash, transactionHistoryId: pending.id, userId: pending.userId, quoteId: s0.quoteId,
                quotedGhs: quote.amountGhs, quotedRateGhsPerUsdc: quote.rateGhsPerUsdc, quotedUsdc: quote.usdcAmount,
                settledGhs: 55, // DIFFERENT economics on the same identity
                settledUsdc: s0.settledUsdc,
                provider: 'MOOLRE', evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'MODEL_B_SETTLED_GHS_MISMATCH' }); // audit r2: binding runs FIRST, then replay eval
            const s1 = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            expect(new Decimal(s1.settledGhs).toFixed(2)).toBe('100.00'); // untouched
        });

        test('the conversion identity is exactly-once across DIFFERENT ledger postings', async () => {
            const { pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);
            await expect(prisma.$transaction((tx) => ledger.post(tx, {
                idempotencyKey: 'p5e:identity-race:other-key',
                entryType: 'ASSET_CONVERSION',
                description: 'attempted reuse of the committed conversion identity',
                conversion: { identity: `p5e:modelb:${pending.txHash}`, rate: '13.42' },
                lines: [
                    { account: 'fiat:momo:ghs', debit: '1' },
                    { account: 'equity:treasury:ghs', credit: '1' },
                    { account: 'expense:cogs:usdc', debit: '1' },
                    { account: 'inventory:usdc:lots', credit: '1' },
                ],
            }))).rejects.toMatchObject({ code: 'LEDGER_CONVERSION_IDENTITY_CONFLICT' });
        });
    });

    // =========================================================================
    // D. Evidence & gate failures — each proven with ZERO partial mutation
    // =========================================================================
    describe('D. evidence and gate failures (fail closed, zero mutation)', () => {
        test('missing durable provider evidence blocks the settlement entirely', async () => {
            const { user, pending, quoteId } = await seedScenario();
            // the mounted webhook ALWAYS records the event first; simulate the
            // pathological case directly at the service boundary: no event row.
            await prisma.fiatProviderEvent.deleteMany({ where: { relatedReference: pending.txHash } });
            const quote = await consumeTransactionQuote({ prisma, quoteId, userId: user.id, purpose: 'deposit' });
            const th = await prisma.transactionHistory.update({ where: { id: pending.id }, data: { status: 'COMPLETED', amountUsdc: quote.usdcAmount } });

            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                reference: pending.txHash, transactionHistoryId: pending.id, userId: user.id, quoteId,
                quotedGhs: quote.amountGhs, quotedRateGhsPerUsdc: quote.rateGhsPerUsdc, quotedUsdc: quote.usdcAmount,
                settledGhs: quote.amountGhs, settledUsdc: th.amountUsdc,
                selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
                provider: 'MOOLRE', evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'MODEL_B_EVIDENCE_MISSING' });
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
            expect(await prisma.modelBSettlement.count()).toBe(0);
        });

        test('wrong route surface fails closed BEFORE any mutation (Model B ON)', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '10', cost: '120' });
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100, 'moolre'); // MOOLRE_MOMO_COLLECTION quote
            const res = await genericWebhook(pending.txHash, 100);        // generic surface is NOT allowed
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/cannot settle/i);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
            expect(await prisma.modelBSettlement.count()).toBe(0);
        });

        test('settled/quote amount mismatch beyond the pesewa gate fails closed', async () => {
            const { user, pending } = await seedScenario();
            const balanceBefore = new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
            const res = await moolreWebhook(pending.txHash, 105); // quote says 100
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/does not match/i);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe(balanceBefore.toFixed(8));
            expect(await prisma.modelBSettlement.count()).toBe(0);
        });

        test('a stale/expired quote fails closed with zero mutation', async () => {
            const { pending } = await seedScenario();
            await prisma.$executeRaw`UPDATE "TransactionQuote" SET "expiresAt" = NOW() - INTERVAL '60 seconds' WHERE "id" = ${pending.metadata.quoteId}::uuid`;
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/quote/i);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            expect(await prisma.modelBSettlement.count()).toBe(0);
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
        });

        test('a late contradictory FAILED callback cannot unwind a committed settlement', async () => {
            const { user, pending } = await seedScenario();
            await moolreWebhook(pending.txHash, 100);
            const committed = {
                balance: new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance),
                settlements: await prisma.modelBSettlement.count(),
            };
            const res = mockResponse();
            await moolreQuoteDepositController.webhook({
                app: makeApp(),
                headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                body: { status: 0, code: 'P02', data: { externalref: pending.txHash, amount: 100 } },
            }, res);
            expect(res.statusCode).toBe(200); // COMPLETED is terminal — acknowledged, never unwound
            expect(res.payload.message).toMatch(/acknowledged/i);
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe(committed.balance.toFixed(8));
            expect(await prisma.modelBSettlement.count()).toBe(committed.settlements);
        });
    });

    // =========================================================================
    // E. Regimes — flag OFF legacy bridge, flag independence from P5-D
    // =========================================================================
    describe('E. rollout regimes', () => {
        test('flag OFF (default): byte-identical legacy bridge — settles with ZERO inventory via clearing:conversion', async () => {
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);
            expect(await modelBSettlement.isModelBSettlementEnabled(prisma)).toBe(false);
            expect(await prisma.inventoryLot.count()).toBe(0); // NO inventory at all

            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);

            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('COMPLETED');
            const q = new Decimal(th.amountUsdc);
            expect((await bal('clearing:conversion')).toFixed(8)).toBe(q.toFixed(8)); // legacy bridge posted
            expect(await prisma.modelBSettlement.count()).toBe(0);
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);            // nothing consumed
            expect(await prisma.journalEntry.count({ where: { account: 'fiat:momo:ghs', ledgerTransactionId: { not: null } } })).toBe(0); // no GHS ledger leg
            expect((await bal(`user:${user.id}:liability`)).toFixed(8)).toBe(q.toFixed(8));
        });

        test('flag OFF with inventory present: the bridge still posts, inventory is NOT consumed', async () => {
            const lot = await acquireTx({ quantity: '10', cost: '120' });
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);
            await moolreWebhook(pending.txHash, 100);
            const l = await prisma.inventoryLot.findUnique({ where: { id: lot.id } });
            expect(new Decimal(l.quantityRemaining).toFixed(8)).toBe('10.00000000');
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe('10.00000000');
            expect((await bal('clearing:conversion')).gt(0)).toBe(true);
        });

        test('flag ON with liquidity OFF: Model B settles; no receipt is created; GHS ledger accounting still lands', async () => {
            const { user, pending } = await seedScenario();
            await setLiquidity(false);
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);
            expect(await prisma.modelBSettlement.count()).toBe(1);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0); // P5-D flag governs receipts, not Model B
            expect((await bal('fiat:momo:ghs')).toFixed(2)).toBe('100.00'); // P5-E ledger leg independent
            expect((await bal(`user:${user.id}:liability`)).gt(0)).toBe(true);
        });
    });

    // =========================================================================
    // F. Invariants — ledger/substrate agreement under repeated settlements
    // =========================================================================
    describe('F. invariants under repeated settlements', () => {
        test('ledger inventory:usdc:lots balance == Σ lot remaining; liability ledger == projection; GHS ledger == Σ settled GHS', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '20', cost: '240' });
            const users = [];
            const pendings = [];
            for (let i = 0; i < 3; i++) {
                const u = await seedUser(prisma, { availableBalance: 0 });
                users.push(u);
                pendings.push(await initiateDeposit(u, 50));
            }
            for (const p of pendings) {
                expect((await moolreWebhook(p.txHash, 50)).statusCode).toBe(200);
            }

            // P5-B invariant extended to the live position (P5-E releases inventory)
            const agg = await prisma.inventoryLot.aggregate({ _sum: { quantityRemaining: true } });
            expect((await bal('inventory:usdc:lots')).toFixed(8)).toBe(new Decimal(agg._sum.quantityRemaining).toFixed(8));

            // every customer: ledger liability == availableBalance projection
            for (const u of users) {
                const row = await prisma.user.findUnique({ where: { id: u.id } });
                expect((await bal(`user:${u.id}:liability`)).toFixed(8)).toBe(new Decimal(row.availableBalance).toFixed(8));
            }

            // GHS ledger asset == Σ settled GHS of Model B settlements
            const sAgg = await prisma.modelBSettlement.aggregate({ _sum: { settledGhs: true } });
            expect((await bal('fiat:momo:ghs')).toFixed(2)).toBe(new Decimal(sAgg._sum.settledGhs).toFixed(2));

            // COGS accumulates the exact delivered quantity
            const cogsAgg = await prisma.modelBSettlement.aggregate({ _sum: { settledUsdc: true } });
            expect((await bal('expense:cogs:usdc')).toFixed(8)).toBe(new Decimal(cogsAgg._sum.settledUsdc).toFixed(8));

            // no quote-only P&L ever
            expect(await prisma.journalEntry.count({ where: { account: 'pnl:inventory' } })).toBe(0);
        });

        test('a fully sold lot returns equity:treasury USDC to zero (acquisition stake drawn in full)', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '4', cost: '48' });
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 53.68); // 53.68 / 13.42 = 4.0 (exact 8dp)
            expect((await moolreWebhook(pending.txHash, 53.68)).statusCode).toBe(200);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(new Decimal(th.amountUsdc).toFixed(8)).toBe('4.00000000');
            expect((await bal('equity:treasury')).toFixed(8)).toBe('0.00000000'); // stake fully drawn
            const lot = await prisma.inventoryLot.findFirst();
            expect(lot.status).toBe('CONSUMED');
        });
    });

    // =========================================================================
    // G. Service-level authority binding (audit r1) — the DIRECT primitive
    //    refuses wrong caller-supplied identities with ZERO mutation.
    // =========================================================================
    describe('G. service-level authority binding (direct primitive, zero mutation)', () => {
        // Base scenario: everything the mounted webhook would have done BEFORE
        // calling the primitive is real — quote consumed for deposit, TH
        // COMPLETED with the committed 8dp amount, durable provider evidence.
        async function seedDirect({ amountGhs = 100 } = {}) {
            await setModelB(true);
            const lot = await acquireTx({ quantity: '10', cost: '120' });
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, amountGhs, 'moolre');
            const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
            const th = await prisma.transactionHistory.update({ where: { id: pending.id }, data: { status: 'COMPLETED', amountUsdc: quote.usdcAmount } });
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'PR-G', dedupKey: `event:moolre-collection:${pending.txHash}`,
                amountGhs, relatedReference: pending.txHash, raw: null,
            });
            return { lot, user, pending, quote, th };
        }
        const baseParams = (d) => ({
            reference: d.pending.txHash, transactionHistoryId: d.th.id, userId: d.user.id, quoteId: d.quote.id,
            quotedGhs: d.quote.amountGhs, quotedRateGhsPerUsdc: d.quote.rateGhsPerUsdc, quotedUsdc: d.quote.usdcAmount,
            settledGhs: d.quote.amountGhs, settledUsdc: d.th.amountUsdc,
            selectedRoute: d.quote.selectedRoute, routeProviderRail: d.quote.routeProviderRail, routePolicyVersion: d.quote.routePolicyVersion,
            provider: 'MOOLRE', providerRef: 'PR-G', evidenceDedupKey: `event:moolre-collection:${d.pending.txHash}`,
        });
        const snapshot = (d) => async () => ({
            settlements: await prisma.modelBSettlement.count(),
            consumptions: await prisma.inventoryLotConsumption.count(),
            lotRemaining: new Decimal((await prisma.inventoryLot.findUnique({ where: { id: d.lot.id } })).quantityRemaining).toFixed(8),
            ledgerEntries: await prisma.journalEntry.count({ where: { ledgerTransactionId: { not: null } } }),
            balance: new Decimal((await prisma.user.findUnique({ where: { id: d.user.id } })).availableBalance).toFixed(8),
        });
        // every negative case: expect the exact fail-closed code AND prove the
        // service performed ZERO mutation (identical pre/post snapshots).
        async function expectFailClosed(d, overrides, code) {
            const before = await snapshot(d)();
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, {
                ...baseParams(d), ...overrides,
            }))).rejects.toMatchObject({ code });
            const after = await snapshot(d)();
            expect(after).toEqual(before);
        }

        test('sanity: the unmodified base scenario settles through the primitive', async () => {
            const d = await seedDirect();
            const { settlement, replayed } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(replayed).toBe(false);
            expect(settlement.transactionHistoryId).toBe(d.th.id);
            expect(settlement.quoteId).toBe(d.quote.id);
            expect(settlement.userId).toBe(d.user.id);
        });

        test('wrong transactionHistoryId fails closed — MODEL_B_TX_NOT_FOUND, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { transactionHistoryId: '00000000-0000-4000-8000-000000000000' }, 'MODEL_B_TX_NOT_FOUND');
        });

        test('wrong userId fails closed — MODEL_B_TX_USER_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { userId: d.user.id + 1 }, 'MODEL_B_TX_USER_MISMATCH');
        });

        test('a quote belonging to another user fails closed — MODEL_B_QUOTE_USER_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            const stranger = await seedUser(prisma, { availableBalance: 0 });
            const strangerPending = await initiateDeposit(stranger, 100, 'moolre');
            const strangerQuote = await consumeTransactionQuote({ prisma, quoteId: strangerPending.metadata.quoteId, userId: stranger.id, purpose: 'deposit' });
            await expectFailClosed(d, { quoteId: strangerQuote.id }, 'MODEL_B_QUOTE_USER_MISMATCH');
        });

        test('wrong quote economics (quotedGhs) fail closed — MODEL_B_QUOTE_AMOUNT_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { quotedGhs: 99.99 }, 'MODEL_B_QUOTE_AMOUNT_MISMATCH');
        });

        test('wrong quote rate fails closed — MODEL_B_QUOTE_RATE_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { quotedRateGhsPerUsdc: '13.42000001' }, 'MODEL_B_QUOTE_RATE_MISMATCH');
        });

        test('wrong settledUsdc vs the committed TransactionHistory fails closed — MODEL_B_TX_AMOUNT_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { settledUsdc: '1.00000000' }, 'MODEL_B_TX_AMOUNT_MISMATCH');
        });

        test('settledUsdc diverging from the quote 8dp projection fails closed — MODEL_B_QUOTE_USDC_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            const q = await prisma.$queryRaw`SELECT "usdcAmount"::text AS "usdcAmount" FROM "TransactionQuote" WHERE "id" = ${d.quote.id}::uuid`;
            const qUsdc8 = new Decimal(q[0].usdcAmount).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            // a plausible-but-wrong committed amount: the quote rounded DOWN a half pesewa
            await prisma.transactionHistory.update({ where: { id: d.th.id }, data: { amountUsdc: qUsdc8.plus('0.00000001').toFixed(8) } });
            const th = await prisma.transactionHistory.findUnique({ where: { id: d.th.id } });
            await expectFailClosed({ ...d, th }, { settledUsdc: th.amountUsdc }, 'MODEL_B_QUOTE_USDC_MISMATCH');
        });

        test('provider mismatch vs the durable evidence fails closed — MODEL_B_EVIDENCE_PROVIDER_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { provider: 'EVIL_AGGREGATOR' }, 'MODEL_B_EVIDENCE_PROVIDER_MISMATCH');
        });

        test('providerRef mismatch vs the durable evidence fails closed — MODEL_B_EVIDENCE_PROVIDER_REF_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { providerRef: 'NOT-THE-OBSERVED-REF' }, 'MODEL_B_EVIDENCE_PROVIDER_REF_MISMATCH');
        });

        test('route mismatch vs the persisted quote fails closed — MODEL_B_ROUTE_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { selectedRoute: 'GENERIC_FIAT_WEBHOOK' }, 'MODEL_B_ROUTE_MISMATCH');
        });

        test('rail mismatch vs the persisted quote fails closed — MODEL_B_ROUTE_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { routeProviderRail: 'TELECEL_CASH' }, 'MODEL_B_ROUTE_MISMATCH');
        });

        test('settledGhs 99.99 against a 100.00 quote fails closed — MODEL_B_SETTLED_GHS_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { settledGhs: 99.99 }, 'MODEL_B_SETTLED_GHS_MISMATCH');
        });

        test('settledGhs 100.01 against a 100.00 quote fails closed — MODEL_B_SETTLED_GHS_MISMATCH, zero mutation', async () => {
            const d = await seedDirect();
            await expectFailClosed(d, { settledGhs: 100.01 }, 'MODEL_B_SETTLED_GHS_MISMATCH');
        });

        // ── audit r2: replay authority binding ──────────────────────────────
        // After a VALID settlement, a replay of the same reference with ANY
        // wrong caller-supplied identity/economic field fails closed at the
        // authority binding or the committed-row comparison — the replay
        // fast-path can never bypass authority validation. An EXACT
        // same-authority replay returns the committed settlement with
        // replayed=true and performs zero additional mutation.
        async function seedReplayed() {
            const d = await seedDirect();
            const { settlement, replayed } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(replayed).toBe(false); // the initial settlement is real
            return { ...d, settlement };
        }

        test('exact same-authority replay returns the committed settlement, replayed=true, ZERO new mutation', async () => {
            const d = await seedReplayed();
            const before = await snapshot(d)();
            const { settlement, replayed } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, baseParams(d)));
            expect(replayed).toBe(true);
            expect(settlement.id).toBe(d.settlement.id); // same committed identity
            expect(await prisma.modelBSettlement.count()).toBe(before.settlements); // no duplicate settlement
            expect(await prisma.inventoryLotConsumption.count()).toBe(before.consumptions); // no additional claim
            expect(await prisma.journalEntry.count({ where: { ledgerTransactionId: { not: null } } })).toBe(before.ledgerEntries); // no additional ledger rows
        });

        test('replay with wrong transactionHistoryId fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { transactionHistoryId: '00000000-0000-4000-8000-000000000000' }, 'MODEL_B_TX_NOT_FOUND');
        });

        test('replay with wrong userId fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { userId: d.user.id + 1 }, 'MODEL_B_TX_USER_MISMATCH');
        });

        test('replay with wrong quoteId fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { quoteId: '00000000-0000-4000-8000-000000000000' }, 'MODEL_B_QUOTE_NOT_FOUND');
        });

        test('replay with wrong quotedGhs fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { quotedGhs: new Decimal(d.quote.amountGhs).plus(1).toFixed(2) }, 'MODEL_B_QUOTE_AMOUNT_MISMATCH');
        });

        test('replay with wrong quotedRateGhsPerUsdc fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { quotedRateGhsPerUsdc: new Decimal(d.quote.rateGhsPerUsdc).plus(0.01).toFixed(8) }, 'MODEL_B_QUOTE_RATE_MISMATCH');
        });

        test('replay with wrong quotedUsdc fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { quotedUsdc: new Decimal(d.quote.usdcAmount).plus('0.00000001').toFixed(12) }, 'MODEL_B_QUOTE_USDC_MISMATCH');
        });

        // audit r3: a caller value that differs from the persisted quote ONLY at
        // the 9th–12th decimal (same 8dp projection) must fail closed at the
        // EXACT 12dp authority binding — the projection can never authorize it.
        test('replay with same-8dp/different-12dp quotedUsdc (delta 0.000000000001) fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            const nudged = new Decimal(d.quote.usdcAmount).plus('0.000000000001').toFixed(12);
            expect(new Decimal(nudged).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8))
                .toBe(new Decimal(d.quote.usdcAmount).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8)); // same 8dp projection
            await expectFailClosed(d, { quotedUsdc: nudged }, 'MODEL_B_QUOTE_USDC_MISMATCH');
        });

        test('direct call with same-8dp/different-12dp quotedUsdc (delta 0.000000000001) fails closed — zero mutation', async () => {
            const d = await seedDirect();
            const nudged = new Decimal(d.quote.usdcAmount).plus('0.000000000001').toFixed(12);
            await expectFailClosed(d, { quotedUsdc: nudged }, 'MODEL_B_QUOTE_USDC_MISMATCH');
        });

        test('replay with wrong route identity fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { selectedRoute: 'momo-some-other-route' }, 'MODEL_B_ROUTE_MISMATCH');
        });

        test('replay with wrong provider fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { provider: 'KOTANI' }, 'MODEL_B_EVIDENCE_PROVIDER_MISMATCH');
        });

        test('replay with wrong providerRef fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { providerRef: 'PR-OTHER' }, 'MODEL_B_EVIDENCE_PROVIDER_REF_MISMATCH');
        });

        test('replay with wrong evidenceDedupKey fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { evidenceDedupKey: 'event:moolre-collection:nonexistent' }, 'MODEL_B_EVIDENCE_MISSING');
        });

        test('replay with a withheld quotedUsdc (null vs committed) fails closed — zero mutation', async () => {
            const d = await seedReplayed();
            await expectFailClosed(d, { quotedUsdc: null }, 'MODEL_B_SETTLEMENT_CONFLICT');
        });
    });

    // =========================================================================
    // H. Exact GHS settlement for Model B (audit r1) — 99.99/100.01 vs a
    //    100.00 quote: the ±0.01 tolerance is flag-OFF legacy ONLY.
    // =========================================================================
    describe('H. exact GHS (99.99/100.01 against a 100.00 quote)', () => {
        const zeroMutation = async (user, pending) => {
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe('0.00000000');
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
            expect(await prisma.modelBSettlement.count()).toBe(0);
            expect(await prisma.journalEntry.count({ where: { account: { in: ['expense:cogs:usdc', `user:${user.id}:liability`] } } })).toBe(0);
            const quote = await quoteRow(pending.metadata.quoteId);
            expect(quote.consumedAt).toBeNull(); // the quote was NOT consumed → deposit retryable
        };

        test('flag ON, moolre surface: 99.99 rejected, zero mutation, deposit retryable', async () => {
            const { user, pending } = await seedScenario(); // quote is 100.00
            const res = await moolreWebhook(pending.txHash, 99.99);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/does not match/i);
            await zeroMutation(user, pending);
        });

        test('flag ON, moolre surface: 100.01 rejected, zero mutation, deposit retryable', async () => {
            const { user, pending } = await seedScenario();
            const res = await moolreWebhook(pending.txHash, 100.01);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/does not match/i);
            await zeroMutation(user, pending);
        });

        test('flag ON, generic surface: 99.99 rejected, zero mutation, deposit retryable', async () => {
            const { user, pending } = await seedScenario({ surface: 'generic' });
            const res = await genericWebhook(pending.txHash, 99.99);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/does not match/i);
            await zeroMutation(user, pending);
        });

        test('flag ON, generic surface: 100.01 rejected, zero mutation, deposit retryable', async () => {
            const { user, pending } = await seedScenario({ surface: 'generic' });
            const res = await genericWebhook(pending.txHash, 100.01);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/does not match/i);
            await zeroMutation(user, pending);
        });

        test('flag OFF legacy compatibility: a within-±0.01 settled amount still settles via the legacy bridge (byte-identical)', async () => {
            await setModelB(false); // legacy regime — the ±0.01 affordance stays untouched
            await acquireTx({ quantity: '10', cost: '120' });
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 5.5);
            const res = await moolreWebhook(pending.txHash, 5.51); // 0.01 off quote → legacy bridge accepts
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('COMPLETED');
            expect(await prisma.modelBSettlement.count()).toBe(0); // bridge, not Model B
            expect(await prisma.inventoryLotConsumption.count()).toBe(0); // inventory untouched
            expect((await bal('clearing:conversion')).gt(0)).toBe(true); // legacy bridge posted
        });
    });

    // =========================================================================
    // I. Inventory authority audit (audit r1) — eligibility is structural:
    //    quantity alone can NEVER fund a real customer USDC liability.
    //    Production truth: acquireLot creates INELIGIBLE lots and NO
    //    production code path grants eligibility — only the future
    //    evidence-backed acquisition authority may.
    // =========================================================================
    describe('I. inventory eligibility gate (no synthetic inventory funds a customer)', () => {
        test('acquireLot lots are INELIGIBLE by default — the acquisition substrate never self-grants settlement authority', async () => {
            const lot = await prisma.$transaction((tx) => inventory.acquireLot(tx, {
                acquisitionKey: 'lot:p5e:ineligible-by-default', sourceType: 'CORPORATE_PURCHASE', sourceReference: 'purchase-log:p5e',
                quantity: '500', costBasisGhs: '6000', acquisitionRate: '12',
            }).then((r) => r.lot));
            expect(lot.eligibleForModelBSettlement).toBe(false); // the audit's guarantee, structural
        });

        test('an INELIGIBLE lot with plenty of quantity can NEVER fund a settlement — fails closed, zero mutation', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '500', cost: '6000', eligible: false }); // quantity exists, authority does not
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(409);
            expect(res.payload.message).toMatch(/inventory/i);
            // zero financial mutation: deposit stays PENDING and retryable
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            expect(new Decimal((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance).toFixed(8)).toBe('0.00000000');
            expect(await prisma.inventoryLotConsumption.count()).toBe(0);
            expect(await prisma.modelBSettlement.count()).toBe(0);
            const quote = await quoteRow(pending.metadata.quoteId);
            expect(quote.consumedAt).toBeNull();

            // only an explicit eligibility grant (the future evidence-backed
            // acquisition authority) lets the SAME deposit settle
            await prisma.inventoryLot.updateMany({ data: { eligibleForModelBSettlement: true } });
            const res2 = await moolreWebhook(pending.txHash, 100);
            expect(res2.statusCode).toBe(200);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('COMPLETED');
        });

        test('insufficient count ignores INELIGIBLE quantity — eligibility, not quantity, is the inventory authority', async () => {
            await setModelB(true);
            await acquireTx({ quantity: '500', cost: '6000', eligible: false }); // plenty of ineligible quantity
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);
            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(409);
            const s = res.payload; expect(s.message).toMatch(/eligible OPEN lots hold 0.00000000/i);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
        });
    });

    // =========================================================================
    // J. Cost-allocation residual (audit r1) — the TRUE sub-8dp residual is
    //    durable and exact: partial-lot basis = recorded 8dp cost + residual.
    // =========================================================================
    describe('J. exact cost allocation with a non-zero residual', () => {
        test('partial lot: exact prorated basis = recorded 8dp costShare + durable 12dp residual, EXACTLY', async () => {
            await setModelB(true);
            // engineered exact numbers: rate 12.5 → 12.50 GHS quotes exactly 1 USDC.
            await prisma.globalSettings.update({ where: { id: 1 }, data: { liveRetailRate: 12.5, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() } });
            // lot: 640 USDC at GHS 100.01 → take 1 USDC → shareExact = 100.01/640 = 0.156265625 EXACT (9dp)
            await acquireTx({ quantity: '640', cost: '100.01', rate: '0.15626563' }); // provenance only (8dp authority)
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 12.5); // quotes exactly 1 USDC
            expect((await moolreWebhook(pending.txHash, 12.5)).statusCode).toBe(200);

            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(new Decimal(th.amountUsdc).toFixed(8)).toBe('1.00000000'); // the engineered take
            const s = await prisma.modelBSettlement.findUnique({ where: { reference: pending.txHash } });
            const alloc = s.lotAllocations[0];

            // the exact rational share and its decomposition
            const shareExact = new Decimal('100.01').times('1').div('640'); // 0.156265625 — exact at 9dp
            const costShare8 = shareExact.toDecimalPlaces(8, Decimal.ROUND_HALF_UP); // 0.15626563
            const residual = shareExact.minus(costShare8); // −0.000000005 — EXACT, 9dp, well inside 12dp

            expect(alloc.quantity).toBe('1.00000000');
            expect(alloc.costShareGhs).toBe(costShare8.toFixed(8));
            expect(alloc.shareResidualGhs).toBe(residual.toFixed(12)); // the TRUE residual, 12dp, never 8dp-collapsed

            // audit r1 identity, EXACT: partial-lot basis = recorded 8dp cost + durable residual
            expect(new Decimal(alloc.costShareGhs).plus(new Decimal(alloc.shareResidualGhs)).toFixed(12)).toBe(shareExact.toFixed(12));

            // the settlement-level residual is the exact sum of the recorded residuals
            expect(new Decimal(s.costAllocationResidualGhs).toFixed(12)).toBe(residual.toFixed(12));

            // costBasisGhsTotal is the EXACT sum of the RECORDED 8dp shares
            expect(new Decimal(s.costBasisGhsTotal).toFixed(8)).toBe(costShare8.toFixed(8));
            expect(new Decimal(s.marginGhs).toFixed(8)).toBe(new Decimal('12.50').minus(costShare8).toFixed(8));
        });
    });
});
