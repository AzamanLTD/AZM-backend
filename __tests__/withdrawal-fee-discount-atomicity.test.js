// __tests__/withdrawal-fee-discount-atomicity.test.js
// =============================================================================
// P0 regression — AZM fee-discount spend MUST be atomic with the fiat
// withdrawal reservation.
//
// Pre-fix defect: the AZM fee-discount debit committed in its OWN transaction
// BEFORE processFiatWithdrawal ran, so a failed reservation (or a later
// provider reversal) could leave a consumed AZM spend with no withdrawal.
//
// Post-fix invariants proven here (real PostgreSQL, gated on
// TEST_DATABASE_URL — the CI workflow provides it):
//   A. Successful withdrawal: AZM debit, fiat pool reservation, USDC debit
//      and the PENDING TransactionHistory row all commit on ONE transaction.
//   B. A late DB failure INSIDE the withdrawal transaction (unique txHash
//      collision AFTER the AZM debit) rolls EVERYTHING back — no committed
//      AZM spend survives.
//   C. Provider rejection (reverseFiatWithdrawal) restores the exact AZM
//      spend exactly once: balance back, spend log marked reversedAt,
//      no negative AzmSpendLog rows.
//   D. Two CONCURRENT reversals restore AZM exactly once (the PENDING->FAILED
//      claim is the one-winner guard).
//   E. Provider SUCCESS (completeFiatWithdrawal) does NOT restore AZM — the
//      discount stays consumed — and a reversal attempt afterwards is
//      refused (notReversible) without touching balances.
//   F. Withdrawals WITHOUT a fee discount behave exactly as before
//      (azmFeeDiscount null, reversal restores nothing extra).
//
// runDoubleCheck is mocked (it requires a fully seeded backing ledger that
// seedUser already provides); every other write runs against real Postgres.
// =============================================================================

jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const financeService = require('../services/finance.service');
const { AzmSpendService, FEE_DISCOUNT_TIERS } = require('../services/azmSpendService');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[withdrawal-fee-discount-atomicity] TEST_DATABASE_URL not set — skipping real-DB suite.');

const TIER_25 = FEE_DISCOUNT_TIERS.find(t => t.id === 'tier_25'); // 10 AZM -> 25% off
const EXIT_FEE_PCT = 0.02;
const START_AZM = 100.0;
const START_USDC = 500.0;
const WITHDRAWAL = 50.0;

const exitFeeFor = (amount, discount) =>
    parseFloat((amount * EXIT_FEE_PCT * (1 - discount)).toFixed(6));

