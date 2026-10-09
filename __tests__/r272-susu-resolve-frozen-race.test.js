// __tests__/r272-susu-resolve-frozen-race.test.js
// =============================================================================
// r272 finding 1 — Susu REFUND_AND_CLOSE / RESUME TOCTOU, real-PostgreSQL
// proof of the in-transaction claim fix.
//
// Pre-fix defect: resolveFrozenSusu validated the group status OUTSIDE the
// money transaction and then wrote UNCONDITIONALLY inside it. A worker that
// finalized (paid out) or cancelled the Susu between the check and the write
// was silently overwritten by the admin resolution:
//   • REFUND_AND_CLOSE racing a cycle payout refunded the SAME pooled money
//     that the worker had just paid out (money printed from nothing).
//   • Two admins resolving the same freeze both refunded every contribution
//     (double refund).
//   • RESUME resurrected a CANCELLED group.
//
// Post-fix contract proven here:
//   1. Two concurrent REFUND_AND_CLOSE resolutions → exactly one commits;
//      the loser gets a 409 SusuError and moves no money.
//   2. Concurrent REFUND_AND_CLOSE vs RESUME → exactly one terminal state,
//      and the refund never executes twice.
//   3. REFUND_AND_CLOSE racing the cycle worker's payout on the SAME frozen
//      pool → exactly one money mover (payout XOR refund), never both.
//   4. RESUME can never resurrect a CANCELLED group (409, no state change).
//   5. A replayed refund after commit refuses (single-use path).
//
// Against the pre-fix implementation tests 1 and 3 fail: both refunds land
// (double credit) and a refund can land on money that was already paid out.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-susu-resolve-frozen-race] TEST_DATABASE_URL not set — skipping.');

const { PrismaClient } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('../services/susu/errors');

