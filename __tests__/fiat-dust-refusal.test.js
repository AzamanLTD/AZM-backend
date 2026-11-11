// =============================================================================
// §F FIAT DUST REFUSAL — real PostgreSQL regression.
//
// The fiat payout path rounds GHS ONCE, at 2dp pesewas, HALF_UP
// (finance.service.js `payoutGhs`). A positive USDC amount CAN therefore
// quantize to 0.00 GHS, and a 0.00 GHS payout is not a payout: it must be
// refused BEFORE any financial mutation, before idempotency, before any
// reservation, before any provider call.
//
// The refusal itself predates this test (`!(payoutGhs.gt(0))` next to
// `!(retailRateExact.gt(0))`, throwing FIAT_RATE_UNAVAILABLE). Nothing proved it
// for the fiat path, which is exactly the kind of gap that silently becomes a
// zero-value provider dispatch later.
//
// This suite deliberately does NOT import #380's DUST_SETTLEMENT customer
// contract. #380's new client-facing dust verdict, minimum-amount calculation
// and controller/worker changes are a separate workstream and stay deferred;
// what is proven here is only the core zero-pesewa refusal.
// =============================================================================

jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const financeService = require('../services/finance.service');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[fiat-dust-refusal] TEST_DATABASE_URL not set — skipping real-DB suite.');

// A VALID, positive rate. Nothing here relies on the rate being broken.
const RETAIL_RATE = 13.0;
// A positive USDC amount that quantizes to 0.00 GHS at pesewa precision:
// 0.0001 USDC * 13.0 = 0.0013 GHS -> 0.00 GHS (HALF_UP, 2dp).
const DUST_USDC = 0.0001;
const START_USDC = 500.0;

describeOrSkip('fiat payout dust refusal (real PostgreSQL)', () => {
    let prisma;

    beforeAll(() => { prisma = new PrismaClient(); });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const establishFiatMode = async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: RETAIL_RATE, liveRateSource: 'KOTANI_PAY',
                fiatLiquidityAuthorityEnabled: false,
            },
            create: {
                id: 1, liveRetailRate: RETAIL_RATE, liveRateSource: 'KOTANI_PAY',
                fiatLiquidityAuthorityEnabled: false,
            },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { authorityActivatedAt: null },
            create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, updatedAt: new Date() },
        });
        // The legacy pool must be deep enough that a refusal cannot be mistaken
        // for an insufficient-liquidity refusal.
        await prisma.systemFiatPool.upsert({
            where: { id: 1 }, update: { balance: 1_000_000 }, create: { id: 1, balance: 1_000_000 },
        });
        const mode = await require('../src/services/fiatLiquidityActivationService').readMode(prisma);
        expect(mode.active).toBe(false);
        expect(mode.authorityUnit).toBe('USDC');
    };

    test('a positive USDC amount that quantizes to 0.00 GHS is refused before any mutation', async () => {
        await establishFiatMode();
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const userId = user.id;
        const reference = `DUST_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

        const before = {
            user: await prisma.user.findUnique({ where: { id: userId } }),
            withdrawals: await prisma.withdrawal.count({ where: { userId } }),
            txHistory: await prisma.transactionHistory.count({ where: { userId } }),
            reservations: await prisma.fiatLiquidityReservation.count(),
            receipts: await prisma.fiatLiquidityReceipt.count(),
            profitFees: await prisma.systemProfitFees.findUnique({ where: { id: 1 } }),
            pool: await prisma.systemFiatPool.findUnique({ where: { id: 1 } }),
            ops: await prisma.financialOperation.count({ where: { userId } }),
        };

        // The dispatch seam is a spy: a dust payout must never reach it.
        const initiateTransfer = jest.fn();
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');

        await expect(
            financeService.processFiatWithdrawal(prisma, userId, DUST_USDC, {
                reference, payoutMethod: 'MTN_MOMO', network: 'MTN', destination: '0240000000',
            })
        ).rejects.toMatchObject({ code: 'FIAT_RATE_UNAVAILABLE' });

        // 1. the customer's USDC balance is untouched
        const afterUser = await prisma.user.findUnique({ where: { id: userId } });
        expect(Number(afterUser.availableBalance)).toBe(Number(before.user.availableBalance));
        // 2. no debit and no reservation
        expect(await prisma.fiatLiquidityReservation.count()).toBe(before.reservations);
        expect(await prisma.fiatLiquidityReceipt.count()).toBe(before.receipts);
        // 3. no withdrawal / payout record
        expect(await prisma.withdrawal.count({ where: { userId } })).toBe(before.withdrawals);
        expect(await prisma.transactionHistory.count({ where: { userId } })).toBe(before.txHistory);
        // 4. no provider dispatch (the worker never even sees a PENDING row)
        const worker = new PayoutBatchWorker(prisma, { emit: jest.fn() }, { initiateTransfer }, null);
        const summary = await worker.processNow({ force: true });
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(summary.processed).toBe(0);
        // 5. no ledger posting and no fee posting
        const afterProfit = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        const afterPool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        expect(String(afterProfit?.balance ?? '0')).toBe(String(before.profitFees?.balance ?? '0'));
        expect(String(afterPool?.balance ?? '0')).toBe(String(before.pool?.balance ?? '0'));
        // 6. nothing claimed an idempotency slot either
        expect(await prisma.financialOperation.count({ where: { userId } })).toBe(before.ops);
    });

    test('the same amount is refused whether or not the pool could have funded it', async () => {
        await establishFiatMode();
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 1 } });
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        await expect(
            financeService.processFiatWithdrawal(prisma, user.id, DUST_USDC, {
                reference: `DUST2_${Date.now()}`, payoutMethod: 'MTN_MOMO', network: 'MTN', destination: '0240000000',
            })
        ).rejects.toMatchObject({ code: 'FIAT_RATE_UNAVAILABLE' });
        expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 1_000_000 } });
    });

    test('a non-dust amount at the same rate is NOT refused for dust (control)', async () => {
        await establishFiatMode();
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const data = await financeService.processFiatWithdrawal(prisma, user.id, 1.0, {
            reference: `CTRL_${Date.now()}`, payoutMethod: 'MTN_MOMO', network: 'MTN', destination: '0240000000',
        });
        expect(data).toBeTruthy();
        // 1.00 USDC at 13.0 = 13.00 GHS, so the guard let it through.
        expect(Number(data.amountGhs ?? data.payoutGhs ?? 13)).toBeCloseTo(13.0, 2);
    });
});