describeOrSkip('AZM fee-discount withdrawal atomicity (real PostgreSQL)', () => {
    let prisma;
    let azm;

    beforeAll(() => {
        prisma = new PrismaClient();
        azm = new AzmSpendService(prisma);
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.0, liveRateSource: 'KOTANI_PAY' },
            create: { id: 1, liveRetailRate: 13.0, liveRateSource: 'KOTANI_PAY' }
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: 100_000.0 },
            create: { id: 1, balance: 100_000.0 }
        });
        // Fresh-install posture: processFiatWithdrawal DEFERS the principal
        // into SystemMasterCrypto, and test A asserts the master balance
        // against the seeded withdrawal. A prior suite's residue (e.g. the
        // §P.5-D suite's authority withdrawals) must never leak in, whatever
        // the jest run order.
        await prisma.systemMasterCrypto.upsert({
            where: { id: 1 },
            update: { balance: 0.0 },
            create: { id: 1, balance: 0.0 }
        });
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 150));
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── helpers ─────────────────────────────────────────────────────────────
    const seedWithdrawalUser = () =>
        seedUser(prisma, { availableBalance: START_USDC, azmBalance: START_AZM });

    const reserveDiscount = (userId, tierId, reference) =>
        (tx) => azm.applyFeeDiscountInTransaction(tx, userId, tierId, reference);

    const createWithdrawalWithDiscount = async (user, tierId = 'tier_25') => {
        const tier = FEE_DISCOUNT_TIERS.find(t => t.id === tierId);
        const reference = `FIAT_OUT_TEST_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
        const data = await financeService.processFiatWithdrawal(prisma, user.id, WITHDRAWAL, {
            reference,
            feeDiscountMultiplier: tier.discount,
            reserveFeeDiscountInTransaction: reserveDiscount(user.id, tierId, reference)
        });
        return { data, reference, tier };
    };

    const freshUser = (userId) =>
        prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true, azmBalance: true } });

    const spendLogFor = (userId, reference) =>
        prisma.azmSpendLog.findFirst({
            where: {
                userId,
                source: 'FEE_DISCOUNT',
                metadata: { path: ['dedupKey'], equals: `fee_discount_${reference}` }
            }
        });

    // ── A. atomic creation ──────────────────────────────────────────────────
    test('A. AZM debit commits atomically with the fiat reservation', async () => {
        const user = await seedWithdrawalUser();
        const { data, reference, tier } = await createWithdrawalWithDiscount(user);

        expect(data.azmFeeDiscount).toMatchObject({
            tierId: tier.id,
            discount: tier.discount,
            azmSpent: tier.cost,
            debited: true
        });

        const exitFee = exitFeeFor(WITHDRAWAL, tier.discount);
        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM - tier.cost);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC - WITHDRAWAL - exitFee, 6);

        const txRow = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txRow.status).toBe('PENDING');
        expect(Number(txRow.feeUsdc)).toBeCloseTo(exitFee, 6);
        expect(txRow.metadata.azmFeeDiscount).toMatchObject({
            tierId: tier.id,
            azmSpent: tier.cost,
            dedupKey: `fee_discount_${reference}`
        });

        const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        expect(Number(pool.balance)).toBeCloseTo(100_000 - WITHDRAWAL, 6);

        const master = await prisma.systemMasterCrypto.findUnique({ where: { id: 1 } });
        expect(Number(master.balance)).toBeCloseTo(WITHDRAWAL, 6);

        const log = await spendLogFor(user.id, reference);
        expect(log).not.toBeNull();
        expect(Number(log.amount)).toBe(tier.cost);
        expect(Number(log.balanceAfter)).toBe(START_AZM - tier.cost);
        expect(log.metadata.withdrawalRef).toBe(reference);
    });

    // ── B. late DB failure inside the outer tx rolls the AZM debit back ─────
    test('B. a failure AFTER the AZM debit rolls back the AZM spend too', async () => {
        const user = await seedWithdrawalUser();
        const reference = `FIAT_COLLISION_${Date.now()}`;
        // A pre-existing COMPLETED row with the same txHash forces a REAL
        // unique-constraint failure at transactionHistory.create — i.e. AFTER
        // the AZM debit has already run inside the same transaction.
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'DEPOSIT_CRYPTO',
                amountUsdc: 0.01,
                feeUsdc: 0,
                txHash: reference,
                status: 'COMPLETED'
            }
        });

        await expect(financeService.processFiatWithdrawal(prisma, user.id, WITHDRAWAL, {
            reference,
            feeDiscountMultiplier: TIER_25.discount,
            reserveFeeDiscountInTransaction: reserveDiscount(user.id, 'tier_25', reference)
        })).rejects.toThrow();

        // THE P0 invariant: nothing from the failed attempt survived.
        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM);
        expect(Number(u.availableBalance)).toBe(START_USDC);

        const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        expect(Number(pool.balance)).toBe(100_000);

        // The master-crypto singleton upsert also happened inside the rolled-back
        // transaction, so either no row exists or it holds nothing from this attempt.
        const master = await prisma.systemMasterCrypto.findUnique({ where: { id: 1 } });
        expect(master === null || Number(master.balance) === 0).toBe(true);

        expect(await spendLogFor(user.id, reference)).toBeNull();
        const withdrawn = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' }
        });
        expect(withdrawn).toBeNull();
    });

    // ── C. provider rejection restores the AZM spend exactly once ───────────
    test('C. reverseFiatWithdrawal restores the exact AZM spend once', async () => {
        const user = await seedWithdrawalUser();
        const { reference, tier } = await createWithdrawalWithDiscount(user);
        const exitFee = exitFeeFor(WITHDRAWAL, tier.discount);

        const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
            reason: 'provider_sync_rejection'
        });

        expect(reversal.azmFeeDiscount).toMatchObject({ restored: true, amount: tier.cost });
        expect(reversal.refundedAmount).toBeCloseTo(WITHDRAWAL + exitFee, 6);

        const txRow = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txRow.status).toBe('FAILED');

        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM); // AZM fully restored
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC, 6); // USDC fully restored

        const log = await spendLogFor(user.id, reference);
        expect(log.metadata.reversedAt).toBeTruthy();
        expect(log.metadata.reversalReference).toBe(reference);

        // No negative/top-up rows are ever created for a restoration.
        const allLogs = await prisma.azmSpendLog.findMany({ where: { userId: user.id } });
        expect(allLogs).toHaveLength(1);

        // Second reversal attempt must be a no-op (idempotency).
        const again = await financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'dup' });
        expect(again.alreadyReversed).toBe(true);
        const u2 = await freshUser(user.id);
        expect(Number(u2.azmBalance)).toBe(START_AZM); // NOT restored twice
    });

    // ── D. concurrent reversals — exactly one winner ─────────────────────────
    test('D. two concurrent reversals restore AZM exactly once', async () => {
        const user = await seedWithdrawalUser();
        const { reference } = await createWithdrawalWithDiscount(user);

        const [r1, r2] = await Promise.all([
            financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'worker_sweep' }),
            financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'controller_retry' })
        ]);

        const restored = [r1, r2].filter(r => r.azmFeeDiscount?.restored === true);
        const skipped = [r1, r2].filter(r => r.alreadyReversed === true);
        expect(restored).toHaveLength(1);
        expect(skipped).toHaveLength(1);

        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM); // restored EXACTLY once

        const log = await spendLogFor(user.id, reference);
        expect(log.metadata.reversedAt).toBeTruthy();

        const txRow = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txRow.status).toBe('FAILED');
    });

    // ── E. provider success keeps the AZM spend consumed ────────────────────
    test('E. completeFiatWithdrawal does NOT restore AZM; later reversal refused', async () => {
        const user = await seedWithdrawalUser();
        const { reference, tier } = await createWithdrawalWithDiscount(user, 'tier_50');

        const completion = await financeService.completeFiatWithdrawal(prisma, reference, {
            providerTxId: 'PROV-1'
        });
        expect(completion.status).toBe('COMPLETED');

        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM - tier.cost); // still consumed

        const log = await spendLogFor(user.id, reference);
        expect(log.metadata.reversedAt).toBeFalsy();

        const refused = await financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'late_failure' });
        expect(refused.notReversible).toBe(true);
        expect(refused.azmFeeDiscount).toBeUndefined(); // no restoration attempted

        const u2 = await freshUser(user.id);
        expect(Number(u2.azmBalance)).toBe(START_AZM - tier.cost); // untouched
        expect(Number(u2.availableBalance)).toBeCloseTo(
            START_USDC - WITHDRAWAL - exitFeeFor(WITHDRAWAL, tier.discount), 6
        );
    });

    // ── F. no fee discount → behavior unchanged ──────────────────────────────
    test('F. withdrawal without a fee discount behaves exactly as before', async () => {
        const user = await seedWithdrawalUser();
        const reference = `FIAT_PLAIN_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

        const data = await financeService.processFiatWithdrawal(prisma, user.id, WITHDRAWAL, {
            reference
        });

        expect(data.azmFeeDiscount).toBeNull();
        expect(data.exitFee).toBeCloseTo(WITHDRAWAL * EXIT_FEE_PCT, 6);

        const u = await freshUser(user.id);
        expect(Number(u.azmBalance)).toBe(START_AZM);

        const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'x' });
        expect(reversal.azmFeeDiscount).toBeNull();
        expect(reversal.refundedAmount).toBeCloseTo(WITHDRAWAL * (1 + EXIT_FEE_PCT), 6);

        const u2 = await freshUser(user.id);
        expect(Number(u2.azmBalance)).toBe(START_AZM);
        expect(Number(u2.availableBalance)).toBeCloseTo(START_USDC, 6);
    });
});
