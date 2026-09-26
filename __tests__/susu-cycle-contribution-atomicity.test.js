// __tests__/susu-cycle-contribution-atomicity.test.js
// Real-PostgreSQL proof that Susu contribution/seizure affordability and
// audit are enforced at the database boundary.
//
// Finding 1 (TOCTOU): the per-member collection transaction read
// availableBalance, decided affordability in JavaScript, then performed an
// unconditional decrement. A wallet spend racing between the read and the
// decrement hit a stale-read debit: in CI (db push — no SQL-migration CHECK
// constraints) it committed a NEGATIVE availableBalance; in production the
// CHECK constraint aborted the member transaction and the outer
// catch-and-continue silently dropped the member from the cycle (payout
// without their contribution and without a recorded default).
//
// Finding 2 (swallowed ledger): the SUSU_CONTRIBUTION / SUSU_SEIZURE
// TransactionHistory writes were .catch(() => {}) — a ledger failure
// committed an unaudited wallet mutation.
//
// Both race schedules are forced deterministically with a Prisma client
// extension that performs a real, guarded wallet spend via the base client
// at the exact moment the vulnerable mutation is about to execute, or that
// forces the ledger write to fail. All other operations run against real
// PostgreSQL with real transactions.
//
// Against the pre-fix implementation:
//   - the forced contribution race commits a negative balance (assertion fails);
//   - the forced ledger failures commit unaudited mutations (assertions fail).

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[susu-cycle-contribution-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Susu contribution/seizure atomicity (real PostgreSQL)', () => {
    let prisma;
    const created = { users: [], groups: [], groupChats: [], cycles: [], members: [], contributions: [], reminderSent: [] };

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new (require('@prisma/client').PrismaClient)();
    });

    afterAll(async () => {
        if (!prisma) return;
        // Exact-id cleanup in FK order — no prefix sweeps, retry-safe.
        await prisma.susuContribution.deleteMany({ where: { id: { in: created.contributions } } });
        await prisma.transactionHistory.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.susuReminderSent.deleteMany({ where: { id: { in: created.reminderSent } } });
        await prisma.susuMember.deleteMany({ where: { id: { in: created.members } } });
        await prisma.susuCycle.deleteMany({ where: { id: { in: created.cycles } } });
        await prisma.groupChat.deleteMany({ where: { id: { in: created.groupChats } } });
        await prisma.susuGroup.deleteMany({ where: { id: { in: created.groups } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
        await prisma.$disconnect();
    });

    async function seedUser(availableBalance, tag) {
        const u = await prisma.user.create({
            data: {
                username: `susu_atom_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                email: `susu_atom_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.local`,
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

    async function seedCycle(group, payoutUserId, status, graceUntil) {
        const c = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id,
                cycleNumber: 1,
                collectionDate: new Date(Date.now() - 60 * 60 * 1000),
                payoutUserId,
                status,
                payoutAmount: 0,
                ...(graceUntil ? { graceUntil } : {}),
            },
        });
        created.cycles.push(c.id);
        return c;
    }

    async function seedGroupChat(group, creator) {
        const gc = await prisma.groupChat.create({
            data: {
                name: `susu_atom_gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                createdById: creator.id,
                susuGroupId: group.id,
            },
        });
        created.groupChats.push(gc.id);
        return gc;
    }

    async function seedMember(group, user, slot) {
        const m = await prisma.susuMember.create({
            data: { susuGroupId: group.id, userId: user.id, cycleSlot: slot, trustScore: 1, status: 'ACTIVE' },
        });
        created.members.push(m.id);
        return m;
    }

    function makeService(client, treasuryId) {
        const SusuCycleService = require('../services/susu/susuCycle.service');
        return new SusuCycleService(client, { treasuryUserId: treasuryId });
    }

    // Client extension: injects a real guarded wallet spend (via the BASE
    // client, so it commits immediately on its own connection) exactly
    // when the service's balance mutation is about to execute, and/or
    // forces the ledger write to fail. Nothing else is mocked.
    function raceClient({ memberUserId, spendAmount, throwOnHistoryType }) {
        let spent = false;
        let thrown = false;
        return prisma.$extends({
            query: {
                user: {
                    async update({ args, query }) {
                        if (!spent && memberUserId != null && args?.where?.id === memberUserId) {
                            spent = true;
                            await prisma.user.updateMany({
                                where: { id: memberUserId, availableBalance: { gte: spendAmount } },
                                data: { availableBalance: { decrement: spendAmount } },
                            });
                        }
                        return query(args);
                    },
                    async updateMany({ args, query }) {
                        if (!spent && memberUserId != null && args?.where?.id === memberUserId) {
                            spent = true;
                            await prisma.user.updateMany({
                                where: { id: memberUserId, availableBalance: { gte: spendAmount } },
                                data: { availableBalance: { decrement: spendAmount } },
                            });
                        }
                        return query(args);
                    },
                },
                transactionHistory: {
                    async create({ args, query }) {
                        if (!thrown && throwOnHistoryType && args?.data?.type === throwOnHistoryType) {
                            thrown = true;
                            throw new Error('forced TransactionHistory write failure');
                        }
                        return query(args);
                    },
                },
            },
        });
    }

    test('forced contribution race: wallet spend between read and debit leaves no negative balance', async () => {
        const group = await seedGroup();
        const member = await seedUser(10, 'race');
        const recipient = await seedUser(0, 'rrcpt');
        const treasury = await seedUser(0, 'rtrsry');
        const cycle = await seedCycle(group, recipient.id, 'PENDING');
        await seedMember(group, member, 1);

        // The forced spend drains the member's full balance at the exact
        // moment the Susu mutation is about to execute.
        const svc = makeService(raceClient({ memberUserId: member.id, spendAmount: 10 }), treasury.id);
        const result = await svc.processCycle(cycle.id);

        // The conditional decrement lost the race: the member is short,
        // the cycle parks in grace, and the balance never goes negative.
        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = await prisma.susuMember.findFirst({ where: { susuGroupId: group.id, userId: member.id } });

        expect(Number(memberAfter.availableBalance)).toBeGreaterThanOrEqual(0);
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(result.grace).toBe(true);
        expect(cycleAfter.status).toBe('COLLECTING_GRACE');
        expect(contributions).toHaveLength(0);
        expect(memberRow.status).toBe('ACTIVE');
        // Markers created by the grace entry are cleaned by exact id.
        const sent = await prisma.susuReminderSent.findMany({ where: { susuMemberId: { in: created.members } } });
        for (const s of sent) created.reminderSent.push(s.id);
    });

    test('forced SUSU_CONTRIBUTION ledger failure rolls the debit back', async () => {
        const group = await seedGroup();
        const member = await seedUser(10, 'ledg');
        const recipient = await seedUser(0, 'lrcpt');
        const treasury = await seedUser(0, 'ltrsry');
        const cycle = await seedCycle(group, recipient.id, 'PENDING');
        await seedMember(group, member, 1);

        const svc = makeService(
            raceClient({ throwOnHistoryType: 'SUSU_CONTRIBUTION' }),
            treasury.id,
        );
        await expect(svc.processCycle(cycle.id)).rejects.toThrow(/forced TransactionHistory write failure/);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const history = await prisma.transactionHistory.findMany({
            where: { userId: member.id, type: 'SUSU_CONTRIBUTION' },
        });

        // Fail-closed: no debit, no contribution row, no unaudited mutation.
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(10, 6);
        expect(contributions).toHaveLength(0);
        expect(history).toHaveLength(0);
        // The tick aborted; the cycle keeps its transient COLLECTING status
        // for idempotent stall-recovery retry.
        expect(cycleAfter.status).toBe('COLLECTING');
    });

    test('forced SUSU_SEIZURE ledger failure rolls the seizure back', async () => {
        const group = await seedGroup();
        const member = await seedUser(5, 'sleg'); // < contribution → seizure path
        const recipient = await seedUser(0, 'srcpt');
        const treasury = await seedUser(0, 'strsry');
        const cycle = await seedCycle(group, recipient.id, 'COLLECTING_GRACE', new Date(Date.now() - 60 * 1000));
        await seedMember(group, member, 1);

        const svc = makeService(
            raceClient({ throwOnHistoryType: 'SUSU_SEIZURE' }),
            treasury.id,
        );
        await expect(svc.processCycle(cycle.id)).rejects.toThrow(/forced TransactionHistory write failure/);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const recipientAfter = await prisma.user.findUnique({ where: { id: recipient.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = await prisma.susuMember.findFirst({ where: { susuGroupId: group.id, userId: member.id } });

        // Fail-closed: no seizure debit, no credit, no default, no SEIZED row.
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(5, 6);
        expect(Number(recipientAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(memberRow.status).toBe('ACTIVE');
        expect(contributions).toHaveLength(0);
        expect(cycleAfter.status).toBe('COLLECTING');
    });

    test('seizure vs concurrent wallet spend: both serializations are safe and exact', async () => {
        const group = await seedGroup();
        const member = await seedUser(5, 'conc'); // < contribution → seizure path
        const recipient = await seedUser(0, 'crcpt');
        const treasury = await seedUser(0, 'ctrsry');
        const cycle = await seedCycle(group, recipient.id, 'COLLECTING_GRACE', new Date(Date.now() - 60 * 1000));
        await seedMember(group, member, 1);
        await seedGroupChat(group, treasury); // hard-default path reads susu.groupChat.id

        const svc = makeService(prisma, treasury.id);

        // Real concurrency, no forced schedule. Valid serializations:
        //  (a) spend commits first: seizure locks and takes the remaining 3;
        //  (b) seizure locks first: takes the full 5, the guarded spend then no-ops.
        const [tick, spend] = await Promise.allSettled([
            svc.processCycle(cycle.id),
            prisma.user.updateMany({
                where: { id: member.id, availableBalance: { gte: 2 } },
                data: { availableBalance: { decrement: 2 } },
            }),
        ]);
        expect(tick.status).toBe('fulfilled');

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const recipientAfter = await prisma.user.findUnique({ where: { id: recipient.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = await prisma.susuMember.findFirst({ where: { susuGroupId: group.id, userId: member.id } });

        expect(contributions).toHaveLength(1);
        expect(contributions[0].status).toBe('SEIZED');
        const seized = Number(contributions[0].seizedFromAvailable);

        // Headline invariant in every serialization: never negative, and the
        // seizure took everything that remained.
        expect(Number(memberAfter.availableBalance)).toBeGreaterThanOrEqual(0);
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(memberRow.status).toBe('DEFAULTED');
        // The credit equals the debit exactly.
        expect(Number(recipientAfter.availableBalance)).toBeCloseTo(seized, 6);
        expect(seized).toBeGreaterThan(0);
        expect(spend.status).toBe('fulfilled'); // guarded spend: ran, possibly no-op
    });

    test('contribution vs concurrent wallet spend: both serializations are safe and exact', async () => {
        const group = await seedGroup();
        const member = await seedUser(10, 'pay');
        const recipient = await seedUser(10, 'prcpt'); // recipient is also a contributing member
        const treasury = await seedUser(0, 'ptrsry');
        const cycle = await seedCycle(group, recipient.id, 'PENDING');
        await seedMember(group, member, 1);
        await seedMember(group, recipient, 2);

        const svc = makeService(prisma, treasury.id);

        // Valid serializations:
        //  (a) spend commits first (10 → 6 < contribution): member shorts, cycle parks in grace;
        //  (b) contribution CAS commits first (10 → 0): the guarded spend no-ops, cycle pays out.
        await Promise.allSettled([
            svc.processCycle(cycle.id),
            prisma.user.updateMany({
                where: { id: member.id, availableBalance: { gte: 4 } },
                data: { availableBalance: { decrement: 4 } },
            }),
        ]);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const memberContrib = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = memberContrib.find((c) => c.userId === member.id);

        expect(Number(memberAfter.availableBalance)).toBeGreaterThanOrEqual(0);
        if (cycleAfter.status === 'PAID_OUT') {
            // Serialization (b): member paid, spend no-oped, recipient got the pool.
            expect(memberRow).toBeDefined();
            expect(memberRow.status).toBe('PAID');
            expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
            const recipientAfter = await prisma.user.findUnique({ where: { id: recipient.id } });
            expect(Number(recipientAfter.availableBalance)).toBeCloseTo(20, 6); // 10 − 10 own contribution + 20 pool
        } else {
            // Serialization (a): member short → grace; recipient paid their own contribution only...
            // recipient is not short, so the cycle cannot finalize this tick.
            expect(cycleAfter.status).toBe('COLLECTING_GRACE');
            expect(memberRow).toBeUndefined();
            expect(Number(memberAfter.availableBalance)).toBeCloseTo(6, 6);
        }
    });
});
