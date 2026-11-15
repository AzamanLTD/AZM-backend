// __tests__/zero-fee-susu-semantics.test.js
// =============================================================================
// Susu fee semantics against real PostgreSQL.
//
// Two facts are established here, and they are NOT the same fact:
//
//  1. The Admin setting GlobalSettings.susuProfitPct must treat 0 as a real
//     value. `settings?.susuProfitPct || 0.03` turned an explicit 0 into the
//     3% default (fixed in services/susuService.js).
//  2. The LIVE payout path (services/susu/susuCycle.service.js, used by the
//     Cycle_Scheduler worker for contractVersion groups) pays out `pooled`
//     with no fee deduction and never reads susuProfitPct at all.
//
// This suite therefore asserts what the code ACTUALLY does, per configuration,
// instead of asserting the fee we would like it to charge.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[zero-fee-susu-semantics] TEST_DATABASE_URL not set — skipping.');

const { Prisma, PrismaClient } = require('@prisma/client');

describeOrSkip('Susu fee semantics (real PostgreSQL)', () => {
    let prisma, treasury;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const tag = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    async function seedUser(balance) {
        return prisma.user.create({
            data: {
                username: `zf_${tag()}`, email: `zf_${tag()}@test.local`,
                password: 'test_password', role: 'USER', availableBalance: balance,
            },
        });
    }

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SusuGroup", "SusuCycle", "SusuMember", "SusuContribution", '
            + '"TransactionHistory", "LedgerTransaction", "JournalEntry", "LedgerAccount", "AuditLog" RESTART IDENTITY CASCADE'
        );
    }, 20000);

    // Realistic 3-member, 1-cycle group: everyone contributes 10, pool of 30.
    async function seedCycle({ members = 3, contribution = 10 } = {}) {
        const recipient = await seedUser(10);
        treasury = await seedUser(0);
        const group = await prisma.susuGroup.create({
            data: {
                status: 'ACTIVE', contributionUsdc: contribution, frequency: 'WEEKLY',
                totalCycles: 1, startDate: new Date(),
                contractRequiredCount: 2, contractVersion: 'v2',
                contractAcceptedCount: 2, rotationSnapshot: [],
            },
        });
        const cycle = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id, cycleNumber: 1,
                collectionDate: new Date(Date.now() - 60 * 60 * 1000),
                payoutUserId: recipient.id, status: 'PENDING', payoutAmount: 0,
            },
        });
        const others = [];
        for (let i = 1; i < members; i += 1) others.push(await seedUser(contribution * 3));
        const roster = [recipient, ...others];
        for (let i = 0; i < roster.length; i += 1) {
            const member = await prisma.susuMember.create({
                data: { susuGroupId: group.id, userId: roster[i].id, cycleSlot: i + 1, status: 'ACTIVE', trustScore: 50 },
            });
            await prisma.susuContribution.create({
                data: {
                    cycleId: cycle.id, memberId: member.id, userId: roster[i].id,
                    amountUsdc: contribution, status: 'PAID',
                },
            });
            await prisma.user.update({
                where: { id: roster[i].id },
                data: { escrowLockedBalance: { increment: contribution } },
            });
        }
        return { cycle, recipient, roster, expectedPool: new Prisma.Decimal(contribution * members) };
    }

    async function runPayout(cycleId) {
        const SusuCycleService = require('../services/susu/susuCycle.service');
        const svc = new SusuCycleService(prisma, { treasuryUserId: treasury.id });
        return svc.processCycle(cycleId);
    }

    const setProfit = (value) => prisma.globalSettings.upsert({
        where: { id: 1 },
        update: { susuProfitPct: value },
        create: { id: 1, susuProfitPct: value },
    });

    async function assertNoFeeTaken(cycleId, expectedPool) {
        const cycle = await prisma.susuCycle.findUnique({ where: { id: cycleId } });
        expect(cycle.status).toBe('PAID_OUT');
        // The live payout applies NO fee: the recipient receives the whole pool.
        expect(new Prisma.Decimal(cycle.payoutAmount).toFixed(8)).toBe(expectedPool.toFixed(8));
        const fee = cycle.feeUsdc === null || cycle.feeUsdc === undefined
            ? new Prisma.Decimal(0) : new Prisma.Decimal(cycle.feeUsdc);
        expect(fee.toFixed(8)).toBe('0.00000000');
        return cycle;
    }

    test('configured 0% profit: zero fee, recipient receives the whole pool', async () => {
        await setProfit(0);
        const { cycle, recipient, expectedPool } = await seedCycle();
        await runPayout(cycle.id);

        await assertNoFeeTaken(cycle.id, expectedPool);
        const winner = await prisma.user.findUnique({ where: { id: recipient.id } });
        expect(new Prisma.Decimal(winner.availableBalance).toFixed(8))
            .toBe(new Prisma.Decimal(10).plus(expectedPool).toFixed(8));
    });

    test('absent configuration: no 3% is applied by the live path either', async () => {
        await prisma.globalSettings.deleteMany();
        const { cycle, expectedPool } = await seedCycle();
        await runPayout(cycle.id);
        await assertNoFeeTaken(cycle.id, expectedPool);
    });

    test('configured 3% (the documented default) is NOT deducted on the live path', async () => {
        await setProfit(0.03);
        const { cycle, expectedPool } = await seedCycle();
        await runPayout(cycle.id);
        // Documents current behaviour, not desired behaviour: no 0.90 fee taken.
        await assertNoFeeTaken(cycle.id, expectedPool);
    });

    test('the legacy service now treats an explicit 0 as zero, not the 3% default', async () => {
        // Source-level proof of the `??` fix: read the file and assert the
        // logical-OR defaulting that silently replaced 0 is gone.
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'susuService.js'), 'utf8');
        expect(src).not.toMatch(/susuProfitPct\s*\|\|\s*0\.03/);
        expect(src).toMatch(/susuProfitPct\s*\?\?\s*0\.03/);
    });
});
