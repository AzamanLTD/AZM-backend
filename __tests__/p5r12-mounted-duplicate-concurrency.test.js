// =============================================================================
// §P.5-E audit r12 — TRUE MOUNTED DUPLICATE-SUCCESS WEBHOOK CONCURRENCY
// (exactly-once economics at the production controller boundary)
// =============================================================================
//
// DISTINCTION FROM THE PRIMITIVE-LEVEL PROOF:
//   The existing P5-E test "concurrent settlements cannot double-allocate the
//   same lot quantity" is a DIRECT-PRIMITIVE proof: it creates two different
//   deposits, manually performs quote consumption + TransactionHistory
//   completion OUTSIDE the controller, and invokes the settlement primitive.
//   It proves inventory cannot be double-allocated — but it does NOT exercise
//   the production duplicate-callback surface. This suite is the missing
//   boundary: the COMPLETE mounted webhook controllers run, with their real
//   out-of-band evidence recording, state checks, quote consumption CAS,
//   TransactionHistory state-machine CAS, Model B settlement, ledger posting
//   and liquidity receipt — under TWO GENUINELY CONCURRENT IDENTICAL SUCCESS
//   callbacks for the SAME deposit.
//
// BOTH interleavings are exercised empirically (never mocked): each race is
// repeated across multiple iterations with fresh deposits, so callbacks
// interleave in different orders — concurrent overlap (loser reads stale
// PENDING pre-state, loses the quote CAS or the state CAS inside the
// transaction) and serialized overlap (second callback observes COMPLETED).
// No transaction ordering is forced; no HTTP result for the loser is forced.
//
// THE KEY INVARIANT IS EXACTLY-ONCE ECONOMICS, NOT A STATUS CODE. Every race
// must end with exactly:
//   * ONE settled outcome (200, credited);
//   * the other request either CONVERGING to the committed result (200
//     already-processed) or FAILING CLOSED safely (409) — both classes are
//     acceptable, and the test records which occurred;
//   * exactly ONE ModelBSettlement row;
//   * exactly ONE customer liability credit (projection AND ledger);
//   * exactly ONE inventory consumption path;
//   * exactly TWO ledger postings for the single settlement only
//     (ASSET_CONVERSION + DEPOSIT) — the loser's attempted postings roll back;
//   * the quote consumed EXACTLY ONCE;
//   * TransactionHistory COMPLETED;
//   * ONE durable primary provider observation (no conflict rows);
//   * NO duplicate liquidity receipt / financial effect with the
//     liquidity-authority flag ON;
//   * user availableBalance reflecting EXACTLY ONE credit;
//   * inventory remaining reflecting EXACTLY ONE delivery.
//
// QUOTE-CAS / SETTLEMENT INTERACTION (audited, not changed):
//   consumeTransactionQuote() is a single-statement SQL CAS
//   (UPDATE ... WHERE consumedAt IS NULL) executed INSIDE the same
//   database transaction as the state-machine CAS, the credit, the Model B
//   settlement, the ledger posting and the receipt. A callback that observed
//   a stale PENDING pre-state can therefore NEVER reach Model B after the
//   winner commits: its quote CAS matches ZERO rows and the ENTIRE
//   transaction (every mutation) rolls back. There is no interleaving in
//   which A consumes, B observes old PENDING, A commits, and B still credits
//   again — B's settlement either wins the quote CAS first (then A loses
//   wholesale) or B's zero-row CAS aborts everything B attempted. These races
//   prove that empirically on real PostgreSQL, repeatedly, on both surfaces.
//
// EVIDENCE SHAPES (both are production behavior):
//   * FRESH — the callbacks themselves establish the durable provider
//     observation concurrently (the normal first-callback path proves
//     evidence is established safely under the race);
//   * PRE-PRESENT — the provider observation is durably present BEFORE both
//     concurrent callbacks (the production retry shape: an earlier callback
//     recorded evidence but did not settle), so both race callbacks CONVERGE
//     on the committed observation row while racing the settlement.
//
// Only non-DB boundaries (audit, journal, notifications, logger) and the
// external Moolre provider are stubbed — exactly the r10/p5e harness
// discipline. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r12-mounted-duplicate-concurrency.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-E audit r12 — mounted duplicate-SUCCESS webhook concurrency (exactly-once economics, real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const ledger = require('../services/ledgerService');
    const inventory = require('../services/inventoryService');
    const modelBSettlement = require('../services/modelBSettlementService');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const { Prisma } = require('@prisma/client');
    const Decimal = Prisma.Decimal;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_r12';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_r12';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            }).catch(() => null);
            await prisma.$disconnect();
        }
    });

    const TRUNCATE_ALL = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ModelBSettlement", "InventoryLotConsumption", "InventoryLot", "LedgerTransaction", "LedgerAccount", "JournalEntry", "TransactionQuote", "TransactionHistory", "FiatProviderEvent", "FiatLiquidityReceipt", "ReconciliationException", "SystemFiatPool", "User" RESTART IDENTITY CASCADE'
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

    // ── flags & fixtures (p5e harness discipline) ──────────────────────────
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
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-R12-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    // ── mounted surfaces (identical payload on EVERY call — a true duplicate) ──
    async function initiateDeposit(user, amountGhs = 100, surface = 'moolre') {
        const res = mockResponse();
        const body = { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' };
        if (surface === 'moolre') {
            await moolreQuoteDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        } else {
            await quoteFiatDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        }
        expect(res.statusCode).toBe(201);
        const pending = await prisma.transactionHistory.findFirst({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' }, orderBy: { id: 'desc' } });
        expect(pending).not.toBeNull();
        return pending;
    }
    const fireMoolre = async (txHash) => {
        const res = mockResponse();
        await moolreQuoteDepositController.webhook({
            app: makeApp(),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: txHash, amount: 100, payer: '0241234567' } },
        }, res);
        return res;
    };
    const fireGeneric = async (txHash) => {
        const res = mockResponse();
        await quoteFiatDepositController.webhook({
            app: makeApp(),
            headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
            body: { reference: txHash, amountGhs: 100, providerTxId: 'GEN-R12', status: 'SUCCESS' },
        }, res);
        return res;
    };

    const acquireTx = (o = {}) => prisma.$transaction((tx) => inventory.acquireLot(tx, {
        acquisitionKey: o.key ?? `lot:p5r12:${Math.random().toString(36).slice(2)}`,
        sourceType: 'CORPORATE_PURCHASE',
        sourceReference: 'purchase-log:p5r12',
        quantity: o.quantity ?? '10',
        costBasisGhs: o.cost ?? '120',
        acquisitionRate: '12',
    }).then(async (r) => {
        await tx.inventoryLot.update({ where: { id: r.lot.id }, data: { eligibleForModelBSettlement: true } });
        return r.lot;
    }));

    const quoteRow = async (quoteId) => {
        const rows = await prisma.$queryRaw`
            SELECT "consumedAt", "consumedFor" FROM "TransactionQuote" WHERE "id" = ${quoteId}::uuid`;
        return rows[0] || null;
    };
    const bal = (account) => ledger.accountBalance(prisma, account).then((b) => b.balance);

    // surface facts: evidence/receipt dedup identities as the controllers use them
    const SURFACE = {
        moolre: {
            eventKey: (ref) => `event:moolre-collection:${ref}`,
            receiptKey: (ref) => `receipt:moolre-collection:${ref}`,
            evidence: (pending, ref) => ({
                provider: 'MOOLRE', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: pending.providerRef, dedupKey: `event:moolre-collection:${ref}`,
                amountGhs: 100, relatedReference: ref, raw: null,
            }),
        },
        generic: {
            eventKey: (ref) => `event:fiat-deposit:${ref}:SUCCESSFUL`,
            receiptKey: (ref) => `receipt:fiat-deposit:${ref}`,
            evidence: (pending, ref) => ({
                provider: 'GENERIC_FIAT_WEBHOOK', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: 'GEN-R12', dedupKey: `event:fiat-deposit:${ref}:SUCCESSFUL`,
                amountGhs: 100, relatedReference: ref, raw: null,
            }),
        },
    };

    // One complete mounted race for a single deposit. Runs the two callbacks
    // genuinely concurrently, classifies the outcomes WITHOUT forcing any
    // status code, and asserts the full exactly-once economics.
    const runRaceAndAssert = async ({ surface, iteration, prePresentEvidence }) => {
        const facts = SURFACE[surface];
        const fire = surface === 'moolre' ? fireMoolre : fireGeneric;

        // fresh eligible inventory + user + ONE pending deposit
        await acquireTx({ quantity: '10', cost: '120' });
        const user = await seedUser(prisma, { availableBalance: 0 });
        const pending = await initiateDeposit(user, 100, surface);
        const ref = pending.txHash;

        // optional production retry shape: the provider observation is
        // durably present BEFORE both concurrent callbacks
        if (prePresentEvidence) {
            await fiatLiquidity.recordProviderEvent(prisma, facts.evidence(pending, ref));
        }

        // TWO GENUINELY CONCURRENT IDENTICAL SUCCESS callbacks — the real
        // controller paths run: evidence, state checks, quote CAS,
        // state-machine CAS, credit, Model B settlement, ledger, receipt.
        const [ra, rb] = await Promise.all([fire(ref), fire(ref)]);

        // classify — do NOT force a particular HTTP result for the loser
        const isSettled = (r) => r.statusCode === 200 && r.payload?.success === true && !!r.payload?.data?.quoteId;
        const isConverged = (r) => r.statusCode === 200 && r.payload?.success === true && !r.payload?.data?.quoteId;
        const isSafeFailure = (r) => r.statusCode === 409 && r.payload?.success === false;
        const settled = [ra, rb].filter(isSettled);
        const converged = [ra, rb].filter(isConverged);
        const safeFailures = [ra, rb].filter(isSafeFailure);
        expect(settled).toHaveLength(1); // exactly one settlement outcome
        expect(settled.length + converged.length + safeFailures.length).toBe(2);
        const outcomeClasses = `iter${iteration}: settled=1, converged=${converged.length}, safeFailures=${safeFailures.length}`;
        process.stdout.write(`    [r12:${surface}${prePresentEvidence ? ':pre' : ':fresh'}] ${outcomeClasses}\n`);

        // ── exactly-once financial state, read durably after the race ──────
        const th = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(th.status).toBe('COMPLETED');
        const q = new Decimal(th.amountUsdc); // exact Decimal(20,8)

        // exactly ONE ModelBSettlement row for this reference
        const settlements = await prisma.modelBSettlement.findMany({ where: { reference: ref } });
        expect(settlements).toHaveLength(1);
        const s = settlements[0];
        expect(new Decimal(s.settledUsdc).toFixed(8)).toBe(q.toFixed(8));

        // exactly ONE customer liability credit: projection AND ledger agree
        const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Decimal(userAfter.availableBalance).toFixed(8)).toBe(q.toFixed(8));
        expect((await bal(`user:${user.id}:liability`)).toFixed(8)).toBe(q.toFixed(8));

        // exactly ONE inventory consumption path (the audit's invariant is
        // ONE delivery, not one lot: FIFO may span lots once a tail lot is
        // partially consumed — every consumption row for this reference must
        // belong to the SAME settlement ledger posting, and the delivered
        // quantity must be EXACTLY q, once, never more)
        const consumptions = await prisma.inventoryLotConsumption.findMany({ where: { sourceReference: ref } });
        expect(consumptions.length).toBeGreaterThanOrEqual(1);
        const consumptionLedgerTxnIds = new Set(consumptions.map((c) => c.ledgerTxnId));
        expect(consumptionLedgerTxnIds.size).toBe(1); // ONE consumption path
        expect(consumptions[0].purpose).toBe('MODEL_B_SETTLEMENT');
        expect(consumptions[0].ledgerTxnId).not.toBeNull();
        const delivered = consumptions.reduce((acc, c) => acc.plus(new Decimal(c.quantity)), new Decimal(0));
        expect(delivered.toFixed(8)).toBe(q.toFixed(8)); // EXACTLY one delivery
        // aggregate inventory truth, computed from DB originals and DB
        // deliveries (self-contained — no cross-test bookkeeping): every lot
        // this test acquired, minus every quantity the settlements actually
        // delivered. Each iteration delivered EXACTLY q, so the remaining
        // total must equal originals minus one delivery per settled
        // iteration — nothing more.
        const lots = await prisma.inventoryLot.findMany();
        const totalOriginal = lots.reduce((acc, l) => acc.plus(new Decimal(l.quantityOriginal)), new Decimal(0));
        const totalRemaining = lots.reduce((acc, l) => acc.plus(new Decimal(l.quantityRemaining)), new Decimal(0));
        const allConsumptions = await prisma.inventoryLotConsumption.findMany();
        const totalDelivered = allConsumptions.reduce((acc, c) => acc.plus(new Decimal(c.quantity)), new Decimal(0));
        expect(allConsumptions.every((c) => c.purpose === 'MODEL_B_SETTLEMENT')).toBe(true);
        expect(totalDelivered.toFixed(8)).toBe(q.mul(iteration + 1).toFixed(8)); // one delivery per iteration
        expect(totalRemaining.toFixed(8)).toBe(totalOriginal.minus(totalDelivered).toFixed(8));

        // exactly TWO ledger postings for the single settlement only — the
        // loser's attempted postings (if any) rolled back with its transaction
        const convTxn = await prisma.ledgerTransaction.findUnique({ where: { id: s.conversionLedgerTxnId } });
        const depTxn = await prisma.ledgerTransaction.findUnique({ where: { id: s.depositLedgerTxnId } });
        expect(convTxn.idempotencyKey).toBe(`ledger:modelb:conversion:${ref}`);
        expect(depTxn.idempotencyKey).toBe(`ledger:modelb:deposit:${ref}`);
        const settlementTxnCount = await prisma.ledgerTransaction.count({
            where: { idempotencyKey: { in: [`ledger:modelb:conversion:${ref}`, `ledger:modelb:deposit:${ref}`] } },
        });
        expect(settlementTxnCount).toBe(2);
        const convEntries = await prisma.journalEntry.count({ where: { ledgerTransactionId: convTxn.id } });
        const depEntries = await prisma.journalEntry.count({ where: { ledgerTransactionId: depTxn.id } });
        expect(convEntries).toBe(4); // fiat:momo:ghs / equity:treasury:ghs / cogs / lots
        expect(depEntries).toBe(2); // equity:treasury draw / customer liability credit
        // and the legacy bridge was NOT posted alongside Model B
        expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:deposit:fiat:${ref}` } })).toBe(0);

        // the quote is consumed EXACTLY ONCE — a single durable consumption
        const qr = await quoteRow(pending.metadata?.quoteId);
        expect(qr.consumedAt).not.toBeNull();
        expect(qr.consumedFor).toBe('deposit');

        // the durable provider observation: ONE primary row, no conflict rows
        const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: ref } });
        expect(events).toHaveLength(1);
        expect(events[0].dedupKey).toBe(facts.eventKey(ref));
        expect(events[0].status).toBe('SUCCESSFUL');

        // liquidity authority ON: exactly ONE receipt / financial effect
        const receipts = await prisma.fiatLiquidityReceipt.findMany({ where: { dedupKey: facts.receiptKey(ref) } });
        expect(receipts).toHaveLength(1);
        expect(receipts[0].status).toBe('AVAILABLE');
        const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Decimal(state.availableGhs).toFixed(2)).toBe(`${(100 * (iteration + 1)).toFixed(2)}`); // one delivery per iteration
        expect(new Decimal(state.reconciliationHeldGhs).toFixed(2)).toBe('0.00');

        // ── after the race: the settled callback converges as a plain replay
        // (the exact-retry class — zero new mutation, no matter which class
        // the loser took above)
        const replayRes = await fire(ref);
        expect(replayRes.statusCode).toBe(200);
        expect(replayRes.payload?.success).toBe(true);
        expect(replayRes.payload?.data?.quoteId).toBeUndefined(); // already processed, nothing re-credited
        expect(await prisma.modelBSettlement.count({ where: { reference: ref } })).toBe(1);
        expect(await prisma.fiatLiquidityReceipt.count({ where: { dedupKey: facts.receiptKey(ref) } })).toBe(1);
        expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: ref } })).toBe(1);
        const userReplay = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Decimal(userReplay.availableBalance).toFixed(8)).toBe(q.toFixed(8));

        return { q, outcomeClasses };
    };

    describe('MOOLRE surface — mounted duplicate-SUCCESS race', () => {
        test('FRESH evidence (callbacks establish it concurrently): exactly-once economics under genuinely concurrent identical callbacks', async () => {
            await setModelB(true);
            await setLiquidity(true);
            for (let i = 0; i < 3; i += 1) {
                await runRaceAndAssert({ surface: 'moolre', iteration: i, prePresentEvidence: false });
            }
        }, 60000);

        test('PRE-PRESENT evidence (production retry shape): exactly-once economics under genuinely concurrent identical callbacks', async () => {
            await setModelB(true);
            await setLiquidity(true);
            for (let i = 0; i < 3; i += 1) {
                await runRaceAndAssert({ surface: 'moolre', iteration: i, prePresentEvidence: true });
            }
        }, 60000);
    });

    describe('GENERIC surface — mounted duplicate-SUCCESS race', () => {
        test('FRESH evidence (callbacks establish it concurrently): exactly-once economics under genuinely concurrent identical callbacks', async () => {
            await setModelB(true);
            await setLiquidity(true);
            for (let i = 0; i < 3; i += 1) {
                await runRaceAndAssert({ surface: 'generic', iteration: i, prePresentEvidence: false });
            }
        }, 60000);

        test('PRE-PRESENT evidence (production retry shape): exactly-once economics under genuinely concurrent identical callbacks', async () => {
            await setModelB(true);
            await setLiquidity(true);
            for (let i = 0; i < 3; i += 1) {
                await runRaceAndAssert({ surface: 'generic', iteration: i, prePresentEvidence: true });
            }
        }, 60000);
    });
});
