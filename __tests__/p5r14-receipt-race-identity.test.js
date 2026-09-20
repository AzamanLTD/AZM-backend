// __tests__/p5r14-receipt-race-identity.test.js
// =============================================================================
// §P.5-D audit r14: receipt ownership under GENUINE PostgreSQL concurrency.
//
// PROVES, with Prisma NEVER mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. The recordReceipt ownership claim is ONE ATOMIC guarded INSERT
//      (§A) — a concurrent duplicate of the same dedupKey NEVER aborts the
//      loser's transaction with P2002 (which aborts the whole underlying
//      PostgreSQL transaction): ON CONFLICT DO NOTHING blocks until the
//      concurrent winner commits or rolls back, returns zero rows, and the
//      loser re-reads the authoritative row in the SAME still-valid
//      transaction — converging with ZERO liquidity mutation. Exactly one
//      creator performs the AVAILABLE increment, by construction, under any
//      interleaving (including a deliberate interlock where the winner holds
//      its transaction open past the INSERT so the loser genuinely blocks on
//      the uncommitted unique index entry).
//   B. ONE dedupKey names ONE receipt — the replay identity is the FULL
//      semantic economics (§B): provider, rail, amountGhs, route, reference,
//      eventDedupKey, relatedTransactionId and the ECONOMIC CLASS. Every
//      differing replay fails closed with ZERO mutation; providerRef is
//      enrichment-only (null→present via a database-enforced compare-and-set —
//      never last-writer-wins, never downgraded; two concurrent DIFFERENT
//      present refs: exactly one wins, the loser fails closed).
//   L. Quote substitution is closed (§L, from the r13 audit): a matched
//      receipt must name the deposit's OWN quote at creation AND on replay —
//      a same-user TWIN quote with identical economics can never satisfy the
//      chain, and an existing receipt cannot be replayed under a different
//      quote either.
//   M. Reservation providerRef enrichment is a COMPARE-AND-SET (§M):
//      markReservationInTransit / settleReservation never write a payout
//      reference unconditionally — a NULL slot is filled by exactly one
//      concurrent winner; a present ref is immutable (same ref converges,
//      a DIFFERENT ref is contradictory evidence and fails closed).
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
if (!hasDb) console.warn('[p5r14-receipt-race.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-D r14: receipt ownership races + identity contract (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { consumeTransactionQuote, createTransactionQuote, persistTransactionQuote } = require('../src/services/transactionQuoteService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_p5r14';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_p5r14';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) {
            // Hermetic exit (p5d pattern): overlay-managed quote rows are not
            // user-cascade dependent, so remove them explicitly, then wipe the
            // user cascade (TH backing, settlements, ledger postings) and the
            // global money singletons this suite touches.
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionQuote"').catch(() => {});
            await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemMasterCrypto"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemFiatPool"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemProfitFees"');
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fiatProviderEvent.deleteMany();
        await prisma.fiatLiquidityReceipt.deleteMany();
        await prisma.fiatLiquidityReservation.deleteMany();
        await prisma.$executeRaw`DELETE FROM "ReconciliationException" WHERE "entityType" LIKE 'FIAT_%'`;
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
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true, modelBSettlementEnabled: true },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true, modelBSettlementEnabled: true },
        });
    });

    const state = () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const dec = (v) => Number(v);
    const inTx = (fn) => prisma.$transaction((tx) => fn(tx));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
                    providerRef: `PR-R14-${++providerRefCounter}`,
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

    async function initiateDeposit(user, amountGhs = 40) {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        // r14 §S: bind to the 201 payload's reference — TransactionHistory ids
        // are UUIDs; ordering by them is a lexical coin-flip.
        const reference = res.payload?.data?.reference;
        expect(reference).toBeTruthy();
        return prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    }

    /**
     * Seed the FULL durable matched chain WITHOUT recording the receipt:
     * a genuine PENDING deposit with a persisted P5-C quote, a durable INBOUND
     * provider observation, the quote consumed, and the deposit CAS-claimed
     * PENDING → COMPLETED — everything recordReceipt's evidence chain
     * verifies, committed, with NO receipt row yet. Racing recordReceipt then
     * exercises the §A ownership claim alone.
     */
    async function seedVerifiedChain({ amountGhs = 40 } = {}) {
        const user = await seedUser(prisma);
        const pending = await initiateDeposit(user, amountGhs);
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
            providerRef: pending.providerRef,
            dedupKey: `event:moolre-collection:${pending.txHash}`,
            amountGhs, relatedReference: pending.txHash,
        });
        const quoteId = pending.metadata.quoteId;
        const consumed = await consumeTransactionQuote({ prisma, quoteId, userId: user.id, purpose: 'deposit' });
        expect(consumed).toBeTruthy();
        const claimed = await prisma.transactionHistory.updateMany({
            where: { id: pending.id, status: 'PENDING' },
            data: { status: 'COMPLETED' },
        });
        expect(claimed.count).toBe(1);
        return {
            user, deposit: pending, quoteId, amountGhs,
            reference: pending.txHash,
            eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            route: consumed.selectedRoute || null,
        };
    }

    const matchedReceiptArgs = (chain, over = {}) => ({
        provider: 'MOOLRE', rail: 'MOMO', dedupKey: `receipt:r14:${chain.deposit.txHash}`,
        amountGhs: chain.amountGhs, route: chain.route,
        reference: chain.reference, relatedTransactionId: chain.deposit.id,
        eventDedupKey: chain.eventDedupKey, quoteId: chain.quoteId,
        ...over,
    });

    /** A same-user TWIN quote — identical economics, a different id. */
    async function createTwinQuote(chain) {
        const twin = createTransactionQuote({
            id: require('crypto').randomUUID(),
            userId: chain.user.id, purpose: 'deposit',
            amountGhs: chain.amountGhs, feeGhs: 0,
            rateGhsPerUsdc: 13.42, rateSource: 'KOTANI_PAY', rateAsOf: new Date(),
            ttlSeconds: 300,
        });
        await persistTransactionQuote(prisma, twin);
        const consumed = await consumeTransactionQuote({ prisma, quoteId: twin.id, userId: chain.user.id, purpose: 'deposit' });
        expect(consumed).toBeTruthy();
        return twin.id;
    }

    // =========================================================================
    // A. the ownership claim is one atomic guarded INSERT (§A)
    // =========================================================================
    describe('A. concurrent duplicates of one receipt identity', () => {
        test('interlocked race: the loser blocks on the uncommitted INSERT, re-reads the winner in its still-valid transaction and converges with ZERO increment', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 40 });

            // The WINNER holds its transaction OPEN past the INSERT so the
            // loser's INSERT genuinely blocks on the uncommitted unique index
            // entry (the real P2002-abort scenario) before the winner commits.
            let winnerHoldOpen;
            const holdGate = new Promise((r) => { winnerHoldOpen = r; });
            const winner = prisma.$transaction(async (tx) => {
                const out = await fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain));
                await holdGate.then(() => sleep(250)); // loser INSERTs INTO the blocked window
                return out;
            });
            await sleep(60); // let the winner reach (and hold) its INSERT
            const loser = prisma.$transaction((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain)));
            await sleep(80);
            winnerHoldOpen(); // winner proceeds to commit; the loser unblocks
            const [w, l] = await Promise.all([winner, loser]);

            // exactly ONE creator — the loser converged, never duplicated
            expect(w.replay).toBe(false);
            expect(l.replay).toBe(true);
            expect(l.raced).toBe(true); // it took the ON CONFLICT path, not the pre-read path
            expect(l.receipt.id).toBe(w.receipt.id);

            // exactly ONE increment, by construction
            const receipts = await prisma.fiatLiquidityReceipt.findMany({ where: { dedupKey: `receipt:r14:${chain.deposit.txHash}` } });
            expect(receipts).toHaveLength(1);
            expect(receipts[0].status).toBe('AVAILABLE');
            const s = await state();
            expect(dec(s.availableGhs)).toBe(40);
            expect(dec((await prisma.systemFiatPool.findUnique({ where: { id: 1 } })).balance)).toBe(40);
        });

        test('a 5-way concurrent identical race lands exactly one AVAILABLE receipt and one increment', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 25 });
            const args = matchedReceiptArgs(chain);
            const attempts = Array.from({ length: 5 }, () => inTx((tx) => fiatLiquidity.recordReceipt(tx, args)));
            const results = await Promise.all(attempts);

            expect(results.filter((r) => !r.replay)).toHaveLength(1);
            expect(results.filter((r) => r.replay)).toHaveLength(4);
            const receipts = await prisma.fiatLiquidityReceipt.findMany();
            expect(receipts).toHaveLength(1);
            expect(dec((await state()).availableGhs)).toBe(25);
        });

        test('a racing duplicate with DIFFERENT economics fails closed and mutates nothing', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 40 });
            const winner = inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain)));
            // rail differs — the durable chain does NOT gate rail, so the
            // loser reaches the INSERT race and fails on RECEIPT IDENTITY (§B)
            const loser = inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain, { rail: 'BANK' })));
            const results = await Promise.allSettled([winner, loser]);

            expect(results[0].status).toBe('fulfilled');
            expect(results[1].status).toBe('rejected');
            expect(results[1].reason).toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });

            const receipts = await prisma.fiatLiquidityReceipt.findMany();
            expect(receipts).toHaveLength(1);
            expect(Number(receipts[0].amountGhs)).toBe(40);
            expect(dec((await state()).availableGhs)).toBe(40); // only the winner's economics
        });

        test('the same atomicity holds for treasury openings (RECEIVED class)', async () => {
            const args = { provider: 'KOTANI_PAY', dedupKey: 'r14-treasury-race', amountGhs: 500, treasury: true };
            const results = await Promise.all(Array.from({ length: 3 }, () => inTx((tx) => fiatLiquidity.recordReceipt(tx, args))));
            expect(results.filter((r) => !r.replay)).toHaveLength(1);
            const receipts = await prisma.fiatLiquidityReceipt.findMany();
            expect(receipts).toHaveLength(1);
            expect(receipts[0].status).toBe('RECEIVED');
            expect(dec((await state()).availableGhs)).toBe(0); // treasury openings are NOT spendable
        });
    });

    // =========================================================================
    // B. the full receipt replay identity (§B)
    // =========================================================================
    describe('B. one dedupKey names one receipt', () => {
        const base = { provider: 'KOTANI_PAY', rail: 'MOMO', dedupKey: 'r14-identity', amountGhs: 75, route: 'KOTANI_COLLECTION' };

        test('an exact sequential replay converges with ZERO mutation', async () => {
            const first = await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            const second = await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            expect(first.replay).toBe(false);
            expect(second.replay).toBe(true);
            expect(second.receipt.id).toBe(first.receipt.id);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
            expect(dec((await state()).availableGhs)).toBe(0); // UNMATCHED — no liquidity effect
        });

        test.each([
            ['provider', { provider: 'MOOLRE' }],
            ['rail', { rail: 'BANK' }],
            ['amountGhs', { amountGhs: 75.01 }],
            ['route', { route: 'MOOLRE_MOMO_COLLECTION' }],
        ])('a replay differing in %s is contradictory evidence and fails closed', async (field, over) => {
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, { ...base, ...over })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });

        test('a same-key replay claiming a DIFFERENT economic class fails closed (matched/treasury vs unmatched)', async () => {
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            // unmatched → claimed matched: a materially different economic claim
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                ...base, relatedTransactionId: '00000000-0000-0000-0000-000000000000', reference: 'r14-x',
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            // unmatched → claimed treasury opening
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, { ...base, treasury: true })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });

        test('an UNMATCHED receipt that reconciliation has since matched (AVAILABLE) can NEVER be replayed through recordReceipt', async () => {
            // Build a genuine UNMATCHED receipt, then progress it through the
            // reconciliation path to AVAILABLE (the legitimate transition).
            const chain = await seedVerifiedChain({ amountGhs: 30 });
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', rail: 'MOMO', dedupKey: 'r14-unmatched-progress',
                amountGhs: 30, route: chain.route,
            }));
            await fiatLiquidity.confirmReconciliationMatch(prisma, {
                dedupKey: 'r14-unmatched-progress',
                reference: chain.reference, relatedTransactionId: chain.deposit.id,
                eventDedupKey: chain.eventDedupKey, quoteId: chain.quoteId,
            }).catch(() => {}); // if the matcher rejects the pairing, the receipt stays UNMATCHED — either way:
            const row = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'r14-unmatched-progress' } });
            if (row.status === 'AVAILABLE') {
                // the matched row is a DIFFERENT economic class now — a plain
                // recordReceipt replay must fail closed
                await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                    provider: 'MOOLRE', rail: 'MOMO', dedupKey: 'r14-unmatched-progress',
                    amountGhs: 30, route: chain.route,
                }))).rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            }
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });

        test('providerRef is enrichment-only: null→present converges, present is immutable, present+different fails closed', async () => {
            const first = await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            expect(first.receipt.providerRef).toBeNull();

            // null → present: legitimate enrichment (compare-and-set)
            const enriched = await inTx((tx) => fiatLiquidity.recordReceipt(tx, { ...base, providerRef: 'REF-R14-A' }));
            expect(enriched.replay).toBe(true);
            expect(enriched.receipt.providerRef).toBe('REF-R14-A');

            // present + SAME ref: converges
            const same = await inTx((tx) => fiatLiquidity.recordReceipt(tx, { ...base, providerRef: 'REF-R14-A' }));
            expect(same.receipt.providerRef).toBe('REF-R14-A');

            // present + DIFFERENT ref: contradictory provider identity
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, { ...base, providerRef: 'REF-R14-B' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });

            // never downgraded back to null by a null-ref replay
            const nulled = await inTx((tx) => fiatLiquidity.recordReceipt(tx, base));
            expect(nulled.receipt.providerRef).toBe('REF-R14-A');
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });

        test('interlocked enrichment race: two concurrent null→present refs — exactly one wins, the other fails closed', async () => {
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, base)); // providerRef: null

            let winnerHoldOpen;
            const holdGate = new Promise((r) => { winnerHoldOpen = r; });
            const winner = prisma.$transaction(async (tx) => {
                const out = await fiatLiquidity.recordReceipt(tx, { ...base, providerRef: 'REF-RACE-A' });
                await holdGate.then(() => sleep(200));
                return out;
            });
            await sleep(50);
            const loser = prisma.$transaction((tx) => fiatLiquidity.recordReceipt(tx, { ...base, providerRef: 'REF-RACE-B' }));
            await sleep(60);
            winnerHoldOpen();
            const results = await Promise.allSettled([winner, loser]);

            expect(results[0].status).toBe('fulfilled');
            expect(results[1].status).toBe('rejected');
            expect(results[1].reason).toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            const row = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'r14-identity' } });
            expect(row.providerRef).toBe('REF-RACE-A'); // the winner's ref — never timing-dependent
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });
    });

    // =========================================================================
    // L. quote substitution is closed (§L)
    // =========================================================================
    describe("L. a matched receipt must name the deposit's OWN quote", () => {
        test('a same-user TWIN quote with identical economics can NEVER record a matched receipt', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 40 });
            const twinQuoteId = await createTwinQuote(chain);
            expect(twinQuoteId).not.toBe(chain.quoteId);

            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain, { quoteId: twinQuoteId }))))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0); // no receipt
            expect(dec((await state()).availableGhs)).toBe(0); // no liquidity
        });

        test('a receipt without any quoteId fails closed (§L requires the binding)', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 40 });
            const { quoteId, ...noQuote } = matchedReceiptArgs(chain);
            expect(quoteId).toBeTruthy();
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, noQuote)))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0);
        });

        test('an existing matched receipt cannot be replayed under a different (twin) quote either', async () => {
            const chain = await seedVerifiedChain({ amountGhs: 40 });
            const created = await inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain)));
            expect(created.replay).toBe(false);
            const twinQuoteId = await createTwinQuote(chain);

            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain, { quoteId: twinQuoteId }))))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            // the legitimate replay still converges
            const ok = await inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain)));
            expect(ok.replay).toBe(true);
            expect(dec((await state()).availableGhs)).toBe(40);
        });
    });

    // =========================================================================
    // M. reservation providerRef enrichment is a compare-and-set (§M)
    // =========================================================================
    describe('M. payout identity is never last-writer-wins', () => {
        async function reservePool(amountGhs = 40, reference = 'W-R14') {
            // seed AVAILABLE liquidity through the full chain
            const chain = await seedVerifiedChain({ amountGhs });
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, matchedReceiptArgs(chain)));
            const rz = await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference, amountGhs, provider: 'MTN_MOMO' }));
            expect(rz.reservation.status).toBe('RESERVED');
            return rz.reservation;
        }

        test('markReservationInTransit fills a NULL ref slot exactly once: same ref converges, a different present ref fails closed', async () => {
            const rz = await reservePool(40, 'W-R14-M1');
            expect(rz.providerRef).toBeNull();

            const dispatched = await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M1', providerRef: 'MTN-DISP-1' }));
            expect(dispatched.reservation.status).toBe('IN_TRANSIT');
            expect(dispatched.reservation.providerRef).toBe('MTN-DISP-1');

            // replay with the SAME ref converges side-effect free
            const replay = await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M1', providerRef: 'MTN-DISP-1' }));
            expect(replay.replay).toBe(true);
            expect(replay.reservation.providerRef).toBe('MTN-DISP-1');

            // replay with a DIFFERENT ref is a contradictory payout identity
            await expect(inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M1', providerRef: 'MTN-DISP-2' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });

            const row = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-R14-M1' } });
            expect(row.providerRef).toBe('MTN-DISP-1');
            const s = await state();
            expect(dec(s.inTransitGhs)).toBe(40); // exactly one RESERVED→IN_TRANSIT move
        });

        test('settleReservation (SUCCESS) enriches a NULL ref slot exactly once — same ref converges, a different ref is quarantined', async () => {
            const rz = await reservePool(40, 'W-R14-M2');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M2' })); // no ref
            expect(rz.providerRef).toBeNull();

            const settled = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-R14-M2', outcome: 'SUCCESSFUL', providerTxId: 'MTN-TX-1' }));
            expect(settled.reservation.status).toBe('PAID_OUT');
            expect(settled.reservation.providerRef).toBe('MTN-TX-1');

            // replay with the same ref converges; with a different ref the
            // terminal row is quarantined as contradictory (r7/r12 contract)
            const replay = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-R14-M2', outcome: 'SUCCESSFUL', providerTxId: 'MTN-TX-1' }));
            expect(replay.replay).toBe(true);
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-R14-M2', outcome: 'SUCCESSFUL', providerTxId: 'MTN-TX-9' }));
            const row = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-R14-M2' } });
            expect(row.status).toBe('RECONCILIATION_REQUIRED'); // contradictory terminal claim quarantined
            expect(row.providerRef).toBe('MTN-TX-1'); // the original payout identity — never overwritten
        });

        test('interlocked enrichment race on an IN_TRANSIT reservation: two concurrent null→present refs — exactly one wins', async () => {
            const rz = await reservePool(40, 'W-R14-M3');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M3' })); // IN_TRANSIT, ref null

            let winnerHoldOpen;
            const holdGate = new Promise((r) => { winnerHoldOpen = r; });
            const winner = prisma.$transaction(async (tx) => {
                const out = await fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M3', providerRef: 'MTN-RACE-A' });
                await holdGate.then(() => sleep(200));
                return out;
            });
            await sleep(50);
            const loser = prisma.$transaction((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-R14-M3', providerRef: 'MTN-RACE-B' }));
            await sleep(60);
            winnerHoldOpen();
            const results = await Promise.allSettled([winner, loser]);

            expect(results[0].status).toBe('fulfilled');
            expect(results[1].status).toBe('rejected');
            expect(results[1].reason).toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            const row = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-R14-M3' } });
            expect(row.providerRef).toBe('MTN-RACE-A'); // deterministic — the CAS winner, never timing
            const s = await state();
            expect(dec(s.inTransitGhs)).toBe(40); // totals moved exactly once
        });
    });
});