describeOrSkip('r272 Susu resolveFrozenSusu races (real PostgreSQL)', () => {
    let prisma, monitor, treasury, cycleSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        const AdminSusuMonitorService = require('../services/susu/adminSusuMonitor.service');
        const SusuCycleService = require('../services/susu/susuCycle.service');
        monitor = new AdminSusuMonitorService(prisma); // no vouch service → void path skipped
        cycleSvc = null; // built per test with the seeded treasury
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    // Exact-id bookkeeping: every row this suite creates is deleted by id in
    // afterAll (FK order respected), so the shared CI battery can run twice
    // without contamination and without broad prefix sweeps.
    const created = { users: [], groups: [], cycles: [], members: [], contributions: [], historyUserIds: [] };

    async function seedUser(availableBalance, tag) {
        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const u = await prisma.user.create({
            data: {
                username: `r272susu_${tag}_${uniq}`,
                email: `r272susu_${tag}_${uniq}@test.local`,
                password: 'test_password',
                role: 'USER',
                availableBalance,
            },
        });
        created.users.push(u.id);
        return u;
    }

    async function seedFrozenGroup() {
        const g = await prisma.susuGroup.create({
            data: {
                status: 'FROZEN_DISPUTE',
                contributionUsdc: 10,
                frequency: 'WEEKLY',
                totalCycles: 1,
                startDate: new Date(),
                contractRequiredCount: 2,
                contractVersion: 'v2',
                contractAcceptedCount: 2,
                rotationSnapshot: [],
                frozenAt: new Date(),
                frozenReason: 'r272 race test',
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

    async function seedMember(group, user, slot) {
        const m = await prisma.susuMember.create({
            data: {
                susuGroupId: group.id,
                userId: user.id,
                cycleSlot: slot,
                trustScore: 1,
                status: 'ACTIVE',
            },
        });
        created.members.push(m.id);
        return m;
    }

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
        created.historyUserIds.push(user.id);
        return c;
    }

    afterAll(async () => {
        if (!prisma) return;
        await prisma.susuContribution.deleteMany({ where: { id: { in: created.contributions } } });
        await prisma.transactionHistory.deleteMany({ where: { userId: { in: created.historyUserIds } } });
        await prisma.susuMember.deleteMany({ where: { id: { in: created.members } } });
        await prisma.susuCycle.deleteMany({ where: { id: { in: created.cycles } } });
        await prisma.susuGroup.deleteMany({ where: { id: { in: created.groups } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    });

    const REFUND = { adminUserId: 1, susuGroupId: 0, action: 'REFUND_AND_CLOSE', notes: 'r272 test' };
    const RESUME = { adminUserId: 1, susuGroupId: 0, action: 'RESUME', notes: 'r272 test' };
    const call = (action) => monitor.resolveFrozenSusu({ ...action });

    test('two concurrent REFUND_AND_CLOSE resolutions refund exactly once', async () => {
        const group = await seedFrozenGroup();
        const treasury = await seedUser(0, 'trsry');
        const c1 = await seedUser(0, 'c1');
        const c2 = await seedUser(0, 'c2');
        const cycle = await seedCycle(group, c1.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        const m2 = await seedMember(group, c2, 2);
        await seedPaidContribution(cycle, m1, c1, 15);
        await seedPaidContribution(cycle, m2, c2, 15);

        const outcomes = await Promise.allSettled([
            call({ ...REFUND, susuGroupId: group.id }),
            call({ ...REFUND, susuGroupId: group.id }),
        ]);
        const wins = outcomes.filter((o) => o.status === 'fulfilled');
        const losses = outcomes.filter((o) => o.status === 'rejected');
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        expect(losses[0].reason).toBeInstanceOf(SusuError);
        expect([400, 409]).toContain(losses[0].reason.status ?? losses[0].reason.statusCode ?? 409);

        const after = await Promise.all([prisma.user.findUnique({ where: { id: c1.id } }), prisma.user.findUnique({ where: { id: c2.id } })]);
        // Each member refunded EXACTLY once — not once per racing admin.
        expect(Number(after[0].availableBalance)).toBeCloseTo(15, 6);
        expect(Number(after[1].availableBalance)).toBeCloseTo(15, 6);
        expect(Number(after[0].escrowLockedBalance)).toBeCloseTo(0, 6);
        expect(Number(after[1].escrowLockedBalance)).toBeCloseTo(0, 6);

        const g = await prisma.susuGroup.findUnique({ where: { id: group.id } });
        expect(g.status).toBe('CANCELLED');

        const refunds = await prisma.transactionHistory.count({ where: { userId: { in: [c1.id, c2.id] }, type: 'SUSU_REFUND' } });
        expect(refunds).toBe(2); // one per member — exactly once per member, not doubled
    });

    test('concurrent REFUND_AND_CLOSE vs RESUME leaves exactly one terminal state', async () => {
        const group = await seedFrozenGroup();
        const c1 = await seedUser(0, 'c1');
        const cycle = await seedCycle(group, c1.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        await seedPaidContribution(cycle, m1, c1, 10);

        const outcomes = await Promise.allSettled([
            call({ ...REFUND, susuGroupId: group.id }),
            call({ ...RESUME, susuGroupId: group.id }),
        ]);
        const wins = outcomes.filter((o) => o.status === 'fulfilled');
        expect(wins).toHaveLength(1); // exactly one resolution owns the freeze

        const g = await prisma.susuGroup.findUnique({ where: { id: group.id } });
        expect(['CANCELLED', 'ACTIVE']).toContain(g.status);

        const member = await prisma.user.findUnique({ where: { id: c1.id } });
        if (g.status === 'CANCELLED') {
            // refund won → refunded exactly once
            expect(Number(member.availableBalance)).toBeCloseTo(10, 6);
        } else {
            // resume won → no refund happened
            expect(Number(member.availableBalance)).toBeCloseTo(0, 6);
            expect(Number(member.escrowLockedBalance)).toBeCloseTo(10, 6);
        }
    });

    test('REFUND_AND_CLOSE racing the cycle payout moves the pool exactly once', async () => {
        const group = await seedFrozenGroup();
        const treasury = await seedUser(0, 'trsry');
        const recipient = await seedUser(0, 'rcpt');
        const c1 = await seedUser(0, 'c1');
        const cycle = await seedCycle(group, recipient.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        await seedPaidContribution(cycle, m1, c1, 25);

        cycleSvc = new (require('../services/susu/susuCycle.service'))(prisma, { treasuryUserId: treasury.id });
        const cycleObj = { id: cycle.id, cycleNumber: 1, payoutUserId: recipient.id };
        const susuObj = { id: group.id, contributionUsdc: 10 };

        const outcomes = await Promise.allSettled([
            call({ ...REFUND, susuGroupId: group.id }),
            cycleSvc._finalizeCycle(cycleObj, susuObj),
        ]);
        const wins = outcomes.filter((o) => o.status === 'fulfilled');
        expect(wins).toHaveLength(1); // exactly ONE money mover — the DB claims are mutually exclusive

        const g = await prisma.susuGroup.findUnique({ where: { id: group.id } });
        const c = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const member = await prisma.user.findUnique({ where: { id: c1.id } });
        const rcpt = await prisma.user.findUnique({ where: { id: recipient.id } });

        if (g.status === 'CANCELLED') {
            // Refund won: cycle defaulted, member refunded once, recipient got NOTHING.
            expect(c.status).toBe('DEFAULTED');
            expect(Number(member.availableBalance)).toBeCloseTo(25, 6);
            expect(Number(rcpt.availableBalance)).toBeCloseTo(0, 6);
        } else {
            // Payout won: cycle PAID_OUT, recipient credited once, member NOT refunded.
            expect(c.status).toBe('PAID_OUT');
            expect(Number(rcpt.availableBalance)).toBeCloseTo(25, 6);
            expect(Number(member.availableBalance)).toBeCloseTo(0, 6);
        }
        // Never both: pooled money can be refunded XOR paid out.
        const refunded = Number(member.availableBalance) > 0;
        const paidOut = Number(rcpt.availableBalance) > 0;
        expect(refunded ^ paidOut).toBe(1);
    });

    test('RESUME cannot resurrect a CANCELLED group', async () => {
        const group = await seedFrozenGroup();
        const c1 = await seedUser(0, 'c1');
        const cycle = await seedCycle(group, c1.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        await seedPaidContribution(cycle, m1, c1, 5);

        await call({ ...REFUND, susuGroupId: group.id });
        // Group is now CANCELLED with a DEFAULTED cycle.
        await expect(call({ ...RESUME, susuGroupId: group.id })).rejects.toThrow();
        const g = await prisma.susuGroup.findUnique({ where: { id: group.id } });
        expect(g.status).toBe('CANCELLED'); // no resurrection
    });

    test('replayed REFUND_AND_CLOSE after commit refuses without moving money', async () => {
        const group = await seedFrozenGroup();
        const c1 = await seedUser(0, 'c1');
        const cycle = await seedCycle(group, c1.id, 'COLLECTING');
        const m1 = await seedMember(group, c1, 1);
        await seedPaidContribution(cycle, m1, c1, 12);

        await call({ ...REFUND, susuGroupId: group.id });
        const member = await prisma.user.findUnique({ where: { id: c1.id } });
        const balance = Number(member.availableBalance);

        await expect(call({ ...REFUND, susuGroupId: group.id })).rejects.toThrow();
        const after = await prisma.user.findUnique({ where: { id: c1.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(balance, 6); // no second refund
    });
});
