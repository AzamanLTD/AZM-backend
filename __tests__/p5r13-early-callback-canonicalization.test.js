// __tests__/p5r13-early-callback-canonicalization.test.js
//
// §P.5-E audit r13 (§4, §7): the early-P01 race matrix and providerRef
// canonicalization.
//
// §4 (per route): for MOOLRE_MOMO_COLLECTION deposits the early P01 in the
// pre-stamp window now records the NULL-ref observation durably and settles;
// the initiation stamp enriches the SAME row (r11 CAS) and retries converge. For
// GENERIC_FIAT_AGGREGATOR deposits the r8 rail-aware contract is preserved:
// Moolre involvement is proven only by the OTP stamp, so the P01 fails closed
// 409 with NO observation until the stamp lands.
// §7: the settlement records the CANONICAL providerRef (durable evidence ref
// when the caller passes none; reconciliation converges TH and event; a
// contradiction fails closed with NOTHING settled).
//
// Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r13-early.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E r13: early-callback race matrix + providerRef canonicalization (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const inventory = require('../services/inventoryService');
    const modelBSettlement = require('../services/modelBSettlementService');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { consumeTransactionQuote } = require('../src/services/transactionQuoteService');
    const { Prisma } = require('@prisma/client');
    const Decimal = Prisma.Decimal;
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');

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
        await prisma.$transaction(async (tx) => {
            const lot = await inventory.acquireLot(tx, {
                acquisitionKey: `lot:r13e:${Math.random().toString(36).slice(2)}`,
                sourceType: 'CORPORATE_PURCHASE', sourceReference: 'purchase-log:r13',
                quantity: '500', costBasisGhs: '6000', acquisitionRate: '12',
            });
            await tx.inventoryLot.update({ where: { id: lot.lot.id }, data: { eligibleForModelBSettlement: true } });
        });
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
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-R13E-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });
    const initiateMoolre = async (userId, amountGhs = 100) => {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: userId }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        // r14 §S: TH ids are UUIDs — lexical ordering is a coin-flip; bind to the
        // 201 payload's reference instead of guessing the newest PENDING row.
        expect(res.payload?.data?.reference).toBeTruthy();
        return await prisma.transactionHistory.findUnique({ where: { txHash: res.payload.data.reference } });
    };
    const initiateGeneric = async (userId, amountGhs = 100) => {
        const res = mockResponse();
        await quoteFiatDepositController.initiate(
            { app: makeApp(), user: { id: userId }, body: { amountGhs, provider: 'MTN_MOMO' }, ip: '127.0.0.1', headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        // r14 §S: TH ids are UUIDs — lexical ordering is a coin-flip; bind to the
        // 201 payload's reference instead of guessing the newest PENDING row.
        expect(res.payload?.data?.reference).toBeTruthy();
        return await prisma.transactionHistory.findUnique({ where: { txHash: res.payload.data.reference } });
    };
    const moolreWebhook = async (txHash, amount = 100) => {
        const res = mockResponse();
        await moolreQuoteDepositController.webhook({
            app: makeApp(),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: txHash, amount, payer: '0241234567' } },
        }, res);
        return res;
    };
    const eventsFor = async (txHash) => prisma.fiatProviderEvent.findMany({ where: { relatedReference: txHash } });

    // =========================================================================
    // A. concurrent identical early P01s — exactly-once observation and
    //    settlement, no lost update, no double credit.
    // =========================================================================
    describe('A. concurrent early callbacks', () => {
        test('two IDENTICAL early P01s racing in the pre-stamp window → ONE observation, ONE settlement, exactly-once economics', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id);
            await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: null } });

            const [r1, r2] = await Promise.all([
                moolreWebhook(pending.txHash),
                moolreWebhook(pending.txHash),
            ]);

            // r12 duplicate-concurrency contract: ONE settles; the racer
            // either converges (200, no data) or fails safe (409 quote-already-
            // consumed) — race-dependent, both exactly-once. The economics
            // below prove exactly-once regardless of which envelope won.
            const codes = [r1.statusCode, r2.statusCode].sort();
            expect(codes[0]).toBe(200); // the settler
            expect([200, 409]).toContain(codes[1]);
            if (codes[1] === 200) {
                const settled = [r1, r2].filter((r) => r.payload?.data?.quoteId);
                expect(settled).toHaveLength(1);
            }

            // exactly ONE observation (r7 identity), ONE settlement
            expect(await eventsFor(pending.txHash)).toHaveLength(1);
            expect(await prisma.modelBSettlement.count()).toBe(1);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('COMPLETED');

            // exactly-once economics: inventory consumed once, credited once
            const consumptions = await prisma.inventoryLotConsumption.findMany();
            expect(consumptions).toHaveLength(1);
            const u = await prisma.user.findUnique({ where: { id: user.id } });
            const q = await prisma.$queryRaw`SELECT "usdcAmount"::text AS u FROM "TransactionQuote" WHERE "id" = ${pending.metadata.quoteId}::uuid`;
            const expected = new Decimal(q[0].u).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            expect(new Decimal(u.availableBalance).toFixed(8)).toBe(expected.toFixed(8));
        });
    });

    // =========================================================================
    // B. enrichment races — the observation ref slot converges to exactly one
    //    value; a conflicting enrichment surfaces typed, nothing contradictory.
    // =========================================================================
    describe('B. enrichment race (r11 CAS)', () => {
        test('two stamps racing to enrich the SAME NULL-ref observation → exactly ONE ref wins, the row is never multi-valued', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id);
            await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: null } });

            // early P01 settles with a NULL-ref observation
            const early = await moolreWebhook(pending.txHash);
            expect(early.statusCode).toBe(200);
            expect(await eventsFor(pending.txHash)).toHaveLength(1);

            // two initiation responses race to enrich the SAME slot
            const results = await Promise.allSettled([
                fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, `event:moolre-collection:${pending.txHash}`, 'PR-ENRICH-A'),
                fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, `event:moolre-collection:${pending.txHash}`, 'PR-ENRICH-B'),
            ]);
            const fulfilled = results.filter((r) => r.status === 'fulfilled');
            const rejected = results.filter((r) => r.status === 'rejected');
            expect(fulfilled).toHaveLength(1); // exactly one ref wins
            expect(rejected).toHaveLength(1); // the other surfaces typed
            expect(rejected[0].reason).toBeInstanceOf(fiatLiquidity.ConflictingEvidenceError);

            // the durable row carries EXACTLY ONE ref
            const events = await eventsFor(pending.txHash);
            expect(events).toHaveLength(1);
            const ref = events[0].providerRef;
            expect(['PR-ENRICH-A', 'PR-ENRICH-B']).toContain(ref);

            // an exact P01 retry still converges (already-processed)
            const retry = await moolreWebhook(pending.txHash);
            expect(retry.statusCode).toBe(200);
            expect(await prisma.modelBSettlement.count()).toBe(1);
            expect((await eventsFor(pending.txHash))[0].providerRef).toBe(ref);
        });
    });

    // =========================================================================
    // C. rail-aware contract preserved for GENERIC-route deposits (§P.5-C):
    //    no Moolre involvement proof (no OTP stamp) → 409, NO observation;
    //    once the OTP stamp lands, the SAME P01 settles.
    // =========================================================================
    describe('C. generic-route rail-aware gate', () => {
        test('generic deposit never through Moolre → P01 fails closed 409 with NO observation, NOTHING settles', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateGeneric(user.id);
            expect(pending.providerRef).toBeFalsy();

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(409);

            expect(await eventsFor(pending.txHash)).toHaveLength(0); // no durable observation
            expect(await prisma.modelBSettlement.count()).toBe(0);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('PENDING');
            const u = await prisma.user.findUnique({ where: { id: user.id } });
            expect(new Decimal(u.availableBalance).toFixed(8)).toBe('0.00000000');
        });

        test('the same generic deposit settles once the OTP-confirmation stamp lands (legitimate Moolre OTP path)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateGeneric(user.id);

            // the OTP path stamps the Moolre providerRef (confirmMoolreOtp)
            await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: 'PR-OTP-STAMP' } });

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(200);

            const events = await eventsFor(pending.txHash);
            expect(events).toHaveLength(1);
            expect(events[0].providerRef).toBe('PR-OTP-STAMP');
            expect(await prisma.modelBSettlement.count()).toBe(1);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.status).toBe('COMPLETED');
        });
    });

    // =========================================================================
    // D. §7 canonicalization + reconciliation on the mounted surface.
    // =========================================================================
    describe('D. providerRef canonicalization (§7)', () => {
        test('event ref + TH NULL → the TH slot is stamped FROM the durable evidence and the settlement records the canonical ref', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id);
            // the stamp was lost (crashed initiation response) but the provider
            // observation arrived and was enriched by ops/backfill
            await prisma.transactionHistory.update({ where: { id: pending.id }, data: { providerRef: null } });
            const early = await moolreWebhook(pending.txHash); // settles, NULL ref
            expect(early.statusCode).toBe(200);

            // backfill: the observation gains the initiation ref
            await fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, `event:moolre-collection:${pending.txHash}`, 'PR-BACKFILL');

            // a second P01 retry reconciles: TH (still NULL) is stamped FROM
            // the durable evidence — already-processed, nothing re-settles
            const retry = await moolreWebhook(pending.txHash);
            expect(retry.statusCode).toBe(200);
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.providerRef).toBe('PR-BACKFILL');
            const settlement = await prisma.modelBSettlement.findFirst({ where: { reference: pending.txHash } });
            expect(settlement.providerRef).toBeNull(); // canonical AT COMMIT TIME — never invented
            expect(await prisma.modelBSettlement.count()).toBe(1);
        });

        test('TH ref + event NULL → the observation is enriched to the TH ref and the settlement records it (fresh deposit)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id); // stamped by initiate
            expect(pending.providerRef).toBeTruthy();

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(200);

            // the observation was constructed WITH the ref — converged
            const events = await eventsFor(pending.txHash);
            expect(events).toHaveLength(1);
            expect(events[0].providerRef).toBe(pending.providerRef);
            const settlement = await prisma.modelBSettlement.findFirst({ where: { reference: pending.txHash } });
            expect(settlement.providerRef).toBe(pending.providerRef); // canonical ref recorded
        });

        test('both present but DIFFERENT → PROVIDER_REF_CONTRADICTION, NOTHING settles, both rows remain durable', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id);
            // an ops mis-backfill writes a DIFFERENT ref into the observation
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'PR-WRONG', dedupKey: `event:moolre-collection:${pending.txHash}`,
                amountGhs: 100, relatedReference: pending.txHash, raw: null,
            });

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(409);
            // the r7 substrate identity catches the ref contradiction FIRST
            // (same dedupKey, materially different providerRef → typed
            // CONFLICT, retained durably). The reconcile block's
            // PROVIDER_REF_CONTRADICTION is the belt for the sub-evidence
            // interleaving (event enriched between evidence recording and the
            // reconcile read) — unreachable deterministically from the surface
            // because the substrate refuses the divergent payload first.
            expect(res.payload.code).toBe('CONTRADICTORY_PROVIDER_EVIDENCE');

            // both authorities remain durable and unchanged; nothing settled
            const events = await eventsFor(pending.txHash);
            expect(events.length).toBeGreaterThanOrEqual(1);
            expect(events[0].providerRef).toBe('PR-WRONG');
            const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(th.providerRef).toBe(pending.providerRef);
            expect(await prisma.modelBSettlement.count()).toBe(0);
            expect(th.status).toBe('PENDING');
        });
    });

    // =========================================================================
    // E. §7 canonicalization at the direct primitive (replay masking).
    // =========================================================================
    describe('E. primitive-level canonical ref', () => {
        async function seedDirect() {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateMoolre(user.id);
            const quote = await consumeTransactionQuote({ prisma, quoteId: pending.metadata.quoteId, userId: user.id, purpose: 'deposit' });
            // the mounted webhook's committed amount: the EXACT 8dp projection
            const settledUsdcLedger = new Decimal(quote.usdcAmountExact).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
            const th = await prisma.transactionHistory.update({ where: { id: pending.id }, data: { status: 'COMPLETED', amountUsdc: settledUsdcLedger.toFixed(8) } });
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', providerRef: 'PR-CANON',
                dedupKey: `event:moolre-collection:${pending.txHash}`, amountGhs: 100, relatedReference: pending.txHash, raw: null,
            });
            const params = (overrides = {}) => ({
                reference: pending.txHash, transactionHistoryId: th.id, userId: user.id, quoteId: quote.id,
                quotedGhs: quote.amountGhsExact, quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact, quotedUsdc: quote.usdcAmountExact,
                settledGhs: quote.amountGhsExact, settledUsdc: settledUsdcLedger.toFixed(8),
                selectedRoute: quote.selectedRoute, routeProviderRail: quote.routeProviderRail, routePolicyVersion: quote.routePolicyVersion,
                provider: 'MOOLRE', providerRef: null, // caller passes NONE
                evidenceDedupKey: `event:moolre-collection:${pending.txHash}`,
                ...overrides,
            });
            return { user, pending, quote, th, params };
        }

        test('caller passes NO ref, evidence has one → the settlement records the evidence ref (canonical)', async () => {
            const d = await seedDirect();
            const { settlement } = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params()));
            expect(settlement.providerRef).toBe('PR-CANON');
        });

        test('caller ref == evidence ref → converges; caller ref ≠ evidence ref → fail closed zero mutation', async () => {
            const d = await seedDirect();
            const ok = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params({ providerRef: 'PR-CANON' })));
            expect(ok.settlement.providerRef).toBe('PR-CANON');

            const d2 = await seedDirect();
            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d2.params({ providerRef: 'PR-FABRICATED' }))))
                .rejects.toMatchObject({ code: 'MODEL_B_EVIDENCE_PROVIDER_REF_MISMATCH' });
            expect(await prisma.modelBSettlement.count()).toBe(1); // only the first
        });

        test('replay with NO ref converges; replay with a DIFFERENT ref conflicts — replay masking closed', async () => {
            const d = await seedDirect();
            const first = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params({ providerRef: 'PR-CANON' })));
            expect(first.settlement.providerRef).toBe('PR-CANON');

            const replayNull = await prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params()));
            expect(replayNull.replayed).toBe(true);
            expect(replayNull.settlement.providerRef).toBe('PR-CANON');

            await expect(prisma.$transaction((tx) => modelBSettlement.settleDepositFromInventory(tx, d.params({ providerRef: 'PR-OTHER' }))))
                .rejects.toMatchObject({ code: 'MODEL_B_EVIDENCE_PROVIDER_REF_MISMATCH' }); // fires BEFORE replay evaluation — a different ref can never hide behind replay convergence
            expect(await prisma.modelBSettlement.count()).toBe(1);
            expect(await prisma.inventoryLotConsumption.count()).toBe(1); // nothing re-consumed
        });
    });
});
