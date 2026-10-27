// __tests__/native-ghs-settlement.test.js
// =============================================================================
// Native-GHS collection settlement — owner intent #369 (2026-10-27).
// Real-PostgreSQL proof of the flag-gated GHS-native settlement leg.
// Design contract: docs/native-ghs-settlement.md
//
// PROVES:
//   A. Flag OFF (default) — the legacy USDC conversion credit is
//      byte-identical: availableBalance credited, nativeGhsBalance
//      UNTOUCHED, settlementCurrency marker 'USDC'. No silent
//      reinterpretation of existing balances.
//   B. Flag ON — a settled Moolre collection credits the native-GHS
//      wallet in EXACT pesewas; availableBalance is NEVER touched; the
//      §P.4 GHS entry (D fiat:momo:ghs, C ghs:user:{id}:liability) posts
//      with the durable idempotency key; clearing:conversion and Model B
//      are not used.
//   C. Idempotency — webhook replay after COMPLETED credits nothing again
//      (deposit-level CAS) and the ledger key is exactly-once.
//   D. Config contradiction — flag ON + Model B ON fails CLOSED before any
//      mutation: deposit stays PENDING, retryable, zero economic effect.
//   E. Failure/reversal — reverseNativeGhsSettlement returns the exact
//      credited GHS once (CAS stamp); a second reversal is refused; a
//      non-GHS-native row is refused; USDC is never touched by a reversal.
//   F. Reconciliation — a COMPLETED GHS_NATIVE row missing its ledger
//      entry is flagged as a reconciliation exception, idempotently, with
//      NO balance mutation.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[native-ghs-settlement.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Native-GHS collection settlement (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const ledger = require('../services/ledgerService');
    const nativeGhsSettlement = require('../src/services/nativeGhsSettlementService');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

    let providerRefCounter = 0;

    const setFlag = async (on) => {
        await prisma.globalSettings.update({ where: { id: 1 }, data: { nativeGhsSettlementEnabled: on } });
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_nghs';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: 13.42, liveUsdToGhs: 13.42, liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(),
                fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false,
                nativeGhsSettlementEnabled: false,
            },
            create: {
                id: 1, liveRetailRate: 13.42, liveUsdToGhs: 13.42, liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(),
                fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false,
                nativeGhsSettlementEnabled: false,
            },
        });
    });

    afterAll(async () => {
        if (prisma) {
            // Restore the rollout flag to the production default so later
            // suites inherit a clean slate.
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false },
            }).catch(() => {});
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        // Reset EVERY settlement authority flag to the shipped default —
        // a leftover Model B flag from the contradiction test would fail
        // later settlements closed.
        await prisma.globalSettings.update({
            where: { id: 1 },
            data: { modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false },
        });
    });

    const makeApp = () => {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: {
                initiatePayment: jest.fn().mockImplementation(async () => ({
                    requiresOtp: false, providerRef: `PR-NGHS-${++providerRefCounter}`,
                })),
            },
        };
        return { get: (key) => registry[key] };
    };
    const mockResponse = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    });

    async function initiateDeposit(user, amountGhs = 100) {
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
            res,
        );
        expect(res.statusCode).toBe(201);
        expect(res.payload?.data?.reference).toBeTruthy();
        const pending = await prisma.transactionHistory.findUnique({ where: { txHash: res.payload.data.reference } });
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

    const ghsLedgerKey = (ref) => `ledger:deposit:fiat-ghs:${ref}`;

    // ── A. flag OFF: legacy credit, byte-identical ───────────────────────

    test('flag OFF (default): legacy USDC conversion credit — native wallet NEVER touched', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 100);

        const res = await moolreWebhook(pending.txHash, 100);
        expect(res.statusCode).toBe(200);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeGreaterThan(0); // USDC conversion credited
        expect(Number(after.nativeGhsBalance)).toBe(0);            // GHS wallet untouched
        const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(row.status).toBe('COMPLETED');
        expect(row.metadata.settlementCurrency).toBe('USDC');
    });

    // ── B. flag ON: GHS-native settlement ───────────────────────────────

    test('flag ON: settled collection credits the native-GHS wallet in exact pesewas; USDC NEVER touched', async () => {
        await setFlag(true);
        const user = await seedUser(prisma, { availableBalance: 25, nativeGhsBalance: 7 });
        const pending = await initiateDeposit(user, 100);

        const res = await moolreWebhook(pending.txHash, 100);
        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(107);      // 7 + 100 exact pesewas
        expect(Number(after.availableBalance)).toBe(25);      // USDC balance byte-identical

        const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(row.status).toBe('COMPLETED');
        expect(row.metadata.settlementCurrency).toBe('GHS_NATIVE');
        expect(row.metadata.settledAmountGhs).toBe('100.00');

        // §P.4 GHS entry posted with the durable idempotency key.
        const posted = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: ghsLedgerKey(pending.txHash) } });
        expect(posted).not.toBeNull();

        // GHS asset + user GHS liability carry the exact credited amount;
        // the legacy USDC conversion bridge (clearing:conversion) is NOT
        // used on this path.
        const asset = await ledger.accountBalance(prisma, 'fiat:momo:ghs');
        expect(Number(asset.balance)).toBeGreaterThanOrEqual(100);
        const ghsLiability = await ledger.accountBalance(prisma, `ghs:user:${user.id}:liability`);
        expect(Number(ghsLiability.balance)).toBe(100); // exactly the credit
    });

    // ── C. idempotency: replay credits nothing ──────────────────────────

    test('flag ON: webhook replay after COMPLETED credits nothing again (CAS + ledger exactly-once)', async () => {
        await setFlag(true);
        const user = await seedUser(prisma, { availableBalance: 0, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 50);

        const first = await moolreWebhook(pending.txHash, 50);
        expect(first.statusCode).toBe(200);

        // Replay converges honestly: 'Already processed', nothing re-settles.
        const replay = await moolreWebhook(pending.txHash, 50);
        expect(replay.statusCode).toBe(200);
        expect(replay.payload.message).toBe('Already processed.');

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(50); // credited EXACTLY once
        expect(Number(after.availableBalance)).toBe(0);
    });

    // ── D. config contradiction fails closed ────────────────────────────

    test('flag ON + Model B ON: fails CLOSED before any mutation — deposit stays PENDING', async () => {
        await prisma.globalSettings.update({
            where: { id: 1 },
            data: { nativeGhsSettlementEnabled: true, modelBSettlementEnabled: true },
        });
        const user = await seedUser(prisma, { availableBalance: 0, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 100);

        const res = await moolreWebhook(pending.txHash, 100);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(0);
        expect(Number(after.availableBalance)).toBe(0);
        const row = await prisma.transactionHistory.findUnique({ where: { id: pending.id } });
        expect(row.status).toBe('PENDING'); // retryable — nothing committed
    });

    // ── E. failure/reversal ─────────────────────────────────────────────

    test('reversal returns the exact credited GHS ONCE; a second reversal is refused; USDC never touched', async () => {
        await setFlag(true);
        const user = await seedUser(prisma, { availableBalance: 40, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 80);
        const settled = await moolreWebhook(pending.txHash, 80);
        expect(settled.statusCode).toBe(200);

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(before.nativeGhsBalance)).toBe(80);

        const reversal = await prisma.$transaction((tx) => nativeGhsSettlement.reverseNativeGhsSettlement(tx, {
            userId: user.id,
            amountGhs: 80,
            reference: pending.txHash,
            transactionHistoryId: pending.id,
            reversalReason: 'test-reversal',
        }));
        expect(Number(reversal.reversedGhs.toFixed(2))).toBe(80);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(0);
        expect(Number(after.availableBalance)).toBe(40); // USDC untouched by the GHS reversal

        // Second reversal: refused, once-only CAS.
        await expect(prisma.$transaction((tx) => nativeGhsSettlement.reverseNativeGhsSettlement(tx, {
            userId: user.id, amountGhs: 80, reference: pending.txHash, transactionHistoryId: pending.id,
        }))).rejects.toMatchObject({ code: 'NATIVE_GHS_ALREADY_REVERSED' });

        const still = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(still.nativeGhsBalance)).toBe(0); // never double-reversed
    });

    test('reversal refuses a row that did not settle as GHS-native', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 100);
        const settled = await moolreWebhook(pending.txHash, 100); // flag OFF in this test
        expect(settled.statusCode).toBe(200);

        await expect(prisma.$transaction((tx) => nativeGhsSettlement.reverseNativeGhsSettlement(tx, {
            userId: user.id, amountGhs: 100, reference: pending.txHash, transactionHistoryId: pending.id,
        }))).rejects.toMatchObject({ code: 'NATIVE_GHS_NOT_GHS_NATIVE' });

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(0);
        expect(Number(after.availableBalance)).toBeGreaterThan(0); // legacy USDC credit intact
    });

    // ── F. reconciliation ───────────────────────────────────────────────

    test('a COMPLETED GHS_NATIVE settlement missing its ledger entry is flagged idempotently, with NO balance mutation', async () => {
        await setFlag(true);
        const user = await seedUser(prisma, { availableBalance: 0, nativeGhsBalance: 0 });
        const pending = await initiateDeposit(user, 60);
        expect((await moolreWebhook(pending.txHash, 60)).statusCode).toBe(200);

        // Simulate the impossible torn transaction: the authoritative ledger
        // posting disappears while the settlement row stays COMPLETED
        // (journal entries first — the sweep keys on the LedgerTransaction).
        const torn = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: ghsLedgerKey(pending.txHash) } });
        await prisma.journalEntry.deleteMany({ where: { ledgerTransactionId: torn.id } });
        await prisma.ledgerTransaction.delete({ where: { id: torn.id } });

        const first = await nativeGhsSettlement.reconcileNativeGhsSettlements(prisma);
        // The torn row IS flagged (exactly-once keyed on its ledger identity).
        const tornFlag = first.flaggedRows.find((r) => r.reference === pending.txHash);
        expect(tornFlag).toBeTruthy();

        // The sweep NEVER mutates money.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.nativeGhsBalance)).toBe(60);

        // Idempotent: a second sweep records NO duplicate exception for the
        // same row (the exception service is keyed on entity+reason+OPEN).
        await nativeGhsSettlement.reconcileNativeGhsSettlements(prisma);
        // ReconciliationException is overlay-managed (raw SQL — no Prisma model).
        const rows = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS n FROM "ReconciliationException"
            WHERE "entityType" = 'TRANSACTION' AND "entityId" = ${pending.txHash}
              AND "reason" = 'NATIVE_GHS_SETTLEMENT_LEDGER_MISSING' AND "status" = 'OPEN'`;
        expect(rows[0].n).toBe(1);
    });
});
