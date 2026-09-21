// __tests__/r17-withdrawal-identity.test.js
// =============================================================================
// r17 P0 — withdrawal obligation/canonical IDENTITY integrity.
//
// Re-traced live code (2026-09-21) found the canonical-resolution fallbacks
// (adminController._resolveCanonicalWithdrawalTx,
// payoutBatchWorker._findCanonicalTransaction,
// withdrawalReconciliationWorker._findCanonicalTransaction) resolving a
// mirror-only withdrawal's canonical TransactionHistory by a GUESSED
// amount±5s identity match that could ADOPT a canonical already durably
// linked to ANOTHER withdrawal's mirror row — rejecting/dispatching/
// reconciling withdrawal X under withdrawal Y's reservation (cross-identity
// hijack) — while the legacy admin rejection path searched obligation
// reference families (withdrawal:smartroute:*) that no creation path ever
// wrote instead of the durable sourceEntity/sourceEntityId relation.
//
// r17 fixes (all additive):
//   1. The guessed fallback may only adopt an ORPHAN canonical — one not
//      linked to ANY Withdrawal row via the transactionHistoryId bridge.
//   2. A withdrawal that OWNS its own obligation (durable relation
//      sourceEntity='withdrawal') never adopts a fiat canonical at all —
//      its economics are its own obligation, never another row's.
//   3. The legacy rejection path resolves its obligation through the
//      durable relation (restrictedObligationService.findActiveForSource)
//      — no phantom reference families.
//
// Proves against REAL PostgreSQL:
//   A. wallet-economics rejection takes the legacy path — the LINKED fiat
//      canonical is untouched (the dominant hijack window).
//   B. legacy path resolves the withdrawal's OWN obligation and cancels it.
//   C. pre-sourceEntity rows (identity-derived reference only) still work.
//   D. repeated legacy rejection is idempotent.
//   E. orphan-adoption positive control — the fallback still recovers a
//      genuinely orphan legacy canonical.
//   F/G. payout + reconciliation workers: guard + exclusion + orphan control.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r17-withdrawal-identity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r17 P0: withdrawal obligation/canonical identity', () => {
    let prisma, controller;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        controller = require('../controllers/adminController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "GlobalSettings", "SystemProfitFees", "SystemFiatPool", "SystemMasterCrypto", "AdminProfitLog", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

    const mkReq = (admin, body, params) => ({
        user: admin,
        body,
        params: params || {},
        app: {
            get: (k) => {
                if (k === 'prisma') return prisma;
                if (k === 'notificationService') return { sendNotification: async () => ({}) };
                if (k === 'emitBalanceUpdate') return async () => {};
                if (k === 'socketio') return { to: () => ({ emit: async () => {} }) };
                return null;
            },
        },
        ip: '127.0.0.1',
    });
    const mkRes = () => {
        const res = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.payload = payload; return res; };
        return res;
    };

    async function reject(admin, withdrawalId, reason = 'test rejection') {
        const res = mkRes();
        await controller.rejectWithdrawal(mkReq(admin, { reason }, { id: String(withdrawalId) }), res);
        return res;
    }

    async function seedFinanceEnv() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 15, liveUsdToGhs: 15 },
            create: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15 }
        });
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
    }

    async function seedBridgedFiatWithdrawal(user, amount) {
        await seedFinanceEnv();
        const financeService = require('../services/finance.service');
        const reference = `FIAT_OUT_${user.id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        await financeService.processFiatWithdrawal(prisma, user.id, amount, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id"',
                    user.id, amount, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });
        const withdrawal = await prisma.withdrawal.findFirst({
            where: { userId: user.id },
            orderBy: { id: 'desc' },
        });
        return { withdrawal, reference };
    }

    async function seedWalletEconomicsRow(user, amount) {
        const restrictedObligations = require('../services/restrictedObligationService');
        const rows = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId", "amount", "payoutMethod", "network", "destination", "status", "createdAt", "updatedAt") ' +
            'VALUES ($1, $2, $3, $4, $5, \'PENDING\', now(), now()) RETURNING "id"',
            user.id, amount, 'MOMO', 'MOMO', '0240000000'
        );
        const id = rows[0].id;
        await prisma.$transaction(async (tx) => {
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_FIAT_WITHDRAWAL',
                reference: `withdrawal:wallet:${id}`,
                userId: user.id,
                amount,
                asset: 'USDC',
                sourceEntity: 'withdrawal',
                sourceEntityId: id,
            });
        });
        return await prisma.withdrawal.findUnique({ where: { id } });
    }

    async function seedBareMirrorRow(user, amount, payoutMethod = 'MTN_MOMO') {
        const rows = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId", "amount", "payoutMethod", "network", "destination", "status", "createdAt", "updatedAt") ' +
            'VALUES ($1, $2, $3, $4, $5, \'PENDING\', now(), now()) RETURNING "id"',
            user.id, amount, payoutMethod, 'MOMO', '0240000000'
        );
        return await prisma.withdrawal.findUnique({ where: { id: rows[0].id } });
    }

    async function seedOrphanCanonical(user, amount, reference) {
        const restrictedObligations = require('../services/restrictedObligationService');
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: amount,
                feeUsdc: 0,
                txHash: reference,
                status: 'PENDING',
                metadata: { ledgerReserved: true, status: 'PENDING' },
            },
        });
        await prisma.$transaction(async (tx) => {
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_FIAT_WITHDRAWAL',
                reference: `withdrawal:fiat:${reference}`,
                userId: user.id,
                amount,
                asset: 'USDC',
                sourceEntity: 'transactionHistory',
                sourceEntityId: reference,
            });
        });
    }

    test('A1: wallet-economics rejection takes the legacy path — the linked fiat canonical is untouched', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { reference } = await seedBridgedFiatWithdrawal(user, 50);

        const walletRow = await seedWalletEconomicsRow(user, 50);

        const res = await reject(admin, walletRow.id);
        expect(res.statusCode).toBe(200);

        const mirror = await prisma.withdrawal.findUnique({ where: { id: walletRow.id } });
        expect(mirror.status).toBe('REJECTED');
        const walletObl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:wallet:${walletRow.id}` } });
        expect(walletObl.status).toBe('CANCELLED');

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');
        const fiatObl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:fiat:${reference}` } });
        expect(fiatObl.status).toBe('ACTIVE');
        const fiatMirror = await prisma.withdrawal.findFirst({
            where: { userId: user.id, transactionHistoryId: { not: null } },
        });
        expect(fiatMirror.status).toBe('PENDING');

        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        const afterFiatDebit = 200 - Number(canonical.amountUsdc) - Number(canonical.feeUsdc);
        expect(Number(fresh.availableBalance)).toBeCloseTo(afterFiatDebit + 50, 5);
    });

    test('B1: mirror-only legacy row with a durable-relation obligation is refunded from restricted reserves', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedFinanceEnv();
        const row = await seedWalletEconomicsRow(user, 30);

        const res = await reject(admin, row.id);
        expect(res.statusCode).toBe(200);
        expect(res.payload.message).toContain('Funds refunded');

        const mirror = await prisma.withdrawal.findUnique({ where: { id: row.id } });
        expect(mirror.status).toBe('REJECTED');
        const obl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:wallet:${row.id}` } });
        expect(obl.status).toBe('CANCELLED');
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(230, 5);
    });

    test('C1: obligation carrying only the identity-derived wallet reference (no sourceEntity) is still cancelled', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedFinanceEnv();
        const row = await seedBareMirrorRow(user, 30);

        await prisma.restrictedObligation.create({
            data: {
                reference: `withdrawal:wallet:${row.id}`,
                sourceType: 'PENDING_FIAT_WITHDRAWAL',
                userId: user.id,
                amount: 30,
                asset: 'USDC',
                status: 'ACTIVE',
            },
        });

        const res = await reject(admin, row.id);
        expect(res.statusCode).toBe(200);

        const obl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:wallet:${row.id}` } });
        expect(obl.status).toBe('CANCELLED');
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(230, 5);
    });

    test('D1: a second rejection of the same mirror row cannot refund twice', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedFinanceEnv();
        const row = await seedWalletEconomicsRow(user, 30);

        const first = await reject(admin, row.id);
        expect(first.statusCode).toBe(200);
        const afterFirst = await prisma.user.findUnique({ where: { id: user.id } });
        const refunded = Number(afterFirst.availableBalance);

        const second = await reject(admin, row.id);
        expect([400, 409]).toContain(second.statusCode);

        const afterSecond = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(afterSecond.availableBalance)).toBeCloseTo(refunded, 5);
    });

    test('E1: the fallback still adopts a GENUINELY orphan legacy canonical and reverses it', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedFinanceEnv();
        const reference = `ORPHAN_FIAT_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        await seedOrphanCanonical(user, 40, reference);

        const mirror = await seedBareMirrorRow(user, 40);

        const res = await reject(admin, mirror.id);
        expect(res.statusCode).toBe(200);

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        const obl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:fiat:${reference}` } });
        expect(obl.status).toBe('CANCELLED');
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(240, 5);
        const mirrorRow = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
        expect(mirrorRow.status).toBe('REJECTED');
        expect(mirrorRow.transactionHistoryId).toBe(canonical.id);
    });

    test('F1: payout worker never dispatches under a wallet-economics row (own-obligation guard)', async () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { reference } = await seedBridgedFiatWithdrawal(user, 50);
        const walletRow = await seedWalletEconomicsRow(user, 50);

        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer: async () => { throw new Error('must not dispatch'); } }, null);
        const canonical = await worker._findCanonicalTransaction(walletRow);
        expect(canonical.row).toBeNull();

        const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(th.status).toBe('PENDING');
    });

    test('F2: payout worker never adopts a canonical linked to ANOTHER withdrawal (bridge-linked exclusion)', async () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedBridgedFiatWithdrawal(user, 50);

        const legacyRow = await seedBareMirrorRow(user, 50);

        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer: async () => { throw new Error('must not dispatch'); } }, null);
        const canonical = await worker._findCanonicalTransaction(legacyRow);
        expect(canonical.row).toBeNull();
    });

    test('F3: payout worker still adopts a GENUINELY orphan canonical (fallback purpose preserved)', async () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedFinanceEnv();
        const reference = `ORPHAN_W_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        await seedOrphanCanonical(user, 40, reference);
        const legacyRow = await seedBareMirrorRow(user, 40);

        const worker = new PayoutBatchWorker(prisma, null, {}, null);
        const canonical = await worker._findCanonicalTransaction(legacyRow);
        expect(canonical.row).not.toBeNull();
        expect(canonical.row.txHash).toBe(reference);
    });

    test('G1: reconciliation worker refuses a wallet-economics row and records the miss', async () => {
        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const user = await seedUser(prisma, { availableBalance: 200 });
        await seedBridgedFiatWithdrawal(user, 50);
        const walletRow = await seedWalletEconomicsRow(user, 50);

        const worker = new WithdrawalReconciliationWorker(prisma, null, {}, null, null);
        const canonical = await worker._findCanonicalTransaction(walletRow);
        expect(canonical.row).toBeNull();

        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = $1',
            String(walletRow.id)
        );
        expect(exceptions.some((e) => e.reason === 'MISSING_TRANSACTION_REFERENCE')).toBe(true);
    });

    test('G2: reconciliation worker never adopts a canonical linked to ANOTHER withdrawal', async () => {
        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { reference } = await seedBridgedFiatWithdrawal(user, 50);
        const legacyRow = await seedBareMirrorRow(user, 50);

        const worker = new WithdrawalReconciliationWorker(prisma, null, {}, null, null);
        const canonical = await worker._findCanonicalTransaction(legacyRow);
        expect(canonical.row).toBeNull();

        const mirror = await prisma.withdrawal.findUnique({ where: { id: legacyRow.id } });
        expect(mirror.transactionHistoryId).toBeNull();
        const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(th.status).toBe('PENDING');
    });
});
