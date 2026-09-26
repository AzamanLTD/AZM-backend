// __tests__/vault-flow.test.js
// Covers (against the REAL services/vaultService.VaultService class):
//   A. depositManual deducts user balance and credits the vault
//   B. depositManual with amount <= 0 is rejected
//   C. breakEarly returns balance minus the early-break penalty
//
// Real shapes (verified, not the design-doc shapes):
//   • vaultService exports { VaultService }; instantiate with
//     new VaultService(prisma, io, notificationService, azmRewardService).
//   • createVault({ userId, name, targetAmountUsdc, maturityDate, ... }) — NOT
//     create({ targetUsdc, lockUntil }). There is no `minimumDeposit`; the guard
//     is amountUsdc > 0. breakEarly refunds currentAmount * (1 - earlyBreakPenaltyPct).
// SKIPS unless TEST_DATABASE_URL is set.
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[vault-flow.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Vault flow', () => {
  let prisma, vaultSvc;
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV     = 'test';
    process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const { PrismaClient } = require('@prisma/client');
    const { VaultService } = require('../services/vaultService');
    prisma   = new PrismaClient();
    // io / notificationService / azmRewardService are non-essential for these
    // paths — pass null-object stubs.
    vaultSvc = new VaultService(
      prisma,
      { to: () => ({ emit: () => {} }) },
      { sendNotification: async () => {} },
      { award: async () => ({}) }
    );
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User", "Vault", "VaultDeposit", "TransactionHistory" RESTART IDENTITY CASCADE'
    );
  }, 15000);

  const futureDate = () => new Date(Date.now() + 30 * 86400000).toISOString();

  test('A: depositManual deducts user balance and credits vault', async () => {
    const user = await seedUser(prisma, { availableBalance: 500 });
    const vault = await vaultSvc.createVault({
      userId: user.id, name: 'Test Vault', targetAmountUsdc: 1000, maturityDate: futureDate(),
    });
    await vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 100 });

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(Number(updated.availableBalance)).toBeLessThan(500);
    const v = await prisma.vault.findUnique({ where: { id: vault.id } });
    expect(Number(v.currentAmountUsdc)).toBeGreaterThan(0);
  });

  test('B: deposit of a non-positive amount is rejected', async () => {
    const user = await seedUser(prisma, { availableBalance: 500 });
    const vault = await vaultSvc.createVault({
      userId: user.id, name: 'Min Vault', targetAmountUsdc: 1000, maturityDate: futureDate(),
    });
    await expect(
      vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 0 })
    ).rejects.toThrow();
  });

  test('C: breakEarly returns balance minus penalty', async () => {
    const user = await seedUser(prisma, { availableBalance: 500 });
    const vault = await vaultSvc.createVault({
      userId: user.id, name: 'Early Vault', targetAmountUsdc: 1000, maturityDate: futureDate(),
    });
    await vaultSvc.depositManual({ userId: user.id, vaultId: vault.id, amountUsdc: 200 });
    const balBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

    await vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id });
    const balAfter = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

    expect(balAfter).toBeGreaterThan(balBefore);        // remainder refunded
    expect(balAfter - balBefore).toBeLessThan(200);      // penalty was applied
  });
});
