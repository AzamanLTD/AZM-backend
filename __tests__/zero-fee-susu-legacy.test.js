// __tests__/zero-fee-susu-legacy.test.js
// =============================================================================
// LEGACY Susu payout (services/susuService.js processCycle) against real
// PostgreSQL. This is the path workers/susuWorker.js drives for groups whose
// contractVersion is NULL, so it is live production code, not dead code.
//
// The setting is Admin-editable and accepts 0. `susuProfitPct || 0.03` turned
// an explicit 0 back into 3%. These tests pin the corrected semantics and the
// exact financial records each case writes.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[zero-fee-susu-legacy] TEST_DATABASE_URL not set — skipping.');

const { Prisma, PrismaClient } = require('@prisma/client');

describeOrSkip('Legacy Susu payout fee semantics (real PostgreSQL)', () => {
    let prisma, SusuService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        ({ SusuService } = require('../services/susuService'));
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SusuGroup", "SusuCycle", "SusuMember", "SusuContribution", '
            + '"TransactionHistory", "AdminProfitLog", "LedgerTransaction", "JournalEntry", "LedgerAccount", '
            + '"AuditLog", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 20000);

    const tag = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    async function seedUser(balance) {
        return prisma.user.create({
            data: {
                username: `lg_${tag()}`, email: `lg_${tag()}@test.local`,
                password: 'test_password', role: 'USER',
                availableBalance: balance, escrowLockedBalance: 0,
                kycStatus: 'VERIFIED',
            },
        });
    }

    // A legacy group: contractVersion NULL, 3 members, 10 USDC each, one cycle.
    async function seedLegacyCycle({ contribution = 10, members = 3 } = {}) {
        const recipient = await seedUser(contribution);
        const others = [];
        for (let i = 1; i < members; i += 1) others.push(await seedUser(contribution));
        const group = await prisma.susuGroup.create({
            data: {
                status: 'ACTIVE', contributionUsdc: contribution, frequency: 'WEEKLY',
                totalCycles: 1, startDate: new Date(),
                contractVersion: null, contractRequiredCount: 0, contractAcceptedCount: 0,
                rotationSnapshot: [],
            },
        });
        const cycle = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id, cycleNumber: 1,
                collectionDate: new Date(Date.now() - 60 * 60 * 1000),
                payoutUserId: recipient.id, status: 'PENDING', payoutAmount: 0,
            },
        });
        const roster = [recipient, ...others];
        for (let i = 0; i < roster.length; i += 1) {
            await prisma.susuMember.create({
                data: {
                    susuGroupId: group.id, userId: roster[i].id, cycleSlot: i + 1,
                    status: 'ACTIVE', trustScore: 50,
                },
            });
        }
        return {
            group, cycle, recipient, roster,
            pooled: new Prisma.Decimal(contribution * members),
        };
    }

    const runCycle = (cycleId) => new SusuService(prisma, null, null, null).processCycle(cycleId);

    const cycleRow = (id) => prisma.susuCycle.findUnique({ where: { id } });
    const bal = async (id) => new Prisma.Decimal((await prisma.user.findUnique({ where: { id } })).availableBalance);

    async function payoutPosting(cycleId) {
        const lt = await prisma.ledgerTransaction.findUnique({
            where: { idempotencyKey: `ledger:susu:payout:${cycleId}` },
            include: { journalEntries: true },
        });
        return lt;
    }

    test('explicit susuProfitPct = 0: zero fee, recipient receives the whole pool', async () => {
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: { susuProfitPct: 0 }, create: { id: 1, susuProfitPct: 0 } });
        const { cycle, recipient, pooled } = await seedLegacyCycle();

        await runCycle(cycle.id);

        const finalCycle = await cycleRow(cycle.id);
        expect(finalCycle.status).toBe('PAID_OUT');
        expect(new Prisma.Decimal(finalCycle.feeUsdc).toFixed(8)).toBe('0.00000000');
        expect(new Prisma.Decimal(finalCycle.payoutAmount).toFixed(8)).toBe(pooled.toFixed(8));

        // Recipient contributed 10 from a 10 balance, then receives the 30 pool.
        expect((await bal(recipient.id)).toFixed(8)).toBe(pooled.toFixed(8));

        // No positive fee anywhere: no AdminProfitLog row of profit, and the
        // payout posting carries NO revenue:fees line at all (zero-value lines
        // are filtered out, not posted as 0).
        const posting = await payoutPosting(cycle.id);
        expect(posting).not.toBeNull();
        const feesLines = posting.journalEntries.filter((e) => e.account === 'revenue:fees');
        expect(feesLines).toHaveLength(0);
        expect(new Prisma.Decimal(posting.metadata.feeUsdc).toFixed(8)).toBe('0.00000000');

        // Conservation: debits equal credits, and the recipient credit is the pool.
        const debit = posting.journalEntries.reduce((a, e) => a.plus(e.debit), new Prisma.Decimal(0));
        const credit = posting.journalEntries.reduce((a, e) => a.plus(e.credit), new Prisma.Decimal(0));
        expect(debit.toFixed(8)).toBe(credit.toFixed(8));
        expect(credit.toFixed(8)).toBe(pooled.toFixed(8));
    });

    test('missing GlobalSettings row: the existing 3% default still applies', async () => {
        const { cycle, pooled } = await seedLegacyCycle();
        await runCycle(cycle.id);

        const finalCycle = await cycleRow(cycle.id);
        // 30.00 pool * 3% = 0.90, ROUND_DOWN to 2dp
        expect(new Prisma.Decimal(finalCycle.feeUsdc).toFixed(8)).toBe('0.90000000');
        expect(new Prisma.Decimal(finalCycle.payoutAmount).toFixed(8))
            .toBe(pooled.minus(new Prisma.Decimal('0.9')).toFixed(8));
    });

    test('explicit 3%: configured fee is deducted and posted to revenue:fees', async () => {
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: { susuProfitPct: 0.03 }, create: { id: 1, susuProfitPct: 0.03 } });
        const { cycle, recipient, pooled } = await seedLegacyCycle();
        await runCycle(cycle.id);

        const finalCycle = await cycleRow(cycle.id);
        const fee = new Prisma.Decimal('0.9');
        expect(new Prisma.Decimal(finalCycle.feeUsdc).toFixed(8)).toBe(fee.toFixed(8));
        expect(new Prisma.Decimal(finalCycle.payoutAmount).toFixed(8)).toBe(pooled.minus(fee).toFixed(8));
        expect((await bal(recipient.id)).toFixed(8)).toBe(pooled.minus(fee).toFixed(8));

        const posting = await payoutPosting(cycle.id);
        const feeLine = posting.journalEntries.find((e) => e.account === 'revenue:fees');
        expect(feeLine).toBeDefined();
        expect(new Prisma.Decimal(feeLine.credit).toFixed(8)).toBe(fee.toFixed(8));

        // fee + net payout === collected pool, exactly.
        const recipientLine = posting.journalEntries.find((e) => e.account === `user:${recipient.id}:liability`);
        expect(new Prisma.Decimal(recipientLine.credit).plus(feeLine.credit).toFixed(8)).toBe(pooled.toFixed(8));
    });

    test('rounding: the existing ROUND_DOWN behaviour is preserved at 2dp', async () => {
        // 10.05 * 3 members = 30.15; * 3% = 0.9045 -> ROUND_DOWN 2dp = 0.90
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: { susuProfitPct: 0.03 }, create: { id: 1, susuProfitPct: 0.03 } });
        const { cycle } = await seedLegacyCycle({ contribution: new Prisma.Decimal('10.05') });
        await runCycle(cycle.id);

        const finalCycle = await cycleRow(cycle.id);
        expect(new Prisma.Decimal(finalCycle.feeUsdc).toFixed(8)).toBe('0.90000000');
        expect(new Prisma.Decimal(finalCycle.payoutAmount).toFixed(8)).toBe('29.25000000');
    });

    test('repeated processing: no duplicate payout, fee or ledger posting', async () => {
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: { susuProfitPct: 0.03 }, create: { id: 1, susuProfitPct: 0.03 } });
        const { cycle, recipient, pooled } = await seedLegacyCycle();
        await runCycle(cycle.id);
        const afterFirst = await bal(recipient.id);

        // Second tick must be refused by the claim CAS, leaving money untouched.
        await runCycle(cycle.id);
        expect((await bal(recipient.id)).toFixed(8)).toBe(afterFirst.toFixed(8));

        const postings = await prisma.ledgerTransaction.count({
            where: { idempotencyKey: `ledger:susu:payout:${cycle.id}` },
        });
        expect(postings).toBe(1);

        const finalCycle = await cycleRow(cycle.id);
        expect(new Prisma.Decimal(finalCycle.payoutAmount).toFixed(8))
            .toBe(pooled.minus(new Prisma.Decimal('0.9')).toFixed(8));
    });
});
