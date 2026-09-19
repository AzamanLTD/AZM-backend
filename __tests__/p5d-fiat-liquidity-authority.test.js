// __tests__/p5d-fiat-liquidity-authority.test.js
// =============================================================================
// §P.5-D real-PostgreSQL proof: evidence-backed GHS liquidity authority.
//
// PROVES, with Prisma NEVER mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. ONLY evidence creates AVAILABLE liquidity — matched deposit webhook
//      settlement (flag ON) is the only path that lands AVAILABLE; unmatched
//      evidence lands UNMATCHED with NO liquidity effect; a treasury opening
//      stays RECEIVED until explicitly confirmed.
//   B. Reservation is a single-winner conditional decrement — concurrent
//      withdrawals cannot over-reserve; a loser fails closed with the legacy
//      FIAT_POOL_INSUFFICIENT contract and leaves NO orphan reservation.
//   C. Idempotent reservation replay — same reference + same amount replays
//      the committed row (no second claim); conflicting reuse fails closed.
//   D. Receipt identity — identical evidence replays converge; conflicting
//      reuse of a dedupKey fails closed; availability never double-counts.
//   E. Dispatch is a single-winner RESERVED → IN_TRANSIT claim; replays are
//      side-effect free; terminal rows cannot re-dispatch.
//   F. Settlement is a single-winner terminal claim — SUCCESS moves
//      IN_TRANSIT → PAID_OUT; FAILED returns funds; replays converge.
//   G. Contradictory provider evidence NEVER rewrites terminal state — the
//      reservation is quarantined RECONCILIATION_REQUIRED with an OPEN
//      ReconciliationException, idempotently; funds stay counted, never
//      spendable twice.
//   H. Release semantics — RESERVED internal reversal returns funds;
//      IN_TRANSIT/PAID_OUT reversals quarantine (cash position unprovable),
//      never auto-release.
//   I. Aggregate conservation across a full lifecycle — every FiatLiquidityState
//      total moves atomically with its evidence rows, and SystemFiatPool stays
//      a deterministic derived projection of availableGhs.
//   J. Reconciliation categories — every discrepancy class (receipt without
//      confirmation, event without receipt, duplicate provider reference,
//      amount mismatch, reservation missing result, conservation delta,
//      unsupported availability) is flagged, idempotent, NEVER auto-repaired.
//   K. Mounted webhook integration — flag ON: a settled deposit lands an
//      AVAILABLE receipt in the SAME transaction (webhook replay converges);
//      flag OFF: raw evidence is still appended, NO receipt, NO liquidity.
//   L. Flag gating of the reservation regime — processFiatWithdrawal reserves
//      through the authority only when the flag is ON; OFF keeps the legacy
//      pool decrement byte-identical (asserted via the recorded behavior).
//   M. Exact pesewas — sub-pesewa precision is rejected everywhere (receipts,
//      events, reservations); 2dp amounts round-trip exactly through
//      Decimal(20,2); no float artifacts.
//   N. DB-enforced bounds — the overlay CHECKs reject negative state totals
//      and non-positive amounts at the database boundary.
//   O. runDoubleCheck regressions — 2+ settled Decimal rows recompute
//      correctly (the NaN/string-concat disarming bug), settled WITHDRAWAL_*
//      rows are read as positive debit magnitudes, and a genuinely
//      inconsistent ledger still fails closed.
//   P. Overlay idempotency — the installer converges on re-run (guarded).
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
if (!hasDb) console.warn('[p5d-fiat-liquidity.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-D evidence-backed GHS liquidity authority (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { runDoubleCheck } = require('../utils/securityCheck');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_p5d';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_p5d';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRaw`DELETE FROM "TransactionHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE username LIKE 'user_%')`;
            await prisma.$executeRaw`DELETE FROM "TransactionQuote"`;
            await prisma.$disconnect();
        }
    });

    // ── suite-local isolation: liquidity truth is zeroed between tests ─────
    beforeEach(async () => {
        await prisma.fiatProviderEvent.deleteMany();
        await prisma.fiatLiquidityReceipt.deleteMany();
        await prisma.fiatLiquidityReservation.deleteMany();
        await prisma.$executeRaw`DELETE FROM "ReconciliationException" WHERE "entityType" LIKE 'FIAT_%'`;
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0 },
            create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0 },
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 },
        });
    });

    async function setAuthorityFlag(on) {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: on },
            create: { id: 1, fiatLiquidityAuthorityEnabled: on },
        });
        expect(await fiatLiquidity.isAuthorityEnabled(prisma)).toBe(on);
    }

    const state = () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const pool = () => prisma.systemFiatPool.findUnique({ where: { id: 1 } }).then((p) => Number(p.balance));
    const dec = (v) => Number(v);
    const inTx = (fn) => prisma.$transaction((tx) => fn(tx));

    async function seedAvailable({ amountGhs, dedupKey = 'receipt:t1', provider = 'GENERIC_FIAT_WEBHOOK', relatedTransactionId = 'tx-1', rail = null, route = 'GENERIC_MOMO', providerRef = null, evidence = { source: 'deposit' } } = {}) {
        return inTx(async (tx) => fiatLiquidity.recordReceipt(tx, {
            provider, rail, providerRef, dedupKey, amountGhs, route,
            relatedTransactionId, evidence,
        }));
    }

    // =========================================================================
    // A. ONLY evidence creates AVAILABLE liquidity
    // =========================================================================
    describe('A. availability is evidence-gated', () => {
        test('a matched deposit observation lands AVAILABLE and increases claimable liquidity (exact pesewas)', async () => {
            const { receipt } = await seedAvailable({ amountGhs: '100.50' });
            expect(receipt.status).toBe('AVAILABLE');
            expect(receipt.confirmedAt).not.toBeNull();
            const s = await state();
            expect(dec(s.availableGhs)).toBe(100.50);
            expect(dec(s.reservedGhs)).toBe(0);
            expect(await pool()).toBe(100.50); // derived projection
        });

        test('unmatched evidence lands UNMATCHED — NO liquidity effect, evidence retained', async () => {
            const { receipt } = await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: 'receipt:unmatched:1', amountGhs: 75,
            }));
            expect(receipt.status).toBe('UNMATCHED');
            expect(receipt.confirmedAt).toBeNull();
            const s = await state();
            expect(dec(s.availableGhs)).toBe(0);
        });

        test('a treasury opening lands RECEIVED — not AVAILABLE until explicit confirmation', async () => {
            const { receipt } = await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'AZM_TREASURY', rail: 'INTERNAL',
                dedupKey: 'treasury:t1', amountGhs: 500, treasury: true,
                evidence: { kind: 'AUDITED_TREASURY_OPENING' },
            }));
            expect(receipt.status).toBe('RECEIVED');
            expect(dec((await state()).availableGhs)).toBe(0);

            const { receipt: confirmed } = await inTx((tx) => fiatLiquidity.confirmReceiptAvailable(tx, {
                dedupKey: 'treasury:t1', confirmedBy: 1,
                evidence: { action: 'LIQUIDATE_PROFITS' },
            }));
            expect(confirmed.status).toBe('AVAILABLE');
            expect(dec((await state()).availableGhs)).toBe(500);

            // explicit confirmation replays without double-counting
            const { replay } = await inTx((tx) => fiatLiquidity.confirmReceiptAvailable(tx, { dedupKey: 'treasury:t1', confirmedBy: 1 }));
            expect(replay).toBe(true);
            expect(dec((await state()).availableGhs)).toBe(500);
        });

        test('an UNMATCHED receipt becomes AVAILABLE only through explicit confirmation', async () => {
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', providerRef: 'PR-9', dedupKey: 'receipt:u2', amountGhs: 20,
            }));
            await inTx((tx) => fiatLiquidity.confirmReceiptAvailable(tx, {
                dedupKey: 'receipt:u2', confirmedBy: 42,
                evidence: { action: 'RECONCILIATION_MATCH', relatedTransactionId: 'tx-9' },
            }));
            const r = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'receipt:u2' } });
            expect(r.status).toBe('AVAILABLE');
            expect(r.relatedTransactionId).toBeNull(); // confirmation is evidence, not a mutation of match data
            expect(dec((await state()).availableGhs)).toBe(20);
        });

        test('RECONCILIATION_REQUIRED and REVERSED receipts can never be confirmed AVAILABLE', async () => {
            await seedAvailable({ amountGhs: 10, dedupKey: 'receipt:x1' });
            await prisma.fiatLiquidityReceipt.update({ where: { dedupKey: 'receipt:x1' }, data: { status: 'RECONCILIATION_REQUIRED' } });
            await expect(inTx((tx) => fiatLiquidity.confirmReceiptAvailable(tx, { dedupKey: 'receipt:x1' })))
                .rejects.toThrow(/RECONCILIATION_REQUIRED|cannot become AVAILABLE/);
            await prisma.fiatLiquidityReceipt.update({ where: { dedupKey: 'receipt:x1' }, data: { status: 'REVERSED', reversedAt: new Date() } });
            await expect(inTx((tx) => fiatLiquidity.confirmReceiptAvailable(tx, { dedupKey: 'receipt:x1' })))
                .rejects.toThrow(/cannot become AVAILABLE/);
        });
    });

    // =========================================================================
    // B. single-winner reservation
    // =========================================================================
    describe('B. reservation is a single-winner conditional decrement', () => {
        test('a claim loser fails closed with the legacy FIAT_POOL_INSUFFICIENT contract and leaves no orphan', async () => {
            await seedAvailable({ amountGhs: 50, dedupKey: 'receipt:b1' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: 'W-LOSER', amountGhs: 80, provider: 'MTN_MOMO',
            }))).rejects.toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });

            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-LOSER' } });
            expect(rz).toBeNull(); // rolled back with the transaction — never an orphan
            expect(dec((await state()).availableGhs)).toBe(50);
        });

        test('concurrent reservations cannot over-reserve: exactly one winner, totals conserved', async () => {
            await seedAvailable({ amountGhs: 100, dedupKey: 'receipt:b2' });
            const attempt = (ref) => inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: ref, amountGhs: 60, provider: 'MTN_MOMO',
            }));
            const results = await Promise.allSettled([attempt('W-RACE-1'), attempt('W-RACE-2')]);
            const winners = results.filter((r) => r.status === 'fulfilled');
            const losers = results.filter((r) => r.status === 'rejected');
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            expect(losers[0].reason.code).toBe('FIAT_POOL_INSUFFICIENT');
            const s = await state();
            expect(dec(s.availableGhs)).toBe(40);
            expect(dec(s.reservedGhs)).toBe(60);
            expect(await pool()).toBe(40);
        });
    });

    // =========================================================================
    // C. idempotent reservation replay / conflicting reuse
    // =========================================================================
    describe('C. reservation identity', () => {
        test('same reference + amount replays the committed reservation — no second claim', async () => {
            await seedAvailable({ amountGhs: 100, dedupKey: 'receipt:c1' });
            const first = await inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: 'W-C1', amountGhs: 30, provider: 'MTN_MOMO', destination: '0244',
            }));
            expect(first.replay).toBe(false);
            const second = await inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: 'W-C1', amountGhs: 30, provider: 'MTN_MOMO', destination: '0244',
            }));
            expect(second.replay).toBe(true);
            const s = await state();
            expect(dec(s.availableGhs)).toBe(70);
            expect(dec(s.reservedGhs)).toBe(30);
            const count = await prisma.fiatLiquidityReservation.count({ where: { reference: 'W-C1' } });
            expect(count).toBe(1);
        });

        test('conflicting reuse of a reference (different amount) fails closed', async () => {
            await seedAvailable({ amountGhs: 100, dedupKey: 'receipt:c2' });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-C2', amountGhs: 30, provider: 'MTN_MOMO' }));
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-C2', amountGhs: 31, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(dec((await state()).reservedGhs)).toBe(30);
        });
    });

    // =========================================================================
    // D. receipt identity / concurrency convergence
    // =========================================================================
    describe('D. receipt identity', () => {
        test('identical evidence replays converge; conflicting dedupKey reuse fails closed', async () => {
            const first = await seedAvailable({ amountGhs: 25, dedupKey: 'receipt:d1' });
            expect(first.replay).toBe(false);
            const second = await seedAvailable({ amountGhs: 25, dedupKey: 'receipt:d1' });
            expect(second.replay).toBe(true);
            expect(dec((await state()).availableGhs)).toBe(25);

            await expect(seedAvailable({ amountGhs: 26, dedupKey: 'receipt:d1' }))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(dec((await state()).availableGhs)).toBe(25);
        });

        test('concurrent identical receipts commit exactly one liquidity effect', async () => {
            const attempt = () => seedAvailable({ amountGhs: 40, dedupKey: 'receipt:d2' });
            await Promise.allSettled([attempt(), attempt(), attempt()]);
            const count = await prisma.fiatLiquidityReceipt.count({ where: { dedupKey: 'receipt:d2' } });
            expect(count).toBe(1);
            expect(dec((await state()).availableGhs)).toBe(40);
        });
    });

    // =========================================================================
    // E./F./G./H. lifecycle: dispatch, settle, contradictions, release
    // =========================================================================
    describe('E./F./G./H. reservation lifecycle', () => {
        async function reservedRef(amountGhs, ref) {
            await seedAvailable({ amountGhs, dedupKey: `receipt:lf-${ref}` });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: ref, amountGhs, provider: 'MTN_MOMO', relatedTransactionId: 'th-' + ref,
            }));
        }

        test('E: RESERVED → IN_TRANSIT moves totals atomically; replays are side-effect free', async () => {
            await reservedRef(40, 'W-E1');
            const first = await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-E1', providerRef: 'MTN-123' }));
            expect(first.replay).toBe(false);
            const second = await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-E1', providerRef: 'MTN-123' }));
            expect(second.replay).toBe(true);
            const s = await state();
            expect(dec(s.reservedGhs)).toBe(0);
            expect(dec(s.inTransitGhs)).toBe(40);
        });

        test('E: terminal rows cannot re-dispatch — fail closed', async () => {
            await reservedRef(10, 'W-E2');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-E2' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-E2', outcome: 'SUCCESSFUL' }));
            await expect(inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-E2' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
        });

        test('F: SUCCESS is a single-winner IN_TRANSIT → PAID_OUT claim; replay converges', async () => {
            await reservedRef(40, 'W-F1');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-F1', providerRef: 'MTN-A' }));
            const first = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-F1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-A' }));
            expect(first.replay).toBe(false);
            const second = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-F1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-A' }));
            expect(second.replay).toBe(true);
            const s = await state();
            expect(dec(s.inTransitGhs)).toBe(0);
            expect(dec(s.paidOutGhs)).toBe(40);
            expect(dec(s.availableGhs)).toBe(0);
        });

        test('F: FAILED returns funds to available from both RESERVED and IN_TRANSIT', async () => {
            await seedAvailable({ amountGhs: 100, dedupKey: 'receipt:f2' });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-F2a', amountGhs: 30, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-F2b', amountGhs: 20, provider: 'MOOLRE' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-F2b' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-F2a', outcome: 'FAILED' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-F2b', outcome: 'FAILED' }));
            const s = await state();
            expect(dec(s.availableGhs)).toBe(100);
            expect(dec(s.reservedGhs)).toBe(0);
            expect(dec(s.inTransitGhs)).toBe(0);
            expect(dec(s.paidOutGhs)).toBe(0);
        });

        test('G: contradictory outcome NEVER rewrites terminal state — quarantine + idempotent exception, funds stay counted', async () => {
            await reservedRef(40, 'W-G1');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G1', providerRef: 'MTN-G' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'FAILED' }));
            const afterFailed = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G1' } });
            expect(afterFailed.status).toBe('RELEASED');

            const quarantined = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-G' }));
            expect(quarantined.quarantined).toBe(true);
            const afterContradiction = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G1' } });
            expect(afterContradiction.status).toBe('RECONCILIATION_REQUIRED');

            const exceptions = await prisma.$queryRaw`SELECT * FROM "ReconciliationException" WHERE "entityType" = 'FIAT_LIQUIDITY_RESERVATION' AND "entityId" = ${'W-G1'}`;
            expect(exceptions).toHaveLength(1);
            expect(exceptions[0].reason).toBe('CONTRADICTORY_PROVIDER_EVIDENCE');
            expect(exceptions[0].status).toBe('OPEN');

            // replay of the contradictory evidence: still exactly ONE OPEN exception
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-G' }));
            const still = await prisma.$queryRaw`SELECT * FROM "ReconciliationException" WHERE "entityType" = 'FIAT_LIQUIDITY_RESERVATION' AND "entityId" = ${'W-G1'} AND "status" = 'OPEN'`;
            expect(still).toHaveLength(1);
        });

        test('G: SUCCESS while still RESERVED (never dispatched) quarantines without a throw', async () => {
            await reservedRef(15, 'W-G2');
            const result = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G2', outcome: 'SUCCESSFUL' }));
            expect(result.quarantined).toBe(true);
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G2' } });
            expect(rz.status).toBe('RECONCILIATION_REQUIRED');
            const s = await state();
            expect(dec(s.reservedGhs)).toBe(15); // funds stay counted — never spendable twice
        });

        test('G: terminal success through a DIFFERENT provider reference quarantines', async () => {
            await reservedRef(15, 'W-G3');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G3', providerRef: 'MTN-1' }));
            const result = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G3', outcome: 'SUCCESSFUL', providerTxId: 'MTN-2' }));
            expect(result.quarantined).toBe(true);
        });

        test('H: internal reversal of a RESERVED payout returns funds; IN_TRANSIT/PAID_OUT reversals quarantine, never auto-release', async () => {
            await seedAvailable({ amountGhs: 100, dedupKey: 'receipt:h1' });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-H1', amountGhs: 30, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-H2', amountGhs: 30, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-H3', amountGhs: 30, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-H2' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-H3' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-H3', outcome: 'SUCCESSFUL' }));

            const r1 = await inTx((tx) => fiatLiquidity.releaseReservation(tx, { reference: 'W-H1', reason: 'gateway_unavailable' }));
            expect(r1.replay).toBe(false);
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-H1' } })).status).toBe('RELEASED');

            const r2 = await inTx((tx) => fiatLiquidity.releaseReservation(tx, { reference: 'W-H2' }));
            expect(r2.quarantined).toBe(true); // cash position unprovable
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-H2' } })).status).toBe('RECONCILIATION_REQUIRED');

            const r3 = await inTx((tx) => fiatLiquidity.releaseReservation(tx, { reference: 'W-H3' }));
            expect(r3.quarantined).toBe(true); // a late reversal cannot unpay cash
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-H3' } })).status).toBe('RECONCILIATION_REQUIRED');

            const s = await state();
            expect(dec(s.availableGhs)).toBe(40); // 100 − 30 (H1 returned) − 30 (H2 quarantined-held) + 30 (H1) − 30 (H3 paid) = 40
            expect(dec(s.reservedGhs)).toBe(0);
            expect(dec(s.inTransitGhs)).toBe(30); // H2: funds stay counted in transit while quarantined
            expect(dec(s.paidOutGhs)).toBe(30);
        });
    });

    // =========================================================================
    // I. aggregate conservation + deterministic pool projection
    // =========================================================================
    describe('I. conservation and projection', () => {
        test('full lifecycle: deposit → reserve → dispatch → success/failure keeps every total exact and the pool a projection', async () => {
            await seedAvailable({ amountGhs: '250.75', dedupKey: 'receipt:i1' });
            expect(await pool()).toBe(250.75);

            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-I1', amountGhs: '100.25', provider: 'MOOLRE' }));
            expect(await pool()).toBe(150.50);
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-I1' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-I1', outcome: 'SUCCESSFUL' }));

            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-I2', amountGhs: '50.50', provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-I2', outcome: 'FAILED' }));

            const s = await state();
            expect(dec(s.availableGhs)).toBe(150.50);
            expect(dec(s.reservedGhs)).toBe(0);
            expect(dec(s.inTransitGhs)).toBe(0);
            expect(dec(s.paidOutGhs)).toBe(100.25);
            expect(await pool()).toBe(150.50);

            const summary = await fiatLiquidity.liquiditySummary(prisma);
            expect(summary.authoritative.availableGhs).toBe('150.5');
            expect(summary.systemFiatPoolProjection).toBe('150.5'); // explicitly non-authoritative
            expect(summary.reservationsByStatus).toEqual(expect.arrayContaining([
                expect.objectContaining({ status: 'PAID_OUT', provider: 'MOOLRE', amountGhs: '100.25' }),
                expect.objectContaining({ status: 'RELEASED', provider: 'MTN_MOMO', amountGhs: '50.5' }),
            ]));
        });
    });

    // =========================================================================
    // J. reconciliation categories — flagged, idempotent, never auto-repaired
    // =========================================================================
    describe('J. reconciliation', () => {
        test('every discrepancy category is flagged idempotently and nothing is auto-repaired', async () => {
            // an inbound event with no receipt
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: 'event:j1', amountGhs: 30,
            });
            // a stale unconfirmed receipt
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', providerRef: 'PR-J', dedupKey: 'receipt:j2', amountGhs: 12,
            }));
            await prisma.fiatLiquidityReceipt.update({
                where: { dedupKey: 'receipt:j2' },
                data: { createdAt: new Date(Date.now() - 3 * 60_000 * 60) },
            });
            // duplicate provider references
            await seedAvailable({ amountGhs: 5, dedupKey: 'receipt:j3', providerRef: 'PR-DUP', provider: 'MOOLRE', relatedTransactionId: 'tx-a' });
            await seedAvailable({ amountGhs: 7, dedupKey: 'receipt:j4', providerRef: 'PR-DUP', provider: 'MOOLRE', relatedTransactionId: 'tx-b' });
            // an amount mismatch between event and receipt
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: 'receipt:j3', amountGhs: 6, providerRef: 'PR-DUP',
            });
            // a stuck reservation
            await prisma.fiatLiquidityReservation.create({
                data: { reference: 'W-J1', amountGhs: 25, provider: 'MTN_MOMO', createdAt: new Date(Date.now() - 3 * 60_000 * 60) },
            });
            // a conservation delta (available raised directly)
            await prisma.fiatLiquidityState.update({
                where: { id: 1 },
                data: { availableGhs: 999 },
            });

            // dry-run first: detects everything, writes nothing
            const rows = () => prisma.$queryRaw`SELECT * FROM "ReconciliationException" WHERE "reason" != 'CONTRADICTORY_PROVIDER_EVIDENCE'`;
            const report = await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60, dryRun: true });
            const reasons = new Set(report.exceptions.map((e) => e.reason));
            expect(reasons).toEqual(new Set([
                'EVENT_WITHOUT_RECEIPT',
                'RECEIPT_WITHOUT_CONFIRMATION',
                'DUPLICATE_PROVIDER_REFERENCE',
                'AMOUNT_MISMATCH',
                'RESERVATION_MISSING_RESULT',
                'STATE_CONSERVATION_DELTA',
                'AVAILABLE_UNSUPPORTED',
            ]));
            expect(await rows()).toHaveLength(0);

            // two writing runs: exactly one exception per entity+reason
            await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60 });
            await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60 });
            const stored = await rows();
            expect(stored).toHaveLength(7); // one per entity+reason category — idempotent upserts
            expect(new Set(stored.map((r) => r.reason))).toEqual(reasons);

            // NOTHING was auto-repaired
            const s = await state();
            expect(dec(s.availableGhs)).toBe(999); // flagged, not fixed
        });
    });

    // =========================================================================
    // K. mounted webhook integration (real controllers, real DB)
    // =========================================================================
    describe('K. mounted deposit-webhook integration', () => {
        function makeApp() {
            const registry = {
                prisma,
                marketOracle: null,
                notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
                socketio: null,
                emitBalanceUpdate: null,
                moolreCollectionService: { initiatePayment: jest.fn().mockResolvedValue({ requiresOtp: false, providerRef: 'PR-P5D' }) },
            };
            return { get: (key) => registry[key] };
        }
        const mockResponse = () => ({
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return this; },
        });

        async function initiateDeposit(user) {
            const res = mockResponse();
            await moolreQuoteDepositController.initiate(
                { app: makeApp(), user: { id: user.id }, body: { amountGhs: 134.20, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
                res,
            );
            expect(res.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            return pending[0];
        }

        async function moolreWebhook(pendingTxHash) {
            const res = mockResponse();
            await moolreQuoteDepositController.webhook(
                {
                    app: makeApp(),
                    headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                    body: {
                        status: 1,
                        code: 'P01',
                        data: { externalref: pendingTxHash, amount: 134.20, payer: '0241234567' },
                    },
                },
                res,
            );
            return res;
        }

        async function seedFreshRates() {
            await prisma.globalSettings.upsert({
                where: { id: 1 },
                update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
                create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
            });
        }

        test('flag ON: a settled Moolre deposit creates an AVAILABLE receipt in the SAME transaction; replays converge', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user);
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);

            const receipts = await prisma.fiatLiquidityReceipt.findMany({ where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` } });
            expect(receipts).toHaveLength(1);
            expect(receipts[0].status).toBe('AVAILABLE');
            expect(receipts[0].relatedTransactionId).toBe(pending.id);
            expect(Number(receipts[0].amountGhs)).toBe(134.20);
            expect(dec((await state()).availableGhs)).toBe(134.20);

            const events = await prisma.fiatProviderEvent.findMany({ where: { dedupKey: `event:moolre-collection:${pending.txHash}` } });
            expect(events).toHaveLength(1); // raw evidence appended out-of-band

            // webhook replay converges: no second receipt, no second liquidity
            await moolreWebhook(pending.txHash);
            expect(await prisma.fiatLiquidityReceipt.count({ where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` } })).toBe(1);
            expect(dec((await state()).availableGhs)).toBe(134.20);

            const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userAfter.availableBalance)).toBeGreaterThan(Number(userBefore.availableBalance));
        });

        test('flag OFF: raw evidence is still appended, but NO receipt and NO liquidity effect', async () => {
            await seedFreshRates();
            await setAuthorityFlag(false);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user);

            const res = await moolreWebhook(pending.txHash);
            expect(res.statusCode).toBe(200);

            expect(await prisma.fiatProviderEvent.count({ where: { dedupKey: `event:moolre-collection:${pending.txHash}` } })).toBe(1);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0);
            expect(dec((await state()).availableGhs)).toBe(0);
            // the deposit itself still settles (mounted behavior unchanged)
            const settled = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(settled.status).toBe('COMPLETED');
        });
    });

    // =========================================================================
    // L. flag gating of the reservation regime (mounted finance.service)
    // =========================================================================
    describe('L. reservation regime gating', () => {
        test('flag default is OFF on a fresh settings row; the legacy pool path stays untouched while OFF', async () => {
            await prisma.globalSettings.deleteMany(); // fresh install posture
            expect(await fiatLiquidity.isAuthorityEnabled(prisma)).toBe(false);
        });

        test('the withdrawal records a GHS reservation ONLY under the authority flag (mounted processFiatWithdrawal)', async () => {
            const financeService = require('../services/finance.service');
            // One user per regime: the fail-closed ledger audit freezes a
            // user's next withdrawal while a PENDING one exists (pre-existing,
            // deliberate behavior — the PENDING window is excluded from the
            // recomputation by design).
            const userOff = await seedUser(prisma, { availableBalance: 1000 });
            const userOn = await seedUser(prisma, { availableBalance: 1000 });

            await prisma.globalSettings.upsert({
                where: { id: 1 },
                update: { fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
                create: { id: 1, fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
            });
            await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 5000 }, create: { id: 1, balance: 5000 } });

            const ref1 = `FIAT_OUT_FLAG_OFF_${userOff.id}`;
            await financeService.processFiatWithdrawal(prisma, userOff.id, 10, { reference: ref1, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO' } });
            expect(await prisma.fiatLiquidityReservation.count()).toBe(0); // legacy regime — no authority rows
            expect(Number((await pool()))).toBe(5000 - 10); // legacy pool decrement

            await setAuthorityFlag(true);
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 5000 } });
            await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 1000 } });
            const ref2 = `FIAT_OUT_FLAG_ON_${userOn.id}`;
            const result = await financeService.processFiatWithdrawal(prisma, userOn.id, 10, { reference: ref2, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0244' } });
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: ref2 } });
            expect(rz).not.toBeNull();
            expect(rz.status).toBe('RESERVED');
            expect(Number(rz.amountGhs)).toBe(134.20); // 10 USDC × 13.42 — exact pesewas
            expect(rz.provider).toBe('MTN_MOMO');
            const s = await state();
            expect(dec(s.availableGhs)).toBe(1000 - 134.20);
            expect(dec(s.reservedGhs)).toBe(134.20);
            expect(await pool()).toBe(1000 - 134.20); // projection follows the authority now
        });
    });

    // =========================================================================
    // M./N. exact pesewas + DB-enforced bounds
    // =========================================================================
    describe('M./N. exactness and DB bounds', () => {
        test('sub-pesewa precision is rejected everywhere — the authority never guesses a rounding', async () => {
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, { provider: 'MOOLRE', dedupKey: 'r-m1', amountGhs: '10.005' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(fiatLiquidity.recordProviderEvent(prisma, { provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', dedupKey: 'e-m1', amountGhs: 10.005 }))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M1', amountGhs: 10.005, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M2', amountGhs: 0, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M3', amountGhs: -5, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
        });

        test('2dp GHS amounts round-trip exactly through Decimal(20,2) — no float artifacts', async () => {
            const { receipt } = await seedAvailable({ amountGhs: '0.10', dedupKey: 'receipt:m2' });
            expect(receipt.amountGhs.toString()).toBe('0.1');
            await seedAvailable({ amountGhs: '0.20', dedupKey: 'receipt:m3' });
            const s = await state();
            expect(s.availableGhs.toString()).toBe('0.3'); // exact — never 0.30000000000000004
        });

        test('the overlay DB CHECKs reject negative state totals and non-positive amounts at the boundary', async () => {
            await expect(prisma.$executeRaw`UPDATE "FiatLiquidityState" SET "availableGhs" = -1 WHERE "id" = 1`)
                .rejects.toThrow();
            await expect(prisma.fiatLiquidityReceipt.create({
                data: { provider: 'X', dedupKey: 'bad-r', amountGhs: -5 },
            })).rejects.toThrow();
            await expect(prisma.fiatLiquidityReservation.create({
                data: { reference: 'bad-rz', amountGhs: 0, provider: 'X' },
            })).rejects.toThrow();
            await expect(prisma.fiatProviderEvent.create({
                data: { provider: 'X', direction: 'SIDEWAYS', status: 'S', dedupKey: 'bad-e', amountGhs: 1 },
            })).rejects.toThrow();
        });
    });

    // =========================================================================
    // O. runDoubleCheck regressions (NaN disarm + withdrawal sign convention)
    // =========================================================================
    describe('O. runDoubleCheck regressions', () => {
        test('2+ settled Decimal rows recompute correctly (old code produced NaN/string-concat and silently passed)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await prisma.transactionHistory.createMany({
                data: [
                    { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: '10', feeUsdc: '5.5', status: 'COMPLETED' },
                    { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: '5.5', feeUsdc: '0', status: 'COMPLETED' },
                ],
            });
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 10 } }); // 10 − 5.5 + 5.5 = 10 exactly
            await expect(runDoubleCheck(prisma, user.id)).resolves.not.toThrow();
        });

        test('settled WITHDRAWAL_* rows are POSITIVE debit magnitudes, not credits', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await prisma.transactionHistory.createMany({
                data: [
                    { userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: '100', status: 'COMPLETED' },
                    { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: '30', feeUsdc: '2', status: 'COMPLETED' },
                ],
            });
            // 100 − (30 + 2) = 68 — the withdrawal must REDUCE the recomputed balance
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 68 } });
            await expect(runDoubleCheck(prisma, user.id)).resolves.not.toThrow();

            // ...and the OLD interpretation (withdrawal as credit) must fail:
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 132 } }); // 100 + 30 − 2
            await expect(runDoubleCheck(prisma, user.id)).rejects.toThrow(/LEDGER INCONSISTENCY/);
        });

        test('a genuinely inconsistent ledger still fails closed', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            await prisma.transactionHistory.createMany({
                data: [{ userId: user.id, type: 'DEPOSIT_CRYPTO', amountUsdc: '10', status: 'COMPLETED' }],
            });
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: 999 } });
            await expect(runDoubleCheck(prisma, user.id)).rejects.toThrow(/LEDGER INCONSISTENCY/);
        });
    });

    // =========================================================================
    // P. overlay idempotency (guarded re-run against the live test DB)
    // =========================================================================
    describe('P. overlay idempotency', () => {
        test('the installer converges on re-run', async () => {
            const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');
            await installFiatLiquidityOverlay(prisma);
            await installFiatLiquidityOverlay(prisma);
            const cols = await prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM information_schema.columns
                WHERE "table_name" = 'FiatLiquidityState'
                  AND "column_name" IN ('availableGhs', 'reservedGhs', 'inTransitGhs', 'paidOutGhs')`;
            expect(cols[0].n).toBe(4);
            const flagCol = await prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM information_schema.columns
                WHERE "table_name" = 'GlobalSettings' AND "column_name" = 'fiatLiquidityAuthorityEnabled'`;
            expect(flagCol[0].n).toBe(1);
        });
    });
});
