// __tests__/p5d-fiat-liquidity-authority.test.js
// =============================================================================
// §P.5-D real-PostgreSQL proof: evidence-backed GHS liquidity authority.
//
// PROVES, with Prisma NEVER mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. ONLY VERIFIED evidence creates AVAILABLE liquidity — every seeding in
//      this suite goes through the SAME authority operation the real webhook
//      uses (a genuine PENDING deposit → quote consumption → settled deposit
//      → durable provider event → recordReceipt). The service itself verifies
//      the durable chain; forged relatedTransactionIds, absent events, amount
//      mismatches, wrong transaction types/states and route contradictions
//      all fail closed with NO liquidity effect.
//   B. NO SYNTHETIC GHS — liquidateProfits (authority ON) records a
//      NON-AVAILABLE audited treasury opening and its response claims NO
//      spendable GHS; only confirmTreasuryOpening with a durable external
//      funding observation unlocks it.
//   C. Reservation is a single-winner conditional decrement — concurrent
//      withdrawals cannot over-reserve; a loser fails closed with the legacy
//      FIAT_POOL_INSUFFICIENT contract and leaves NO orphan reservation.
//   D. Idempotent reservation replay — same reference + same amount replays
//      the committed row (no second claim); conflicting reuse fails closed.
//   E. Receipt identity — identical evidence replays converge; conflicting
//      reuse of a dedupKey fails closed; availability never double-counts.
//   F. Dispatch is a single-winner RESERVED → IN_TRANSIT claim; replays are
//      side-effect free; terminal rows cannot re-dispatch.
//   G. Settlement is a single-winner terminal claim — SUCCESS moves
//      IN_TRANSIT → PAID_OUT; FAILED returns funds; replays converge.
//   H. Contradictory provider evidence NEVER rewrites terminal state — the
//      reservation is quarantined RECONCILIATION_REQUIRED with an OPEN
//      ReconciliationException, idempotently; the disputed amount moves into
//      the reconciliationHeldGhs bucket: counted, NEVER spendable — including
//      released-then-contradicted payouts, whose returned amount leaves
//      availability and enters hold, and the released-funds-already-spent
//      case, which flags CONTRADICTORY_RELEASE_ALREADY_SPENT loudly instead
//      of hiding a potential over-spend.
//   I. Release semantics — RESERVED internal reversal returns funds;
//      IN_TRANSIT/PAID_OUT reversals quarantine (cash position unprovable),
//      never auto-release.
//   J. Aggregate conservation across a full lifecycle — every FiatLiquidityState
//      total (including reconciliationHeldGhs) moves atomically with its
//      evidence rows, and SystemFiatPool stays a deterministic derived
//      projection of availableGhs.
//   K. Reconciliation categories — every discrepancy class (receipt without
//      confirmation, event without receipt, duplicate provider reference,
//      amount mismatch, reservation missing result, conservation delta over
//      ALL buckets, unsupported availability) is flagged, idempotent, NEVER
//      auto-repaired. Event↔receipt pairing joins through DURABLE rows
//      (provider+providerRef, or event.relatedReference → settled deposit →
//      bound receipt) — never fabricated key equality.
//   L. Mounted webhook integration — flag ON: a settled deposit lands an
//      AVAILABLE receipt in the SAME transaction (webhook replay converges);
//      flag OFF: raw evidence is still appended, NO receipt, NO liquidity.
//      FAIL-CLOSED: when the evidence table is unavailable the webhook
//      returns 503, the deposit stays PENDING, no USDC is credited, and a
//      retry after recovery converges.
//   M. Flag gating of the reservation regime — processFiatWithdrawal reserves
//      through the authority only when the flag is ON; OFF keeps the legacy
//      pool decrement byte-identical (asserted via the recorded behavior).
//   N. Exact pesewas — sub-pesewa precision is rejected everywhere (receipts,
//      events, reservations); 2dp amounts round-trip exactly through
//      Decimal(20,2); OUTBOUND observations may carry no amount (providers
//      that report status only); no float artifacts.
//   O. DB-enforced bounds — the overlay CHECKs reject negative state totals,
//      non-positive amounts, INBOUND events without an amount, and invalid
//      directions at the database boundary.
//   P. Outbound evidence — terminal settlement observations are durably
//      retained BEFORE the authoritative transition, fail closed when the
//      evidence store is unavailable; duplicates converge and contradictions
//      are retained as distinct rows.
//   Q. Auto-payout worker — the liquidity regime follows the RECORDED row,
//      never the current global flag: a FiatLiquidityReservation for the
//      canonical reference means the §P.5-D authority regime (the exact
//      reserved GHS is dispatched — rate drift can never mutate it, the
//      operational headroom floor is compared in GHS, and SystemFiatPool is
//      never an input), while an unreserved row keeps the LEGACY USDC pool
//      policy even when the flag is ON. The worker never reserves.
//   R. runDoubleCheck regressions — 2+ settled Decimal rows recompute
//      correctly (the NaN/string-concat disarming bug), settled WITHDRAWAL_*
//      rows are read as positive debit magnitudes, and a genuinely
//      inconsistent ledger still fails closed.
//   S. Overlay idempotency — the installer converges on re-run (guarded),
//      including the reconciliationHeldGhs column and the outbound-amount
//      CHECK on existing deployments.
//   T. Provider-observation identity — ONE dedupKey names ONE observation:
//      replay converges ONLY on semantic match (provider, rail, direction,
//      status, providerRef, amountGhs, relatedReference — never raw); a
//      materially different payload under a committed identity is
//      contradictory evidence: retained as a DISTINCT durable conflict row
//      (deterministic identity, exact retries converge) and surfaced with a
//      typed fail-closed error. Distinct statuses are distinct durable
//      observations — SUCCESS and FAILED for the same reference can never
//      collapse into one silently.
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
            // Hermetic exit (same pattern as custody-accounting): this suite
            // seeds ~21 users whose children span many tables (TH backing,
            // quotes, deposits, settlements, ledger postings). A
            // User-cascade truncate wipes them all; the two global deletes
            // cover the non-user-keyed rows this suite leaves behind. The
            // serial battery re-seeds everything afterward, and leaving
            // user_* rows behind breaks later suites' FK-sensitive cleanup.
            await prisma.$executeRawUnsafe('DELETE FROM "AdminProfitLog"');
            await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
            // The suite's processFiatWithdrawal calls ensure/increment the
            // global money singletons (SystemMasterCrypto principal deferral,
            // SystemFiatPool legacy projection mirror, SystemProfitFees
            // ensure-only). Leave them in the fresh-install posture so
            // order-independent suites that assume a clean slate (e.g.
            // withdrawal-fee-discount-atomicity, whose FIRST test compares
            // the master crypto balance against a seeded withdrawal) are
            // never contaminated by residue, whatever the jest run order.
            await prisma.$executeRawUnsafe('DELETE FROM "SystemMasterCrypto"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemFiatPool"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemProfitFees"');
            await prisma.$disconnect();
        }
    });

    // ── suite-local isolation: liquidity truth is zeroed between tests ─────
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

    // ── REAL evidence-chain machinery (the same operations the mounted
    //    webhook uses — see section L) ──────────────────────────────────────
    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            // unique provider refs per collection — duplicate provider
            // references are asserted DELIBERATELY in section K.
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({
                    requiresOtp: false,
                    providerRef: `PR-P5D-${++providerRefCounter}`,
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

    async function seedFreshRates() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
        });
    }

    async function initiateDeposit(user, amountGhs = 100) {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
        expect(pending).toHaveLength(1);
        return pending[0];
    }

    async function moolreWebhook(pendingTxHash, amountGhs = 100) {
        const res = mockResponse();
        await moolreQuoteDepositController.webhook(
            {
                app: makeApp(),
                headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                body: {
                    status: 1,
                    code: 'P01',
                    data: { externalref: pendingTxHash, amount: amountGhs, payer: '0241234567' },
                },
            },
            res,
        );
        return res;
    }

    /**
     * Seed AVAILABLE liquidity through the FULL durable chain — the same
     * authority operation the real Moolre webhook exercises: a genuine user,
     * a genuine PENDING deposit with a consumed P5-C quote, the settled
     * COMPLETED deposit (CAS-claimed by the webhook), the raw provider
     * observation, and the verified recordReceipt transition. Nothing here
     * forges authority rows by hand.
     */
    async function seedAvailable({ amountGhs = 100 } = {}) {
        await seedFreshRates();
        await setAuthorityFlag(true);
        const user = await seedUser(prisma);
        const pending = await initiateDeposit(user, amountGhs);
        const res = await moolreWebhook(pending.txHash, amountGhs);
        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        const receipt = await prisma.fiatLiquidityReceipt.findUnique({
            where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` },
        });
        expect(receipt).not.toBeNull();
        expect(receipt.status).toBe('AVAILABLE');
        return { receipt, user, pending, reference: pending.txHash };
    }

    // =========================================================================
    // A. ONLY VERIFIED evidence creates AVAILABLE liquidity
    // =========================================================================
    describe('A. availability is evidence-gated', () => {
        test('a real matched deposit webhook observation lands AVAILABLE and increases claimable liquidity (exact pesewas)', async () => {
            const { receipt } = await seedAvailable({ amountGhs: 100.50 });
            expect(receipt.status).toBe('AVAILABLE');
            expect(receipt.confirmedAt).not.toBeNull();
            expect(receipt.provider).toBe('MOOLRE');
            const s = await state();
            expect(dec(s.availableGhs)).toBe(100.50);
            expect(dec(s.reservedGhs)).toBe(0);
            expect(await pool()).toBe(100.50); // derived projection
        });

        test('a forged relatedTransactionId can NEVER create AVAILABLE liquidity (blocker 3)', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 40); // genuine PENDING deposit
            // A durable provider event for a DIFFERENT amount — the classic
            // "caller asserts the chain" forgery attempt.
            // a legitimate pre-recorded observation (e.g. a webhook retry
            // that raced the settle): same providerRef the deposit carries
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: pending.providerRef, dedupKey: `event:moolre-collection:${pending.txHash}`,
                amountGhs: 40, relatedReference: pending.txHash,
            });
            // attempt 1: a transaction id that does not exist
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: `receipt:moolre-collection:${pending.txHash}`,
                amountGhs: 40, reference: pending.txHash, relatedTransactionId: '00000000-0000-0000-0000-000000000000',
                eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            // attempt 2: no durable provider observation at all
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: `receipt:moolre-collection:${pending.txHash}`,
                amountGhs: 40, reference: pending.txHash, relatedTransactionId: pending.id,
                eventDedupKey: 'event:moolre-collection:never-recorded',
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            // attempt 3: an event amount that contradicts the receipt amount
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: `receipt:moolre-collection:${pending.txHash}`,
                amountGhs: 41, reference: pending.txHash, relatedTransactionId: pending.id,
                eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            // attempt 4: the deposit is not settled — the authoritative state
            // (COMPLETED) is missing
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: `receipt:moolre-collection:${pending.txHash}`,
                amountGhs: 40, reference: pending.txHash, relatedTransactionId: pending.id,
                eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            // NO liquidity was created by any forgery attempt
            expect(dec((await state()).availableGhs)).toBe(0);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0);

            // the GENUINE chain still works afterwards (fail-closed did not
            // poison the identity)
            const res = await moolreWebhook(pending.txHash, 40);
            expect(res.statusCode).toBe(200);
            expect(dec((await state()).availableGhs)).toBe(40);
        });

        test('a receipt bound to a transaction of the WRONG TYPE or a CONTRADICTED route fails closed', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 30);
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: null, dedupKey: `event:moolre-collection:${pending.txHash}`,
                amountGhs: 30, relatedReference: pending.txHash,
            });

            // wrong transaction type: a P2P transfer row posing as the deposit
            const fake = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'INTERNAL_TRANSFER', amountUsdc: 30, status: 'COMPLETED', txHash: 'fake-p2p' },
            });
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: 'receipt:wrongtype', amountGhs: 30,
                reference: pending.txHash, relatedTransactionId: fake.id,
                eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });

            // route contradiction: the quote selected a different route
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: 'receipt:wrongroute', amountGhs: 30,
                reference: pending.txHash, relatedTransactionId: pending.id, route: 'GENERIC_BANK',
                eventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });

            expect(dec((await state()).availableGhs)).toBe(0);
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

        test('an UNMATCHED receipt becomes AVAILABLE only through confirmReconciliationMatch against a REAL durable chain (blocker 4)', async () => {
            await seedFreshRates();
            // a genuine deposit settled with the flag OFF: the TH row is
            // COMPLETED and the raw provider observation exists, but NO
            // receipt was created (the flag-off regime).
            await setAuthorityFlag(false);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 20);
            const res = await moolreWebhook(pending.txHash, 20);
            expect(res.statusCode).toBe(200);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0);

            // an operator records the unmatched observation (e.g. a webhook
            // delivered out of order, before the deposit existed)
            const { receipt } = await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: 'receipt:u2', amountGhs: 20,
            }));
            expect(receipt.status).toBe('UNMATCHED');

            // a "confirmation" without the durable provider observation is refused
            await expect(inTx((tx) => fiatLiquidity.confirmReconciliationMatch(tx, {
                dedupKey: 'receipt:u2', matchedTransactionId: pending.id,
                confirmedBy: 42,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            expect((await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: 'receipt:u2' } })).status).toBe('UNMATCHED');

            // the REAL match: names the deposit AND the durable observation
            const { receipt: confirmed } = await inTx((tx) => fiatLiquidity.confirmReconciliationMatch(tx, {
                dedupKey: 'receipt:u2', matchedTransactionId: pending.id,
                confirmedBy: 42,
                providerEventDedupKey: `event:moolre-collection:${pending.txHash}`,
            }));
            expect(confirmed.status).toBe('AVAILABLE');
            expect(confirmed.relatedTransactionId).toBe(pending.id); // the verified match is recorded
            expect(dec((await state()).availableGhs)).toBe(20);

            // replay: no double count
            const { replay } = await inTx((tx) => fiatLiquidity.confirmReconciliationMatch(tx, {
                dedupKey: 'receipt:u2', matchedTransactionId: pending.id,
                providerEventDedupKey: `event:moolre-collection:${pending.txHash}`,
            })).catch((e) => { throw e; });
            expect(replay).toBe(true); // an idempotent retry of the SAME match converges
            expect(dec((await state()).availableGhs)).toBe(20);
        });

        test('a reconciliation match that would DOUBLE-COUNT a deposit is refused (blocker 4)', async () => {
            // deposit A already carries an AVAILABLE receipt (real webhook chain)
            const { pending: depositA } = await seedAvailable({ amountGhs: 25 });
            // an unmatched observation for a DIFFERENT collection with the same amount
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'MOOLRE', dedupKey: 'receipt:dcount', amountGhs: 25,
            }));
            // trying to unlock it against deposit A — already claimed — fails closed
            await expect(inTx((tx) => fiatLiquidity.confirmReconciliationMatch(tx, {
                dedupKey: 'receipt:dcount', matchedTransactionId: depositA.id,
                providerEventDedupKey: `event:moolre-collection:${depositA.txHash}`,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(dec((await state()).availableGhs)).toBe(25); // unchanged
        });

        test('a treasury opening lands RECEIVED — ONLY confirmTreasuryOpening with a durable external funding observation unlocks it', async () => {
            const { receipt } = await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'AZM_TREASURY', rail: 'INTERNAL',
                dedupKey: 'treasury:t1', amountGhs: 500, treasury: true,
                evidence: { kind: 'AUDITED_TREASURY_OPENING' },
            }));
            expect(receipt.status).toBe('RECEIVED');
            expect(dec((await state()).availableGhs)).toBe(0);

            // no funding reference → refused (caller JSON is not evidence)
            await expect(inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: 'treasury:t1', confirmedBy: 1, fundingReference: '  ', fundingChannel: 'BANK',
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            // invalid channel → refused
            await expect(inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: 'treasury:t1', confirmedBy: 1, fundingReference: 'BANK-REF-1', fundingChannel: 'CASH_UNDER_MATTRESS',
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            expect(dec((await state()).availableGhs)).toBe(0);

            // a real external funding observation becomes DURABLE evidence
            const { receipt: confirmed } = await inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: 'treasury:t1', confirmedBy: 1, fundingReference: 'BANK-REF-1', fundingChannel: 'BANK',
            }));
            expect(confirmed.status).toBe('AVAILABLE');
            expect(dec((await state()).availableGhs)).toBe(500);
            const fundingEvent = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: 'event:treasury-funding:BANK-REF-1' } });
            expect(fundingEvent).not.toBeNull();
            expect(fundingEvent.provider).toBe('AZM_TREASURY');
            expect(Number(fundingEvent.amountGhs)).toBe(500);

            // replay: no double count
            const { replay } = await inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: 'treasury:t1', confirmedBy: 1, fundingReference: 'BANK-REF-1', fundingChannel: 'BANK',
            }));
            expect(replay).toBe(true);
            expect(dec((await state()).availableGhs)).toBe(500);
        });

        test('liquidateProfits (authority ON) creates NO spendable GHS — a NON-AVAILABLE audited opening only (blocker 1)', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates();
            await setAuthorityFlag(true);
            await prisma.systemProfitFees.upsert({
                where: { id: 1 }, update: { balance: 200 }, create: { id: 1, balance: 200 },
            });

            const result = await financeService.liquidateProfits(prisma, 50, 1);
            // honest response: the internal USDC move created NO spendable GHS
            expect(result.treasuryOpeningRecorded).toBe(true);
            expect(result.ghsAvailableCreated).toBe('0.00');
            expect(result.ghsAvailabilityNote).toMatch(/confirmTreasuryOpening/);

            const opening = await prisma.fiatLiquidityReceipt.findFirst({ where: { provider: 'AZM_TREASURY' } });
            expect(opening).not.toBeNull();
            expect(opening.status).toBe('RECEIVED'); // NOT AVAILABLE — no synthetic GHS
            expect(Number(opening.amountGhs)).toBe(671.00); // 50 USDC × 13.42 — priced, not custody
            expect(dec((await state()).availableGhs)).toBe(0); // zero claimable liquidity

            // unlocking it requires the external funding boundary
            await inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: opening.dedupKey, confirmedBy: 1,
                fundingReference: 'MOVO-98765', fundingChannel: 'MOMO',
            }));
            expect(dec((await state()).availableGhs)).toBe(671.00);
        });

        test('RECONCILIATION_REQUIRED and REVERSED receipts can never be confirmed AVAILABLE', async () => {
            const { receipt } = await seedAvailable({ amountGhs: 10 });
            await prisma.fiatLiquidityReceipt.update({ where: { id: receipt.id }, data: { status: 'RECONCILIATION_REQUIRED' } });
            await expect(inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, { dedupKey: receipt.dedupKey, fundingReference: 'R-1', fundingChannel: 'BANK' })))
                .rejects.toThrow(/RECONCILIATION_REQUIRED|RECEIVED treasury opening only/);
            await expect(inTx((tx) => fiatLiquidity.confirmReconciliationMatch(tx, { dedupKey: receipt.dedupKey, matchedTransactionId: receipt.relatedTransactionId, providerEventDedupKey: 'event:x' })))
                .rejects.toThrow(/UNMATCHED only/);
            await prisma.fiatLiquidityReceipt.update({ where: { id: receipt.id }, data: { status: 'REVERSED', reversedAt: new Date() } });
            await expect(inTx((tx) => fiatLiquidity.confirmTreasuryOpening(tx, { dedupKey: receipt.dedupKey, fundingReference: 'R-1', fundingChannel: 'BANK' })))
                .rejects.toThrow(/RECEIVED treasury opening only/);
        });
    });

    // =========================================================================
    // B. single-winner reservation
    // =========================================================================
    describe('B. reservation is a single-winner conditional decrement', () => {
        test('a claim loser fails closed with the legacy FIAT_POOL_INSUFFICIENT contract and leaves no orphan', async () => {
            await seedAvailable({ amountGhs: 50 });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: 'W-LOSER', amountGhs: 80, provider: 'MTN_MOMO',
            }))).rejects.toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });

            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-LOSER' } });
            expect(rz).toBeNull(); // rolled back with the transaction — never an orphan
            expect(dec((await state()).availableGhs)).toBe(50);
        });

        test('concurrent reservations cannot over-reserve: exactly one winner, totals conserved', async () => {
            await seedAvailable({ amountGhs: 100 });
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
            await seedAvailable({ amountGhs: 100 });
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
            await seedAvailable({ amountGhs: 100 });
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
        test('a webhook replay of the same settled deposit converges — exactly one liquidity effect', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 25);
            const first = await moolreWebhook(pending.txHash, 25);
            expect(first.statusCode).toBe(200);
            const second = await moolreWebhook(pending.txHash, 25); // provider retries
            expect(second.statusCode).toBe(200);
            expect(second.payload.message).toMatch(/Already processed/);
            expect(await prisma.fiatLiquidityReceipt.count({ where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` } })).toBe(1);
            expect(dec((await state()).availableGhs)).toBe(25);
        });

        test('conflicting reuse of a receipt identity fails closed (treasury openings carry no chain)', async () => {
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'AZM_TREASURY', dedupKey: 'treasury:d1', amountGhs: 25, treasury: true,
            }));
            await expect(inTx((tx) => fiatLiquidity.recordReceipt(tx, {
                provider: 'AZM_TREASURY', dedupKey: 'treasury:d1', amountGhs: 26, treasury: true,
            }))).rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            expect(dec((await state()).availableGhs)).toBe(0);
        });

        test('concurrent identical webhook settlements commit exactly one liquidity effect', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 40);
            const res1 = await moolreWebhook(pending.txHash, 40);
            expect(res1.statusCode).toBe(200);
            expect(dec((await state()).availableGhs)).toBe(40);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
        });
    });

    // =========================================================================
    // E./F./G./H. lifecycle: dispatch, settle, contradictions, release
    // =========================================================================
    describe('E./F./G./H. reservation lifecycle', () => {
        async function reservedRef(amountGhs, ref) {
            await seedAvailable({ amountGhs });
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
            await seedAvailable({ amountGhs: 100 });
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

        test('G: contradictory outcome NEVER rewrites terminal state — quarantine + idempotent exception, funds move to the hold bucket', async () => {
            await reservedRef(40, 'W-G1');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G1', providerRef: 'MTN-G' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'FAILED' }));
            const afterFailed = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G1' } });
            expect(afterFailed.status).toBe('RELEASED');
            expect(dec((await state()).availableGhs)).toBe(40); // returned to available

            // contradictory SUCCESS after the release: the previously returned
            // amount must LEAVE availability and enter the reconciliation hold
            const quarantined = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-G' }));
            expect(quarantined.quarantined).toBe(true);
            expect(quarantined.heldMove).toBe('released_to_held');
            const afterContradiction = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G1' } });
            expect(afterContradiction.status).toBe('RECONCILIATION_REQUIRED');

            const s = await state();
            expect(dec(s.availableGhs)).toBe(0); // NOT +40 — held, not spendable
            expect(dec(s.reconciliationHeldGhs)).toBe(40);

            const exceptions = await prisma.$queryRaw`SELECT * FROM "ReconciliationException" WHERE "entityType" = 'FIAT_LIQUIDITY_RESERVATION' AND "entityId" = ${'W-G1'}`;
            expect(exceptions).toHaveLength(1);
            expect(exceptions[0].reason).toBe('CONTRADICTORY_PROVIDER_EVIDENCE');
            expect(exceptions[0].status).toBe('OPEN');

            // replay of the contradictory evidence: still exactly ONE OPEN exception
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1', outcome: 'SUCCESSFUL', providerTxId: 'MTN-G' }));
            const still = await prisma.$queryRaw`SELECT * FROM "ReconciliationException" WHERE "entityType" = 'FIAT_LIQUIDITY_RESERVATION' AND "entityId" = ${'W-G1'} AND "status" = 'OPEN'`;
            expect(still).toHaveLength(1);
        });

        test('G: the held amount is NOT spendable — a second payout cannot consume it (blocker 5)', async () => {
            await seedAvailable({ amountGhs: 100 });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-G1b', amountGhs: 40, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G1b' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1b', outcome: 'FAILED' })); // released → available 100 again
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G1b', outcome: 'SUCCESSFUL' })); // contradiction → held
            const s = await state();
            expect(dec(s.availableGhs)).toBe(60);
            expect(dec(s.reconciliationHeldGhs)).toBe(40);

            // a 70 payout now FAILS: only 60 is claimable — the quarantined
            // 40 can never be paid out again
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, {
                reference: 'W-G1c', amountGhs: 70, provider: 'MTN_MOMO',
            }))).rejects.toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });
        });

        test('G: released funds already consumed by later payouts — the over-spend is flagged loudly, never hidden (blocker 5)', async () => {
            await seedAvailable({ amountGhs: 50 });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-G2a', amountGhs: 40, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G2a' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G2a', outcome: 'FAILED' })); // released → available 50
            // consume the returned funds with a real later payout
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-G2b', amountGhs: 45, provider: 'MOOLRE' }));
            expect(dec((await state()).availableGhs)).toBe(5);

            // the contradiction arrives AFTER the released 40 was spent
            const result = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G2a', outcome: 'SUCCESSFUL' }));
            expect(result.heldMove).toBe('released_already_spent');
            const exceptions = await prisma.$queryRaw`SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = ${'W-G2a'} AND "status" = 'OPEN'`;
            const reasons = new Set(exceptions.map((e) => e.reason));
            expect(reasons).toEqual(new Set(['CONTRADICTORY_PROVIDER_EVIDENCE', 'CONTRADICTORY_RELEASE_ALREADY_SPENT']));
            // the state stays honest: available was NOT driven negative
            const s = await state();
            expect(dec(s.availableGhs)).toBe(5);
            expect(dec(s.reconciliationHeldGhs)).toBe(0); // nothing could be moved to hold
        });

        test('G: SUCCESS while still RESERVED (never dispatched) quarantines with funds moved to hold', async () => {
            await reservedRef(15, 'W-G3');
            const result = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G3', outcome: 'SUCCESSFUL' }));
            expect(result.quarantined).toBe(true);
            expect(result.heldMove).toBe('reserved_to_held');
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-G3' } });
            expect(rz.status).toBe('RECONCILIATION_REQUIRED');
            const s = await state();
            expect(dec(s.reservedGhs)).toBe(0); // left the reservation bucket
            expect(dec(s.reconciliationHeldGhs)).toBe(15); // counted in hold — never spendable
        });

        test('G: terminal success through a DIFFERENT provider reference quarantines', async () => {
            await reservedRef(15, 'W-G4');
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-G4', providerRef: 'MTN-1' }));
            const result = await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-G4', outcome: 'SUCCESSFUL', providerTxId: 'MTN-2' }));
            expect(result.quarantined).toBe(true);
            expect(result.heldMove).toBe('in_transit_to_held');
            const s = await state();
            expect(dec(s.inTransitGhs)).toBe(0);
            expect(dec(s.reconciliationHeldGhs)).toBe(15);
        });

        test('H: internal reversal of a RESERVED payout returns funds; IN_TRANSIT/PAID_OUT reversals quarantine with funds held, never auto-release', async () => {
            await seedAvailable({ amountGhs: 100 });
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
            expect(r2.heldMove).toBe('in_transit_to_held');
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-H2' } })).status).toBe('RECONCILIATION_REQUIRED');

            const r3 = await inTx((tx) => fiatLiquidity.releaseReservation(tx, { reference: 'W-H3' }));
            expect(r3.quarantined).toBe(true); // a late reversal cannot unpay cash
            expect(r3.heldMove).toBe('paid_out_unchanged');
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-H3' } })).status).toBe('RECONCILIATION_REQUIRED');

            const s = await state();
            // 100 − 30 (H2 quarantined into hold) − 30 (H3 paid out) = 40;
            // H1's reservation was RELEASED — its funds returned to available
            expect(dec(s.availableGhs)).toBe(40);
            expect(dec(s.reservedGhs)).toBe(0);
            expect(dec(s.inTransitGhs)).toBe(0); // H2 left transit into hold
            expect(dec(s.paidOutGhs)).toBe(30);
            expect(dec(s.reconciliationHeldGhs)).toBe(30); // H2 held; H3 stays paid out
        });
    });

    // =========================================================================
    // I. aggregate conservation + deterministic pool projection
    // =========================================================================
    describe('I. conservation and projection', () => {
        test('full lifecycle: deposit → reserve → dispatch → success/failure keeps every total exact and the pool a projection', async () => {
            await seedAvailable({ amountGhs: 250.75 });
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
            expect(dec(s.reconciliationHeldGhs)).toBe(0);
            expect(await pool()).toBe(150.50);

            const summary = await fiatLiquidity.liquiditySummary(prisma);
            expect(summary.authoritative.availableGhs).toBe('150.5');
            expect(summary.authoritative.reconciliationHeldGhs).toBe('0');
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
            // an inbound event with no receipt (webhook recorded the raw
            // observation but no receipt exists — e.g. flag-off settlement)
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
            // duplicate provider references on two UNMATCHED receipts
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, { provider: 'MOOLRE', providerRef: 'PR-DUP', dedupKey: 'receipt:j3', amountGhs: 5 }));
            await inTx((tx) => fiatLiquidity.recordReceipt(tx, { provider: 'MOOLRE', providerRef: 'PR-DUP', dedupKey: 'receipt:j4', amountGhs: 7 }));
            // an amount mismatch between a durable event and its receipt,
            // paired through provider + providerRef (durable join, not keys)
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: 'event:j5', amountGhs: 6, providerRef: 'PR-J',
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

        test('real webhook chains produce ZERO reconciliation exceptions (durable join pairs them correctly)', async () => {
            await seedAvailable({ amountGhs: 55 });
            const report = await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60, dryRun: true });
            expect(report.exceptions).toEqual([]);
            expect(report.totals.reconciliationHeldGhs).toBe('0');
        });

        test('conservation covers ALL buckets including the reconciliation hold', async () => {
            await seedAvailable({ amountGhs: 100 });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-K1', amountGhs: 40, provider: 'MTN_MOMO' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-K1' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-K1', outcome: 'FAILED' }));
            await inTx((tx) => fiatLiquidity.settleReservation(tx, { reference: 'W-K1', outcome: 'SUCCESSFUL' })); // → hold

            const clean = await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60, dryRun: true });
            expect(clean.exceptions).toEqual([]); // held bucket reconciles exactly

            // tamper the hold bucket: conservation must flag it
            await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { reconciliationHeldGhs: 41 } });
            const tampered = await fiatLiquidity.reconcile(prisma, { horizonMinutes: 60, dryRun: true });
            const delta = tampered.exceptions.find((e) => e.reason === 'STATE_CONSERVATION_DELTA');
            expect(delta).toBeDefined();
            expect(JSON.stringify(delta.details)).toMatch(/reconciliationHeldGhs/);
        });
    });

    // =========================================================================
    // K. mounted webhook integration (real controllers, real DB)
    // =========================================================================
    describe('K. mounted deposit-webhook integration', () => {
        test('flag ON: a settled Moolre deposit creates an AVAILABLE receipt in the SAME transaction; replays converge', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 134.20);
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            const res = await moolreWebhook(pending.txHash, 134.20);
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
            await moolreWebhook(pending.txHash, 134.20);
            expect(await prisma.fiatLiquidityReceipt.count({ where: { dedupKey: `receipt:moolre-collection:${pending.txHash}` } })).toBe(1);
            expect(dec((await state()).availableGhs)).toBe(134.20);

            const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userAfter.availableBalance)).toBeGreaterThan(Number(userBefore.availableBalance));
        });

        test('flag OFF: raw evidence is still appended, but NO receipt and NO liquidity effect', async () => {
            await seedFreshRates();
            await setAuthorityFlag(false);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);

            const res = await moolreWebhook(pending.txHash, 100);
            expect(res.statusCode).toBe(200);

            expect(await prisma.fiatProviderEvent.count({ where: { dedupKey: `event:moolre-collection:${pending.txHash}` } })).toBe(1);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(0);
            expect(dec((await state()).availableGhs)).toBe(0);
            // the deposit itself still settles (mounted behavior unchanged)
            const settled = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(settled.status).toBe('COMPLETED');
        });

        test('sub-pesewa settlement amounts are rejected 400 — the authority never guesses a rounding', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 100);
            const res = await moolreWebhook(pending.txHash, 100.005);
            expect(res.statusCode).toBe(400);
            expect(res.payload.message).toMatch(/pesewa/);
            const tx = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(tx.status).toBe('PENDING'); // not settled, not credited
        });

        test('FAIL-CLOSED: when the evidence store is unavailable the settlement is blocked and NOTHING is credited (blocker 2)', async () => {
            await seedFreshRates();
            await setAuthorityFlag(true);
            const user = await seedUser(prisma);
            const pending = await initiateDeposit(user, 80);
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            // simulate evidence-store unavailability at the DB boundary
            await prisma.$executeRaw`DROP TABLE "FiatProviderEvent"`;
            const blocked = await moolreWebhook(pending.txHash, 80);
            expect(blocked.statusCode).toBe(503);
            expect(blocked.payload.success).toBe(false);
            expect(blocked.payload.message).toMatch(/durably recorded/);

            // the deposit stayed PENDING; no USDC was credited; no liquidity
            const tx = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(tx.status).toBe('PENDING');
            const userMid = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userMid.availableBalance)).toBe(Number(userBefore.availableBalance));
            expect(dec((await state()).availableGhs)).toBe(0);

            // recover the evidence store (the idempotent overlay installer)
            const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');
            await installFiatLiquidityOverlay(prisma);

            // the provider retries: the settlement now proceeds and converges
            const retried = await moolreWebhook(pending.txHash, 80);
            expect(retried.statusCode).toBe(200);
            const settled = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(settled.status).toBe('COMPLETED');
            expect(dec((await state()).availableGhs)).toBe(80);
            expect(await prisma.fiatLiquidityReceipt.count()).toBe(1);
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
            await financeService.processFiatWithdrawal(prisma, userOn.id, 10, { reference: ref2, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0244' } });
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

        test('authority ON: a stale/manipulated SystemFiatPool can neither false-reject nor false-authorize a withdrawal', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates(); // 13.42
            await setAuthorityFlag(true);
            await seedAvailable({ amountGhs: 1000 }); // genuine AVAILABLE liquidity

            // (1) FALSE REJECTION impossible: the compatibility pool reads 0 —
            // the legacy USDC preflight would reject every withdrawal. Under
            // the authority the withdrawal must succeed on the GHS claim alone.
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 0 } });
            const u1 = await seedUser(prisma, { availableBalance: 1000 });
            const ref1 = `FIAT_OUT_POOL_ZERO_${u1.id}`;
            const out1 = await financeService.processFiatWithdrawal(prisma, u1.id, 20, {
                reference: ref1, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0244' },
            });
            expect(out1.reference).toBe(ref1);
            const rz1 = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: ref1 } });
            expect(rz1).not.toBeNull();
            expect(rz1.status).toBe('RESERVED');
            expect(dec(rz1.amountGhs)).toBe(268.40); // 20 USDC × 13.42 — exact pesewas
            const s1 = await state();
            expect(dec(s1.availableGhs)).toBeCloseTo(1000 - 268.40, 2);
            expect(dec(s1.reservedGhs)).toBeCloseTo(268.40, 2);

            // (2) FALSE AUTHORIZATION impossible: the compatibility pool claims
            // 1,000,000 (the legacy preflight would admit anything) while the
            // authority has only 10 claimable GHS — the withdrawal must fail
            // closed with nothing deducted and nothing recorded.
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 1000000 } });
            await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 10 } });
            const u2 = await seedUser(prisma, { availableBalance: 1000 });
            const ref2 = `FIAT_OUT_POOL_FAT_${u2.id}`;
            await expect(
                financeService.processFiatWithdrawal(prisma, u2.id, 500, {
                    reference: ref2, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0244' },
                }),
            ).rejects.toMatchObject({ code: 'FIAT_POOL_INSUFFICIENT' });
            const u2After = await prisma.user.findUnique({ where: { id: u2.id } });
            expect(dec(u2After.availableBalance)).toBe(1000); // nothing deducted
            expect(await prisma.transactionHistory.count({ where: { txHash: ref2 } })).toBe(0);
            expect(await prisma.fiatLiquidityReservation.count({ where: { reference: ref2 } })).toBe(0);
            const s2 = await state();
            expect(dec(s2.availableGhs)).toBe(10); // untouched — the pool scalar had no say
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
            await expect(fiatLiquidity.recordProviderEvent(prisma, { provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL', dedupKey: 'e-m1b' }))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' }); // INBOUND must carry the amount
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M1', amountGhs: 10.005, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M2', amountGhs: 0, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
            await expect(inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-M3', amountGhs: -5, provider: 'MTN_MOMO' })))
                .rejects.toMatchObject({ code: 'LIQUIDITY_INVALID_EVIDENCE' });
        });

        test('OUTBOUND observations may carry no amount (providers that report status only) — INBOUND may not', async () => {
            const { event, replay } = await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'OUTBOUND', status: 'FAILED',
                providerRef: 'MTN-NULL-AMT', dedupKey: 'event:payout-outbound:MOOLRE:W-M4:FAILED',
                relatedReference: 'W-M4',
            });
            expect(replay).toBe(false);
            expect(event.amountGhs).toBeNull();
            const again = await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'MOOLRE', direction: 'OUTBOUND', status: 'FAILED',
                providerRef: 'MTN-NULL-AMT', dedupKey: 'event:payout-outbound:MOOLRE:W-M4:FAILED',
                relatedReference: 'W-M4',
            });
            expect(again.replay).toBe(true); // duplicate terminal callback converges
        });

        test('2dp GHS amounts round-trip exactly through Decimal(20,2) — no float artifacts', async () => {
            const { receipt } = await seedAvailable({ amountGhs: 0.10 });
            expect(receipt.amountGhs.toString()).toBe('0.1');
            await seedAvailable({ amountGhs: 0.20 });
            const s = await state();
            expect(s.availableGhs.toString()).toBe('0.3'); // exact — never 0.30000000000000004
        });

        test('the overlay DB CHECKs reject negative state totals, non-positive amounts, INBOUND events without amounts and invalid directions', async () => {
            await expect(prisma.$executeRaw`UPDATE "FiatLiquidityState" SET "availableGhs" = -1 WHERE "id" = 1`)
                .rejects.toThrow();
            await expect(prisma.$executeRaw`UPDATE "FiatLiquidityState" SET "reconciliationHeldGhs" = -1 WHERE "id" = 1`)
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
            // INBOUND without an amount is rejected by the amount_present CHECK
            await expect(prisma.fiatProviderEvent.create({
                data: { provider: 'X', direction: 'INBOUND', status: 'S', dedupKey: 'bad-e2' },
            })).rejects.toThrow();
            // OUTBOUND without an amount is allowed
            await expect(prisma.fiatProviderEvent.create({
                data: { provider: 'X', direction: 'OUTBOUND', status: 'S', dedupKey: 'ok-e3' },
            })).resolves.toBeDefined();
        });
    });

    // =========================================================================
    // P. outbound terminal evidence (settlement service, fail-closed)
    // =========================================================================
    describe('P. outbound terminal evidence', () => {
        test('settleFiatWithdrawal retains the terminal observation durably BEFORE settling; duplicates converge', async () => {
            const fiatSettlementService = require('../services/fiatSettlementService');
            await seedAvailable({ amountGhs: 60 });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-P1', amountGhs: 60, provider: 'MOOLRE', relatedTransactionId: 'th-p1' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-P1', providerRef: 'PR-P1' }));

            // build a genuine pending fiat withdrawal row for the settle path
            const user = await seedUser(prisma, { availableBalance: 0 });
            const txRow = await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: '4.47', status: 'PENDING', txHash: 'W-P1' },
            });

            const settle = async () => fiatSettlementService.settleFiatWithdrawal(prisma, { reference: 'W-P1', provider: 'MOOLRE', providerTxId: 'PR-P1', status: 'SUCCESSFUL' });
            const result = await settle();
            expect(result.transaction.status).toBe('COMPLETED');

            // the terminal observation is durable
            const ev = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: 'event:payout-outbound:MOOLRE:W-P1:SUCCESSFUL' } });
            expect(ev).not.toBeNull();
            expect(ev.direction).toBe('OUTBOUND');
            expect(ev.relatedReference).toBe('W-P1');

            // the authority reservation followed the settlement
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-P1' } });
            expect(rz.status).toBe('PAID_OUT');
            expect(dec((await state()).paidOutGhs)).toBe(60);

            // a duplicate terminal callback converges (event + reservation replay)
            const again = await settle();
            expect(again.transaction.status).toBe('COMPLETED');
            expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: 'W-P1' } })).toBe(1);
        });

        test('a CONTRADICTORY terminal observation is retained as a DISTINCT durable row, never dropped', async () => {
            const fiatSettlementService = require('../services/fiatSettlementService');
            await seedAvailable({ amountGhs: 60 });
            await inTx((tx) => fiatLiquidity.reserveForPayout(tx, { reference: 'W-P2', amountGhs: 60, provider: 'MOOLRE', relatedTransactionId: 'th-p2' }));
            await inTx((tx) => fiatLiquidity.markReservationInTransit(tx, { reference: 'W-P2', providerRef: 'PR-P2' }));
            const user = await seedUser(prisma, { availableBalance: 0 });
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: '4.47', status: 'PENDING', txHash: 'W-P2' },
            });

            await fiatSettlementService.settleFiatWithdrawal(prisma, { reference: 'W-P2', provider: 'MOOLRE', providerTxId: 'PR-P2', status: 'FAILED', reason: 'insufficient' });
            expect((await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-P2' } })).status).toBe('RELEASED');

            // the provider now claims SUCCESS for the same payout
            await fiatSettlementService.settleFiatWithdrawal(prisma, { reference: 'W-P2', provider: 'MOOLRE', providerTxId: 'PR-P2', status: 'SUCCESSFUL' });
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: 'W-P2' } });
            expect(rz.status).toBe('RECONCILIATION_REQUIRED'); // quarantined, never rewritten
            // BOTH observations are durable and distinct
            expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: 'W-P2', direction: 'OUTBOUND' } })).toBe(2);
        });

        test('FAIL-CLOSED: when the evidence store is unavailable the payout settlement refuses to proceed (blocker 6)', async () => {
            const fiatSettlementService = require('../services/fiatSettlementService');
            const user = await seedUser(prisma, { availableBalance: 0 });
            await prisma.transactionHistory.create({
                data: { userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: '4.47', status: 'PENDING', txHash: 'W-P3' },
            });
            await prisma.$executeRaw`DROP TABLE "FiatProviderEvent"`;
            await expect(fiatSettlementService.settleFiatWithdrawal(prisma, { reference: 'W-P3', provider: 'MOOLRE', providerTxId: 'PR-P3', status: 'SUCCESSFUL' }))
                .rejects.toThrow();
            // the withdrawal stayed PENDING — no settlement without evidence
            expect((await prisma.transactionHistory.findFirst({ where: { txHash: 'W-P3' } })).status).toBe('PENDING');
            const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');
            await installFiatLiquidityOverlay(prisma); // restore for afterEach bookkeeping
        });
    });

    // =========================================================================
    // Q. auto-payout worker: authoritative GHS units (blocker 7)
    // =========================================================================
    describe('Q. auto-payout worker liquidity units', () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const buildWorker = () => new PayoutBatchWorker(prisma, null, { initiateTransfer: jest.fn() }, null);

        async function workerSettings({ threshold, max }) {
            // The auto-payout configuration lives on GlobalSettings.
            await prisma.globalSettings.upsert({
                where: { id: 1 },
                update: { autoPayoutEnabled: true, autoPayoutThresholdUsdc: threshold, autoPayoutMaxAmountUsdc: max },
                create: { id: 1, autoPayoutEnabled: true, autoPayoutThresholdUsdc: threshold, autoPayoutMaxAmountUsdc: max },
            });
            return prisma.globalSettings.findUnique({ where: { id: 1 } });
        }

        async function pendingAutoWithdrawal(user, amountUsdc) {
            const created = new Date(Date.now() - 10 * 60_000);
            // the real flow creates BOTH rows: the Withdrawal and its canonical
            // WITHDRAWAL_FIAT TransactionHistory identity (same amount, same
            // instant) — the worker refuses to dispatch without it.
            await prisma.transactionHistory.create({
                data: {
                    userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: amountUsdc,
                    status: 'PENDING', txHash: `auto-payout-w-${user.id}-${Date.now()}`,
                    createdAt: created,
                },
            });
            await prisma.withdrawal.create({
                data: {
                    userId: user.id, amount: amountUsdc, status: 'PENDING',
                    payoutMethod: 'MTN_MOMO', destination: '0241234567',
                    network: 'MTN', createdAt: created,
                },
            });
        }

        test('a LEGACY withdrawal (no reservation) under authority flag ON keeps the LEGACY recorded-row regime — the flag never converts it', async () => {
            await seedFreshRates(); // 13.42
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 100, max: 500 });
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED', data: { reference: 'MTN-Q1L' }, providerRef: 'MTN-Q1L' }) };

            // authority headroom is DRAINED (500 GHS available << the 100 USDC
            // ≡ 1342 GHS authority floor) while the LEGACY pool projection is
            // healthy (500). The old flag-global code flagged this row with
            // AUTHORITY_HEADROOM_BELOW_THRESHOLD; the per-row regime code MUST
            // dispatch it — this recorded row predates §P.5-D and the flag
            // must not rewrite its meaning.
            await seedAvailable({ amountGhs: 500 });
            const user = await seedUser(prisma, { availableBalance: 200 });
            await pendingAutoWithdrawal(user, 20);

            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.flagged).toBe(0);
            expect(results.processed).toBe(1);
            expect(results.details.flaggedManualReview).toHaveLength(0);
            // no liquidity history was invented for the legacy row
            expect(await prisma.fiatLiquidityReservation.count({ where: { reference: { contains: String(user.id) } } })).toBe(0);
            // the legacy USDC pool projection gauge was used and decremented
            expect(results.poolBalance).toBe(500 - 20);
            expect(worker.mtn.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountGhs: parseFloat((20 * 13.42).toFixed(2)) }));
        });

        test('an authority-RECORDED withdrawal hits the operational headroom floor (threshold converted to GHS at the live rate) and stays RESERVED', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates(); // 13.42
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 100, max: 5000 }); // floor: 100 USDC ≡ 1342 GHS
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED' }) };

            // claimable authority liquidity: 500 GHS. After reserving 268.40
            // only 231.60 remains — far below the 1342 GHS floor.
            await seedAvailable({ amountGhs: 500 });
            const user = await seedUser(prisma, { availableBalance: 1000 });
            const reference = `FIAT_OUT_HEADROOM_${user.id}`;
            await financeService.processFiatWithdrawal(prisma, user.id, 20, { reference, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0241234567' } });
            const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            await prisma.withdrawal.create({
                data: { userId: user.id, amount: 20, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN', createdAt: th.createdAt },
            });

            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.flagged).toBe(1);
            expect(results.details.flaggedManualReview[0].reason).toBe('AUTHORITY_HEADROOM_BELOW_THRESHOLD');
            expect(results.processed).toBe(0);
            expect(worker.mtn.initiateTransfer).not.toHaveBeenCalled();
            // the reservation is untouched — funds held, not spendable, not dispatched
            const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(rz.status).toBe('RESERVED');
            const st = await state();
            expect(dec(st.availableGhs)).toBeCloseTo(500 - 268.40, 2);
            expect(dec(st.reservedGhs)).toBeCloseTo(268.40, 2);
            const flagged = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
            expect(flagged.status).toBe('NEEDS_MANUAL_REVIEW');
        });

        test('a LEGACY withdrawal pays out through the LEGACY pool policy (authority flag ON) — the worker itself never reserves', async () => {
            await seedFreshRates(); // 13.42 → threshold 100 USDC ≡ 1342 GHS
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 100, max: 5000 });
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED', data: { reference: 'MTN-Q2' }, providerRef: 'MTN-Q2' }) };

            // seeding 2000 GHS of claimable availability ALSO mirrors the
            // legacy pool projection to 2000 — healthy for the legacy gate.
            await seedAvailable({ amountGhs: 2000 });
            const user = await seedUser(prisma, { availableBalance: 200 });
            await pendingAutoWithdrawal(user, 20); // 20 USDC ≡ 268.40 GHS

            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.processed).toBe(1);
            expect(results.details.processed).toHaveLength(1);
            expect(results.details.flaggedManualReview).toHaveLength(0);
            const rz = await prisma.fiatLiquidityReservation.findMany({ where: { reference: { contains: String(user.id) } } });
            expect(rz).toHaveLength(0); // the worker itself never reserves
            // the legacy USDC pool projection gauge decremented — legacy regime
            expect(results.poolBalance).toBe(2000 - 20);
            // dispatch evidence was recorded durably
            const dispatched = results.details.processed[0];
            expect(dispatched.referenceId).toBeDefined();
            const ev = await prisma.fiatProviderEvent.findFirst({ where: { direction: 'OUTBOUND', relatedReference: dispatched.referenceId } });
            expect(ev).not.toBeNull();
        });

        test('authority ON: a P5-D-reserved withdrawal dispatches with exactly ONE reservation and NO second GHS decrement', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates(); // 13.42
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 100, max: 5000 }); // floor: 100 USDC ≡ 1342 GHS
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED', data: { reference: 'MTN-Q5' }, providerRef: 'MTN-Q5' }) };

            await seedAvailable({ amountGhs: 2000 });
            const user = await seedUser(prisma, { availableBalance: 1000 });

            // 1. the REAL authority path creates the GHS reservation and the
            //    canonical PENDING TransactionHistory row (same reference).
            const reference = `FIAT_OUT_WORKER_${user.id}`;
            await financeService.processFiatWithdrawal(prisma, user.id, 20, { reference, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0241234567' } });
            const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(th).not.toBeNull();

            const rzAfterCreate = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(rzAfterCreate).not.toBeNull();
            expect(rzAfterCreate.status).toBe('RESERVED');
            expect(dec(rzAfterCreate.amountGhs)).toBe(268.40); // 20 USDC × 13.42

            const stateAfterCreate = await state();
            const availableAfterCreate = dec(stateAfterCreate.availableGhs);
            expect(availableAfterCreate).toBeCloseTo(2000 - 268.40, 2);
            expect(dec(stateAfterCreate.reservedGhs)).toBeCloseTo(268.40, 2);

            // 2. the PENDING Withdrawal row the worker scans (fallback
            //    canonical match: same user/amount/createdAt window).
            await prisma.withdrawal.create({
                data: {
                    userId: user.id, amount: 20, status: 'PENDING',
                    payoutMethod: 'MTN_MOMO', destination: '0241234567',
                    network: 'MTN', createdAt: th.createdAt,
                },
            });

            // 3. the worker dispatches it — with the reservation ALREADY present.
            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.processed).toBe(1);
            expect(results.details.flaggedManualReview).toHaveLength(0);

            // 4. exactly one liquidity reservation exists for the payout.
            const allRz = await prisma.fiatLiquidityReservation.findMany({ where: { reference } });
            expect(allRz).toHaveLength(1);

            // 5. available GHS was NOT decremented a second time by the
            //    dispatch: the reservation amount moved reserved → in-transit
            //    only. GHS is compared with GHS throughout.
            const s2 = await state();
            expect(dec(s2.availableGhs)).toBeCloseTo(availableAfterCreate, 2);
            expect(dec(s2.reservedGhs)).toBeCloseTo(0, 2);
            expect(dec(s2.inTransitGhs)).toBeCloseTo(268.40, 2);
        });

        test('RATE DRIFT never mutates a reserved payout: the provider receives EXACTLY the originally reserved GHS', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates(); // 13.42 GHS/USDC at reservation time
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 10, max: 5000 }); // floor: 10 USDC ≡ 134.20 GHS
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED', data: { reference: 'MTN-DRIFT' }, providerRef: 'MTN-DRIFT' }) };

            await seedAvailable({ amountGhs: 2000 });
            const user = await seedUser(prisma, { availableBalance: 1000 });

            // 1. authority-on withdrawal at 13.42 → exactly 268.40 GHS reserved
            const reference = `FIAT_OUT_DRIFT_${user.id}`;
            await financeService.processFiatWithdrawal(prisma, user.id, 20, { reference, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0241234567' } });
            const rzBefore = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(dec(rzBefore.amountGhs)).toBe(268.40); // 20 USDC × 13.42
            const availableBefore = dec((await state()).availableGhs); // 2000 − 268.40

            const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            await prisma.withdrawal.create({
                data: { userId: user.id, amount: 20, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN', createdAt: th.createdAt },
            });

            // 2. the live rate drifts MATERIALLY before the worker runs —
            //    a naive recomputation would pay 20 × 15.75 = 315.00 GHS.
            await prisma.globalSettings.update({ where: { id: 1 }, data: { liveRetailRate: 15.75 } });

            // 3. the payout worker dispatches
            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.processed).toBe(1);
            expect(results.details.flaggedManualReview).toHaveLength(0);

            // 4. the provider received EXACTLY the reserved 268.40 — not the
            //    recalculated 315.00
            expect(worker.mtn.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({
                referenceId: reference, amountGhs: 268.40,
            }));
            expect(results.details.processed[0].amountGhs).toBe(268.40);

            // 5. the reservation row itself still carries exactly 268.40
            const rzAfter = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(dec(rzAfter.amountGhs)).toBe(268.40);

            // 6. the durable outbound evidence carries the same exact amount
            const ev = await prisma.fiatProviderEvent.findFirst({ where: { direction: 'OUTBOUND', relatedReference: reference } });
            expect(ev).not.toBeNull();
            expect(dec(ev.amountGhs)).toBe(268.40);

            // 7. state moved reservedGhs → inTransitGhs for EXACTLY 268.40,
            //    and availableGhs was NOT decremented a second time during
            //    dispatch
            const st = await state();
            expect(dec(st.availableGhs)).toBeCloseTo(availableBefore, 2);
            expect(dec(st.reservedGhs)).toBeCloseTo(0, 2);
            expect(dec(st.inTransitGhs)).toBeCloseTo(268.40, 2);

            // 8. exactly one reservation exists for the payout
            expect(await prisma.fiatLiquidityReservation.count({ where: { reference } })).toBe(1);
        });

        test('an authority-reserved withdrawal cannot be controlled by a manipulated SystemFiatPool — the pool is never an authority input', async () => {
            const financeService = require('../services/finance.service');
            await seedFreshRates(); // 13.42
            await setAuthorityFlag(true);
            const settings = await workerSettings({ threshold: 10, max: 5000 }); // floor: 10 USDC ≡ 134.20 GHS
            const worker = buildWorker();
            worker.mtn = { initiateTransfer: jest.fn().mockResolvedValue({ status: 'ACCEPTED', data: { reference: 'MTN-POOL0' }, providerRef: 'MTN-POOL0' }) };

            await seedAvailable({ amountGhs: 2000 });
            const user = await seedUser(prisma, { availableBalance: 1000 });
            const reference = `FIAT_OUT_POOL0_${user.id}`;
            await financeService.processFiatWithdrawal(prisma, user.id, 20, { reference, retailRate: 13.42, liquidityRoute: { provider: 'MTN_MOMO', destination: '0241234567' } });
            const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            await prisma.withdrawal.create({
                data: { userId: user.id, amount: 20, status: 'PENDING', payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN', createdAt: th.createdAt },
            });

            // an attacker (or operator) drains the LEGACY pool projection to
            // zero — under the legacy regime this would hold the payout; for
            // a RESERVED authority withdrawal it must change nothing.
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 0 } });

            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.processed).toBe(1);
            expect(results.details.flaggedManualReview).toHaveLength(0);
            expect(worker.mtn.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ referenceId: reference, amountGhs: 268.40 }));
            // reserved → IN_TRANSIT for exactly the reserved amount; the
            // authority figures never touched the legacy pool
            const st = await state();
            expect(dec(st.inTransitGhs)).toBeCloseTo(268.40, 2);
            expect(dec(st.reservedGhs)).toBeCloseTo(0, 2);
            // the legacy projection is still zero — authority processing did
            // not read or mutate it
            expect(await pool()).toBe(0);
        });

        test('authority OFF: legacy USDC pool comparison is byte-identical (INSUFFICIENT_POOL_LIQUIDITY on a drained pool)', async () => {
            await setAuthorityFlag(false);
            const settings = await workerSettings({ threshold: 500, max: 200 });
            const worker = buildWorker();
            await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 100 } });
            const user = await seedUser(prisma, { availableBalance: 200 });
            await pendingAutoWithdrawal(user, 20);

            const results = await worker._processBatch(settings, { isManualTrigger: true });
            expect(results.flagged).toBe(1);
            expect(results.details.flaggedManualReview[0].reason).toBe('INSUFFICIENT_POOL_LIQUIDITY');
        });
    });

    // =========================================================================
    // R. runDoubleCheck regressions (NaN disarm + withdrawal sign convention)
    // =========================================================================
    describe('R. runDoubleCheck regressions', () => {
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
    // S. overlay idempotency (guarded re-run against the live test DB)
    // =========================================================================
    describe('S. overlay idempotency', () => {
        test('the installer converges on re-run', async () => {
            const { installFiatLiquidityOverlay } = require('../infra/install-fiat-liquidity-overlay');
            await installFiatLiquidityOverlay(prisma);
            await installFiatLiquidityOverlay(prisma);
            const cols = await prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM information_schema.columns
                WHERE "table_name" = 'FiatLiquidityState'
                  AND "column_name" IN ('availableGhs', 'reservedGhs', 'inTransitGhs', 'paidOutGhs', 'reconciliationHeldGhs')`;
            expect(cols[0].n).toBe(5);
            const flagCol = await prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM information_schema.columns
                WHERE "table_name" = 'GlobalSettings' AND "column_name" = 'fiatLiquidityAuthorityEnabled'`;
            expect(flagCol[0].n).toBe(1);
        });
    });

    // =========================================================================
    // T. provider-observation identity (substrate authority, real PostgreSQL)
    //    proofs 15/A/B of the evidence-identity hardening: exact duplicate
    //    observations converge idempotently to ONE row; materially different
    //    observations under a committed identity are retained as DISTINCT
    //    durable rows and fail closed — nothing ever collapses silently.
    // =========================================================================
    describe('T. provider-observation identity (substrate)', () => {
        const baseObservation = {
            provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'SUCCESSFUL',
            providerRef: 'PTX-1', dedupKey: 'event:fiat-deposit:R-T:SUCCESSFUL',
            amountGhs: 100, relatedReference: 'R-T',
        };

        test('A: an exact semantic duplicate converges to exactly ONE event row — raw payload differences never manufacture conflicts', async () => {
            const first = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, raw: { attempt: 1, ts: '2026-09-19T18:00:00Z' } });
            expect(first.replay).toBe(false);
            // the SAME economic observation retried with a byte-different raw
            // payload (timestamps, field ordering, transport noise) — raw is
            // NOT identity, this must converge, never conflict
            const retry = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, raw: { attempt: 2, ts: '2026-09-19T18:05:00Z', extra: 'transport noise' } });
            expect(retry.replay).toBe(true);
            expect(retry.event.id).toBe(first.event.id);
            const rows = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T' } });
            expect(rows).toHaveLength(1); // exactly ONE durable row
            expect(rows[0].status).toBe('SUCCESSFUL');
            expect(rows[0].amountGhs.toString()).toBe('100');
        });

        test('B: a materially different observation under a committed identity is retained as a DISTINCT row and fails closed — the committed row is never rewritten', async () => {
            const first = await fiatLiquidity.recordProviderEvent(prisma, baseObservation);
            const committedAt = new Date(first.event.receivedAt);

            // same dedupKey, DIFFERENT collected amount — contradictory evidence
            await expect(fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, amountGhs: 5 }))
                .rejects.toMatchObject({
                    code: 'LIQUIDITY_CONFLICTING_EVIDENCE',
                    details: { dedupKey: baseObservation.dedupKey, differingFields: ['amountGhs'] },
                });

            // the committed row is untouched — never rewritten, never absorbed
            const committed = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: baseObservation.dedupKey } });
            expect(committed.id).toBe(first.event.id);
            expect(committed.amountGhs.toString()).toBe('100');
            expect(new Date(committed.receivedAt).getTime()).toBe(committedAt.getTime());

            // the contradictory observation IS durably retained, on its own
            // deterministic conflict identity
            const conflictRows = await prisma.fiatProviderEvent.findMany({
                where: { dedupKey: { contains: ':CONFLICT:' }, relatedReference: 'R-T' },
            });
            expect(conflictRows).toHaveLength(1);
            expect(conflictRows[0].amountGhs.toString()).toBe('5'); // the contradictory claim, visible

            // an exact retry of the CONTRADICTORY payload converges to the
            // conflict row — still exactly 2 durable observations, no growth
            await expect(fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, amountGhs: 5 }))
                .rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            const all = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T' } });
            expect(all).toHaveLength(2);

        });

        test('r10-C: providerRef null→present for the same observation is ENRICHMENT, not a contradiction — converges to ONE row, the committed row gains the observed ref, nothing else changes', async () => {
            // The generic deposit webhook's providerTxId has never been a
            // required field; a first callback without it commits the
            // observation, and a legitimate retry carrying it must converge
            // (fail-closed contradiction here would manufacture a false
            // ReconciliationException out of a provider retry).
            const first = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: null });
            expect(first.replay).toBe(false);
            expect(first.event.providerRef).toBeNull();
            const retry = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: 'PTX-ENRICHED' });
            expect(retry.replay).toBe(true); // converge — NOT contradictory evidence
            expect(retry.event.id).toBe(first.event.id);
            expect(retry.event.providerRef).toBe('PTX-ENRICHED'); // strictly additive enrichment
            const rows = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T' } });
            expect(rows).toHaveLength(1); // still exactly ONE durable observation
            expect(rows[0].status).toBe('SUCCESSFUL');
            expect(rows[0].amountGhs.toString()).toBe('100');
            expect(new Date(rows[0].receivedAt).getTime()).toBe(new Date(first.event.receivedAt).getTime()); // committed claims untouched
            // an exact retry of the ENRICHED payload also converges (idempotent)
            const again = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: 'PTX-ENRICHED' });
            expect(again.replay).toBe(true);
            expect(again.event.id).toBe(first.event.id);
            expect((await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T' } })).length).toBe(1);
        });

        test('r10-D: providerRef present→absent for the same observation converges WITHOUT downgrade — the committed ref stands, the retry carries no claim', async () => {
            const first = await fiatLiquidity.recordProviderEvent(prisma, baseObservation); // providerRef 'PTX-1'
            expect(first.event.providerRef).toBe('PTX-1');
            const retry = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: null });
            expect(retry.replay).toBe(true); // an absent ref is not a contradiction
            expect(retry.event.id).toBe(first.event.id);
            expect(retry.event.providerRef).toBe('PTX-1'); // never downgraded to null
            expect((await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T' } })).length).toBe(1);
        });

        test('r10-E: two PRESENT but different refs are still materially different — contradiction retained, committed row untouched (binding is NOT weakened)', async () => {
            const first = await fiatLiquidity.recordProviderEvent(prisma, baseObservation); // providerRef 'PTX-1'
            await expect(fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: 'PTX-2' }))
                .rejects.toMatchObject({
                    code: 'LIQUIDITY_CONFLICTING_EVIDENCE',
                    details: { dedupKey: baseObservation.dedupKey, differingFields: ['providerRef'] },
                });
            const committed = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: baseObservation.dedupKey } });
            expect(committed.providerRef).toBe('PTX-1'); // untouched
            expect(committed.id).toBe(first.event.id);
            const conflicts = await prisma.fiatProviderEvent.findMany({
                where: { dedupKey: { contains: ':CONFLICT:' }, relatedReference: 'R-T' },
            });
            expect(conflicts).toHaveLength(1); // the contradictory ref, durably visible
            expect(conflicts[0].providerRef).toBe('PTX-2');
        });

        test('r11: concurrent null→present enrichment is a COMPARE-AND-SET — two concurrent different refs can never collapse into last-writer-wins (real PostgreSQL race)', async () => {
            // Commit the observation with providerRef = NULL (exactly the
            // state a legitimate generic callback whose providerTxId was
            // absent leaves behind), then fire TWO CONCURRENT enrichment
            // retries carrying DIFFERENT present refs. The durable identity
            // must be deterministic: ONE ref wins, the loser is rejected as
            // contradictory evidence and durably retained — never a
            // last-writer-wins overwrite.
            const committed = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: null });
            expect(committed.replay).toBe(false);
            expect(committed.event.providerRef).toBeNull();

            const outcomes = await Promise.allSettled([
                fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: 'PTX-A' }),
                fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: 'PTX-B' }),
            ]);
            const winner = outcomes.find((o) => o.status === 'fulfilled');
            const loser = outcomes.find((o) => o.status === 'rejected');
            expect(winner).toBeDefined();
            expect(loser).toBeDefined(); // the loser is NEVER silently converged

            // exactly ONE durable primary observation row exists under the
            // original identity — and it carries exactly ONE winning ref
            const primaries = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T', dedupKey: { not: { contains: ':CONFLICT:' } } } });
            expect(primaries).toHaveLength(1);
            const primary = primaries[0];
            expect(primary.id).toBe(committed.event.id); // the committed row, never a new one
            expect(['PTX-A', 'PTX-B']).toContain(primary.providerRef);
            const winningRef = primary.providerRef;
            const losingRef = winningRef === 'PTX-A' ? 'PTX-B' : 'PTX-A';

            // the loser was rejected with the typed contradiction error
            expect(loser.reason).toMatchObject({
                code: 'LIQUIDITY_CONFLICTING_EVIDENCE',
                details: { dedupKey: baseObservation.dedupKey, differingFields: ['providerRef'] },
            });

            // the contradictory observation is durably retained under its
            // deterministic conflict identity — carrying the LOSING ref
            const conflictRows = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T', dedupKey: { contains: ':CONFLICT:' } } });
            expect(conflictRows).toHaveLength(1);
            expect(conflictRows[0].providerRef).toBe(losingRef);

            // an exact retry of the LOSING ref converges to the SAME conflict
            // row — no second row, no growth, no overwrite of the winner
            const losingRetry = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: losingRef }).catch((e) => e);
            expect(losingRetry).toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            const conflictRowsAfter = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: 'R-T', dedupKey: { contains: ':CONFLICT:' } } });
            expect(conflictRowsAfter).toHaveLength(1);
            expect(conflictRowsAfter[0].id).toBe(conflictRows[0].id);
            expect(conflictRowsAfter[0].providerRef).toBe(losingRef);

            // the primary committed row remains EXACTLY the winner's claim
            const primaryAfter = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: baseObservation.dedupKey } });
            expect(primaryAfter.providerRef).toBe(winningRef);
            expect(primaryAfter.status).toBe('SUCCESSFUL');
            expect(primaryAfter.amountGhs.toString()).toBe('100');
            expect(new Date(primaryAfter.receivedAt).getTime()).toBe(new Date(committed.event.receivedAt).getTime());

            // an exact retry of the WINNING ref converges as a plain replay
            const winningRetry = await fiatLiquidity.recordProviderEvent(prisma, { ...baseObservation, providerRef: winningRef });
            expect(winningRetry.replay).toBe(true);
            expect(winningRetry.event.id).toBe(primary.id);

            // total durable rows: one primary + one conflict — no generic
            // financial mutation is involved anywhere in this contract
            expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: 'R-T' } })).toBe(2);
        });

        test('15: two materially different provider observations can NEVER collapse into one silently — exact retries converge, distinct statuses are distinct rows', async () => {
            // the generic webhook surface identity shape: status-scoped keys
            const ref = 'R-T15';
            const successKey = `event:fiat-deposit:${ref}:SUCCESSFUL`;
            const failedKey = `event:fiat-deposit:${ref}:FAILED`;

            // SUCCESS observation + an exact webhook retry — converges
            const s1 = await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'PTX-S', dedupKey: successKey, amountGhs: 100, relatedReference: ref,
            });
            const s2 = await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'PTX-S', dedupKey: successKey, amountGhs: 100, relatedReference: ref,
            });
            expect(s2.replay).toBe(true);
            expect(s2.event.id).toBe(s1.event.id);

            // a FAILED observation for the SAME reference — a materially
            // different observation, its OWN durable identity, never absorbed
            const f1 = await fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'FAILED',
                providerRef: 'PTX-S', dedupKey: failedKey, amountGhs: 100, relatedReference: ref,
            });
            expect(f1.replay).toBe(false);
            expect(f1.event.id).not.toBe(s1.event.id);

            // BOTH directions from the persisted rows: two durable
            // observations for one reference, statuses visible and queryable
            const rows = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: ref } });
            expect(rows).toHaveLength(2);
            expect(rows.filter((r) => r.status === 'SUCCESSFUL')).toHaveLength(1);
            expect(rows.filter((r) => r.status === 'FAILED')).toHaveLength(1);
            // each identity resolves to ITS OWN observation — the FAILED row
            // can never be returned as a replay of the SUCCESS observation or
            // vice versa
            expect((await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: successKey } })).status).toBe('SUCCESSFUL');
            expect((await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: failedKey } })).status).toBe('FAILED');

            // and a materially different SUCCESS payload under the SUCCESS
            // identity still fails closed with the contradiction retained —
            // three durable rows, zero silent collapses
            await expect(fiatLiquidity.recordProviderEvent(prisma, {
                provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'PTX-S', dedupKey: successKey, amountGhs: 55, relatedReference: ref,
            })).rejects.toMatchObject({ code: 'LIQUIDITY_CONFLICTING_EVIDENCE' });
            const after = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: ref } });
            expect(after).toHaveLength(3); // SUCCESS, FAILED, SUCCESS-conflict — all visible
        });
    });
});
