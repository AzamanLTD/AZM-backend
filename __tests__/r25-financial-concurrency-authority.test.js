// __tests__/r25-financial-concurrency-authority.test.js
// =============================================================================
// r25 — FINANCIAL CONCURRENCY AUTHORITY (real PostgreSQL proofs).
//
// The r25 theme: on every money path, the durable state claim (CAS on the row)
// and the exact-quantity balance claim (conditional decrement) come BEFORE any
// economic mutation, and an exact ledger replay inside a just-claimed operation
// is contradictory evidence that aborts. Mocks can prove the CALLS happen in
// the right order; only a real database can prove that two genuinely parallel
// operations produce exactly-once money. These tests race REAL services and
// controllers against real Postgres with Promise.all and assert the exact final
// quantities — no orphans, no double-spends, no lost updates, no negative
// balances.
//
// Coverage map (each mirrors an r25 diff):
//   §1  escrowService.fundEscrow                  — same-escrow race: exactly-once
//   §2  escrowService.fundEscrow                  — insufficient-budget race
//   §3  bookingEscrowService.fundBookingEscrow    — same-escrow race
//   §4  peerTransferController.fulfillTransferRequest — same-transfer CAS
//   §5  peerTransferController.fulfillTransferRequest — budget race
//   §6  walletController.requestWithdrawal        — budget race
//   §7  savingsController.deposit                 — FOR UPDATE lost-update regression
//   §8  savingsController.deposit                 — budget race, full rollback
//   §9  routes/chatRoutes                         — broken /transfer endpoint unmounted
// =============================================================================

const { seedUser, seedEscrowTicket, seedSavingsGoal, seedFriendship } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r25-concurrency] TEST_DATABASE_URL not set — skipping DB proofs.');

// Post-commit setImmediate side effects must run INSIDE the test so they hit
// live modules, never a torn-down jest environment.
const drainPostCommitHooks = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
};

// Exactness over floats: Decimal columns are the authority.
const exactNum = (decimalish) =>
    Number(new (require('@prisma/client').Prisma).Decimal(decimalish).toFixed(8));

