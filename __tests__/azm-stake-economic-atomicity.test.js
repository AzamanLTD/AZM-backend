// __tests__/azm-stake-economic-atomicity.test.js
// =============================================================================
// Real-PostgreSQL proof that AZM Nitro stakes are economically backed —
// DEBIT/RETURN model.
//
// Pre-fix defects (proven against the old implementation):
//   1. createStake never read/debited azmBalance — a user with ZERO AZM
//      could create a 5,000-AZM stake and instantly hold NITRO_GOLD,
//      unlocking premium storefront widgets/themes. Unlimited, uncapped,
//      concurrent-friendly (no dedup, no cap): two concurrent creates with 0
//      balance both committed.
//   2. completeUnstake flipped UNSTAKING→COMPLETED without crediting any
//      principal — coherent only because none was ever taken.
//   3. requestUnstake/completeUnstake transitions were read-then-write
//      (stale status checks) — both racing requests/workers succeeded.
//
// Post-fix invariants proven here (real PostgreSQL, gated on
// TEST_DATABASE_URL — CI's db-push database deliberately has NO
// SQL-migration CHECK constraints, so these tests exercise the
// application-level DB-boundary guarantees exactly as production runs):
//   A. Zero/insufficient AZM cannot create a stake (fail-closed: no stake
//      row, no ledger row, balance untouched).
//   B. createStake debit + stake + STAKE_LOCK ledger commit on ONE
//      transaction — a forced ledger failure rolls all three back.
//   C. Concurrent creates cannot spend the same AZM twice; azmBalance can
//      never go negative (the conditional gte mutation is the only
//      authorization).
//   D. requestUnstake is single-winner (CAS on ACTIVE).
//   E. Two racing completion workers release/credit/log exactly once (CAS
//      on UNSTAKING + elapsed cooldown, inside one transaction).
//   F. Replay after completion cannot credit again.
//   G. End-to-end earn → stake → unstake → release conserves AZM.
//   H. Nitro eligibility corresponds to actually backed stake rows —
//      including the product semantic that UNSTAKING stakes still hold the
//      locked principal and count toward the tier until cooldown completes.
//
// Racing schedules are forced deterministically with a Prisma client
// extension barrier (both racing operations complete their reads before
// either performs its mutation). All operations run against real PostgreSQL.
//
// Against the pre-fix implementation:
//   - A fails (the old createStake succeeded with zero AZM);
//   - C fails (both concurrent creates succeeded — no debit existed);
//   - D/E fail (both racing transitions succeeded);
//   - G fails (balance never left azmBalance and was never returned);
//   - H fails at the release step (eligibility kept counting a COMPLETED
//     stake because it counted every non-ACTIVE row's status too — the old
//     tier query read ACTIVE only, so it failed the other direction: it
//     STOPPED counting the locked-but-unstaking principal).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-stake-economic-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('AZM stake economic atomicity (real PostgreSQL)', () => {
    let prisma;
    const created = { users: [], stakes: [], businesses: [] };

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new (require('@prisma/client').PrismaClient)();
    });

    afterAll(async () => {
        if (!prisma) return;
        // Exact-id cleanup in FK order — no prefix sweeps, retry-safe.
        await prisma.azmStake.deleteMany({ where: { userId: { in: created.users } } }); // exact-user, retry-safe
        await prisma.azmSpendLog.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.azmRewardLog.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.businessProfile.deleteMany({ where: { id: { in: created.businesses } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
        await prisma.$disconnect();
    });

    const rnd = () => Math.random().toString(36).slice(2, 8);

    async function seedUser(azmBalance, tag = 'stake') {
        const u = await prisma.user.create({
            data: {
                username: `azm_stake_${tag}_${Date.now()}_${rnd()}`,
                email: `azm_stake_${tag}_${Date.now()}_${rnd()}@test.local`,
                password: 'test_password',
                role: 'USER',
                azmBalance,
            },
        });
        created.users.push(u.id);
        return u;
    }

    async function seedBusiness(userId) {
        const b = await prisma.businessProfile.create({
            data: {
                userId,
                bizId: `BIZ-${Math.floor(100000000 + Math.random() * 899999999)}`,
                businessName: `Stake Test Biz ${rnd()}`,
            },
        });
        created.businesses.push(b.id);
        return b;
    }

    const azm = (u) => parseFloat(u.azmBalance.toString());
    const svc = require('../services/azmStakeService');
    const storefront = require('../services/storefrontService');

    // ── A. Insufficient AZM cannot create a stake ─────────────────────────────

    test('A1: zero AZM cannot create a stake — fail-closed, nothing persisted', async () => {
        const user = await seedUser(0);
        await expect(svc.createStake(prisma, user.id, 5000)).rejects.toThrow(/Insufficient AZM balance/);

        expect(await prisma.azmStake.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.azmSpendLog.count({ where: { userId: user.id } })).toBe(0);
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBe(0);
    });

    test('A2: partial AZM cannot create an over-sized stake', async () => {
        const user = await seedUser(499.9999);
        await expect(svc.createStake(prisma, user.id, 500)).rejects.toThrow(/Insufficient AZM balance/);
        expect(await prisma.azmStake.count({ where: { userId: user.id } })).toBe(0);
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(499.9999, 6);
    });

    // ── B. createStake is atomic: debit + stake + ledger commit together ──────

    test('B1: successful createStake debits azmBalance and writes the STAKE_LOCK ledger atomically', async () => {
        const user = await seedUser(1000);
        const result = await svc.createStake(prisma, user.id, 600);

        expect(result.stake.status).toBe('ACTIVE');
        expect(parseFloat(result.stake.amountAzm.toString())).toBe(600);
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(400, 6);

        const log = await prisma.azmSpendLog.findFirst({ where: { userId: user.id, source: 'STAKE_LOCK' } });
        expect(log).not.toBeNull();
        expect(parseFloat(log.amount.toString())).toBe(600);
        expect(log.dedupKey).toBe(`stake_lock_${result.stake.id}`);
        expect(log.metadata.stakeId).toBe(result.stake.id);
        expect(parseFloat(log.balanceAfter.toString())).toBeCloseTo(400, 6);
    });

    test('B2: a forced STAKE_LOCK ledger failure rolls back the debit AND the stake row', async () => {
        const user = await seedUser(1000);
        // Force the in-transaction ledger insert to fail — the debit and the
        // stake must both roll back (no swallowed ledger errors).
        const broken = prisma.$extends({
            query: {
                azmSpendLog: {
                    async create({ args, query }) {
                        if (args?.data?.source === 'STAKE_LOCK') throw new Error('forced ledger outage');
                        return query(args);
                    },
                },
            },
        });
        await expect(svc.createStake(broken, user.id, 600)).rejects.toThrow('forced ledger outage');

        expect(await prisma.azmStake.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.azmSpendLog.count({ where: { userId: user.id } })).toBe(0);
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(1000, 6);
    });

    // ── C. Concurrent creates cannot double-spend ───────────────────────────

    test('C1: two concurrent creates against a single balance — exactly one commits, balance never negative', async () => {
        const user = await seedUser(700);
        const results = await Promise.allSettled([
            svc.createStake(prisma, user.id, 500),
            svc.createStake(prisma, user.id, 500),
        ]);
        const ok = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        expect(ok.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason.message).toMatch(/Insufficient AZM balance/);

        const balance = azm(await prisma.user.findUnique({ where: { id: user.id } }));
        expect(balance).toBeCloseTo(200, 6);
        expect(balance).toBeGreaterThanOrEqual(0);
        expect(await prisma.azmStake.count({ where: { userId: user.id } })).toBe(1);
        expect(await prisma.azmSpendLog.count({ where: { userId: user.id, source: 'STAKE_LOCK' } })).toBe(1);
    });

    test('C2: many concurrent creates can only lock what the balance affords', async () => {
        const user = await seedUser(1200);
        const results = await Promise.allSettled([
            svc.createStake(prisma, user.id, 500),
            svc.createStake(prisma, user.id, 500),
            svc.createStake(prisma, user.id, 500),
            svc.createStake(prisma, user.id, 500),
        ]);
        const ok = results.filter(r => r.status === 'fulfilled');
        expect(ok.length).toBe(2); // 1200 affords exactly two 500-AZM stakes

        const balance = azm(await prisma.user.findUnique({ where: { id: user.id } }));
        expect(balance).toBeCloseTo(200, 6);
        expect(balance).toBeGreaterThanOrEqual(0);
        expect(await prisma.azmStake.count({ where: { userId: user.id, status: 'ACTIVE' } })).toBe(2);
    });

    // ── D. requestUnstake is single-winner ───────────────────────────────────

    test('D1: two racing unstake requests produce exactly one UNSTAKING transition', async () => {
        const user = await seedUser(600);
        const { stake } = await svc.createStake(prisma, user.id, 600);

        // Force the stale-read interleaving: both requests complete their
        // pre-read before either performs its conditional mutation.
        let reads = 0, release;
        const barrier = new Promise(r => (release = r));
        const racing = prisma.$extends({
            query: {
                azmStake: {
                    async findUnique({ args, query }) {
                        const result = await query(args);
                        if (args?.where?.id === stake.id) {
                            reads++;
                            if (reads === 1) await barrier;
                            else if (reads === 2) release();
                        }
                        return result;
                    },
                },
            },
        });

        const results = await Promise.allSettled([
            svc.requestUnstake(racing, user.id, stake.id),
            svc.requestUnstake(racing, user.id, stake.id),
        ]);
        const ok = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        expect(ok.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason.message).toBe('Stake is not active.');

        const row = await prisma.azmStake.findUnique({ where: { id: stake.id } });
        expect(row.status).toBe('UNSTAKING');
        expect(row.unstakeRequestedAt).not.toBeNull();
        expect(row.unstakeAvailableAt).not.toBeNull();
        // The principal stays locked during cooldown.
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(0, 6);
    });

    // ── E. Two racing completion workers release exactly once ────────────────

    test('E1: two racing completeUnstake workers credit the principal exactly once', async () => {
        const user = await seedUser(600);
        const { stake } = await svc.createStake(prisma, user.id, 600);
        await svc.requestUnstake(prisma, user.id, stake.id);
        await prisma.azmStake.update({
            where: { id: stake.id },
            data: { unstakeAvailableAt: new Date(Date.now() - 1000) },
        });

        // Force the stale-read interleaving: both workers complete their
        // in-transaction pre-read before either performs its CAS.
        let reads = 0, release;
        const barrier = new Promise(r => (release = r));
        const racing = prisma.$extends({
            query: {
                azmStake: {
                    async findUnique({ args, query }) {
                        const result = await query(args);
                        if (args?.where?.id === stake.id) {
                            reads++;
                            if (reads === 1) await barrier;
                            else if (reads === 2) release();
                        }
                        return result;
                    },
                },
            },
        });

        const results = await Promise.all([
            svc.completeUnstake(racing, stake.id),
            svc.completeUnstake(racing, stake.id),
        ]);
        const winners = results.filter(r => r !== null);
        const losers = results.filter(r => r === null);

        expect(winners.length).toBe(1);
        expect(losers.length).toBe(1);
        expect(winners[0].status).toBe('COMPLETED');

        // Exactly one credit, one release ledger event, one terminal flip.
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(600, 6);
        expect(await prisma.azmRewardLog.count({ where: { userId: user.id, source: 'STAKE_RELEASE' } })).toBe(1);
        expect(await prisma.azmStake.count({ where: { id: stake.id, status: 'COMPLETED' } })).toBe(1);
    });

    // ── F. Replay after completion cannot credit again ───────────────────────

    test('F1: replaying completeUnstake after completion is a no-op — no double credit', async () => {
        const user = await seedUser(600);
        const { stake } = await svc.createStake(prisma, user.id, 600);
        await svc.requestUnstake(prisma, user.id, stake.id);
        await prisma.azmStake.update({
            where: { id: stake.id },
            data: { unstakeAvailableAt: new Date(Date.now() - 1000) },
        });

        const first = await svc.completeUnstake(prisma, stake.id);
        expect(first.status).toBe('COMPLETED');
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(600, 6);

        const replay = await svc.completeUnstake(prisma, stake.id);
        expect(replay).toBeNull();
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(600, 6);
        expect(await prisma.azmRewardLog.count({ where: { userId: user.id, source: 'STAKE_RELEASE' } })).toBe(1);
    });

    // ── G. End-to-end conservation ───────────────────────────────────────────

    test('G1: earn → stake → unstake → release conserves AZM and moves the tier correctly', async () => {
        const user = await seedUser(1000);

        const staked = await svc.createStake(prisma, user.id, 600);
        expect(staked.tier).toBe('NITRO_BRONZE');
        expect(staked.stakedBalance).toBe(600);
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(400, 6);

        // While the stake holds the principal, the AZM is NOT freely spendable
        // elsewhere: a second stake can only use what is left.
        await expect(svc.createStake(prisma, user.id, 500)).rejects.toThrow(/Insufficient AZM balance/);

        await svc.requestUnstake(prisma, user.id, staked.stake.id);
        // Tier is retained during cooldown (UNSTAKING still holds the principal).
        expect(await svc.getUserTier(prisma, user.id)).toBe('NITRO_BRONZE');
        expect(await svc.getStakedBalance(prisma, user.id)).toBe(600);

        await prisma.azmStake.update({
            where: { id: staked.stake.id },
            data: { unstakeAvailableAt: new Date(Date.now() - 1000) },
        });
        const queue = await svc.processUnstakeQueue(prisma);
        expect(queue.completed).toBe(1);

        // Conservation: the principal is back, tier falls, ledger is exact.
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(1000, 6);
        expect(await svc.getUserTier(prisma, user.id)).toBe('FREE');
        expect(await svc.getStakedBalance(prisma, user.id)).toBe(0);

        const spendLogs = await prisma.azmSpendLog.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        const rewardLogs = await prisma.azmRewardLog.findMany({ where: { userId: user.id } });
        expect(spendLogs.length).toBe(1);
        expect(spendLogs[0].source).toBe('STAKE_LOCK');
        expect(parseFloat(spendLogs[0].balanceAfter.toString())).toBeCloseTo(400, 6);
        expect(rewardLogs.length).toBe(1);
        expect(rewardLogs[0].source).toBe('STAKE_RELEASE');
        expect(parseFloat(rewardLogs[0].balanceAfter.toString())).toBeCloseTo(1000, 6);
    });

    // ── H. Eligibility corresponds to backed stake rows ───────────────────────

    test('H1: storefront Nitro eligibility follows the backed stake lifecycle (ACTIVE → UNSTAKING → COMPLETED)', async () => {
        const user = await seedUser(600);
        const business = await seedBusiness(user.id);
        // A NITRO_BRONZE premium widget in the layout.
        const layoutJson = { tiles: [{ id: 't1', widgetType: 'video_player' }] };

        // FREE tier: the premium widget is a violation.
        let eligibility = await storefront.validateNitroEligibility(prisma, business.id, layoutJson, null);
        expect(eligibility.eligible).toBe(false);
        expect(eligibility.tier).toBe('FREE');

        const { stake } = await svc.createStake(prisma, user.id, 600);
        created.stakes.push(stake.id);

        // Backed stake: BRONZE reached, widget allowed.
        eligibility = await storefront.validateNitroEligibility(prisma, business.id, layoutJson, null);
        expect(eligibility.eligible).toBe(true);
        expect(eligibility.tier).toBe('NITRO_BRONZE');
        expect(eligibility.stakedBalance).toBe(600);

        // During cooldown the principal is still locked — eligibility RETAINED
        // (product semantic: UNSTAKING counts until completion).
        await svc.requestUnstake(prisma, user.id, stake.id);
        eligibility = await storefront.validateNitroEligibility(prisma, business.id, layoutJson, null);
        expect(eligibility.eligible).toBe(true);
        expect(eligibility.tier).toBe('NITRO_BRONZE');

        // After release: the principal is back in azmBalance and the premium
        // widget is a violation again.
        await prisma.azmStake.update({
            where: { id: stake.id },
            data: { unstakeAvailableAt: new Date(Date.now() - 1000) },
        });
        await svc.processUnstakeQueue(prisma);
        eligibility = await storefront.validateNitroEligibility(prisma, business.id, layoutJson, null);
        expect(eligibility.eligible).toBe(false);
        expect(eligibility.tier).toBe('FREE');
        expect(azm(await prisma.user.findUnique({ where: { id: user.id } }))).toBeCloseTo(600, 6);
    });
});
