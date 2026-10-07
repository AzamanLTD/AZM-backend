// __tests__/vault-completion-reward-atomicity.test.js
// =============================================================================
// §vault-completion-reward (2026-10-07) — the AZM completion reward is an
// economic ENTITLEMENT of vault completion, not a best-effort side effect.
//
// Proves against REAL PostgreSQL, with the REAL AzmRewardService wired in:
//   1. Atomic reward success — COMPLETED vault, principal released exactly
//      once, reward credited exactly once, AzmRewardLog with the correct
//      source / dedupKey / amount / vault metadata.
//   2. Reward failure rolls back the ENTIRE completion — vault stays
//      ACTIVE, principal stays locked, no ledger/history/receipt survives.
//   3. Concurrent maturity sweeps converge — one terminal winner, one
//      principal release, one completion reward.
//   4. breakEarly vs completeMatured race — exactly one terminal outcome;
//      ONLY the COMPLETED winner receives the completion reward.
//   5. Re-drive — a completed vault can never receive the reward twice;
//      the deterministic dedup identity stays authoritative.
//   6. Formula regression — the established contract (flat 25 AZM +
//      1.25% of the released final balance) is locked so the historical
//      comment/code drift ("5% of total deposits" vs balance*0.0125+25)
//      cannot recur.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[vault-completion-reward] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§vault-completion-reward: atomic AZM completion entitlement', () => {
    let prisma, vaultSvc, rewardSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { VaultService } = require('../services/vaultService');
        const { AzmRewardService } = require('../services/azmRewardService');
        prisma = new PrismaClient();
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

    // createVault validates a FUTURE maturityDate — seed future, then flip
    // the row to already-matured (mimicking time passing) so the sweep sees
    // a due vault. Mirrors the r16 seeding pattern.
    async function seedMaturedVault(userId, balance, penaltyPct = 0.05) {
        const vault = await vaultSvc.createVault({
            userId,
            name: 'Reward Vault',
            targetAmountUsdc: 1000,
            maturityDate: new Date(Date.now() + 90 * 86400000).toISOString(),
            earlyBreakPenaltyPct: penaltyPct,
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

    async function rewardLogs(vaultId) {
        return prisma.azmRewardLog.findMany({
            where: { source: 'VAULT_COMPLETION', metadata: { path: ['vaultId'], equals: vaultId } },
        });
    }

    test('1: atomic reward success — completion, principal release and reward commit TOGETHER', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
        const vault = await seedMaturedVault(user.id, 400);

        await vaultSvc.completeMatured(vault);

        // Vault terminal, principal released exactly once.
        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(freshVault.status).toBe('COMPLETED');
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(400, 5);

        // Reward credited exactly once, with full provenance.
        const logs = await rewardLogs(vault.id);
        expect(logs.length).toBe(1);
        expect(logs[0].dedupKey).toBe(`vault-completion-${vault.id}`);
        expect(logs[0].source).toBe('VAULT_COMPLETION');
        // Established contract: 25 flat + 1.25% of 400 = 30.
        expect(Number(logs[0].amount)).toBeCloseTo(30, 5);
        expect(logs[0].metadata.vaultId).toBe(vault.id);
        expect(logs[0].metadata.deposited).toBe('400');
        // The AZM balance increment committed in the SAME transaction.
        expect(Number(freshUser.azmBalance)).toBeCloseTo(30, 5);

        // The authoritative ledger entry for the release exists exactly once.
        const ledgerEntries = await prisma.ledgerTransaction.findMany({
            where: { relatedEntity: 'vault', relatedEntityId: vault.id, entryType: 'VAULT_RELEASE' },
        });
        expect(ledgerEntries.length).toBe(1);
    });

    test('2: reward failure rolls back the ENTIRE completion — no partial economic state', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
        const vault = await seedMaturedVault(user.id, 250);

        // Force the transaction-client reward primitive to fail. A stub with
        // the same method contract as the real service.
        const userBefore = await prisma.user.findUnique({ where: { id: user.id } });
        const failingSvc = Object.create(vaultSvc);
        failingSvc.azmRewardService = {
            _creditAzmWithClient: async () => { throw new Error('reward engine down'); },
        };

        await expect(failingSvc.completeMatured(vault)).rejects.toThrow(/reward engine down/);

        // Vault did NOT complete — still ACTIVE, principal still locked.
        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(freshVault.status).toBe('ACTIVE');
        expect(Number(freshVault.currentAmountUsdc)).toBeCloseTo(250, 5);

        // Principal release rolled back — balance untouched.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(Number(userBefore.availableBalance), 5);

        // No partial completion state anywhere.
        const ledgerEntries = await prisma.ledgerTransaction.findMany({
            where: { relatedEntity: 'vault', relatedEntityId: vault.id },
        });
        expect(ledgerEntries.length).toBe(0);
        const history = await prisma.transactionHistory.findMany({
            where: { userId: user.id, type: 'VAULT_RELEASE' },
        });
        expect(history.length).toBe(0);
        expect(await rewardLogs(vault.id)).toHaveLength(0);

        // And the vault is still completable once the reward engine recovers
        // (the real service is wired back on the unmodified instance).
        await vaultSvc.completeMatured(vault);
        const recovered = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(recovered.status).toBe('COMPLETED');
        expect((await rewardLogs(vault.id)).length).toBe(1);
    });

    test('3: concurrent maturity sweeps converge — ONE release, ONE reward', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
        const vault = await seedMaturedVault(user.id, 600);

        const results = await Promise.allSettled([
            vaultSvc.completeMatured(vault),
            vaultSvc.completeMatured(vault),
        ]);

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(freshVault.status).toBe('COMPLETED');
        expect(Number(freshVault.currentAmountUsdc)).toBe(0);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(600, 5);

        // Exactly one winner credited the reward; the loser threw the
        // terminalized error without ever reaching the reward.
        const logs = await rewardLogs(vault.id);
        expect(logs.length).toBe(1);
        // 25 flat + 1.25% of 600 = 32.5.
        expect(Number(logs[0].amount)).toBeCloseTo(32.5, 5);
        expect(Number(freshUser.azmBalance)).toBeCloseTo(32.5, 5);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason.code).toBe('VAULT_ALREADY_TERMINALIZED');
    });

    test('4: breakEarly vs completeMatured race — only the COMPLETED winner is rewarded', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
        const vault = await seedMaturedVault(user.id, 500);

        await Promise.allSettled([
            vaultSvc.breakEarly({ userId: user.id, vaultId: vault.id }),
            vaultSvc.completeMatured(vault),
        ]);

        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(['BROKEN_EARLY', 'COMPLETED']).toContain(freshVault.status);
        expect(freshVault.status).not.toBe('ACTIVE');

        // Exactly one terminal release identity (500 matured or 475 broken).
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const credited = Number(freshUser.availableBalance);
        expect([500, 475]).toContain(credited);

        // The completion reward exists IFF the vault COMPLETED.
        const logs = await rewardLogs(vault.id);
        if (freshVault.status === 'COMPLETED') {
            expect(logs.length).toBe(1);
            expect(credited).toBe(500);
            // 25 flat + 1.25% of 500 = 31.25.
            expect(Number(logs[0].amount)).toBeCloseTo(31.25, 5);
        } else {
            expect(logs.length).toBe(0);
        }
    });

    test('5: re-drive of a completed vault can NEVER duplicate the reward', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
        const vault = await seedMaturedVault(user.id, 300);

        await vaultSvc.completeMatured(vault);
        const azmAfterFirst = Number(
            (await prisma.user.findUnique({ where: { id: user.id } })).azmBalance
        );

        // Worker crash/re-drive: the sweep re-attempts the completed vault.
        await expect(vaultSvc.completeMatured(vault)).rejects.toThrow(/no longer active/i);
        // A fresh sweep pass with a stale pre-read converges identically.
        await expect(vaultSvc.completeMatured(vault.id)).rejects.toThrow(/no longer active/i);

        // The dedup authority held: exactly one reward log, balance unchanged.
        expect((await rewardLogs(vault.id)).length).toBe(1);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.azmBalance)).toBeCloseTo(azmAfterFirst, 5);

        // Even a hypothetical second reward credit for the same vault identity
        // is blocked by the deterministic dedup key at the reward layer.
        const again = await rewardSvc.creditAzm({
            userId: user.id,
            amount: 28.75,
            source: 'VAULT_COMPLETION',
            reason: 'replay attempt',
            metadata: { vaultId: vault.id, deposited: '300' },
            dedupKey: `vault-completion-${vault.id}`,
        });
        expect(again.credited).toBe(false);
        expect((await rewardLogs(vault.id)).length).toBe(1);
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).azmBalance))
            .toBeCloseTo(azmAfterFirst, 5);
    });

    test('6: formula regression — the established contract is flat 25 AZM + 1.25% of the released final balance', async () => {
        // The repository evidence chain (see services/vaultService.js header):
        // the formula balance*0.0125 + 25 is unchanged since the initial
        // launch commit (2aa9b6c) and is the only behavior ever shipped; the
        // "5% of total deposits" comment never matched any implementation
        // (no totalDeposited field exists on Vault). This test LOCKS the
        // established contract so comment/code drift cannot recur silently.
        const cases = [
            { balance: 100, expected: 26.25 },   // 25 + 1.25
            { balance: 400, expected: 30 },     // 25 + 5
            { balance: 1000, expected: 37.5 },   // 25 + 12.5
            { balance: 1234.56, expected: 40.432 }, // 25 + 15.432
        ];
        for (const { balance, expected } of cases) {
            const user = await seedUser(prisma, { availableBalance: 0, azmBalance: 0 });
            const vault = await seedMaturedVault(user.id, balance);
            await vaultSvc.completeMatured(vault);
            const logs = await rewardLogs(vault.id);
            expect(logs.length).toBe(1);
            expect(Number(logs[0].amount)).toBeCloseTo(expected, 2);
        }
    });
});
