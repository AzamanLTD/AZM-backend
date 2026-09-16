// __tests__/legacy-susu-economic-atomicity.test.js
// Real-PostgreSQL proof of the legacy Susu (susuService.js) economic
// integrity fixes. The legacy worker (workers/susuWorker.js) is LIVE for
// legacy groups (susu.contractVersion null), so this path moves real money.
//
// Proven findings fixed by this suite:
//   F1. Contribution/seizure affordability was a stale-read TOCTOU —
//       findUnique(availableBalance) → JS gte → unconditional decrement.
//       A wallet spend between the read and the decrement committed a
//       negative balance on the CI database (db push has no SQL-migration
//       CHECK constraints); in production the CHECK abort landed in a
//       catch that manufactured a default (ban + trust penalties) for a
//       member whose money never moved.
//   F2. PENDING → COLLECTING was a blind update, not a compare-and-set:
//       two concurrent ticks both won "ownership" and both ran the member
//       loop and the payout. The unique contribution row rolled back the
//       loser's debit — but the loser's catch then reclassified the
//       fully-paid member as a default (ban, strikes, voucher penalties),
//       and both payout transactions ran.
//   F3. A member-transaction failure was reclassified as a default and the
//       cycle finalized anyway.
//   F4. The payout batch wrote TransactionHistory with userId: null on a
//       NOT NULL column — a guaranteed Prisma validation error that
//       aborted the ENTIRE payout transaction AFTER the member debits had
//       committed: members debited, winner never paid, cycle permanently
//       stranded in COLLECTING (the worker only selects PENDING).
//   F5. Contribution/seizure wallet debits had NO TransactionHistory
//       ledger rows at all.
//
// Against the pre-fix implementation every test below fails at its
// headline assertion. Race schedules are forced deterministically with
// Prisma client extensions (a real guarded spend via the base client at
// the exact mutation moment, a forced ledger failure, or a pinned entry
// read); all other operations are real DB / real transactions.

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[legacy-susu-economic-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Legacy Susu economic atomicity (real PostgreSQL)', () => {
    let prisma;
    const created = { users: [], groups: [], cycles: [], members: [], contributions: [] };

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
        if (created.cycles.length) {
            await prisma.adminProfitLog.deleteMany({
                where: {
                    source: 'SUSU_FEE',
                    relatedTxId: { in: created.cycles.map((id) => `susu_fee_${id}`) },
                },
            });
        }
        await prisma.susuMember.deleteMany({ where: { id: { in: created.members } } });
        await prisma.susuCycle.deleteMany({ where: { id: { in: created.cycles } } });
        await prisma.susuGroup.deleteMany({ where: { id: { in: created.groups } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
        await prisma.$disconnect();
    });

    async function seedUser(availableBalance, tag) {
        const u = await prisma.user.create({
            data: {
                username: `susu_legacy_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                email: `susu_legacy_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.local`,
                password: 'test_password',
                role: 'USER',
                availableBalance,
            },
        });
        created.users.push(u.id);
        return u;
    }

    // A LEGACY group: contractVersion null → owned by susuWorker/susuService.
    async function seedGroup(contributionUsdc) {
        const g = await prisma.susuGroup.create({
            data: {
                status: 'ACTIVE',
                contributionUsdc,
                frequency: 'WEEKLY',
                totalCycles: 1,
                startDate: new Date(),
                contractRequiredCount: 2,
                contractAcceptedCount: 2,
                rotationSnapshot: [],
                contractVersion: null,
            },
        });
        created.groups.push(g.id);
        return g;
    }

    async function seedCycle(group, payoutUserId, status, startedCollectingAt) {
        const c = await prisma.susuCycle.create({
            data: {
                susuGroupId: group.id,
                cycleNumber: 1,
                collectionDate: new Date(Date.now() - 60 * 60 * 1000),
                payoutUserId,
                status,
                payoutAmount: 0,
                ...(startedCollectingAt ? { startedCollectingAt } : {}),
            },
        });
        created.cycles.push(c.id);
        return c;
    }

    async function seedMember(group, user, slot) {
        const m = await prisma.susuMember.create({
            data: { susuGroupId: group.id, userId: user.id, cycleSlot: slot, trustScore: 100, status: 'ACTIVE' },
        });
        created.members.push(m.id);
        return m;
    }

    function makeService(client) {
        const { SusuService } = require('../services/susuService');
        return new SusuService(client, undefined, undefined, undefined);
    }

    // Prisma client extension forcing race schedules / failures:
    //  - spendAmount + memberUserId: a real guarded wallet spend (base
    //    client, commits immediately) at the exact moment the service's
    //    balance mutation for that member is about to execute;
    //  - throwOnHistoryType: force a TransactionHistory write to fail once;
    //  - throwOnContributionCreate: force the susuContribution.create to
    //    fail once;
    //  - memoizeCycleId: pin both concurrent processCycle entry reads to
    //    the same early PENDING snapshot (a real possible serialization).
    function raceClient({ memberUserId, spendAmount, throwOnHistoryType, throwOnContributionCreate, memoizeCycleId }) {
        let spent = false;
        let thrown = false;
        let thrownCreate = false;
        let memo = null;
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
                susuContribution: {
                    async create({ args, query }) {
                        if (!thrownCreate && throwOnContributionCreate) {
                            thrownCreate = true;
                            throw new Error('forced susuContribution write failure');
                        }
                        return query(args);
                    },
                },
                susuCycle: {
                    async findUnique({ args, query }) {
                        if (memoizeCycleId && args?.where?.id === memoizeCycleId) {
                            if (!memo) memo = await query(args);
                            return memo;
                        }
                        return query(args);
                    },
                },
            },
        });
    }

    test('full legacy cycle: contributions, seizure, fee, payout and ledger all atomically consistent', async () => {
        // Three members: two pay 10, one holds only 5 → seizure of 5.
        // Pool = 25, fee = 3% (0.75), net payout = 24.25 to member 1.
        const group = await seedGroup(10);
        const winner = await seedUser(10, 'full_w');
        const m2 = await seedUser(10, 'full_2');
        const short = await seedUser(5, 'full_3');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, winner, 1);
        await seedMember(group, m2, 2);
        await seedMember(group, short, 3);

        const svc = makeService(prisma);
        const report = await svc.processCycle(cycle.id);

        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        const m2After = await prisma.user.findUnique({ where: { id: m2.id } });
        const shortAfter = await prisma.user.findUnique({ where: { id: short.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = await prisma.susuMember.findFirst({ where: { susuGroupId: group.id, userId: short.id } });
        const history = await prisma.transactionHistory.findMany({ where: { userId: { in: [winner.id, m2.id, short.id] } } });
        const profitLogs = await prisma.adminProfitLog.findMany({
            where: { source: 'SUSU_FEE', relatedTxId: `susu_fee_${cycle.id}` },
        });
        const groupAfter = await prisma.susuGroup.findUnique({ where: { id: group.id } });

        // Money: 10 − 10 + 24.25 for the winner; 0 for m2; 0 for the defaulter.
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(24.25, 6);
        expect(Number(m2After.availableBalance)).toBeCloseTo(0, 6);
        expect(Number(shortAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(Number(shortAfter.availableBalance)).toBeGreaterThanOrEqual(0);

        // Cycle terminal record.
        expect(cycleAfter.status).toBe('DEFAULTED'); // legacy semantics: any default marks the cycle
        expect(Number(cycleAfter.payoutAmount)).toBeCloseTo(24.25, 6);
        expect(Number(cycleAfter.feeUsdc)).toBeCloseTo(0.75, 6);
        expect(cycleAfter.defaultsCount).toBe(1);
        expect(cycleAfter.paidOutAt).not.toBeNull();

        // Contribution rows: 2 PAID + 1 SEIZED(5).
        expect(contributions).toHaveLength(3);
        const seizedRow = contributions.find((c) => c.status === 'SEIZED');
        expect(Number(seizedRow.seizedFromAvailable)).toBeCloseTo(5, 6);
        expect(memberRow.status).toBe('DEFAULTED');
        expect(Number(memberRow.totalSeizedUsdc)).toBeCloseTo(5, 6);
        expect(shortAfter.banStatus).toBe('BANNED_INDEF');

        // Wallet ledger now exists for every economic effect.
        const byType = {};
        for (const h of history) byType[h.type] = (byType[h.type] || []).concat(h);
        expect(byType.SUSU_CONTRIBUTION).toHaveLength(2);
        expect(Number(byType.SUSU_CONTRIBUTION[0].amountUsdc)).toBeCloseTo(-10, 6);
        expect(byType.SUSU_SEIZURE).toHaveLength(1);
        expect(Number(byType.SUSU_SEIZURE[0].amountUsdc)).toBeCloseTo(-5, 6);
        expect(byType.SUSU_PAYOUT).toHaveLength(1);
        expect(Number(byType.SUSU_PAYOUT[0].amountUsdc)).toBeCloseTo(24.25, 6);
        expect(byType.SUSU_PAYOUT[0].status).toBe('COMPLETED');
        expect(byType.SUSU_PROFIT).toHaveLength(1);
        expect(Number(byType.SUSU_PROFIT[0].amountUsdc)).toBeCloseTo(-0.75, 6);
        expect(profitLogs).toHaveLength(1);
        expect(Number(profitLogs[0].amountUsdc)).toBeCloseTo(0.75, 6);
        expect(profitLogs[0].relatedTxId).toBe(`susu_fee_${cycle.id}`);

        // Report and group completion.
        expect(report.paid).toBe(2);
        expect(report.defaulted).toBe(1);
        expect(report.totalCollected).toBeCloseTo(25, 6);
        expect(report.netPayout).toBeCloseTo(24.25, 6);
        expect(groupAfter.status).toBe('COMPLETED');
    });

    test('forced contribution race: wallet spend between read and debit leaves no negative balance', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(10, 'race_m');
        const winner = await seedUser(0, 'race_w');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, member, 1);

        // The forced spend drains the member's full balance at the exact
        // moment the Susu mutation is about to execute. Pre-fix: the stale
        // read authorized a 10 USDC debit against a 0 balance → −10.
        const svc = makeService(raceClient({ memberUserId: member.id, spendAmount: 10 }));
        await svc.processCycle(cycle.id);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const memberRow = await prisma.susuMember.findFirst({ where: { susuGroupId: group.id, userId: member.id } });

        // The conditional decrement lost the race: no negative balance.
        expect(Number(memberAfter.availableBalance)).toBeGreaterThanOrEqual(0);
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
        // The member falls through to the legacy hard-default branch: seized
        // whatever remained (0), recorded, defaulted, and the cycle
        // finalized without paying an unearned pool.
        expect(contributions).toHaveLength(1);
        expect(contributions[0].status).toBe('SEIZED');
        expect(Number(contributions[0].seizedFromAvailable)).toBeCloseTo(0, 6);
        expect(memberRow.status).toBe('DEFAULTED');
        expect(cycleAfter.status).toBe('DEFAULTED');
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(Number(cycleAfter.payoutAmount)).toBeCloseTo(0, 6);
    });

    test('forced seizure race: stale seizable amount never drives the balance negative', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(5, 'sz_m'); // < contribution → seizure branch
        const winner = await seedUser(0, 'sz_w');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, member, 1);

        // Pre-fix: seizable came from the unlocked read (5); the forced
        // spend drained all 5 before the unconditional decrement → −5.
        const svc = makeService(raceClient({ memberUserId: member.id, spendAmount: 5 }));
        await svc.processCycle(cycle.id);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });

        expect(Number(memberAfter.availableBalance)).toBeGreaterThanOrEqual(0);
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(contributions).toHaveLength(1);
        expect(contributions[0].status).toBe('SEIZED');
        expect(Number(contributions[0].seizedFromAvailable)).toBeCloseTo(0, 6);
        expect(cycleAfter.status).toBe('DEFAULTED');
        // Nothing was debited, so nothing was pooled or paid out.
        expect(Number(cycleAfter.payoutAmount)).toBeCloseTo(0, 6);
    });

    test('two concurrent processCycle ticks: exactly one claims and processes, no manufactured default', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(10, 'conc_m');
        const winner = await seedUser(0, 'conc_w');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, member, 1);

        // Both entry reads pinned to the same early PENDING snapshot (a
        // real possible serialization). Pre-fix: the blind COLLECTING flip
        // let both ticks through; the loser's duplicate contribution row
        // (P2002) was reclassified as a default — the fully-paid member
        // was banned with trust penalties — and both payout transactions
        // ran.
        const svc = makeService(raceClient({ memoizeCycleId: cycle.id }));
        const outcomes = await Promise.allSettled([
            svc.processCycle(cycle.id),
            svc.processCycle(cycle.id),
        ]);
        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });
        const payoutRows = await prisma.transactionHistory.findMany({
            where: { userId: winner.id, type: 'SUSU_PAYOUT' },
        });
        const profitLogs = await prisma.adminProfitLog.findMany({
            where: { source: 'SUSU_FEE', relatedTxId: `susu_fee_${cycle.id}` },
        });

        // Exactly one tick won the claim; the other skipped.
        expect(fulfilled).toHaveLength(2);
        expect(fulfilled.filter((r) => r && r.skipped)).toHaveLength(1);

        // The member paid exactly once and was NOT punished for it.
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(0, 6);
        expect(memberAfter.banStatus).not.toBe('BANNED_INDEF');
        expect(contributions).toHaveLength(1);
        expect(contributions[0].status).toBe('PAID');

        // Single payout: 10 − 0.30 fee = 9.70, once.
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(9.70, 6);
        expect(payoutRows).toHaveLength(1);
        expect(profitLogs).toHaveLength(1);
        expect(cycleAfter.status).toBe('PAID_OUT');
        expect(Number(cycleAfter.payoutAmount)).toBeCloseTo(9.70, 6);
    });

    test('member transaction failure aborts the tick and retries idempotently — never a manufactured default', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(10, 'fail_m');
        const winner = await seedUser(0, 'fail_w');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, member, 1);

        // Force the contribution write to fail once. Pre-fix: the catch
        // reclassified the failure as a default (ban, no contribution row,
        // no seizure) and finalized the cycle anyway.
        const svc = makeService(raceClient({ throwOnContributionCreate: true }));
        await expect(svc.processCycle(cycle.id)).rejects.toThrow(/forced susuContribution write failure/);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });

        // Fail-closed: no debit, no default, no manufactured punishment.
        expect(Number(memberAfter.availableBalance)).toBeCloseTo(10, 6);
        expect(memberAfter.banStatus).not.toBe('BANNED_INDEF');
        expect(contributions).toHaveLength(0);
        // The claim was released for an immediate idempotent retry.
        expect(cycleAfter.status).toBe('PENDING');

        // The next tick processes the cycle cleanly.
        const report = await svc.processCycle(cycle.id);
        expect(report.paid).toBe(1);
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        const memberFinal = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleFinal = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        expect(Number(memberFinal.availableBalance)).toBeCloseTo(0, 6);
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(9.70, 6);
        expect(cycleFinal.status).toBe('PAID_OUT');
    });

    test('forced SUSU_CONTRIBUTION ledger failure rolls the debit back and the tick retries', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(10, 'ledg_m');
        const winner = await seedUser(0, 'ledg_w');
        const cycle = await seedCycle(group, winner.id, 'PENDING');
        await seedMember(group, member, 1);

        // The ledger row is part of the economic operation: a write failure
        // must not commit an unaudited debit.
        const svc = makeService(raceClient({ throwOnHistoryType: 'SUSU_CONTRIBUTION' }));
        await expect(svc.processCycle(cycle.id)).rejects.toThrow(/forced TransactionHistory write failure/);

        const memberAfter = await prisma.user.findUnique({ where: { id: member.id } });
        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const contributions = await prisma.susuContribution.findMany({ where: { cycleId: cycle.id } });

        expect(Number(memberAfter.availableBalance)).toBeCloseTo(10, 6);
        expect(contributions).toHaveLength(0);
        expect(cycleAfter.status).toBe('PENDING');
        expect(memberAfter.banStatus).not.toBe('BANNED_INDEF');

        // Idempotent retry succeeds with full audit trail.
        const report = await svc.processCycle(cycle.id);
        expect(report.paid).toBe(1);
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(9.70, 6);
    });

    test('crash-stranded COLLECTING cycle is reclaimed and completed; fresh COLLECTING is not stolen', async () => {
        // A tick crashed mid-collection 6 minutes ago.
        const group = await seedGroup(10);
        const member = await seedUser(10, 'stall_m');
        const winner = await seedUser(0, 'stall_w');
        const staleCycle = await seedCycle(group, winner.id, 'COLLECTING', new Date(Date.now() - 6 * 60 * 1000));
        await seedMember(group, member, 1);

        const svc = makeService(prisma);
        const report = await svc.processCycle(staleCycle.id);

        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: staleCycle.id } });
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        expect(report.skipped).toBeUndefined();
        expect(cycleAfter.status).toBe('PAID_OUT');
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(9.70, 6);

        // A FRESH COLLECTING cycle (a live worker's active tick) is not
        // claimable by anyone else.
        const group2 = await seedGroup(10);
        const member2 = await seedUser(10, 'fresh_m');
        const winner2 = await seedUser(0, 'fresh_w');
        const freshCycle = await seedCycle(group2, winner2.id, 'COLLECTING', new Date());
        await seedMember(group2, member2, 1);

        const result = await svc.processCycle(freshCycle.id);
        const member2After = await prisma.user.findUnique({ where: { id: member2.id } });
        const freshAfter = await prisma.susuCycle.findUnique({ where: { id: freshCycle.id } });
        expect(result.skipped).toBe(true);
        expect(freshAfter.status).toBe('COLLECTING');
        expect(Number(member2After.availableBalance)).toBeCloseTo(10, 6);
    });

    test('the legacy worker sweep itself recovers crash-stranded cycles', async () => {
        const group = await seedGroup(10);
        const member = await seedUser(10, 'worker_m');
        const winner = await seedUser(0, 'worker_w');
        const cycle = await seedCycle(group, winner.id, 'COLLECTING', new Date(Date.now() - 6 * 60 * 1000));
        await seedMember(group, member, 1);

        const svc = makeService(prisma);
        const SusuWorker = require('../workers/susuWorker');
        const worker = new SusuWorker(prisma, svc);
        await worker._tick();

        const cycleAfter = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
        const winnerAfter = await prisma.user.findUnique({ where: { id: winner.id } });
        expect(cycleAfter.status).toBe('PAID_OUT');
        expect(Number(winnerAfter.availableBalance)).toBeCloseTo(9.70, 6);
    });
});
