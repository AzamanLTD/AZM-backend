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
    let prisma, vaultSvc, rewardSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { VaultService } = require('../services/vaultService');
        const { AzmRewardService } = require('../services/azmRewardService');
        prisma = new PrismaClient();
        // Real reward service since §vault-completion-reward: the completion
        // reward is atomic with the release, so the race tests exercise the
        // genuine reward leg (dedup + AzmRewardLog) alongside the claim.
        rewardSvc = new AzmRewardService(prisma, { to: () => ({ emit: () => {} }) });
        vaultSvc = new VaultService(
            prisma,
            { to: () => ({ emit: () => {} }) },
            { sendNotification: async () => ({}) },
            rewardSvc
        );
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Vault", "VaultDeposit", "TransactionHistory", "AdminProfitLog", "AzmRewardLog" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount" RESTART IDENTITY CASCADE');
    }, 15000);

    async function seedVaultWithBalance(userId, balance) {
        // createVault validates that maturityDate is in the FUTURE — seed a
        // future maturity, then flip the row to already-matured (mimicking
        // time passing) so completeMatured sees a due vault.
        const vault = await vaultSvc.createVault({
            userId,
            name: 'Race Vault',
            targetAmountUsdc: 1000,
            maturityDate: new Date(Date.now() + 90 * 86400000).toISOString(),
            earlyBreakPenaltyPct: 0.05,
        });
        await prisma.vault.update({
            where: { id: vault.id },
            data: {
                currentAmountUsdc: balance,
                maturityDate: new Date(Date.now() - 1000),
            },
        });
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

        // The two transactions now share the Vault→User lock order, so
        // Postgres serializes them instead of deadlocking: EITHER break
        // wins (the deposit's guarded ACTIVE claim finds count 0 → clean
        // VAULT_TERMINALIZED rollback) OR deposit wins (break then runs to
        // completion behind it). The assertions below hold in BOTH orders.
        const [breakRes, depositRes] = await Promise.allSettled([
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
            vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 30 }),
        ]);

        // r16 P0-F regression: neither side may die to a Prisma deadlock /
        // write-conflict error (P2034) — the pre-fix AB-BA lock order
        // produced exactly that flaky failure on CI. Only the clean
        // business outcomes are allowed to surface.
        for (const res of [breakRes, depositRes]) {
            if (res.status === 'rejected') {
                const msg = String(res.reason?.message || res.reason || '');
                expect(msg).not.toMatch(/P2034|deadlock|write conflict|40P01|40001/i);
                expect(['VAULT_TERMINALIZED', 'VAULT_ALREADY_TERMINALIZED'])
                    .toContain(res.reason?.code);
            }
        }

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        // Whichever order serialized, the vault ends TERMINAL and drained
        // exactly once (deposit-winner: break refunds 130−penalty; break-
        // winner: deposit rolled back). It can never remain ACTIVE with a
        // stranded deposit while both calls have settled.
        expect(freshVault.status).not.toBe('ACTIVE');
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        // Break-winner: 50 + 95 = 145. Deposit-winner: 50 − 30 + 123.5 = 143.5.
        expect([145, 143.5]).toContain(Number(freshUser.availableBalance));
        expect(depositRes).toBeDefined();
    });

    test('D2b: deposit-winner serialization — a committed deposit is refunded by the subsequent break', async () => {
        const user = await seedUser(prisma, { availableBalance: 50 });
        const vault = await seedVaultWithBalance(user.id, 100);

        // Pin the deposit-winner branch deterministically: the deposit
        // commits fully, then the break runs to completion behind it.
        await vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 30 });
        await vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id });

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(freshVault.status).toBe('BROKEN_EARLY');
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);

        // 130 balance − 5% penalty = 123.5 refunded, on top of 50 − 30.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(143.5, 5);
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
        // Order-proof seed: a leftover GlobalSettings row (id 1) from an
        // earlier suite would make create() fail silently and the withdrawal
        // would read a stale rate. Upsert pins BOTH rates explicitly.
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            // §271: the savings-deposit/withdraw quote gate is fail-closed on
            // stale oracle observations — pin freshness alongside the rate.
            update: { liveUsdToGhs: 15, liveRetailRate: 15, liveRateSource: 'KOTANI_PAY', lastRateSync: new Date(), lastExternalSync: new Date() }, // USDC→GHS 1:15 for readability
            create: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15, liveRateSource: 'KOTANI_PAY', lastRateSync: new Date(), lastExternalSync: new Date() },
        });
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
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveUsdToGhs: 15, liveRetailRate: 15, liveRateSource: 'KOTANI_PAY', lastRateSync: new Date(), lastExternalSync: new Date() },
            create: { id: 1, liveUsdToGhs: 15, liveRetailRate: 15, liveRateSource: 'KOTANI_PAY', lastRateSync: new Date(), lastExternalSync: new Date() },
        });
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
        expect(Number(freshUser.availableBalance)).not.toBeCloseTo(2 * (50 / 15), 5);
    });
});
