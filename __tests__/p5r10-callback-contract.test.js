// __tests__/p5r10-callback-contract.test.js
//
// §P.5-D/E audit r10 — DEPOSIT-CALLBACK CONTRACT, proven on the MOUNTED
// controller paths against real PostgreSQL. Three confirmed defect families,
// each with a regression proof that would fail on the pre-r10 code:
//
//   A. ONE authoritative status interpretation (Finding 1) — the status
//      durably recorded for evidence is exactly the status the lifecycle
//      acts on. Case-variant success representations ('success',
//      'SUCCESSFUL') settle; unsupported representations ('PENDING',
//      whitespace-padded ' SUCCESS ') are retained as evidence but take NO
//      lifecycle action (422 fail-closed, deposit stays PENDING); the
//      omitted/FAILED distinctions stay exactly as before. Pre-r10, a
//      lowercase 'success' was durably recorded as success-labeled evidence
//      and then terminally FAILED the deposit.
//   B. HONEST contradiction flagging (Finding 2) — the API never claims a
//      contradiction "was flagged" unless the ReconciliationException write
//      committed. Injected persistence failure → 500
//      CONTRADICTION_RETAINED_FLAGGING_FAILED with the contradictory
//      observation still durably retained, the committed observation
//      untouched, zero financial mutation, and a retry of the same callback
//      re-attempting the flagging successfully (409 + exception row).
//   C. LOSSLESS GHS boundary (Finding 4) — webhook amounts are parsed through
//      the P5-D exact-decimal authority, never JS Number: accepted pesewa
//      input ('100.30') is never altered on its way to evidence/settlement;
//      sub-pesewa input within half a double-ulp of a pesewa-exact value
//      ('100.3000000000000001') is rejected fail-closed 400 with ZERO
//      mutation — pre-r10 it silently collapsed to 100.30 and settled.
//
//   (Finding 3 — providerRef null-tolerance/enrichment — is proven at the
//   substrate level in p5d-fiat-liquidity-authority.test.js §T.)
//
// Only non-DB boundaries (audit, journal, notifications, logger) and the
// external Moolre provider are stubbed; the reconciliation exception queue
// is wrapped with a passthrough mock whose failure is ARMABLE per test.
// Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));
// Passthrough mock with an armable injected persistence failure: with the
// switch OFF the real service (and its real PostgreSQL upsert) runs, so
// every other behavior in this suite is the real thing.
jest.mock('../services/reconciliationExceptionService', () => {
    const actual = jest.requireActual('../services/reconciliationExceptionService');
    const orig = actual.recordReconciliationException;
    let failArmed = 0;
    const recordReconciliationException = jest.fn((prisma, payload) => {
        if (failArmed > 0) {
            failArmed -= 1;
            return Promise.reject(new Error('injected: reconciliation queue persistence failure'));
        }
        return orig(prisma, payload);
    });
    recordReconciliationException.__armFailure = (n) => { failArmed = n; };
    return { ...actual, recordReconciliationException };
});

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5r10-callback-contract.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-D/E audit r10 — deposit-callback contract (mounted, real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const { recordReconciliationException: flaggedMock } = require('../services/reconciliationExceptionService');
    const { Prisma } = require('@prisma/client');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_r10';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_r10';
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
        flaggedMock.__armFailure(0);
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
    afterEach(async () => {
        flaggedMock.__armFailure(0);
        await TRUNCATE_ALL();
    }, 30000);

    let providerRefCounter = 0;
    function makeApp() {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({ requiresOtp: false, providerRef: `PR-R10-${++providerRefCounter}` })),
            },
        };
        return { get: (key) => registry[key] };
    }
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    async function initiateDeposit(user, amountGhs = 100, controller = 'generic') {
        const res = mockResponse();
        const body = { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' };
        if (controller === 'moolre') {
            await moolreQuoteDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        } else {
            await quoteFiatDepositController.initiate({ app: makeApp(), user: { id: user.id }, body, headers: {} }, res);
        }
        expect(res.statusCode).toBe(201);
                // r14 §S harness integrity: TransactionHistory ids are UUIDs — ordering by
        // them is a lexical coin-flip. Bind to the 201 body's reference instead of
        // guessing the newest PENDING row (two same-user pending deposits made the
        // old findFirst(id desc) return the wrong/same row ~50% of runs).
        expect(res.payload?.data?.reference).toBeTruthy();
        const pending = await prisma.transactionHistory.findUnique({ where: { txHash: res.payload.data.reference } });
        expect(pending).not.toBeNull();
        return pending;
    }

    async function genericWebhook(txHash, { amountGhs = 100, providerTxId = 'GEN-1', status = 'SUCCESS' } = {}) {
        const res = mockResponse();
        const body = { reference: txHash, amountGhs };
        if (providerTxId !== null) body.providerTxId = providerTxId;
        if (status !== undefined) body.status = status;
        await quoteFiatDepositController.webhook({
            app: makeApp(),
            headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
            body,
        }, res);
        return res;
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

    // TransactionQuote / ReconciliationException are overlay-created tables —
    // no Prisma delegate — so their proofs read through raw SQL.
    const exceptionCount = async () => {
        const rows = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS n FROM "ReconciliationException"');
        return rows[0].n;
    };

    const zeroFinancialMutation = async (user) => {
        const bal = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Prisma.Decimal(bal.availableBalance).toFixed(8)).toBe('0.00000000');
        expect(await prisma.modelBSettlement.count()).toBe(0);
        expect(await prisma.journalEntry.count()).toBe(0);
    };

    // =========================================================================
    // A. ONE authoritative status interpretation (Finding 1)
    // =========================================================================
    describe('A. one authoritative status interpretation', () => {
        test('A1: lowercase success representation settles — evidence SUCCESSFUL + deposit COMPLETED (pre-r10: evidence said success, lifecycle FAILED it)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: 'success' });
            expect(res.statusCode).toBe(200);
            expect(res.payload.success).toBe(true);
            const tx = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(tx.status).toBe('COMPLETED'); // the pre-r10 bug: this was FAILED
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe('SUCCESSFUL');
            expect(events[0].amountGhs.toFixed(2)).toBe('100.00');
        });

        test('A2: the SUCCESSFUL success representation settles — same authoritative interpretation on both sides', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: 'SUCCESSFUL' });
            expect(res.statusCode).toBe(200);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('COMPLETED');
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe('SUCCESSFUL'); // converges with the SUCCESS identity — same observation
        });

        test('A3: omitted status still settles — the omitted/supported distinction is unchanged', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: undefined });
            expect(res.statusCode).toBe(200);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('COMPLETED');
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe('SUCCESSFUL');
        });

        test('A4: an unsupported status token (PENDING) is retained as evidence but takes NO lifecycle action — 422, deposit stays PENDING, zero financial mutation (pre-r10: it terminally FAILED the deposit)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: 'PENDING' });
            expect(res.statusCode).toBe(422);
            expect(res.payload.code).toBe('UNSUPPORTED_CALLBACK_STATUS');
            const tx = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(tx.status).toBe('PENDING'); // the pre-r10 bug: this was FAILED
            await zeroFinancialMutation(user);
            const quoteRow = await prisma.$queryRawUnsafe('SELECT "consumedAt" FROM "TransactionQuote" WHERE "id"::text = $1', pending.metadata.quoteId);
            expect(quoteRow[0].consumedAt).toBeNull(); // retryable with a supported representation
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1); // durably retained evidence...
            expect(events[0].status).toBe('PENDING'); // ...under its own status-scoped identity
        });

        test('A5: a whitespace-padded token is NOT silently normalized — unsupported, retained as evidence, no lifecycle action', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: ' SUCCESS ' });
            expect(res.statusCode).toBe(422);
            expect(res.payload.code).toBe('UNSUPPORTED_CALLBACK_STATUS');
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            await zeroFinancialMutation(user);
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe(' SUCCESS '); // the raw token, uppercased — its own identity
        });

        test('A6: a lowercase failure representation FAILS the deposit — case-insensitivity is symmetric on the failure side', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);
            const res = await genericWebhook(pending.txHash, { status: 'failed' });
            expect(res.statusCode).toBe(200);
            expect(res.payload.data.status).toBe('FAILED');
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('FAILED');
            await zeroFinancialMutation(user);
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe('FAILED');
        });
    });

    // =========================================================================
    // B. HONEST contradiction flagging (Finding 2)
    // =========================================================================
    describe('B. the flagging claim is guaranteed honest', () => {
        test('B1 (generic surface): flagging persistence failure is never converted into the flagged 409 — evidence retained, committed row untouched, zero mutation, retry re-attempts the flagging', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100);

            // Commit an observation WITHOUT settling: an amount that misses the
            // quote — evidence records first, the settlement then fails closed,
            // the deposit stays PENDING and retryable.
            const first = await genericWebhook(pending.txHash, { amountGhs: 55 });
            expect(first.statusCode).toBeGreaterThanOrEqual(400);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            const committed = await prisma.fiatProviderEvent.findUnique({
                where: { dedupKey: `event:fiat-deposit:${pending.txHash}:SUCCESSFUL` },
            });
            expect(committed).not.toBeNull();
            expect(committed.amountGhs.toFixed(2)).toBe('55.00');

            // A materially different payload under the committed identity —
            // with the reconciliation-queue write ARMED TO FAIL.
            flaggedMock.__armFailure(1);
            const contradiction = await genericWebhook(pending.txHash, { amountGhs: 66 });
            // 1) NOT the flagged 409 — the honest fail-closed operational answer
            expect(contradiction.statusCode).toBe(500);
            expect(contradiction.payload.code).toBe('CONTRADICTION_RETAINED_FLAGGING_FAILED');
            expect(contradiction.payload.message).not.toMatch(/flagged for reconciliation/);
            // 2) the committed observation is untouched
            const committedAfter = await prisma.fiatProviderEvent.findUnique({ where: { id: committed.id } });
            expect(committedAfter.amountGhs.toFixed(2)).toBe('55.00');
            expect(committedAfter.status).toBe('SUCCESSFUL');
            // 3) the contradictory observation IS durably retained
            const conflicts = await prisma.fiatProviderEvent.findMany({
                where: { relatedReference: pending.txHash },
            });
            expect(conflicts).toHaveLength(2);
            expect(conflicts.map((c) => c.amountGhs.toFixed(2)).sort()).toEqual(['55.00', '66.00']);
            // 4) no financial mutation, no settlement, deposit stays PENDING
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            await zeroFinancialMutation(user);
            // ...and the failed queue write was NOT silently recorded as success
            expect(await exceptionCount()).toBe(0);

            // 5) a retry of the SAME contradictory payload re-attempts the
            // flagging: the conflict row converges (no growth), the exception
            // write succeeds, the honest 409 comes back.
            const retry = await genericWebhook(pending.txHash, { amountGhs: 66 });
            expect(retry.statusCode).toBe(409);
            expect(retry.payload.code).toBe('CONTRADICTORY_PROVIDER_EVIDENCE');
            expect(await exceptionCount()).toBe(1);
            expect((await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } })).length).toBe(2); // converged
            expect((await prisma.fiatProviderEvent.findUnique({ where: { id: committed.id } })).amountGhs.toFixed(2)).toBe('55.00');
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            await zeroFinancialMutation(user);
        });

        test('B2 (moolre surface): same honest contract on the mounted Moolre webhook', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100, 'moolre');

            const first = await moolreWebhook(pending.txHash, 55);
            expect(first.statusCode).toBeGreaterThanOrEqual(400);
            const committed = await prisma.fiatProviderEvent.findUnique({
                where: { dedupKey: `event:moolre-collection:${pending.txHash}` },
            });
            expect(committed).not.toBeNull();
            expect(committed.amountGhs.toFixed(2)).toBe('55.00');

            flaggedMock.__armFailure(1);
            const contradiction = await moolreWebhook(pending.txHash, 66);
            expect(contradiction.statusCode).toBe(500);
            expect(contradiction.payload.code).toBe('CONTRADICTION_RETAINED_FLAGGING_FAILED');
            expect(await exceptionCount()).toBe(0);
            const rows = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(rows).toHaveLength(2);
            expect(rows.map((r) => r.amountGhs.toFixed(2)).sort()).toEqual(['55.00', '66.00']);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            await zeroFinancialMutation(user);

            const retry = await moolreWebhook(pending.txHash, 66);
            expect(retry.statusCode).toBe(409);
            expect(retry.payload.code).toBe('CONTRADICTORY_PROVIDER_EVIDENCE');
            expect(await exceptionCount()).toBe(1);
            expect((await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } })).length).toBe(2);
            expect((await prisma.fiatProviderEvent.findUnique({ where: { id: committed.id } })).amountGhs.toFixed(2)).toBe('55.00');
            await zeroFinancialMutation(user);
        });
    });

    // =========================================================================
    // C. LOSSLESS GHS boundary (Finding 4)
    // =========================================================================
    describe('C. lossless webhook GHS boundary', () => {
        test('C1 (generic): accepted pesewa input is never altered — settles with the EXACT decimal, evidence and metadata carry 100.30', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100.3);
            const res = await genericWebhook(pending.txHash, { amountGhs: '100.30' });
            expect(res.statusCode).toBe(200);
            const tx = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
            expect(tx.status).toBe('COMPLETED');
            expect(tx.metadata.settledAmountGhs).toBe('100.30'); // exact string — never a collapsed float
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: pending.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].amountGhs.toFixed(2)).toBe('100.30');
        });

        test('C2 (generic): sub-pesewa input within half a double-ulp FAILS CLOSED — 400, zero evidence, zero mutation (pre-r10: silently collapsed to 100.30 and settled)', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const pending = await initiateDeposit(user, 100.3);
            // This exact input parses through Number() to the SAME double as
            // 100.3 — the old float boundary accepted and recorded it as a
            // pesewa-exact 100.30. The exact-decimal authority rejects it.
            const res = await genericWebhook(pending.txHash, { amountGhs: '100.3000000000000001' });
            expect(res.statusCode).toBe(400);
            expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: pending.txHash } })).toBe(0);
            expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
            await zeroFinancialMutation(user);
            const quoteRow = await prisma.$queryRawUnsafe('SELECT "consumedAt" FROM "TransactionQuote" WHERE "id"::text = $1', pending.metadata.quoteId);
            expect(quoteRow[0].consumedAt).toBeNull();
        });

        test('C3 (moolre): exact pesewa input settles unaltered; sub-pesewa input fails closed with zero evidence', async () => {
            const user = await seedUser(prisma, { availableBalance: 0 });
            const ok = await initiateDeposit(user, 100.3, 'moolre');
            const res = await moolreWebhook(ok.txHash, '100.30');
            expect(res.statusCode).toBe(200);
            const tx = await prisma.transactionHistory.findUnique({ where: { id: ok.id } });
            expect(tx.status).toBe('COMPLETED');
            expect(tx.metadata.settledAmountGhs).toBe('100.30');
            const events = await prisma.fiatProviderEvent.findMany({ where: { relatedReference: ok.txHash } });
            expect(events).toHaveLength(1);
            expect(events[0].amountGhs.toFixed(2)).toBe('100.30');

            const bad = await initiateDeposit(user, 100.3, 'moolre');
            const rejected = await moolreWebhook(bad.txHash, '100.3000000000000001');
            expect(rejected.statusCode).toBe(400);
            expect(await prisma.fiatProviderEvent.count({ where: { relatedReference: bad.txHash } })).toBe(0);
            expect((await prisma.transactionHistory.findUnique({ where: { id: bad.id } })).status).toBe('PENDING');
        });
    });
});