describeOrSkip('r25 financial concurrency authority (real PostgreSQL)', () => {
    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        // CASCADE from User clears Friendship/Ticket/SmartEscrow/PeerTransfer/
        // SavingsGoal/SavingsDeposit/Withdrawal/TransactionHistory; reset the
        // profit-fee singleton too (same convention as escrow-flow.test.js).
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // Pin the canonical rate so the USDC amounts below are exact integers
    // of the GHS amounts (125 GHS @ 12.50 = 10 USDC exactly). The test DB's
    // settings row may carry a different historical rate — pin, don't trust.
    const ensureSettings = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveUsdToGhs: rate },
            create: { id: 1, liveUsdToGhs: rate },
        });

    const mockApp = () => ({
        get: (k) =>
            k === 'prisma' ? prisma :
            k === 'socketio' ? { to: () => ({ emit: () => {} }) } :
            k === 'emitBalanceUpdate' ? (async () => {}) : null,
    });

    const mockRes = () => {
        const r = {};
        r.status = (s) => { r._status = s; return r; };
        r.json = (b) => { r._body = b; return r; };
        return r;
    };

    const userBalances = async (id) => {
        const u = await prisma.user.findUnique({ where: { id } });
        return {
            available: exactNum(u.availableBalance),
            escrowLocked: exactNum(u.escrowLockedBalance),
        };
    };

    // ── §1/§2 escrowService.fundEscrow ─────────────────────────────────────
    describe('escrowService.fundEscrow — atomic funding claim', () => {
        const escrowService = require('../services/escrowService');

        test('two concurrent funds of ONE escrow: exactly one winner, money moved exactly once', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT');

            const results = await Promise.allSettled([
                escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id }),
                escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id }),
            ]);
            await drainPostCommitHooks();

            const winners = results.filter((r) => r.status === 'fulfilled');
            const losers = results.filter((r) => r.status === 'rejected');
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            expect(losers[0].reason.message).toMatch(/cannot be funded from status FUNDED/i);

            // Exactly-once money.
            const finalEscrow = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(finalEscrow.status).toBe('FUNDED');
            const payerAfter = await userBalances(payer.id);
            expect(payerAfter.available).toBe(149.75); // 200 − 50 − 0.25, exact
            expect(payerAfter.escrowLocked).toBe(50);

            // Exactly one canonical history row and one ledger posting.
            const history = await prisma.transactionHistory.findMany({
                where: { userId: payer.id, type: 'TICKET_ESCROW_FUND' },
            });
            expect(history).toHaveLength(1);

            const ledgerPostings = await prisma.ledgerTransaction.findMany({
                where: { idempotencyKey: `ledger:escrow:fund:${escrow.id}` },
            });
            expect(ledgerPostings).toHaveLength(1);
            expect(ledgerPostings[0].entryType).toBe('ESCROW_LOCK');
        });

        test('two concurrent funds of TWO escrows from ONE thin budget: one winner, loser moves nothing', async () => {
            const { payer, payee, friendship, escrow: escrowA } = await seedEscrowTicket(prisma, 'DRAFT');

            // Budget covers ONE funding (50.25) but not two. Keep the history
            // backing in sync with the reduced balance (runDoubleCheck audit).
            await prisma.user.update({ where: { id: payer.id }, data: { availableBalance: 60 } });
            await prisma.transactionHistory.updateMany({
                where: { userId: payer.id, type: 'DEPOSIT_CRYPTO', status: 'COMPLETED' },
                data: { amountUsdc: 60 },
            });

            // A second independent escrow for the same payer.
            const ticketB = await prisma.ticket.create({
                data: {
                    friendshipId: friendship.id,
                    creatorId: payer.id,
                    counterpartyId: payee.id,
                    name: 'Race Escrow B',
                    type: 'ESCROW',
                    targetAmount: 50,
                    targetCurrency: 'USDC',
                    status: 'OPEN',
                    lastActivityAt: new Date(),
                },
            });
            const escrowB = await prisma.smartEscrow.create({
                data: {
                    ticketId: ticketB.id,
                    payerId: payer.id,
                    payeeId: payee.id,
                    amountUsdc: 50,
                    feeUsdc: 0.25,
                    status: 'DRAFT',
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                },
            });

            const results = await Promise.allSettled([
                escrowService.fundEscrow(prisma, { escrowId: escrowA.id, payerId: payer.id }),
                escrowService.fundEscrow(prisma, { escrowId: escrowB.id, payerId: payer.id }),
            ]);
            await drainPostCommitHooks();

            const winners = results.filter((r) => r.status === 'fulfilled');
            const losers = results.filter((r) => r.status === 'rejected');
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            expect(losers[0].reason.code).toBe('INSUFFICIENT_BALANCE');

            // Exactly one escrow FUNDED, and the balances are exact.
            const statuses = await prisma.smartEscrow.findMany({
                where: { id: { in: [escrowA.id, escrowB.id] } },
                select: { status: true },
            });
            expect(statuses.filter((s) => s.status === 'FUNDED')).toHaveLength(1);
            const payerAfter = await userBalances(payer.id);
            expect(payerAfter.available).toBe(9.75); // 60 − 50.25, exact
            expect(payerAfter.escrowLocked).toBe(50);

            // The loser orphaned nothing.
            const history = await prisma.transactionHistory.findMany({
                where: { userId: payer.id, type: 'TICKET_ESCROW_FUND' },
            });
            expect(history).toHaveLength(1);
            const postings = await prisma.ledgerTransaction.count({
                where: {
                    idempotencyKey: {
                        in: [`ledger:escrow:fund:${escrowA.id}`, `ledger:escrow:fund:${escrowB.id}`],
                    },
                },
            });
            expect(postings).toBe(1);
        });
    });

    // ── §3 bookingEscrowService.fundBookingEscrow ───────────────────────────
    describe('bookingEscrowService.fundBookingEscrow — claim before money', () => {
        test('two concurrent booking funds: exactly one winner with ESCROW_ALREADY_FUNDED for the loser', async () => {
            const { fundBookingEscrow } = require('../services/bookingEscrowService');
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT');

            const results = await Promise.allSettled([
                fundBookingEscrow(prisma, { escrowId: escrow.id, payerId: payer.id, bookingType: 'RESERVATION', bookingId: null }),
                fundBookingEscrow(prisma, { escrowId: escrow.id, payerId: payer.id, bookingType: 'RESERVATION', bookingId: null }),
            ]);
            await drainPostCommitHooks();

            const winners = results.filter((r) => r.status === 'fulfilled');
            const losers = results.filter((r) => r.status === 'rejected');
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            expect(losers[0].reason.code).toBe('ESCROW_ALREADY_FUNDED');

            const finalEscrow = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(finalEscrow.status).toBe('FUNDED');
            const payerAfter = await userBalances(payer.id);
            expect(payerAfter.available).toBe(149.75);
            expect(payerAfter.escrowLocked).toBe(50);

            const postings = await prisma.ledgerTransaction.findMany({
                where: { idempotencyKey: `ledger:escrow:fund:${escrow.id}` },
            });
            expect(postings).toHaveLength(1);
        });
    });

    // ── §4/§5 peerTransferController.fulfillTransferRequest ─────────────────
    describe('peerTransferController.fulfillTransferRequest — PENDING CAS + balance claim', () => {
        const ctrl = require('../controllers/peerTransferController');

        const seedTransfer = (friendshipId, payer, requester, amount) =>
            prisma.peerTransfer.create({
                data: {
                    friendshipId,
                    senderId: payer.id,
                    receiverId: requester.id,
                    amount,
                    type: 'REQUEST',
                    status: 'PENDING',
                    reference: 'r25 race',
                },
            });

        test('two concurrent fulfillments of ONE transfer: exactly one commits money', async () => {
            const requester = await seedUser(prisma, { availableBalance: 0 });
            const payer = await seedUser(prisma, { availableBalance: 175 });
            const friendship = await seedFriendship(prisma, payer.id, requester.id);
            const transfer = await seedTransfer(friendship.id, payer, requester, 75);

            const responses = await Promise.all([
                ctrl.fulfillTransferRequest(
                    { user: { id: payer.id }, params: { id: String(transfer.id) }, app: mockApp() },
                    mockRes()
                ),
                ctrl.fulfillTransferRequest(
                    { user: { id: payer.id }, params: { id: String(transfer.id) }, app: mockApp() },
                    mockRes()
                ),
            ]);
            await drainPostCommitHooks();

            // Both calls return 200 — but only ONE performed the transfer.
            // The loser is the controller's idempotent replay of the winner's
            // committed outcome (same durable identity, no second mutation).
            expect(responses.every((r) => r._status === 200)).toBe(true);
            const executed = responses.filter((r) => !(r._body && r._body.idempotent));
            const replayed = responses.filter((r) => r._body && r._body.idempotent);
            expect(executed).toHaveLength(1);
            expect(replayed).toHaveLength(1);

            const finalTransfer = await prisma.peerTransfer.findUnique({ where: { id: transfer.id } });
            expect(finalTransfer.status).toBe('COMPLETED');

            const payerAfter = await userBalances(payer.id);
            const requesterAfter = await userBalances(requester.id);
            expect(payerAfter.available).toBe(100); // 175 − 75, exactly once
            expect(requesterAfter.available).toBe(75);
        });

        test('two transfers, budget for one: one fulfills, the loser stays PENDING and retryable', async () => {
            const requester = await seedUser(prisma, { availableBalance: 0 });
            const payer = await seedUser(prisma, { availableBalance: 100 });
            const friendship = await seedFriendship(prisma, payer.id, requester.id);
            const t1 = await seedTransfer(friendship.id, payer, requester, 75);
            const t2 = await seedTransfer(friendship.id, payer, requester, 75);

            const responses = await Promise.all([
                ctrl.fulfillTransferRequest(
                    { user: { id: payer.id }, params: { id: String(t1.id) }, app: mockApp() },
                    mockRes()
                ),
                ctrl.fulfillTransferRequest(
                    { user: { id: payer.id }, params: { id: String(t2.id) }, app: mockApp() },
                    mockRes()
                ),
            ]);
            await drainPostCommitHooks();

            const ok = responses.filter((r) => r._status === 200);
            const refused = responses.filter((r) => r._status >= 400);
            expect(ok).toHaveLength(1);
            expect(refused).toHaveLength(1);

            const final = await prisma.peerTransfer.findMany({
                where: { id: { in: [t1.id, t2.id] } },
                select: { id: true, status: true },
            });
            expect(final.filter((t) => t.status === 'COMPLETED')).toHaveLength(1);
            // The loser rolled back its PENDING→COMPLETED claim: still PENDING,
            // so a top-up can legitimately retry it.
            expect(final.filter((t) => t.status === 'PENDING')).toHaveLength(1);

            const payerAfter = await userBalances(payer.id);
            expect(payerAfter.available).toBe(25); // 100 − 75, exactly once
            const requesterAfter = await userBalances(requester.id);
            expect(requesterAfter.available).toBe(75);
        });
    });

    // ── §6 walletController.requestWithdrawal ───────────────────────────────
    describe('walletController.requestWithdrawal — atomic balance claim', () => {
        test('two concurrent withdrawals, budget for one: exactly one Withdrawal row, no negative balance', async () => {
            await ensureSettings();
            const ctrl = require('../controllers/walletController');
            const user = await seedUser(prisma, { availableBalance: 100 });

            const withdrawalReq = (res) =>
                ctrl.requestWithdrawal(
                    {
                        user: { id: user.id },
                        body: { amount: 60, destination: '0241234567' }, // MOMO-shaped, zero gas fee
                        app: mockApp(),
                    },
                    res
                );

            const res1 = mockRes();
            const res2 = mockRes();
            await Promise.all([withdrawalReq(res1), withdrawalReq(res2)]);
            const responses = [res1, res2];
            await drainPostCommitHooks();

            const ok = responses.filter((r) => r._status >= 200 && r._status < 300);
            const refused = responses.filter((r) => r._status >= 400);
            expect(ok).toHaveLength(1);
            expect(refused).toHaveLength(1);

            const withdrawals = await prisma.withdrawal.findMany({ where: { userId: user.id } });
            expect(withdrawals).toHaveLength(1);
            expect(withdrawals[0].status).toBe('PENDING');
            expect(exactNum(withdrawals[0].amount)).toBe(60);

            const after = await userBalances(user.id);
            expect(after.available).toBe(40); // 100 − 60, exact; never negative
        });
    });

    // ── §7/§8 savingsController.deposit ────────────────────────────────────
    describe('savingsController.deposit — FOR UPDATE goal row + balance claim', () => {
        const ctrl = require('../controllers/savingsController');

        // 125 GHS @ the pinned 12.50 GHS/USDC rate = 10 USDC exactly.
        // clientRequestIds are unique per run: the LedgerTransaction table is
        // NOT truncated by afterEach (it is not user-scoped), so a fixed key
        // from a previous run is a committed posting whose hash can never
        // match this run's user ids — the ledger replay guard refuses it.
        const runTag = process.env.JEST_WORKER_ID || 'w';
        const uniq = (s) => `${s}_${runTag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const depositReq = (res, userId, goalId, clientRequestId) =>
            ctrl.deposit(
                {
                    user: { id: userId },
                    params: { id: goalId },
                    body: { amountGhs: 125, clientRequestId },
                    headers: {},
                    app: mockApp(),
                },
                res
            );

        test('two concurrent deposits: streak/current derived from the LOCKED row — no lost update', async () => {
            await ensureSettings();
            const { user, goal } = await seedSavingsGoal(prisma, {
                user: { availableBalance: 500 },
                goal: { targetAmountGhs: 1000, currentAmountGhs: 0, nextDueDate: new Date(Date.now() + 7 * 86400000) },
            });

            const res1 = mockRes();
            const res2 = mockRes();
            await Promise.all([
                depositReq(res1, user.id, goal.id, uniq('r25-streak-a')),
                depositReq(res2, user.id, goal.id, uniq('r25-streak-b')),
            ]);
            await drainPostCommitHooks();

            expect(res1._status).toBe(200);
            expect(res2._status).toBe(200);
            expect([res1, res2].every((r) => r._body && r._body.success)).toBe(true);

            const finalGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            // The pre-r25 code read the goal row BEFORE the transaction: both
            // deposits read streakCount=0 and both wrote 1 (a silently lost
            // increment). The locked row makes each deposit see the other's
            // committed state: streak is 2, current is the exact sum.
            expect(finalGoal.streakCount).toBe(2);
            expect(finalGoal.longestStreak).toBe(2);
            expect(finalGoal.missedCount).toBe(0);
            expect(exactNum(finalGoal.currentAmountGhs)).toBe(250);
            expect(finalGoal.status).toBe('ACTIVE');

            const after = await userBalances(user.id);
            expect(after.available).toBe(480); // 500 − 2 × 10, exact
            expect(after.escrowLocked).toBe(20);

            const deposits = await prisma.savingsDeposit.findMany({ where: { goalId: goal.id } });
            expect(deposits).toHaveLength(2);
        });

        test('two concurrent deposits, budget for one: one commits, the loser rolls back EVERYTHING', async () => {
            await ensureSettings();
            const { user, goal } = await seedSavingsGoal(prisma, {
                user: { availableBalance: 15 },
                goal: { targetAmountGhs: 1000, currentAmountGhs: 0, nextDueDate: new Date(Date.now() + 7 * 86400000) },
            });

            const res1 = mockRes();
            const res2 = mockRes();
            await Promise.all([
                depositReq(res1, user.id, goal.id, uniq('r25-thin-a')),
                depositReq(res2, user.id, goal.id, uniq('r25-thin-b')),
            ]);
            await drainPostCommitHooks();

            const ok = [res1, res2].filter((r) => r._status === 200);
            const refused = [res1, res2].filter((r) => r._status >= 400);
            expect(ok).toHaveLength(1);
            expect(refused).toHaveLength(1);

            const finalGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
            expect(finalGoal.streakCount).toBe(1);
            expect(exactNum(finalGoal.currentAmountGhs)).toBe(125);

            const after = await userBalances(user.id);
            expect(after.available).toBe(5); // 15 − 10, exact
            expect(after.escrowLocked).toBe(10);

            // The loser orphaned nothing.
            expect(await prisma.savingsDeposit.count({ where: { goalId: goal.id } })).toBe(1);
            expect(
                await prisma.transactionHistory.count({
                    where: { userId: user.id, type: 'INTERNAL_TRANSFER' },
                })
            ).toBe(1);
        });
    });
});

// ── §9 routes/chatRoutes — the broken in-chat transfer endpoint is GONE ────
// (No DB needed: mounting is a static property of the module.)
describe('r25 §6 — legacy in-chat transfer endpoint unmounted', () => {
    test('POST /api/chat/transfer is no longer mounted (route had a constructor bug: every live call 500-ed)', () => {
        const router = require('../routes/chatRoutes');
        const paths = router.stack
            .filter((layer) => layer.route)
            .map((layer) => layer.route.path);
        expect(paths).not.toContain('/transfer');
        let resolved = true;
        try { require.resolve('../controllers/chatTransferController'); } catch (_) { resolved = false; }
        expect(resolved).toBe(false);
    });
});
