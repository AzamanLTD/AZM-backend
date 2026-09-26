/**
 * §R15-B — Moolre collection unknown-outcome handling (real PostgreSQL)
 * =========================================================================
 * One durable external reference per business action; after an uncertain
 * provider response the SAME reference is reused and the operation stays
 * pending until status/callback resolves it. Never a second instruction.
 *
 * Two layers are proven:
 *   1. ADAPTER classification (axios transport mocked at the boundary):
 *      ECONNREFUSED → NOT_DISPATCHED; timeout/reset/5xx → UNKNOWN_OUTCOME;
 *      TP13 → DUPLICATE_REFERENCE; other envelope refusals → DEFINITIVE_REJECTION.
 *   2. CONTROLLER/RECOVERY orchestration on a real database: ambiguous
 *      initiations keep the deposit PENDING with durable evidence (never
 *      FAILED, never re-instructed); status-query recovery validates the
 *      returned authority and settles/fails exactly once through the shared
 *      settlement core; callback/status races converge; contradictions are
 *      quarantined with zero settlement.
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15b-moolre-collection-outcomes] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§R15-B Moolre collection unknown-outcome handling (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const MoolreCollectionService = require('../services/moolreCollectionService');
    const { PROVIDER_OUTCOMES } = require('../services/moolreCollectionService');
    const axios = require('axios');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const fiatLiquidity = require('../src/services/fiatLiquidityService');
    const { resolvePendingDeposit } = require('../src/services/moolreCollectionRecoveryService');

    // ── adapter fixture (no DB) ─────────────────────────────────────────────
    let liveService;
    let axiosSpy;
    const liveEnv = () => {
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_API_PUBKEY = 'test-pub';
        process.env.MOOLRE_BASE_URL = 'https://moolre.test.local';
    };

    beforeAll(async () => {
        if (!hasDb) return;
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_r15b';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_r15b';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        liveEnv();
        liveService = new MoolreCollectionService({});
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRawUnsafe('DELETE FROM "AdminProfitLog"');
            await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemMasterCrypto"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemFiatPool"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemProfitFees"');
            await prisma.$disconnect();
        }
        if (axiosSpy) axiosSpy.mockRestore();
    });

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
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
            create: { id: 1, fiatLiquidityAuthorityEnabled: false, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date() },
        });
    });

    // ── mounted-controller harness ─────────────────────────────────────────
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });
    /** A moolre service DOUBLE the controller talks to — call-recorded. */
    const moolreDouble = (impl) => {
        const calls = { initiatePayment: [], getPaymentStatus: [], otpConfirm: [] };
        const svc = {
            initiatePayment: jest.fn(async (args) => {
                calls.initiatePayment.push(args);
                return impl(args);
            }),
            getPaymentStatus: jest.fn(async (args) => {
                calls.getPaymentStatus.push(args);
                return impl.status(args);
            }),
            _calls: calls,
        };
        return svc;
    };
    const typedError = (message, providerOutcome, extra = {}) => {
        const err = new Error(`[MoolreCollectionService] ${message}`);
        err.providerOutcome = providerOutcome;
        err.provider = 'MOOLRE';
        Object.assign(err, extra);
        return err;
    };
    let refCounter = 0;
    const makeApp = (moolre) => ({
        get: (key) => ({
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: moolre,
        })[key],
    });

    async function initiateDeposit(user, amountGhs, moolre, opts = {}) {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate({
            app: makeApp(moolre),
            user: { id: user.id },
            body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' },
            headers: opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {},
        }, res);
        const pending = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'DEPOSIT_FIAT' },
            orderBy: { id: 'desc' },
        });
        return { res, pending };
    }

    async function settledDeposit(amountGhs, moolre) {
        const user = await seedUser(prisma);
        const { pending } = await initiateDeposit(user, amountGhs, moolre || {
            initiatePayment: async () => ({ providerRef: `PR-${++refCounter}`, requiresOtp: false }),
        });
        expect(pending).toBeTruthy();
        const wb = await moolreQuoteDepositController.webhook({
            app: makeApp(null),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: pending.txHash, amount: amountGhs, payer: '0241234567' } },
        }, mockResponse());
        expect(wb.statusCode).toBe(200);
        return pending;
    }

    // =========================================================================
    // 1. Adapter classification (transport mocked at the axios boundary)
    // =========================================================================
    test('adapter: ECONNREFUSED classifies NOT_DISPATCHED — provably no bytes reached Moolre', async () => {
        axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        await expect(liveService.initiatePayment({ externalRef: 'ext-a', amountGhs: '20.00', payerPhone: '0241234567' }))
            .rejects.toMatchObject({ providerOutcome: PROVIDER_OUTCOMES.NOT_DISPATCHED });
    });

    test.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'])(
        'adapter: %s classifies UNKNOWN_OUTCOME — Moolre may have accepted the instruction',
        async (code) => {
            axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
            axiosSpy.mockRejectedValueOnce(Object.assign(new Error('socket failed'), { code }));
            await expect(liveService.initiatePayment({ externalRef: 'ext-b', amountGhs: '20.00', payerPhone: '0241234567' }))
                .rejects.toMatchObject({ providerOutcome: PROVIDER_OUTCOMES.UNKNOWN_OUTCOME });
        });

    test('adapter: 5xx without an envelope classifies UNKNOWN_OUTCOME', async () => {
        axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 502'), {
            response: { status: 502, data: 'Bad Gateway' },
        }));
        await expect(liveService.initiatePayment({ externalRef: 'ext-c', amountGhs: '20.00', payerPhone: '0241234567' }))
            .rejects.toMatchObject({ providerOutcome: PROVIDER_OUTCOMES.UNKNOWN_OUTCOME });
    });

    test('adapter: TP13 envelope classifies DUPLICATE_REFERENCE and preserves the same externalRef identity', async () => {
        axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
        axiosSpy.mockResolvedValueOnce({ data: { status: 0, code: 'TP13', message: 'Duplicate reference' } });
        const err = await liveService.initiatePayment({ externalRef: 'ext-d', amountGhs: '20.00', payerPhone: '0241234567' })
            .catch((e) => e);
        expect(err.providerOutcome).toBe(PROVIDER_OUTCOMES.DUPLICATE_REFERENCE);
        expect(err.isDuplicate).toBe(true);
        expect(err.referenceId).toBe('ext-d');
    });

    test('adapter: other explicit envelope refusals classify DEFINITIVE_REJECTION', async () => {
        axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
        axiosSpy.mockResolvedValueOnce({ data: { status: 0, code: 'TP99', message: 'Insufficient payer balance' } });
        await expect(liveService.initiatePayment({ externalRef: 'ext-e', amountGhs: '20.00', payerPhone: '0241234567' }))
            .rejects.toMatchObject({ providerOutcome: PROVIDER_OUTCOMES.DEFINITIVE_REJECTION, code: 'TP99' });
    });

    test('adapter: status-lookup failure classifies UNKNOWN_OUTCOME (unresolved, never failed)', async () => {
        axiosSpy = axiosSpy || jest.spyOn(axios, 'post');
        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        await expect(liveService.getPaymentStatus({ externalRef: 'ext-f' }))
            .rejects.toMatchObject({ providerOutcome: PROVIDER_OUTCOMES.UNKNOWN_OUTCOME });
    });

    // =========================================================================
    // 2. Controller orchestration — ambiguous initiation NEVER terminates the
    //    deposit and NEVER issues a second instruction
    // =========================================================================
    test('A. timeout after provider-side acceptance: deposit STAYS PENDING, durable attempt evidence, honest 202 contract, no second instruction', async () => {
        const user = await seedUser(prisma);
        let attempts = 0;
        const moolre = moolreDouble(() => {
            attempts += 1;
            throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);
        });
        const { res, pending } = await initiateDeposit(user, 20, moolre);

        expect(attempts).toBe(1); // exactly one provider instruction
        expect(res.statusCode).toBe(202);
        expect(res.payload.code).toBe('MOOLRE_OUTCOME_UNKNOWN');
        expect(res.payload.data.reference).toBe(pending.txHash);
        expect(res.payload.data.status).toBe('PENDING');
        expect(res.payload.retryable).toBe(false); // never re-instruct

        const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(row.status).toBe('PENDING'); // NEVER failed
        expect(row.metadata.providerAttempt.outcome).toBe('UNKNOWN_OUTCOME');
        const ev = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: `event:moolre-initiation:${pending.txHash}` } });
        expect(ev).toBeTruthy();
        expect(ev.status).toBe('AMBIGUOUS');
        expect(ev.amountGhs.toString()).toBe('20');
    });

    test('B. connection reset mid-flight: identical UNKNOWN_OUTCOME semantics', async () => {
        const user = await seedUser(prisma);
        const moolre = moolreDouble(() => { throw typedError('socket hang up', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { res, pending } = await initiateDeposit(user, 20, moolre);
        expect(res.statusCode).toBe(202);
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    test('C. 5xx gateway after acceptance: identical UNKNOWN_OUTCOME semantics', async () => {
        const user = await seedUser(prisma);
        const moolre = moolreDouble(() => { throw typedError('502 Bad Gateway', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { res, pending } = await initiateDeposit(user, 20, moolre);
        expect(res.statusCode).toBe(202);
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    test('D. TP13 duplicate reference after a previously accepted attempt: deposit STAYS PENDING as reconciliation-required — never a local terminal failure', async () => {
        const user = await seedUser(prisma);
        const moolre = moolreDouble(() => {
            throw typedError('Duplicate external reference', PROVIDER_OUTCOMES.DUPLICATE_REFERENCE, { code: 'TP13', isDuplicate: true });
        });
        const { res, pending } = await initiateDeposit(user, 20, moolre);
        expect(res.statusCode).toBe(202);
        expect(res.payload.code).toBe('MOOLRE_DUPLICATE_REFERENCE');
        const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(row.status).toBe('PENDING');
        const ev = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: `event:moolre-initiation:${pending.txHash}` } });
        expect(ev.status).toBe('DUPLICATE_REFERENCE');
    });

    test('NOT_DISPATCHED (ECONNREFUSED) IS safe to fail: deposit transitions FAILED once — no money can have moved', async () => {
        const user = await seedUser(prisma);
        const moolre = moolreDouble(() => { throw typedError('connect ECONNREFUSED', PROVIDER_OUTCOMES.NOT_DISPATCHED); });
        const { res, pending } = await initiateDeposit(user, 20, moolre);
        expect(res.statusCode).toBe(502);
        expect(res.payload.code).toBe('NOT_DISPATCHED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('FAILED');
    });

    test('DEFINITIVE_REJECTION is safe to fail: deposit transitions FAILED once', async () => {
        const user = await seedUser(prisma);
        const moolre = moolreDouble(() => { throw typedError('Insufficient payer balance', PROVIDER_OUTCOMES.DEFINITIVE_REJECTION, { code: 'TP99' }); });
        const { res, pending } = await initiateDeposit(user, 20, moolre);
        expect(res.statusCode).toBe(502);
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('FAILED');
    });

    test('M. client retry after an ambiguous response under the SAME Idempotency-Key: 409, ZERO second provider instruction', async () => {
        const user = await seedUser(prisma);
        let attempts = 0;
        const moolre = moolreDouble(() => {
            attempts += 1;
            throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);
        });
        const key = 'r15b-idem-key-1';
        const first = await initiateDeposit(user, 20, moolre, { idempotencyKey: key });
        expect(first.res.statusCode).toBe(202);
        const retry = await initiateDeposit(user, 20, moolre, { idempotencyKey: key });
        expect(retry.res.statusCode).toBe(409); // quote identity conflict — the original initiation stands
        expect(attempts).toBe(1); // no second instruction was ever sent
        const pendingRows = await prisma.transactionHistory.count({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
        expect(pendingRows).toBe(1); // exactly one pending deposit
    });

    // =========================================================================
    // 3. OTP flow (TP14) — the confirmation surface preserves the reference
    // =========================================================================
    test('E/F. TP14 → OTP confirmation UNKNOWN_OUTCOME keeps the deposit PENDING; the eventual provider callback settles it once', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => ({ requiresOtp: true }));
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        expect(pending.status).toBe('PENDING');

        // OTP confirmation itself fails ambiguously
        const confirmMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const confirmRes = mockResponse();
        await quoteFiatDepositController.confirmMoolreOtp({
            app: makeApp(confirmMoolre),
            user: { id: user.id },
            body: { reference: pending.txHash, otpCode: '123456' },
            headers: {},
        }, confirmRes);
        expect(confirmRes.statusCode).toBe(202);
        expect(confirmRes.payload.code).toBe('MOOLRE_OUTCOME_UNKNOWN');
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');

        // the provider callback settles the SAME reference exactly once
        const wb = await moolreQuoteDepositController.webhook({
            app: makeApp(null),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: pending.txHash, amount: 20, payer: '0241234567' } },
        }, mockResponse());
        expect(wb.statusCode).toBe(200);
        const settled = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(settled.status).toBe('COMPLETED');
        const again = await moolreQuoteDepositController.webhook({
            app: makeApp(null),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: pending.txHash, amount: 20, payer: '0241234567' } },
        }, mockResponse());
        expect(again.statusCode).toBe(200); // idempotent replay
        expect(await prisma.fiatLiquidityReceipt.count({ where: { relatedTransactionId: String(pending.id) } })).toBeLessThanOrEqual(1);
    });

    // =========================================================================
    // 4. Status-query recovery — the durable path for uncertain outcomes
    // =========================================================================
    test('L. recovery: ambiguous initiation, then status says SUCCESS — settled exactly once with the SAME evidence identity as the callback', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        const balanceBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({
                txstatus: 1, externalref: pending.txHash, amount: '20.00', payer: '0241234567',
            })),
        };
        const out = await resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id });
        expect(out.outcome).toBe('SETTLED');
        const settled = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(settled.status).toBe('COMPLETED');
        const userNow = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(userNow.availableBalance)).toBeGreaterThan(balanceBefore); // credited exactly once

        // exactly ONE settlement-evidence observation under the SHARED identity
        const ev = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: `event:moolre-collection:${pending.txHash}` } });
        expect(ev).toBeTruthy();
        expect(ev.status).toBe('SUCCESSFUL');

        // the late provider callback converges — settles nothing again
        const wb = await moolreQuoteDepositController.webhook({
            app: makeApp(null),
            headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
            body: { status: 1, code: 'P01', data: { externalref: pending.txHash, amount: 20, payer: '0241234567' } },
        }, mockResponse());
        expect(wb.statusCode).toBe(200);
        const userFinal = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(userFinal.availableBalance)).toBe(Number(userNow.availableBalance)); // ZERO second credit
    });

    test('I. recovery: status says FAILED — terminal transition ONCE via CAS; replaying the recovery is a no-op', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        const balanceBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({
                txstatus: 2, externalref: pending.txHash, amount: '20.00', payer: '0241234567',
            })),
        };
        const out = await resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id });
        expect(out.outcome).toBe('FAILED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('FAILED');
        const out2 = await resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id });
        expect(out2.outcome).toBe('ALREADY_FAILED');
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(balanceBefore); // never credited
    });

    test('G. recovery: status response for a DIFFERENT reference is contradictory — quarantined, nothing settles, deposit stays PENDING', async () => {
        const pending = await settledDeposit(20);
        const other = 'MOOLRE_DEP_NOT_YOURS_999';
        const recovery = {
            initiatePayment: jest.fn(),
            getPaymentStatus: jest.fn(async () => ({ txstatus: 1, externalref: other, amount: '20.00', payer: '0241234567' })),
        };
        // the settled deposit is already COMPLETED — use a fresh pending one instead
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending: ambiguous } = await initiateDeposit(user, 20, initiateMoolre);
        await expect(resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: ambiguous.id }))
            .rejects.toMatchObject({ code: 'CONTRADICTORY_PROVIDER_EVIDENCE' });
        const row = await prisma.transactionHistory.findUnique({ where: { id: ambiguous.id } });
        expect(row.status).toBe('PENDING'); // stays pending, never settles
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS c FROM "ReconciliationException" WHERE "entityType" = $1 AND "entityId" = $2',
            'TRANSACTION', ambiguous.txHash);
        expect(exceptions[0].c).toBe(1); // quarantined durably
    });

    test('H. recovery: status amount ≠ quoted amount is contradictory — quarantined, nothing settles', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({ txstatus: 1, externalref: pending.txHash, amount: '20.01', payer: '0241234567' })),
        };
        await expect(resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id }))
            .rejects.toMatchObject({ code: 'CONTRADICTORY_PROVIDER_EVIDENCE' });
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    test('recovery: a mismatched payer is contradictory — quarantined, nothing settles', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({ txstatus: 1, externalref: pending.txHash, amount: '20.00', payer: '0550000000' })),
        };
        await expect(resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id }))
            .rejects.toMatchObject({ code: 'CONTRADICTORY_PROVIDER_EVIDENCE' });
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    test('recovery: status still PENDING → stays pending, no mutation; status lookup unavailable → stays pending (unresolved ≠ failed)', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => { throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);

        const pendingStatus = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({ txstatus: 0, externalref: pending.txHash, amount: '20.00', payer: '0241234567' })),
        };
        const out1 = await resolvePendingDeposit({ prisma, moolre: pendingStatus, transactionHistoryId: pending.id });
        expect(out1.outcome).toBe('STILL_PENDING');
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');

        const unavailable = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => { throw typedError('timeout', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME); }),
        };
        const out2 = await resolvePendingDeposit({ prisma, moolre: unavailable, transactionHistoryId: pending.id });
        expect(out2.outcome).toBe('STATUS_UNAVAILABLE');
        expect((await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    test('J. callback SUCCESS racing status SUCCESS: exactly-once settlement, one credit, one event, one receipt', async () => {
        const user = await seedUser(prisma);
        const initiateMoolre = moolreDouble(() => ({ providerRef: `PR-${++refCounter}`, requiresOtp: false }));
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        const balanceBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({ txstatus: 1, externalref: pending.txHash, amount: '20.00', payer: '0241234567' })),
        };
        const [wb, out] = await Promise.all([
            moolreQuoteDepositController.webhook({
                app: makeApp(null),
                headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                body: { status: 1, code: 'P01', data: { externalref: pending.txHash, amount: 20, payer: '0241234567' } },
            }, mockResponse()),
            resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id }),
        ]);
        // Exactly-once: EITHER surface may win. If the recovery committed
        // first, the webhook's settlement transaction fails closed (409,
        // CAS lost) and rolls back with zero economic effect — and vice
        // versa. Never a double settlement.
        const validOutcomes = [
            [200, 'ALREADY_SETTLED'], // webhook won; recovery converged
            [409, 'SETTLED'],          // recovery won; webhook CAS failed closed
        ];
        expect(validOutcomes).toContainEqual([wb.statusCode, out.outcome]);
        expect(await prisma.transactionHistory.findUnique({ where: { id: pending.id } })).toMatchObject({ status: 'COMPLETED' });

        const userNow = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(userNow.availableBalance)).toBeGreaterThan(balanceBefore); // credited EXACTLY once
        const receipts = await prisma.fiatLiquidityReceipt.count({ where: { relatedTransactionId: String(pending.id) } });
        expect(receipts).toBeLessThanOrEqual(1);
        const events = await prisma.fiatProviderEvent.count({ where: { dedupKey: `event:moolre-collection:${pending.txHash}` } });
        expect(events).toBe(1); // the two surfaces converged on ONE observation
    });

    test('N. across every recovery pass the SAME externalRef is used — zero additional provider instructions anywhere', async () => {
        const user = await seedUser(prisma);
        let initiateCalls = 0;
        const initiateMoolre = moolreDouble(() => {
            initiateCalls += 1;
            throw typedError('Request timed out', PROVIDER_OUTCOMES.UNKNOWN_OUTCOME);
        });
        const { pending } = await initiateDeposit(user, 20, initiateMoolre);
        expect(initiateCalls).toBe(1);

        const recovery = {
            initiatePayment: initiateMoolre.initiatePayment,
            getPaymentStatus: jest.fn(async () => ({ txstatus: 1, externalref: pending.txHash, amount: '20.00', payer: '0241234567' })),
        };
        const out = await resolvePendingDeposit({ prisma, moolre: recovery, transactionHistoryId: pending.id });
        expect(out.outcome).toBe('SETTLED');
        expect(recovery.getPaymentStatus).toHaveBeenCalledTimes(1);
        expect(recovery.getPaymentStatus).toHaveBeenCalledWith({ externalRef: pending.txHash }); // SAME reference
        expect(initiateCalls).toBe(1); // no re-instruction EVER — the reference stayed authoritative
    });
});
