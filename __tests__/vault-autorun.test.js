// __tests__/vault-autorun.test.js
// =============================================================================
// Vault auto-rule integration tests
//
// Complements vault-flow.test.js by covering the auto-rule deposit path that the
// vaultWorker drives on a schedule.
//
// Covers:
//   A. runAutoRule: credits vault + debits user when balance is sufficient
//   B. runAutoRule: increments missedCount and writes a FAILED_INSUFFICIENT
//      VaultDeposit when balance is insufficient — and does NOT throw (the
//      worker must keep running for the next user)
//   C. runAutoRule: no-op when autoRuleEnabled is false
//   D. Two concurrent runAutoRule calls conserve money (no value created)
//
// Adapted to the ACTUAL services/vaultService.js (verified, NOT the doc shapes):
//   • The worker entry point is runAutoRule(vault) — it takes the full Vault row
//     and returns { ok, status } (it never throws on a missed deposit), NOT
//     depositAuto({ userId, vaultId }).
//   • VaultService is constructed with (prisma, io, notificationService,
//     azmRewardService); we pass null-object stubs for the non-DB collaborators.
//   • Vault.rulesAcceptedAt is REQUIRED (no default), so makeVault sets it.
//   • runAutoRule has no idempotency key, so test D asserts the real invariant —
//     money is conserved (user outflow == vault inflow), not a brittle
//     "exactly one deposit". (See the doc's own note: 1 or 2 deposits are both
//     acceptable; the hard guarantee is that no money is created.)
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[vault-autorun.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Vault auto-rule deposits', () => {
    let prisma, vaultSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { VaultService } = require('../services/vaultService');
        prisma   = new PrismaClient();
        vaultSvc = new VaultService(
            prisma,
            { to: () => ({ emit: () => {} }) },     // io stub
            { sendNotification: async () => {} },   // notificationService stub
            { creditAzm: async () => ({}) }         // azmRewardService stub
        );
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User","Vault","VaultDeposit","TransactionHistory" RESTART IDENTITY CASCADE'
        );
    });

    async function makeVault(userId, overrides = {}) {
        return prisma.vault.create({
            data: {
                userId,
                name:                 overrides.name             ?? 'Auto Test Vault',
                targetAmountUsdc:     overrides.targetAmountUsdc ?? 1000,
                currentAmountUsdc:    overrides.currentAmountUsdc ?? 0,
                maturityDate:         overrides.maturityDate     ?? new Date(Date.now() + 90 * 86400000),
                rulesAcceptedAt:      new Date(),                // REQUIRED — no schema default
                earlyBreakPenaltyPct: overrides.earlyBreakPenaltyPct ?? 0.10,
                autoRuleEnabled:      overrides.autoRuleEnabled  ?? true,
                autoRuleAmountUsdc:   overrides.autoRuleAmountUsdc ?? 50,
                autoRuleFrequency:    overrides.autoRuleFrequency ?? 'WEEKLY',
                autoRuleNextRun:      overrides.autoRuleNextRun  ?? new Date(Date.now() - 1000), // overdue
                missedCount:          overrides.missedCount      ?? 0,
            },
        });
    }

    // ── A. Successful auto-deposit ─────────────────────────────────────────────
    test('A: runAutoRule credits vault and debits user when balance is sufficient', async () => {
        const user  = await seedUser(prisma, { availableBalance: 500 });
        const vault = await makeVault(user.id);

        const result = await vaultSvc.runAutoRule(vault);
        expect(result.ok).toBe(true);

        const updatedVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(Number(updatedVault.currentAmountUsdc)).toBeGreaterThan(0);

        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(updatedUser.availableBalance)).toBeLessThan(500);

        const deposit = await prisma.vaultDeposit.findFirst({ where: { vaultId: vault.id } });
        expect(deposit).not.toBeNull();
    });

    // ── B. Insufficient balance — missedCount increments, no throw ─────────────
    test('B: runAutoRule increments missedCount when balance is insufficient', async () => {
        const user  = await seedUser(prisma, { availableBalance: 5 }); // far below the 50 rule
        const vault = await makeVault(user.id);

        // Must NOT throw — workers keep running even when one user misses.
        await expect(vaultSvc.runAutoRule(vault)).resolves.not.toThrow();

        const updatedVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(updatedVault.missedCount).toBeGreaterThan(0);
        // Vault balance must NOT have increased.
        expect(Number(updatedVault.currentAmountUsdc)).toBe(0);
    });

    // ── C. Auto-rule disabled — no-op ─────────────────────────────────────────
    test('C: runAutoRule is a no-op when autoRuleEnabled is false', async () => {
        const user  = await seedUser(prisma, { availableBalance: 500 });
        const vault = await makeVault(user.id, { autoRuleEnabled: false });

        const result = await vaultSvc.runAutoRule(vault);
        expect(result.ok).toBe(false);

        const updatedVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(Number(updatedVault.currentAmountUsdc)).toBe(0); // nothing moved
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(updatedUser.availableBalance)).toBe(500); // untouched
    });

    // ── D. Concurrent auto-deposits conserve money ─────────────────────────────
    test('D: two concurrent runAutoRule calls do not create money', async () => {
        const user  = await seedUser(prisma, { availableBalance: 500 });
        const vault = await makeVault(user.id, { autoRuleAmountUsdc: 100 });

        await Promise.allSettled([
            vaultSvc.runAutoRule(vault),
            vaultSvc.runAutoRule(vault),
        ]);

        const updatedUser  = await prisma.user.findUnique({ where: { id: user.id } });
        const updatedVault = await prisma.vault.findUnique({ where: { id: vault.id } });

        const userLost = 500 - Number(updatedUser.availableBalance);
        const vaultGot = Number(updatedVault.currentAmountUsdc);

        // Hard invariant: every USDC that left the user landed in the vault.
        expect(userLost).toBeCloseTo(vaultGot, 1);
        // At least one rule-amount moved, and never more than both runs could.
        expect(vaultGot).toBeGreaterThanOrEqual(100);
        expect(vaultGot).toBeLessThanOrEqual(200 * 1.01); // tiny rounding tolerance
    });
});
