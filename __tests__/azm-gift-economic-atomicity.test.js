// __tests__/azm-gift-economic-atomicity.test.js
// =============================================================================
// Real-PostgreSQL proof that AZM gift sends are economically atomic and
// idempotent.
//
// Pre-fix defects (proven against main e68f0ce — see the temporary probe run
// documented in the PR; the old sendGift was debit-tx -> credit-tx ->
// bare gift-create):
//   1. creditAzm swallowed non-P2002 failures — a credit failure left the
//      debit COMMITTED, the receiver uncredited, a gift row claiming success,
//      and the controller returned HTTP 200.
//   2. The debit dedupKey embedded Date.now() — a logical retry NEVER
//      converged: every attempt double-debited and double-credited.
//   3. No transaction composed the three writes — no failure could roll
//      anything back.
//   4. Debit authorization was stale read-then-decrement — racing spends
//      reached the DB CHECK floor and surfaced raw CHECK violations.
//
// Post-fix invariants proven here (real PostgreSQL, gated on
// TEST_DATABASE_URL):
//   A. credit failure rolls the ENTIRE transfer back;
//   B. gift-create failure rolls the ENTIRE transfer back;
//   C. sequential same-key replay converges to exactly one movement;
//   D. concurrent same-key requests converge safely — one winner, one
//      converged result, no duplicates, no rejections;
//   E. concurrent distinct gifts cannot overdraw the sender: exactly one
//      winner, losers get the clean 'Insufficient AZM balance' contract
//      (never a raw CHECK violation, never negative);
//   F. receiver-side concurrent credits both commit exactly once with
//      authoritative balanceAfter chains;
//   G. failure then same-key retry: zero state after the failed attempt,
//      exactly one movement after the retry;
//   H. missing/invalid Idempotency-Key is rejected before any mutation;
//   I. forced gift-claim race (barrier-extension: both transactions miss the
//      fast path) — exactly one authoritative gift, loser converges;
//   J. ledger correctness: sources, deterministic dedup keys, authoritative
//      balanceAfter, exact sender/receiver reconciliation.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-gift-economic-atomicity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('AZM gift economic atomicity (real PostgreSQL)', () => {
    let prisma;
    const created = { users: [] };
    const rnd = () => Math.random().toString(36).slice(2, 8);
    let seq = 0;

    const {
        sendGiftTransfer,
        GiftValidationError,
    } = require('../services/azmGiftService');

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new (require('@prisma/client').PrismaClient)();
    });

    afterAll(async () => {
        if (!prisma) return;
        // Exact-id cleanup in FK order — no prefix sweeps, retry-safe.
        await prisma.azmGift.deleteMany({
            where: { OR: [{ senderId: { in: created.users } }, { receiverId: { in: created.users } }] },
        });
        await prisma.azmSpendLog.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.azmRewardLog.deleteMany({ where: { userId: { in: created.users } } });
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
        await prisma.$disconnect();
    });

    async function seedUser(azmBalance, tag = 'gift') {
        seq += 1;
        const u = await prisma.user.create({
            data: {
                username: `azm_gift_${tag}_${seq}_${rnd()}`,
                email: `azm_gift_${tag}_${seq}_${rnd()}@test.local`,
                password: 'test_password',
                role: 'USER',
                azmBalance,
            },
        });
        created.users.push(u.id);
        return u;
    }

    const azm = (u) => parseFloat(u.azmBalance.toString());
    const bal = async (id) => azm(await prisma.user.findUniqueOrThrow({ where: { id } }));
    const key = () => `gift-key-${Date.now()}-${rnd()}-${seq}`;

    const counts = async (...userIds) => ({
        spend: await prisma.azmSpendLog.count({ where: { userId: { in: userIds }, source: 'GIFT_TIP' } }),
        reward: await prisma.azmRewardLog.count({ where: { userId: { in: userIds }, source: 'GIFT_TIP_RECEIVED' } }),
        gift: await prisma.azmGift.count({
            where: { OR: [{ senderId: { in: userIds } }, { receiverId: { in: userIds } }] },
        }),
    });

    const send = (client, params) => sendGiftTransfer(client, null, params);

    // ── A. Credit failure rolls the ENTIRE transfer back ─────────────────────
    test('A. forced credit failure: no debit, no credit, no gift, error propagates (not swallowed)', async () => {
        const sender = await seedUser(10, 'a-s');
        const receiver = await seedUser(0, 'a-r');
        const idem = key();

        let thrown = false;
        const failing = prisma.$extends({
            query: {
                azmRewardLog: {
                    async create({ args, query }) {
                        if (!thrown && args?.data?.source === 'GIFT_TIP_RECEIVED') {
                            thrown = true;
                            throw new Error('forced credit ledger failure');
                        }
                        return query(args);
                    },
                },
            },
        });

        await expect(
            send(failing, { senderId: sender.id, receiverId: receiver.id, amount: 5, type: 'GIFT', idempotencyKey: idem })
        ).rejects.toThrow('forced credit ledger failure');

        expect(await bal(sender.id)).toBe(10);     // debit rolled back
        expect(await bal(receiver.id)).toBe(0);    // credit never landed
        const c = await counts(sender.id, receiver.id);
        expect(c).toEqual({ spend: 0, reward: 0, gift: 0 });
    });

    // ── B. Gift-create failure rolls the ENTIRE transfer back ─────────────────
    test('B. forced gift-create failure: balances untouched, no ledger rows, no gift', async () => {
        const sender = await seedUser(10, 'b-s');
        const receiver = await seedUser(0, 'b-r');
        const idem = key();

        let thrown = false;
        const failing = prisma.$extends({
            query: {
                azmGift: {
                    async create({ args, query }) {
                        if (!thrown) { thrown = true; throw new Error('forced gift create failure'); }
                        return query(args);
                    },
                },
            },
        });

        await expect(
            send(failing, { senderId: sender.id, receiverId: receiver.id, amount: 5, type: 'GIFT', idempotencyKey: idem })
        ).rejects.toThrow('forced gift create failure');

        expect(await bal(sender.id)).toBe(10);
        expect(await bal(receiver.id)).toBe(0);
        const c = await counts(sender.id, receiver.id);
        expect(c).toEqual({ spend: 0, reward: 0, gift: 0 });
    });

    // ── C. Sequential same-key replay converges ───────────────────────────────
    test('C. same key twice: exactly one movement, second call is a replay', async () => {
        const sender = await seedUser(10, 'c-s');
        const receiver = await seedUser(0, 'c-r');
        const idem = key();

        const first = await send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem });
        expect(first.replay).toBe(false);
        expect(first.debited).toBe(true);
        expect(first.credited).toBe(true);

        const second = await send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem });
        expect(second.replay).toBe(true);
        expect(second.gift.id).toBe(first.gift.id);   // converged to the SAME gift
        expect(second.debited).toBe(false);
        expect(second.credited).toBe(false);

        expect(await bal(sender.id)).toBe(6);
        expect(await bal(receiver.id)).toBe(4);
        const c = await counts(sender.id, receiver.id);
        expect(c).toEqual({ spend: 1, reward: 1, gift: 1 });  // exactly once
    });

    // ── D. Concurrent same-key requests converge safely ───────────────────────
    test('D. concurrent same-key: one economic operation, all callers resolve, no duplicates', async () => {
        const sender = await seedUser(10, 'd-s');
        const receiver = await seedUser(0, 'd-r');
        const idem = key();

        const results = await Promise.all([
            send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem }),
            send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem }),
            send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem }),
        ]);

        // No rejection: the DB unique gates + P2002 convergence absorb the race.
        const giftIds = new Set(results.map((r) => r.gift.id));
        expect(giftIds.size).toBe(1);                       // one authoritative gift
        expect(results.filter((r) => !r.replay)).toHaveLength(1); // exactly one executor
        for (const r of results.filter((x) => x.replay)) {
            expect(r.debited).toBe(false);
            expect(r.credited).toBe(false);
        }

        expect(await bal(sender.id)).toBe(6);
        expect(await bal(receiver.id)).toBe(4);
        const c = await counts(sender.id, receiver.id);
        expect(c).toEqual({ spend: 1, reward: 1, gift: 1 });
    });

    // ── E. Concurrent distinct gifts vs sender balance ─────────────────────────
    test('E. balance 10, three concurrent 6-AZM gifts: exactly one wins, losers get clean insufficient contract', async () => {
        const sender = await seedUser(10, 'e-s');
        const r1 = await seedUser(0, 'e-r1');
        const r2 = await seedUser(0, 'e-r2');
        const r3 = await seedUser(0, 'e-r3');

        const settles = await Promise.allSettled([
            send(prisma, { senderId: sender.id, receiverId: r1.id, amount: 6, type: 'GIFT', idempotencyKey: key() }),
            send(prisma, { senderId: sender.id, receiverId: r2.id, amount: 6, type: 'GIFT', idempotencyKey: key() }),
            send(prisma, { senderId: sender.id, receiverId: r3.id, amount: 6, type: 'GIFT', idempotencyKey: key() }),
        ]);

        const wins = settles.filter((s) => s.status === 'fulfilled');
        const losses = settles.filter((s) => s.status === 'rejected');
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(2);
        for (const l of losses) {
            // The clean historical contract — never a raw CHECK violation.
            expect(l.reason.message).toMatch(/Insufficient AZM balance/);
        }

        expect(await bal(sender.id)).toBe(4);   // 10 - exactly one 6
        expect(await bal(sender.id)).toBeGreaterThanOrEqual(0);
        const winnerReceiver = wins[0].value.gift.receiverId;
        for (const r of [r1, r2, r3]) {
            expect(await bal(r.id)).toBe(r.id === winnerReceiver ? 6 : 0);
        }
        const c = await counts(sender.id, r1.id, r2.id, r3.id);
        expect(c).toEqual({ spend: 1, reward: 1, gift: 1 });
    });

    // ── F. Receiver-side concurrent credits ───────────────────────────────────
    test('F. two concurrent credits to one receiver: both exactly once, authoritative balanceAfter chain', async () => {
        const senderA = await seedUser(20, 'f-a');
        const senderB = await seedUser(20, 'f-b');
        const receiver = await seedUser(0, 'f-r');
        const { AzmRewardService } = require('../services/azmRewardService');
        const rewardService = new AzmRewardService(prisma);

        const [giftRes] = await Promise.all([
            send(prisma, { senderId: senderA.id, receiverId: receiver.id, amount: 5, type: 'GIFT', idempotencyKey: key() }),
            rewardService.creditAzm({ userId: receiver.id, amount: 3, source: 'TRADE_COMPLETE', reason: 'race credit', dedupKey: `race-${rnd()}` }),
        ]);
        expect(giftRes.credited).toBe(true);

        const finalReceiver = await bal(receiver.id);
        expect(finalReceiver).toBe(8); // 5 + 3, each exactly once

        const logs = await prisma.azmRewardLog.findMany({
            where: { userId: receiver.id, source: { in: ['GIFT_TIP_RECEIVED', 'TRADE_COMPLETE'] } },
            orderBy: { balanceAfter: 'asc' },
        });
        expect(logs).toHaveLength(2);
        const chain = logs.map((l) => parseFloat(l.balanceAfter.toString()));
        // The increments serialize on the user row lock: the committed chain is
        // 3, 8 or 5, 8 — monotonic, and the max is the live final balance.
        expect(chain[chain.length - 1]).toBe(finalReceiver);
        expect(chain[0]).toBe(Math.min(3, 5));
        const amounts = logs.map((l) => parseFloat(l.amount.toString())).sort();
        expect(amounts).toEqual([3, 5]);
    });

    // ── G. Failure then same-key retry ───────────────────────────────────────
    test('G. failed attempt leaves zero state; same-key retry succeeds exactly once', async () => {
        const sender = await seedUser(10, 'g-s');
        const receiver = await seedUser(0, 'g-r');
        const idem = key();

        let thrown = false;
        const failingOnce = prisma.$extends({
            query: {
                azmRewardLog: {
                    async create({ args, query }) {
                        if (!thrown && args?.data?.source === 'GIFT_TIP_RECEIVED') {
                            thrown = true;
                            throw new Error('transient infra failure');
                        }
                        return query(args);
                    },
                },
            },
        });

        await expect(
            send(failingOnce, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem })
        ).rejects.toThrow('transient infra failure');
        expect(await counts(sender.id, receiver.id)).toEqual({ spend: 0, reward: 0, gift: 0 });

        // Retry the SAME logical request (same key) with the failure gone:
        const retry = await send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem });
        expect(retry.replay).toBe(false);
        expect(await bal(sender.id)).toBe(6);
        expect(await bal(receiver.id)).toBe(4);
        expect(await counts(sender.id, receiver.id)).toEqual({ spend: 1, reward: 1, gift: 1 });
    });

    // ── H. Idempotency-key enforcement before any mutation ────────────────────
    test('H. missing/invalid key: rejected before any economic mutation', async () => {
        const sender = await seedUser(10, 'h-s');
        const receiver = await seedUser(0, 'h-r');

        for (const bad of [undefined, null, '', 'short', 'has space in it!', 'x'.repeat(200), 12345]) {
            await expect(
                send(prisma, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: bad })
            ).rejects.toThrow(GiftValidationError);
        }

        expect(await bal(sender.id)).toBe(10);
        expect(await bal(receiver.id)).toBe(0);
        expect(await counts(sender.id, receiver.id)).toEqual({ spend: 0, reward: 0, gift: 0 });
    });

    // ── I. Forced gift-claim race (barrier: both transactions miss the fast path) ──
    test('I. barrier-forced same-key race: one authoritative gift, loser converges', async () => {
        const sender = await seedUser(10, 'i-s');
        const receiver = await seedUser(0, 'i-r');
        const idem = key();

        // Barrier extension: the FIRST azmGift.findUnique (the replay fast path)
        // parks until the SECOND one arrives — both transactions are then past
        // the pre-check simultaneously and MUST resolve ownership via the
        // AzmGift.dedupKey unique index instead of the fast path.
        let arrivals = 0;
        let releaseFirst;
        const gate = new Promise((resolve) => { releaseFirst = resolve; });
        let firstParked = false;
        const barrier = prisma.$extends({
            query: {
                azmGift: {
                    async findUnique({ args, query }) {
                        if (args?.where?.dedupKey === `gift_${sender.id}_${idem}`) {
                            arrivals += 1;
                            if (arrivals === 1) { firstParked = true; await gate; }
                            else if (arrivals === 2 && firstParked) { releaseFirst(); }
                        }
                        return query(args);
                    },
                },
            },
        });

        const [a, b] = await Promise.all([
            send(barrier, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem }),
            send(barrier, { senderId: sender.id, receiverId: receiver.id, amount: 4, type: 'GIFT', idempotencyKey: idem }),
        ]);

        expect(a.gift.id).toBe(b.gift.id);
        const executors = [a, b].filter((r) => !r.replay);
        expect(executors).toHaveLength(1);
        expect(await bal(sender.id)).toBe(6);
        expect(await bal(receiver.id)).toBe(4);
        expect(await counts(sender.id, receiver.id)).toEqual({ spend: 1, reward: 1, gift: 1 });
    });

    // ── J. Ledger correctness ────────────────────────────────────────────────
    test('J. successful gift: sources, deterministic dedup keys, authoritative balanceAfter, exact reconciliation', async () => {
        const sender = await seedUser(10, 'j-s');
        const receiver = await seedUser(2, 'j-r');
        const idem = key();

        const result = await send(prisma, {
            senderId: sender.id, receiverId: receiver.id, amount: 3.5, type: 'TIP',
            message: 'nice trade', contextType: 'TRADE', contextId: 'trade-1', idempotencyKey: idem,
        });
        expect(result.replay).toBe(false);

        const opKey = `gift_${sender.id}_${idem}`;
        const spendLog = await prisma.azmSpendLog.findFirstOrThrow({ where: { userId: sender.id, source: 'GIFT_TIP' } });
        const rewardLog = await prisma.azmRewardLog.findFirstOrThrow({ where: { userId: receiver.id, source: 'GIFT_TIP_RECEIVED' } });
        const gift = await prisma.azmGift.findFirstOrThrow({ where: { senderId: sender.id } });

        expect(spendLog.dedupKey).toBe(opKey);
        expect(spendLog.metadata.dedupKey).toBe(opKey);           // legacy mirror preserved
        expect(parseFloat(spendLog.amount.toString())).toBe(3.5);
        expect(rewardLog.dedupKey).toBe(`gift_received_${sender.id}_${idem}`);
        expect(rewardLog.metadata.dedupKey).toBe(rewardLog.dedupKey);
        expect(gift.dedupKey).toBe(opKey);

        const senderFinal = await bal(sender.id);
        const receiverFinal = await bal(receiver.id);
        expect(senderFinal).toBe(6.5);          // 10 - 3.5
        expect(receiverFinal).toBe(5.5);        // 2 + 3.5
        expect(parseFloat(spendLog.balanceAfter.toString())).toBe(senderFinal);    // authoritative
        expect(parseFloat(rewardLog.balanceAfter.toString())).toBe(receiverFinal);
        expect(result.senderNewBalance.toString()).toBe(spendLog.balanceAfter.toString());
        expect(result.receiverNewBalance.toString()).toBe(rewardLog.balanceAfter.toString());
        expect(gift.type).toBe('TIP');
        expect(gift.message).toBe('nice trade');
        expect(gift.contextType).toBe('TRADE');
        expect(gift.contextId).toBe('trade-1');
    });
});
