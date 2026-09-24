// __tests__/r38-chat-money-balance-claims.test.js
// =============================================================================
// r38/P1 — ATOMIC BALANCE CLAIMS in the chat-money rail (real PostgreSQL).
//
// The three money-moving paths (MONEY_SEND, accept-money, fund-escrow) used
// a read-check-decrement pattern whose only guard was the database's
// nonnegative CHECK: two concurrent sends both passed the read, both
// decremented, and one aborted on the CHECK violation with a raw 500 —
// and any non-CHECK database invariant would have permitted a negative
// balance. The r38 fix makes the conditional decrement (gte predicate) the
// SOLE authority, exactly like escrowService.
//
// Proofs (each hammered concurrently):
//   • exactly one contender wins the balance; the loser fails with a
//     DETERMINISTIC 400 INSUFFICIENT_BALANCE — never a P2035/CHECK 500;
//   • the loser leaves ZERO residual side effects (messages, tickets,
//     TransactionHistory, balance movements);
//   • single-path behaviour is unchanged (happy path + plain
//     insufficient-balance rejection).
// =============================================================================
const { PrismaClient, Prisma } = require('@prisma/client');
const { ConversationMoneyService } = require('../services/conversationMoneyService');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P1 — atomic balance claims in the chat-money rail', () => {
    let db;
    let svc;
    let A, B, C;
    let convABFull, convACFull;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        svc = new ConversationMoneyService({ prisma: db });
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "TransactionHistory", "Contact", "JournalEntry", "LedgerTransaction", "LedgerAccount", "BusinessLedgerEntry", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedUser(db, { availableBalance: 100 });
        B = await seedUser(db, { availableBalance: 1000 });
        C = await seedUser(db, { availableBalance: 1000 });
        const mk = async (...users) => {
            const conv = await db.conversation.create({ data: { type: 'PERSONAL' } });
            for (const u of users) await db.$executeRawUnsafe(
                'INSERT INTO "_ConversationParticipants" ("A", "B") VALUES ($1, $2)', conv.id, u.id);
            return db.conversation.findUnique({ where: { id: conv.id }, include: { participants: true } });
        };
        convABFull = await mk(A, B);
        convACFull = await mk(A, C);
    });

    const bal = async (id) => new Prisma.Decimal(
        (await db.user.findUnique({ where: { id }, select: { availableBalance: true } })).availableBalance);

    // ── MONEY_SEND ─────────────────────────────────────────────────────────────

    test('two concurrent MONEY_SENDs over one balance → exactly one lands, loser 400 INSUFFICIENT_BALANCE with zero residue', async () => {
        const results = await Promise.allSettled([
            svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '80', clientRequestId: 'race-1' }),
            svc.sendMoney({ user: A, conv: convACFull, type: 'MONEY_SEND', recipientId: C.id, moneyAmount: '80', clientRequestId: 'race-2' }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason.status).toBe(400);
        expect(rejected[0].reason.code).toBe('INSUFFICIENT_BALANCE');

        // One transfer only: balance conservation across A, B, C.
        expect((await bal(A.id)).toFixed(8)).toBe(new Prisma.Decimal(20).toFixed(8));
        const b = (await bal(B.id)).toFixed(8);
        const c = (await bal(C.id)).toFixed(8);
        expect([b, c].sort()).toEqual([new Prisma.Decimal(1000).toFixed(8), new Prisma.Decimal(1080).toFixed(8)].sort());

        // Zero residue from the loser: one ticket, one message.
        expect(await db.conversationMoneyTicket.count()).toBe(1);
        expect(await db.message.count()).toBe(1);
        // Exactly one transfer's financial history (sender + receiver rows);
        // seedUser may add unrelated signup rows — count the transfer class.
        expect(await db.transactionHistory.count({ where: { type: 'INTERNAL_TRANSFER' } })).toBe(2);
    });

    test('two concurrent sends of the SAME amount to the SAME recipient → one lands, one deterministic rejection', async () => {
        const results = await Promise.allSettled([
            svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '100', clientRequestId: 'same-1' }),
            svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '100', clientRequestId: 'same-2' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const loser = results.find((r) => r.status === 'rejected').reason;
        expect(loser.status).toBe(400);
        expect(loser.code).toBe('INSUFFICIENT_BALANCE');
        expect((await bal(A.id)).toFixed(8)).toBe('0.00000000');
        expect((await bal(B.id)).toFixed(8)).toBe(new Prisma.Decimal(1100).toFixed(8));
    });

    test('hammered: N concurrent sends of 50 against a 120 balance → at most floor winners, every loser deterministic', async () => {
        const N = 12;
        const results = await Promise.allSettled(Array.from({ length: N }, (_, i) =>
            svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '50', clientRequestId: `hammer-${i}` })));
        const winners = results.filter((r) => r.status === 'fulfilled').length;
        const losers = results.filter((r) => r.status === 'rejected');
        expect(winners).toBe(2); // floor(100/50) = 2
        expect(losers.length).toBe(N - 2);
        for (const l of losers) {
            expect(l.reason.status).toBe(400);
            expect(l.reason.code).toBe('INSUFFICIENT_BALANCE');
        }
        expect((await bal(A.id)).toFixed(8)).toBe('0.00000000');
        // Balance conservation exactly.
        expect((await bal(B.id)).toFixed(8)).toBe(new Prisma.Decimal(1000).plus(100).toFixed(8));
    });

    // ── accept-money (concurrent requests against one payer) ──────────────────

    test('concurrent ACCEPTs of two requests over one payer balance → exactly one lands', async () => {
        const reqA = await svc.sendMoney({ user: B, conv: convABFull, type: 'MONEY_REQUEST', moneyAmount: '80', clientRequestId: 'acc-1' });
        const reqC = await svc.sendMoney({ user: C, conv: convACFull, type: 'MONEY_REQUEST', moneyAmount: '80', clientRequestId: 'acc-2' });

        const results = await Promise.allSettled([
            svc.acceptMoney({ user: A, conversationId: convABFull.id, messageId: reqA.message.id }),
            svc.acceptMoney({ user: A, conversationId: convACFull.id, messageId: reqC.message.id }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const loser = results.find((r) => r.status === 'rejected').reason;
        expect(loser.status).toBe(400);
        expect(loser.code).toBe('INSUFFICIENT_BALANCE');

        expect((await bal(A.id)).toFixed(8)).toBe('20.00000000');
        // Loser's ticket stays 'sent' — zero residue, still payable later.
        const tickets = await db.conversationMoneyTicket.findMany({ orderBy: { clientRequestId: 'asc' } });
        const statuses = tickets.map((t) => t.status).sort();
        expect(statuses).toEqual(['ACCEPTED', 'sent']);
    });

    // ── fund-escrow (concurrent funding over one balance) ─────────────────────

    test('concurrent FUNDs of two escrow tickets over one balance → exactly one lands, loser ticket stays sent', async () => {
        const esc1 = await svc.sendMoney({ user: A, conv: convABFull, type: 'ESCROW_TICKET', amount: '80', itemName: 'X1', clientRequestId: 'fnd-1' });
        const esc2 = await svc.sendMoney({ user: A, conv: convACFull, type: 'ESCROW_TICKET', amount: '80', itemName: 'X2', clientRequestId: 'fnd-2' });

        const results = await Promise.allSettled([
            svc.fundEscrow({ user: A, conversationId: convABFull.id, messageId: esc1.message.id }),
            svc.fundEscrow({ user: A, conversationId: convACFull.id, messageId: esc2.message.id }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const loser = results.find((r) => r.status === 'rejected').reason;
        expect(loser.status).toBe(400);
        expect(loser.code).toBe('INSUFFICIENT_BALANCE');

        expect((await bal(A.id)).toFixed(8)).toBe('20.00000000');
        const statuses = (await db.conversationMoneyTicket.findMany({
            where: { kind: 'ESCROW_TICKET' }, orderBy: { clientRequestId: 'asc' },
        })).map((t) => t.status).sort();
        expect(statuses).toEqual(['ESCROW_FUNDED', 'sent']);
    });

    // ── single-path behaviour unchanged ────────────────────────────────────────

    test('plain insufficient balance (no race) → 400 INSUFFICIENT_BALANCE, exact amounts, zero mutation', async () => {
        await expect(svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '100.01', clientRequestId: 'plain-1' }))
            .rejects.toMatchObject({ status: 400, code: 'INSUFFICIENT_BALANCE' });
        expect((await bal(A.id)).toFixed(8)).toBe('100.00000000');
        expect(await db.conversationMoneyTicket.count()).toBe(0);
        expect(await db.message.count()).toBe(0);
    });

    test('tiny 8dp send over an exact balance → lands exactly, no over-draft via rounding', async () => {
        const res = await svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '100', clientRequestId: 'exact-1' });
        expect(res.replay).toBe(false);
        expect((await bal(A.id)).toFixed(8)).toBe('0.00000000');
        // A second even-tinier send must be deterministically refused.
        await expect(svc.sendMoney({ user: A, conv: convABFull, type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '0.00000001', clientRequestId: 'exact-2' }))
            .rejects.toMatchObject({ status: 400, code: 'INSUFFICIENT_BALANCE' });
    });
});
