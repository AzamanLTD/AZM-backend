// __tests__/r21-settlement-binding-gap-proofs.test.js
// =============================================================================
// r21 — OUTBOUND SETTLEMENT BINDING GAP PROOFS (real PostgreSQL)
//
// The r20 batch established the outbound settlement evidence binding (known
// provider identity, durable-owner agreement, exact echoed reference, exact
// durable payout amount) with 10 core scenarios. This suite closes the
// remaining audit K-axis gaps:
//
//   1. CONCURRENT contradictory-but-correctly-bound terminal answers —
//      a provider SUCCESS answer and a provider FAILED answer, BOTH bound to
//      the exact same payout economics, racing two reconciliation workers:
//      exactly ONE canonical terminal outcome, no double refund, no double
//      fee/profit effects, exactly one user-facing settlement emission.
//
//   2. G-PARITY — a WRONG-reference FAILED answer must NEVER refund (r20
//      proved wrong-reference SUCCESS parks; failure evidence gets the same
//      standard, never trusted loosely).
//
//   3. G-PARITY — a WRONG-amount FAILED answer must NEVER refund.
//
//   4. D-RESIDUAL — a terminal poll answer with NO provider
//      self-identification and NO durable owner must fail closed: the
//      normalized 'DISBURSEMENT_POLL' fallback is NOT admissible owner
//      identity and may never settle or reverse customer money.
//
//   5. K9 — a provider NOT_FOUND (authoritative absence) answer never
//      settles and never reverses; the payout parks with durable evidence.
//
//   6. K10 — a NONTERMINAL (PENDING) answer with the exact bound economics
//      moves nothing: no terminal transition, no exception.
// =============================================================================

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r21] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r21 P0: settlement binding gap proofs (real PostgreSQL)', () => {
    let prisma;
    let MoolreDisbursementService;
    let axiosSpy;
    let adapter;
    let WithdrawalReconciliationWorker;

    beforeAll(() => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_BASE_URL = 'https://moolre.test.local';
        process.env.MOOLRE_ACCOUNT_NUMBER = '100000100002';
        process.env.MOOLRE_WEBHOOK_SECRET = 'r21-gap-secret';
        MoolreDisbursementService = require('../services/moolreDisbursementService');
        adapter = new MoolreDisbursementService({});
        expect(adapter.providerMode).toBe('LIVE');
        axiosSpy = jest.spyOn(axios, 'post');
        WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
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

    /** Seed a parked payout with durable creation-time economics (metadata.payoutGhs). */
    async function seedPayout(reference) {
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
        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: AMOUNT,
                feeUsdc: FEE,
                status: 'PENDING',
                txHash: reference,
                metadata: {
                    provider: 'MOOLRE',
                    outcome: 'UNKNOWN_OUTCOME',
                    payoutGhs: PAYOUT_GHS,
                    economicsDeferred: true,
                    dispatchedAt: new Date().toISOString(),
                },
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

    /** A Moolre application-error envelope that authoritatively answers absence. */
    const moolreNotFoundAnswer = (reference) => ({
        data: {
            status: 0,
            code: 'SS09',
            message: `No matching transaction found for externalref ${reference}`,
            data: null,
        },
    });

    const makeIo = () => {
        const emitted = [];
        return {
            emitted,
            to: jest.fn(() => ({
                emit: jest.fn((event, payload) => emitted.push({ scope: 'user', event, payload }))
            })),
            emit: jest.fn((event, payload) => emitted.push({ scope: 'global', event, payload }))
        };
    };

    test('CONCURRENCY: contradictory-but-correctly-bound SUCCESS vs FAILED answers produce EXACTLY ONE canonical terminal outcome — no double refund, no double economics, one emission', async () => {
        const reference = 'R21-RACE-SUCCESS-VS-FAIL';
        const { user, withdrawal } = await seedPayout(reference);

        // Two workers observe the same payout through the same rail at the
        // same instant: one answer is a bound SUCCESS, the other a bound
        // FAILED — both economically exact for THIS payout. The canonical
        // CAS must let exactly one win; the loser becomes a no-op.
        const successAdapter = {
            getTransferStatus: jest.fn().mockResolvedValue({
                status: 'SUCCESSFUL',
                provider: 'MOOLRE_DISBURSEMENT',
                providerRef: 'MOOLRE-R21-S',
                externalId: reference,
                amountGhs: PAYOUT_GHS,
            }),
        };
        const failAdapter = {
            getTransferStatus: jest.fn().mockResolvedValue({
                status: 'FAILED',
                provider: 'MOOLRE_DISBURSEMENT',
                providerRef: 'MOOLRE-R21-F',
                externalId: reference,
                amountGhs: PAYOUT_GHS,
                reason: 'RECIPIENT_LIMIT',
            }),
        };
        const ioA = makeIo();
        const ioB = makeIo();
        const a = new WithdrawalReconciliationWorker(prisma, ioA, successAdapter);
        const b = new WithdrawalReconciliationWorker(prisma, ioB, failAdapter);

        await Promise.all([a._reconcileOne(await loadWithdrawal(withdrawal.id)), b._reconcileOne(await loadWithdrawal(withdrawal.id))]);
        await new Promise((resolve) => setImmediate(resolve));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id }, select: { status: true } });

        // exactly ONE terminal outcome — the canonical row and its mirror agree
        expect(['COMPLETED', 'FAILED']).toContain(txAfter.status);
        expect(wAfter.status).toBe(txAfter.status);

        // the balance reflects the ONE outcome exactly once — no double refund
        // (FAILED: full refund to START) and no completion double-charge
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        if (txAfter.status === 'COMPLETED') {
            expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        } else {
            expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE, 6);
        }

        // exactly ONE user-facing settlement emission across both workers
        const settlements = [ioA, ioB].flatMap((io) => io.emitted)
            .filter((e) => e.scope === 'user' && e.event === 'withdrawal_settled');
        expect(settlements).toHaveLength(1);
        expect(settlements[0].payload.status).toBe(txAfter.status); // canonical status, not the provider term

        // no reconciliation exception — neither answer was contradictory evidence
        const reasons = await exceptionReasons(reference);
        expect(reasons.filter(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED')).toHaveLength(0);
    });

    test('G-PARITY: a FAILED answer echoing a DIFFERENT business reference NEVER refunds — parked (REFERENCE_MISMATCH)', async () => {
        const reference = 'R21-FAILED-WRONG-ECHO';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ txstatus: 2, externalref: 'SOMEONE-ELSES-REF', amount: '671.00' }));

        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING'); // never reversed on unbound failure evidence
        // a WRONG failure must never refund the user
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('REFERENCE_MISMATCH');
        expect(rejected.details.observedStatus).toBe('FAILED');
    });

    test('G-PARITY: a FAILED answer with the WRONG amount NEVER refunds — parked (AMOUNT_MISMATCH)', async () => {
        const reference = 'R21-FAILED-WRONG-AMOUNT';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ txstatus: 2, externalref: reference, amount: '999.00' }));

        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('AMOUNT_MISMATCH');
        expect(Number(rejected.details.bindingDetails.observedPesewa)).toBe(99900);
    });

    test('D-RESIDUAL: a terminal answer with NO provider self-identification and NO durable owner fails closed — DISBURSEMENT_POLL is not admissible identity', async () => {
        const reference = 'R21-UNIDENTIFIED-PROVIDER';
        const { user, withdrawal } = await seedPayout(reference);

        // No metadata.payoutProvider was seeded → no durable owner; the
        // answer names no provider → the worker's evidenceProvider falls
        // back to 'DISBURSEMENT_POLL', which the binding must refuse.
        const anonymousAdapter = {
            getTransferStatus: jest.fn().mockResolvedValue({
                status: 'SUCCESSFUL',
                providerRef: 'ANON-1',
                // deliberately NO provider field
                externalId: reference,
                amountGhs: PAYOUT_GHS,
            }),
        };
        const worker = new WithdrawalReconciliationWorker(prisma, null, anonymousAdapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING'); // a fallback identity may never settle
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const reasons = await exceptionReasons(reference);
        const rejected = reasons.find(r => r.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(rejected).toBeDefined();
        expect(rejected.details.bindingReason).toBe('PROVIDER_NOT_IDENTIFIED');
        expect(rejected.details.provider).toBe('DISBURSEMENT_POLL');
    });

    test('K9: an authoritative NOT_FOUND answer never settles and never reverses — parked with durable absence evidence', async () => {
        const reference = 'R21-NOT-FOUND';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreNotFoundAnswer(reference));

        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING'); // absence is not a settlement attempt
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id }, select: { status: true } });
        expect(wAfter.status).toBe('PENDING');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const reasons = await exceptionReasons(reference);
        const absence = reasons.find(r => r.reason === 'PROVIDER_REFERENCE_NOT_FOUND');
        expect(absence).toBeDefined();
        expect(absence.details.provider).toBe('MOOLRE_DISBURSEMENT');
        // no settlement-evidence rejection: the absence answer was coherent,
        // it simply contradicts the dispatch acceptance — an operator item.
    });

    test('K10: a NONTERMINAL PENDING answer with the exact bound economics moves nothing — no transition, no exception', async () => {
        const reference = 'R21-PENDING-ANSWER';
        const { user, withdrawal } = await seedPayout(reference);

        axiosSpy.mockResolvedValueOnce(moolreStatusAnswer({ txstatus: 0, externalref: reference, amount: '671.00' }));

        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);
        await worker._reconcileOne(await loadWithdrawal(withdrawal.id));

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
        const balance = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(balance.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const reasons = await exceptionReasons(reference);
        expect(reasons).toHaveLength(0); // a coherent nonterminal answer is normal life, not an exception
        // the observation IS durably retained as evidence (P5-D), even though
        // it is not terminal.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { relatedReference: reference, status: 'PENDING' },
        });
        expect(evidence).not.toBeNull();
        expect(evidence.provider).toBe('MOOLRE_DISBURSEMENT');
    });
});
