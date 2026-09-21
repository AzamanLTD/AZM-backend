// __tests__/r20-outbound-settlement-evidence-binding.test.js
// =============================================================================
// r20 P0 — OUTBOUND SETTLEMENT EVIDENCE BINDING (real PostgreSQL)
//
// THE CONTRACT: a terminal provider answer — whether observed by the
// reconciliation worker's STATUS POLL or delivered by the provider's
// SETTLEMENT CALLBACK — may move customer money ONLY when it is bound to the
// EXACT canonical payout:
//   1. known canonical provider identity (one rail = one identity everywhere)
//   2. durable-owner agreement (a different provider's answer parks)
//   3. the echoed business reference (a different reference parks)
//   4. the exact provider-reported payout amount vs the durable committed
//      economics — reservation amountGhs / creation-time payoutGhs / the
//      durable dispatch observation — NEVER the current rate
//   5. destination: documented residual (no live settlement contract echoes
//      the recipient MSISDN — bound at dispatch time, not re-verifiable at
//      settlement)
//
// Any contradiction parks the payout for operator review: no completion, no
// reversal/refund, no canonical state motion. A genuine legacy row (no
// durable local economics at all) settles on the provider-reported amount,
// durably recorded as the FIRST committed observation.
//
// Poll path: REAL MoolreDisbursementService (LIVE mode, axios mocked at the
// HTTP boundary) inside the REAL WithdrawalReconciliationWorker.
// Callback path: the REAL fiat settlement webhook controller.
// =============================================================================

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r20] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r20 P0: outbound settlement evidence binding (real PostgreSQL)', () => {
    let prisma;
    let MoolreDisbursementService;
    let axiosSpy;
    let adapter;
    let webhook;

    beforeAll(() => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_BASE_URL = 'https://moolre.test.local';
        process.env.MOOLRE_ACCOUNT_NUMBER = '100000100002';
        process.env.MOOLRE_WEBHOOK_SECRET = 'r20-binding-secret';
        MoolreDisbursementService = require('../services/moolreDisbursementService');
        adapter = new MoolreDisbursementService({});
        expect(adapter.providerMode).toBe('LIVE');
        axiosSpy = jest.spyOn(axios, 'post');
        webhook = require('../controllers/fiatSettlementWebhook.controller').moolreDisbursementWebhook;
    });

    afterAll(async () => {
        axiosSpy.mockRestore();
        ['MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY', 'MOOLRE_BASE_URL', 'MOOLRE_ACCOUNT_NUMBER', 'MOOLRE_WEBHOOK_SECRET']
            .forEach(k => delete process.env[k]);
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        axiosSpy.mockClear();
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: 100_000.0 },
            create: { id: 1, balance: 100_000.0 }
        });
        await prisma.systemMasterCrypto.upsert({
            where: { id: 1 },
            update: { balance: 0.0 },
            create: { id: 1, balance: 0.0 }
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false }
        });
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 150));
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Withdrawal", "ReconciliationException", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto", "FiatLiquidityReceipt", "FiatProviderEvent", "ProviderSettlementAttempt", "FiatLiquidityReservation", "FiatLiquidityState" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const START_BALANCE = 1000.0;
    const AMOUNT = 50.0;
    const FEE = 1.0;
    // 50 USDC x 13.42 = 671.00 GHS — the durable creation-time economics.
    const PAYOUT_GHS = 671.00;

    /**
     * Seed a parked ambiguous payout with durable creation-time economics
     * (metadata.payoutGhs) — the binding's amount authority for these tests.
     */
    async function seedPayout(reference, { owner = null } = {}) {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: START_BALANCE });
        await prisma.user.update({
            where: { id: user.id },
            data: { availableBalance: { decrement: AMOUNT + FEE } }
        });
        await prisma.systemMasterCrypto.update({
            where: { id: 1 },
            data: { balance: { increment: AMOUNT } }
        });
        const metadata = {
            provider: 'MOOLRE',
            outcome: 'UNKNOWN_OUTCOME',
            payoutGhs: PAYOUT_GHS,
            economicsDeferred: true,
            dispatchedAt: new Date().toISOString(),
        };
        if (owner) {
            // durable ownership exactly as the dispatch bookkeeping writes it
            metadata.payoutProvider = owner;
            metadata.payoutProviderName = owner === 'mtn' ? 'MTN_MOMO_DISBURSEMENT' : 'MOOLRE_DISBURSEMENT';
            metadata.ownershipRecordedAt = new Date().toISOString();
        }
        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: AMOUNT,
                feeUsdc: FEE,
                status: 'PENDING',
                txHash: reference,
                metadata,
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: AMOUNT,
                destination: '0244556677',
                payoutMethod: 'MOBILE_MONEY',
                status: 'PENDING',
                createdAt: new Date(Date.now() - 60_000),
            }
        });
        await prisma.$executeRawUnsafe(
            'UPDATE "Withdrawal" SET "transactionHistoryId" = $1 WHERE "id" = $2',
            tx.id, withdrawal.id
        );
        return { user, tx, withdrawal };
    }

    const loadWithdrawal = (id) => prisma.withdrawal.findUnique({
        where: { id },
        include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
    });

    const exceptionReasons = async (reference) => {
        const rows = await prisma.$queryRawUnsafe(
            'SELECT "reason", "details" FROM "ReconciliationException" WHERE "reference" = $1 ORDER BY "firstSeenAt"',
            reference
        );
        return rows.map(r => ({
            reason: r.reason,
            details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
        }));
    };

    /** The documented Moolre status envelope, with overridable evidence fields. */
    const moolreStatusAnswer = ({ txstatus = 1, externalref, amount = '671.00' } = {}) => ({
        data: {
            status: 1,
            code: 'SS01',
            message: 'Transaction Successful',
            data: { txstatus, transactionid: '31830999', externalref, ...(amount !== null && amount !== undefined ? { amount } : {}) },
        },
    });

    // ── POLL PATH ────────────────────────────────────────────────────────────
    // The worker observed the provider through the REAL adapter; a terminal
    // answer is bound before any money moves.

    test('POLL: provider SUCCESS with the WRONG amount vs the durable payoutGhs parks the payout — no completion, durable exception', async () => {
        const reference = 'R20-POLL-WRONG-AMOUNT';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ externalref: reference, amount: '999.00' }));

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING'); // never settled on contradictory economics
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id }, select: { status: true } });
        expect(wAfter.status).toBe('PENDING');
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('AMOUNT_MISMATCH');
        expect(Number(rejected.details.bindingDetails.expectedPesewa)).toBe(67100);
        expect(Number(rejected.details.bindingDetails.observedPesewa)).toBe(99900);
        // the user's committed debit is untouched — no refund, no completion
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
    });

    test('POLL: provider SUCCESS echoing a DIFFERENT business reference parks the payout (REFERENCE_MISMATCH)', async () => {
        const reference = 'R20-POLL-WRONG-ECHO';
        const { withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ externalref: 'SOMEONE-ELSES-REF', amount: '671.00' }));

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('REFERENCE_MISMATCH');
    });

    test('POLL: a terminal answer carrying NO amount cannot prove the payout economics — parked (PROVIDER_AMOUNT_MISSING)', async () => {
        const reference = 'R20-POLL-NO-AMOUNT';
        const { withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ externalref: reference, amount: null }));

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('PROVIDER_AMOUNT_MISSING');
    });

    test('POLL: a durable-owner contradiction parks the payout — the WRONG provider\'s SUCCESS answer never settles mtn-owned money', async () => {
        const reference = 'R20-POLL-OWNER-CONTRADICTION';
        // the durable dispatch bookkeeping says MTN accepted this payout
        const { withdrawal } = await seedPayout(reference, { owner: 'mtn' });

        // the moolre rail answers SUCCESS for it anyway — a contradiction
        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ externalref: reference, amount: '671.00' }));

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        // the worker's owner-authority guard fires BEFORE the binding: the
        // answering rail self-identifies and disputes the durable owner.
        const reasons = await exceptionReasons(reference);
        const contradiction = reasons.find(r => r.reason === 'OWNER_SELF_IDENTIFICATION_CONTRADICTION');
        expect(contradiction).toBeDefined();
        expect(contradiction.details.ownerCanonicalName).toBe('MTN_MOMO_DISBURSEMENT');
        expect(contradiction.details.statusSelfIdentified).toBe('MOOLRE_DISBURSEMENT');
    });

    test('POLL: a FAILED answer with the exact bound economics reverses EXACTLY once — the binding never blocks an honest reversal', async () => {
        const reference = 'R20-POLL-BOUND-FAILED';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(
            moolreStatusAnswer({ txstatus: 2, externalref: reference, amount: '671.00' })
        );

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('FAILED');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE, 6);

        // replay: the refund lands EXACTLY once
        axiosSpy.mockResolvedValueOnce(
            moolreStatusAnswer({ txstatus: 2, externalref: reference, amount: '671.00' })
        );
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));
        const finalBalance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(finalBalance.availableBalance)).toBeCloseTo(START_BALANCE, 6);
    });

    // ── CALLBACK PATH ─────────────────────────────────────────────────────────
    // The provider's settlement webhook crosses the same binding before any
    // ledger motion.

    const makeWebhookReq = () => {
        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const sendNotification = jest.fn().mockResolvedValue({});
        return {
            req: {
                headers: { 'x-moolre-webhook-secret': 'r20-binding-secret' },
                app: {
                    get: (key) => ({
                        prisma,
                        socketio: io,
                        notificationService: { sendNotification },
                        emitBalanceUpdate: jest.fn().mockResolvedValue({}),
                    })[key] || null,
                },
            },
            io,
        };
    };

    const runWebhook = async (payload) => {
        const { req, io } = makeWebhookReq();
        req.body = payload;
        let statusCode;
        let body;
        const res = {
            status(code) { statusCode = code; return res; },
            json(payload) { body = payload; return res; },
        };
        await webhook(req, res);
        return { statusCode, body, io };
    };

    const successCallback = ({ externalref, amount } = {}) => ({
        status: 1,
        code: 'SS01',
        message: 'Transaction Successful',
        data: {
            txstatus: 1,
            transactionid: '31839999',
            ...(externalref ? { externalref } : {}),
            ...(amount !== undefined ? { amount } : {}),
        },
    });

    test('CALLBACK: SUCCESS with the WRONG amount vs the durable payoutGhs is rejected 409 — no ledger motion, durable exception', async () => {
        const reference = 'R20-CB-WRONG-AMOUNT';
        const { user } = await seedPayout(reference);

        const { statusCode } = await runWebhook(successCallback({ externalref: reference, amount: '500.00' }));

        expect(statusCode).toBe(409);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('AMOUNT_MISMATCH');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
    });

    test('CALLBACK: SUCCESS with the exact durable amount settles through the canonical finance boundary', async () => {
        const reference = 'R20-CB-EXACT-AMOUNT';
        const { user, withdrawal } = await seedPayout(reference);

        const { statusCode, body } = await runWebhook(successCallback({ externalref: reference, amount: '671.00' }));

        expect(statusCode).toBe(200);
        expect(body.data.status).toBe('COMPLETED');
        // the CANONICAL row is authoritative; the Withdrawal mirror converges
        // on the next reconciliation scan.
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        // the settled balance is the durable economics — not the current rate
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
    });

    test('CALLBACK: a callback contract that carries NO amount settles on the DOCUMENTED residual binding (authenticated identity + exact reference)', async () => {
        const reference = 'R20-CB-RESIDUAL';
        const { withdrawal } = await seedPayout(reference);

        const { statusCode, body } = await runWebhook(successCallback({ externalref: reference, amount: undefined }));

        expect(statusCode).toBe(200);
        expect(body.data.status).toBe('COMPLETED');
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
    });

    test('CALLBACK: a WRONG provider claiming an mtn-owned payout parks it — 409, OWNER_CONTRADICTION, no ledger motion', async () => {
        const reference = 'R20-CB-OWNER-CONTRADICTION';
        const { user } = await seedPayout(reference, { owner: 'mtn' });

        const { statusCode } = await runWebhook(successCallback({ externalref: reference, amount: '671.00' }));

        expect(statusCode).toBe(409);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('OWNER_CONTRADICTION');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
    });

    test('LEGACY: a genuine pre-evidence-era row (no durable local economics) settles on the provider-reported amount as the FIRST committed observation', async () => {
        const reference = 'R20-LEGACY-FIRST-OBSERVATION';
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: START_BALANCE });
        await prisma.user.update({
            where: { id: user.id },
            data: { availableBalance: { decrement: AMOUNT + FEE } }
        });
        // NO payoutGhs, NO reservation, NO dispatch observation — the genuine
        // stranded legacy state. The provider's own answer is the only
        // economics record that will ever exist for this payout.
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: AMOUNT,
                feeUsdc: FEE,
                status: 'PENDING',
                txHash: reference,
                metadata: { provider: 'MOOLRE', outcome: 'UNKNOWN_OUTCOME', economicsDeferred: true, dispatchedAt: new Date().toISOString() },
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: AMOUNT,
                destination: '0244556677',
                payoutMethod: 'MOBILE_MONEY',
                status: 'PENDING',
                createdAt: new Date(Date.now() - 60_000),
            }
        });

        // the callback carries the provider-reported economics
        const { statusCode, body } = await runWebhook(successCallback({ externalref: reference, amount: '671.00' }));

        expect(statusCode).toBe(200);
        expect(body.data.status).toBe('COMPLETED');
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
    });
});
