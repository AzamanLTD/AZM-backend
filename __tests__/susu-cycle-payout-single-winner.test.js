// __tests__/susu-cycle-payout-single-winner.test.js
// Real-PostgreSQL proof that the Susu cycle payout has a single-winner
// authority at the database boundary.
//
// SusuCycleService._acquireCycle's advisory lock is transaction-scoped: it
// expires the moment the acquisition transaction commits, and after that
// exclusion relies on the 5-minute stall-recovery heuristic. Two workers
// that both believe they own a COLLECTING cycle both reach _finalizeCycle.
// The payout authority is a conditional status claim inside the transaction
// that moves the money: only one of the competing finalizations may credit
// the pool.
//
// Against the pre-fix implementation (blind status flip + unconditional
// credit) the concurrent test fails: both credits land and the recipient is
// double-paid.

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[susu-cycle-payout-single-winner] TEST_DATABASE_URL not set — skipping.');

const { Prisma, PrismaClient } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('../services/susu/errors');

describeOrSkip('Susu cycle payout single-winner (real PostgreSQL)', () => {
    let prisma, svc, treasury, recipient, contributor, cycleIds, userIds, memberIds;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        const SusuCycleService = require('../services/susu/susuCycle.service');
        treasury = null; // seeded per test below
        svc = null;
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    // ── Fixtures ─────────────────────────────────────────────────────────
    // Exact-id bookkeeping: every row this suite creates is deleted by id in
    // afterAll (FK order respected) so the shared CI battery can run twice
    // without contamination and without broad prefix sweeps.
    const created = { users: [], groups: [], cycles: [], members: [], contributions: [], historyUserIds: [] };

    async function seedUser(availableBalance, tag) {
        const u = await prisma.user.create({
            data: {
                username: `susu_race_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                email: `susu_race_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.local`,
                password: 'test_password',
                role: 'USER',
                availableBalance,
            },
        });
        created.users.push(u.id);
        return u;
    }

    async function seedGroup() {
        const g = await prisma.susuGroup.create({
            data: {
                status: 'ACTIVE',
                contributionUsdc: 10,
                frequency: 'WEEKLY',
                totalCycles: 1,
                startDate: new Date(),
                contractRequiredCount: 2,
                contractVersion: 'v2',
                contractAcceptedCount: 2,
                rotationSnapshot: [],
            },
        });
        created.groups.push(g.id);
        return g;
    }

    async function seedCycle(group, payoutUserId, status) {
        const c = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id,
                cycleNumber: 1,
                collectionDate: new Date(Date.now() - 60 * 60 * 1000),
                payoutUserId,
                status,
                payoutAmount: 0,
            },
        });
        created.cycles.push(c.id);
        return c;
    }

    async function seedMember(group, user, slot, status) {
        const m = await prisma.susuMember.create({
            data: {
                susuGroupId: group.id,
                userId: user.id,
                cycleSlot: slot,
                trustScore: 1,
                status: status || 'ACTIVE',
            },
        });
        created.members.push(m.id);
        return m;
    }

    // A PAID contribution — represents a debit that already happened during
    // the per-member collection pass.
    async function seedPaidContribution(cycle, member, user, amount) {
        const c = await prisma.susuContribution.create({
            data: {
                cycleId: cycle.id,
                memberId: member.id,
                userId: user.id,
                amountUsdc: amount,
                status: 'PAID',
            },
        });
        await prisma.user.update({
            where: { id: user.id },
            data: { escrowLockedBalance: { increment: amount } },
        });
        created.contributions.push(c.id);
        return c;
    }

    afterAll(async () => {
        if (!prisma) return;
        await prisma.susuContribution.deleteMany({ where: { id: { in: created.contributions } } });
        await prisma.transactionHistory.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.susuMember.deleteMany({ where: { id: { in: created.members } } });
        await prisma.susuCycle.deleteMany({ where: { id: { in: created.cycles } } });
        await prisma.susuGroup.deleteMany({ where: { id: { in: created.groups } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    });

    test('concurrent finalizations credit the pool exactly once', async () => {
        const group = await seedGroup();
        recipient = await seedUser(0, 'rcpt');
        treasury = await seedUser(0, 'trsry');
        const c1 = await seedUser(0, 'c1');
        const c2 = await seedUser(0, 'c2');
        const cycle = await seedCycle(group, recipient.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        const m2 = await seedMember(group, c2, 2);
        await seedPaidContribution(cycle, m1, c1, 15);
        await seedPaidContribution(cycle, m2, c2, 15);

        svc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        const cycleObj = { id: cycle.id, cycleNumber: 1, payoutUserId: recipient.id };
        const susuObj = { id: group.id, contributionUsdc: 10 };

        // Two workers that both believe they own the COLLECTING cycle (the
        // advisory lock has expired; both passed the stall heuristic).
        const outcomes = await Promise.all([
            svc._finalizeCycle(cycleObj, susuObj).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
            svc._finalizeCycle(cycleObj, susuObj).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
        ]);

        const winners = outcomes.filter((o) => o.ok);
        expect(winners).toHaveLength(1);
        expect(outcomes.filter((o) => !o.ok)[0].e).toBeInstanceOf(SusuError);
        expect(outcomes.filter((o) => !o.ok)[0].e.code).toBe(ErrorCodes.CYCLE_ALREADY_FINALIZED);

        const finalRecipient = await prisma.user.findUnique({ where: { id: recipient.id } });
        const finalTreasury = await prisma.user.findUnique({ where: { id: treasury.id } });
        const finalCycle = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const payoutLedger = await prisma.transactionHistory.findMany({
            where: { userId: recipient.id, type: 'SUSU_PAYOUT' },
        });

        // Pooled 30 USDC credited exactly ONCE — not once per racing worker.
        expect(Number(finalRecipient.availableBalance)).toBeCloseTo(30, 6);
        expect(Number(finalTreasury.availableBalance)).toBeCloseTo(0, 6);
        expect(finalCycle.status).toBe('PAID_OUT');
        expect(Number(finalCycle.payoutAmount)).toBeCloseTo(30, 6);
        expect(payoutLedger).toHaveLength(1);
        expect(payoutLedger[0].status).toBe('COMPLETED');
    });

    test('replay after commit refuses a second payout without moving money', async () => {
        // Reuse the paid-out cycle from the previous test.
        const paidOutCycle = await prisma.susuCycle.findFirst({
            where: { id: { in: created.cycles } },
            orderBy: { paidOutAt: 'asc' },
        });
        const recipientRow = await prisma.user.findFirst({
            where: { username: { startsWith: 'susu_race_rcpt' } },
        });
        const balanceBefore = Number(recipientRow.availableBalance);
        const historyBefore = await prisma.transactionHistory.count({
            where: { userId: recipientRow.id, type: 'SUSU_PAYOUT' },
        });

        svc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        const cycleObj = { id: paidOutCycle.id, cycleNumber: 1, payoutUserId: paidOutCycle.payoutUserId };
        const group = await prisma.susuGroup.findUnique({ where: { id: paidOutCycle.susuGroupId } });

        await expect(svc._finalizeCycle(cycleObj, { id: group.id, contributionUsdc: 10 }))
            .rejects.toThrow(/finalized by another worker/);

        const recipientAfter = await prisma.user.findUnique({ where: { id: recipientRow.id } });
        const historyAfter = await prisma.transactionHistory.count({
            where: { userId: recipientRow.id, type: 'SUSU_PAYOUT' },
        });
        expect(Number(recipientAfter.availableBalance)).toBeCloseTo(balanceBefore, 6);
        expect(historyAfter).toBe(historyBefore);
    });

    test('recipient-defaulted diversion credits treasury exactly once under concurrency', async () => {
        const group = await seedGroup();
        recipient = await seedUser(0, 'drcpt');
        treasury = await seedUser(0, 'dtrsry');
        const c1 = await seedUser(0, 'dc1');
        const cycle = await seedCycle(group, recipient.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        const recipientMember = await seedMember(group, recipient, 2, 'DEFAULTED');
        await seedPaidContribution(cycle, m1, c1, 12);

        svc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        const cycleObj = { id: cycle.id, cycleNumber: 1, payoutUserId: recipient.id };
        const susuObj = { id: group.id, contributionUsdc: 10 };

        const outcomes = await Promise.all([
            svc._finalizeCycle(cycleObj, susuObj).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
            svc._finalizeCycle(cycleObj, susuObj).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
        ]);

        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

        const finalRecipient = await prisma.user.findUnique({ where: { id: recipient.id } });
        const finalTreasury = await prisma.user.findUnique({ where: { id: treasury.id } });
        const finalCycle = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const treasuryLedger = await prisma.transactionHistory.findMany({
            where: { userId: treasury.id, type: 'SUSU_PAYOUT' },
        });

        expect(Number(finalRecipient.availableBalance)).toBeCloseTo(0, 6);
        expect(Number(finalTreasury.availableBalance)).toBeCloseTo(12, 6);
        expect(finalCycle.status).toBe('PAID_OUT');
        expect(finalCycle.escrowDivertedAt).not.toBeNull();
        expect(treasuryLedger).toHaveLength(1);
    });

    test('grace re-park cannot resurrect a finalized cycle', async () => {
        const paidOutCycle = await prisma.susuCycle.findFirst({
            where: { id: { in: created.cycles }, status: 'PAID_OUT' },
            orderBy: { paidOutAt: 'asc' },
        });
        const recipientRow = await prisma.user.findFirst({
            where: { username: { startsWith: 'susu_race_rcpt' } },
        });
        const balanceBefore = Number(recipientRow.availableBalance);

        svc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        // A worker holding a stale in-memory cycle tries to park it in grace
        // after another worker already paid it out.
        const cycleObj = { id: paidOutCycle.id, cycleNumber: 1, graceUntil: null };
        const group = await prisma.susuGroup.findUnique({ where: { id: paidOutCycle.susuGroupId } });

        await expect(svc._enterOrHoldGrace(cycleObj, { id: group.id }, [], 10))
            .rejects.toThrow(/grace re-park refused/);

        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: paidOutCycle.id } });
        const recipientAfter = await prisma.user.findUnique({ where: { id: recipientRow.id } });
        expect(cycleAfter.status).toBe('PAID_OUT');
        expect(Number(recipientAfter.availableBalance)).toBeCloseTo(balanceBefore, 6);
    });

    test('the legitimate end-to-end public path still pays out exactly once', async () => {
        const group = await seedGroup();
        // Realistic susu: the payout recipient is themselves a contributing
        // member. Everyone contributes 10; the pool of 30 goes to recipient.
        recipient = await seedUser(10, 'ercpt');
        treasury = await seedUser(0, 'etrsry');
        const c1 = await seedUser(25, 'ec1');
        const c2 = await seedUser(25, 'ec2');
        const cycle = await seedCycle(group, recipient.id, 'PENDING');
        await seedMember(group, c1, 1);
        await seedMember(group, c2, 2);
        await seedMember(group, recipient, 3);

        svc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        const result = await svc.processCycle(cycle.id);

        expect(result.cycleStatus).toBe('PAID_OUT');
        expect(result.pooled).toBe('30');

        const finalCycle = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const finalRecipient = await prisma.user.findUnique({ where: { id: recipient.id } });
        const finalC1 = await prisma.user.findUnique({ where: { id: c1.id } });
        const finalC2 = await prisma.user.findUnique({ where: { id: c2.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const payoutLedger = await prisma.transactionHistory.findMany({
            where: { userId: recipient.id, type: 'SUSU_PAYOUT' },
        });

        expect(finalCycle.status).toBe('PAID_OUT');
        expect(Number(finalCycle.payoutAmount)).toBeCloseTo(30, 6);
        // Recipient: 10 (seeded) − 10 (own contribution) + 30 (payout) = 30.
        expect(Number(finalRecipient.availableBalance)).toBeCloseTo(30, 6);
        expect(Number(finalC1.availableBalance)).toBeCloseTo(15, 6);
        expect(Number(finalC2.availableBalance)).toBeCloseTo(15, 6);
        expect(contributions).toHaveLength(3);
        expect(contributions.every((c) => c.status === 'PAID')).toBe(true);
        expect(payoutLedger).toHaveLength(1);
        // Parent group completed: single cycle, now terminal.
        const finalGroup = await prisma.susuGroup.findUnique({ where: { id: group.id } });
        expect(finalGroup.status).toBe('COMPLETED');
    });
});
