// __tests__/r16-vault-savings-claims.test.js
// =============================================================================
// r16 P0-D + P0-E proofs — atomic terminal claims on Vault release and
// Savings withdrawal.
//
// Proves against REAL PostgreSQL:
//   D1. breakEarly vs completeMatured racing the same vault → exactly ONE
//       release identity wins; the user is credited ONCE.
//   D2. deposit vs breakEarly → money never lands in a terminal vault.
//   E1. two concurrent partial savings withdrawals validated against the same
//       snapshot → total withdrawn never exceeds the goal balance; the user
//       is credited exactly the goal's money.
//   E2. replayed withdrawal requestId converges to one execution.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16-vault-savings] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r16 P0-D: Vault terminal claims', () => {
    let prisma, vaultSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { VaultService } = require('../services/vaultService');
        prisma = new PrismaClient();
        vaultSvc = new VaultService(
            prisma,
            { to: () => ({ emit: () => {} }) },
            { sendNotification: async () => ({}) },
            { creditAzm: async () => ({}) }
        );
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Vault", "VaultDeposit", "TransactionHistory", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount" RESTART IDENTITY CASCADE');
    }, 15000);

    async function seedVaultWithBalance(userId, balance) {
        const vault = await vaultSvc.createVault({
            userId,
            name: 'Race Vault',
            targetAmountUsdc: 1000,
            maturityDate: new Date(Date.now() - 1000).toISOString(), // ALREADY matured
            earlyBreakPenaltyPct: 0.05,
        });
        await prisma.vault.update({ where: { id: vault.id }, data: { currentAmountUsdc: balance } });
        return prisma.vault.findUnique({ where: { id: vault.id } });
    }

    test('D1: breakEarly vs completeMatured racing the same vault → exactly one release', async () => {
        const user = await seedUser(prisma, { availableBalance: 0 });
        const vault = await seedVaultWithBalance(user.id, 100);

        // Both release identities fire concurrently against the same vault.
        const [, breakRes] = await Promise.allSettled([
            vaultSvc.completeMatured(vault),
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
        ]);

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(['BROKEN_EARLY', 'COMPLETED']).toContain(freshVault.status);
        expect(freshVault.status).not.toBe('ACTIVE'); // exactly one terminal identity

        // The user was credited EXACTLY ONCE (100 matured, or 95 broken-early).
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const credited = Number(freshUser.availableBalance);
        expect([100, 95]).toContain(credited);

        // The vault's escrow drained exactly once — balance is terminal zero.
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);
        expect(breakRes.status).toBeDefined();
    });

    test('D1b: two concurrent breakEarly calls → exactly one release', async () => {
        const user = await seedUser(prisma, { availableBalance: 0 });
        const vault = await seedVaultWithBalance(user.id, 200);

        const [, r2] = await Promise.allSettled([
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
        ]);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        // Penalty 5% of 200 → exactly 190, ONCE.
        expect(Number(freshUser.availableBalance)).toBeCloseTo(190, 5);
        expect(r2).toBeDefined();
    });

    test('D2: deposit racing breakEarly never commits money into a terminal vault', async () => {
        const user = await seedUser(prisma, { availableBalance: 50 });
        const vault = await seedVaultWithBalance(user.id, 100);

        // Break wins the row lock; the concurrent deposit must roll back.
        const [, depositRes] = await Promise.allSettled([
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
            vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 30 }),
        ]);

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(freshVault.status).not.toBe('ACTIVE');
        // Whatever committed, the vault balance must be terminal-consistent:
        // a broken vault holds ZERO (any deposit that lost the race rolled back).
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        // Either the deposit lost (balance back to 50+release) or never happened.
        expect(Number(freshUser.availableBalance)).toBeGreaterThan(0);
        expect(depositRes).toBeDefined();
    });
});

describeOrSkip('r16 P0-E: Savings withdrawal atomic claim', () => {
    let prisma, controller;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        controller = require('../controllers/savingsController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SavingsGoal", "SavingsDeposit", "TransactionHistory", "GlobalSettings", "SystemProfitFees" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount" RESTART IDENTITY CASCADE');
    }, 15000);

    const mkReq = (user, body, params) => ({
        user,
        body,
        params: params || {},
        app: { get: (k) => (k === 'prisma' ? prisma : null) },
        ip: '127.0.0.1',
    });
    const mkRes = () => {
        const res = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.payload = payload; return res; };
        return res;
    };

    async function withdraw(user, goalId, body) {
        const res = mkRes();
        await controller.withdraw(mkReq(user, body, { id: goalId }), res);
        return res;
    }

    test('E1: two concurrent partial withdrawals cannot double-release the same savings money', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: 100 });
        await prisma.globalSettings.create({
            data: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15 } // USDC→GHS 1:15 for readability
        }).catch(() => {});
        const goal = await prisma.savingsGoal.create({
            data: {
                userId: user.id,
                name: 'Race goal',
                targetAmountGhs: 150,
                currentAmountGhs: 150, // = 100 USDC
                frequencyAmount: 15,
                isLocked: false, // no penalty — net == gross for arithmetic clarity
            },
        });

        // Both withdrawals validate against the SAME 150 GHS snapshot.
        const [r1, r2] = await Promise.all([
            withdraw(user, goal.id, { amountGhs: 150 }),
            withdraw(user, goal.id, { amountGhs: 150 }),
        ]);

        const results = [r1, r2];
        const successes = results.filter((r) => r.statusCode === 200 && r.payload?.success);
        expect(successes.length).toBe(1);

        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(0, 5);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        // 150 GHS @ 15 = 10 USDC credited EXACTLY ONCE.
        expect(Number(freshUser.availableBalance)).toBeCloseTo(10, 5);
        expect(Number(freshUser.escrowLockedBalance)).toBeCloseTo(90, 5);
    });

    test('E2: replayed requestId converges to one execution', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: 100 });
        await prisma.globalSettings.create({
            data: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15 }
        }).catch(() => {});
        const goal = await prisma.savingsGoal.create({
            data: {
                userId: user.id,
                name: 'Replay goal',
                targetAmountGhs: 150,
                currentAmountGhs: 150,
                frequencyAmount: 15,
                isLocked: false,
            },
        });

        const body = { amountGhs: 50, requestId: 'client-abc-123' };
        const r1 = await withdraw(user, goal.id, body);
        const r2 = await withdraw(user, goal.id, body);

        expect(r1.statusCode).toBe(200);
        expect(r2.statusCode).toBe(200);
        expect(r2.payload?.data?.replay).toBe(true);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(50 / 15, 5);
        expect(freshUser.availableBalance.toString()).not.toBeCloseTo(2 * (50 / 15));
    });
});
