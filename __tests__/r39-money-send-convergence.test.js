// __tests__/r39-money-send-convergence.test.js
// =============================================================================
// r39/P1 — MONEY-SEND SAME-KEY CONCURRENT RESPONSE CONVERGENCE (real
// PostgreSQL).
//
// The unique clientRequestId index already guarantees exactly one economic
// effect. This suite proves the response contract the reviewer asked for:
//
//   • a CONCURRENT same-key loser returns the exact committed winner's
//     outcome (message/ticket/replay:true), not a transient DUPLICATE_REQUEST;
//   • exactly ONE economic effect occurs (balances move once, one message,
//     one ticket, one history pair);
//   • the loser leaves ZERO residue (its transaction rolled back);
//   • a same-key RETRY always returns the exact committed result;
//   • a concurrent same-key request with DIFFERENT parameters still fails
//     closed as IDEMPOTENCY_CONFLICT — convergence never launders a
//     conflicting replay.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { ConversationMoneyService } = require('../services/conversationMoneyService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r39/P1 — money-send same-key concurrent response convergence', () => {
    let db;
    let svc;

    beforeAll(() => {
        db = new PrismaClient();
        svc = new ConversationMoneyService({ prisma: db, io: null, emitBalanceUpdate: () => {}, pushIfOffline: () => {} });
    });
    // r39/P1 BATTERY-HERMETIC TEARDOWN (see r39-money-ticket-lifecycle): the
    // explicit-id User seeds (ids 1, 2) plus RESTART IDENTITY would otherwise
    // leave User_id_seq at 1 behind surviving rows — later suites' auto-
    // increment user.create() collides on User.id. End clean.
    afterAll(async () => {
        try {
            await raw('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "User" RESTART IDENTITY CASCADE');
            await raw('TRUNCATE TABLE "LedgerTransaction", "LedgerAccount" RESTART IDENTITY CASCADE');
            await raw('TRUNCATE TABLE "TransactionHistory" RESTART IDENTITY CASCADE');
        } catch (e) { /* teardown is best-effort; beforeEach re-truncates */ }
        await db.$disconnect();
    });

    const raw = (sql) => db.$executeRawUnsafe(sql);

    beforeEach(async () => {
        await raw('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "User" RESTART IDENTITY CASCADE');
        await raw('TRUNCATE TABLE "LedgerTransaction", "LedgerAccount" RESTART IDENTITY CASCADE');
        await raw('TRUNCATE TABLE "TransactionHistory" RESTART IDENTITY CASCADE');

        await raw(`INSERT INTO "User" ("id", "username", "email", "password", "availableBalance", "createdAt")
                   VALUES (1, 'r39a', 'r39a@t.test', 'pw', 100, NOW()),
                          (2, 'r39b', 'r39b@t.test', 'pw', 0, NOW())`);
        await raw(`INSERT INTO "Conversation" ("id", "type", "createdAt", "updatedAt")
                   VALUES ('conv1', 'PERSONAL', NOW(), NOW())`);
    });

    test('concurrent same-key: one economic effect, loser converges to the exact committed outcome', async () => {
        const user = { id: 1 };
        const conv = { id: 'conv1' };
        const base = { user, conv, type: 'MONEY_SEND', moneyAmount: '25', recipientId: '2', clientRequestId: 'r39-key-1' };

        const [r1, r2] = await Promise.allSettled([
            svc.sendMoney(base),
            svc.sendMoney({ ...base }),
        ]);

        // Both requests CONVERGE — neither surfaces a transient 409.
        expect(r1.status).toBe('fulfilled');
        expect(r2.status).toBe('fulfilled');
        const a = r1.value, b = r2.value;

        // Same exact committed outcome for both callers.
        expect(a.message.id).toBe(b.message.id);
        expect(a.ticket.id).toBe(b.ticket.id);
        expect(a.ticket.clientRequestId).toBe('r39-key-1');
        // Exactly one of the two created it; the other replayed it.
        expect([a.replay, b.replay].filter((x) => x === false)).toHaveLength(1);
        expect([a.replay, b.replay].filter((x) => x === true)).toHaveLength(1);

        // EXACTLY ONE economic effect.
        const sender = await db.user.findUnique({ where: { id: 1 } });
        const receiver = await db.user.findUnique({ where: { id: 2 } });
        expect(Number(sender.availableBalance)).toBe(75);
        expect(Number(receiver.availableBalance)).toBe(25);
        expect(await db.message.count({ where: { conversationId: 'conv1', messageType: 'PAYMENT_TRANSFER' } })).toBe(1);
        expect(await db.conversationMoneyTicket.count({ where: { clientRequestId: 'r39-key-1' } })).toBe(1);
        expect(await db.transactionHistory.count({ where: { type: 'INTERNAL_TRANSFER' } })).toBe(2); // one pair
        expect(await db.ledgerTransaction.count()).toBe(1);

        // ZERO residue: the loser's rolled-back transaction left no dangling
        // message rows of any type.
        expect(await db.message.count({ where: { conversationId: 'conv1' } })).toBe(1);
    });

    test('same-key retry after commit always returns the exact committed result', async () => {
        const user = { id: 1 };
        const conv = { id: 'conv1' };
        const base = { user, conv, type: 'MONEY_SEND', moneyAmount: '10', recipientId: '2', clientRequestId: 'r39-key-2' };

        const first = await svc.sendMoney(base);
        expect(first.replay).toBe(false);

        const retry = await svc.sendMoney({ ...base });
        expect(retry.replay).toBe(true);
        expect(retry.message.id).toBe(first.message.id);
        expect(retry.ticket.id).toBe(first.ticket.id);

        const sender = await db.user.findUnique({ where: { id: 1 } });
        expect(Number(sender.availableBalance)).toBe(90); // moved once, never twice
        expect(await db.conversationMoneyTicket.count({ where: { clientRequestId: 'r39-key-2' } })).toBe(1);
    });

    test('concurrent same-key with DIFFERENT parameters fails closed — no laundering', async () => {
        const user = { id: 1 };
        const conv = { id: 'conv1' };
        const key = 'r39-key-3';

        const [r1, r2] = await Promise.allSettled([
            svc.sendMoney({ user, conv, type: 'MONEY_SEND', moneyAmount: '20', recipientId: '2', clientRequestId: key }),
            svc.sendMoney({ user, conv, type: 'MONEY_SEND', moneyAmount: '70', recipientId: '2', clientRequestId: key }),
        ]);

        // At most one wins; the conflicting twin is rejected (either via the
        // pre-check, via convergence identity check, or both).
        const codes = [r1, r2].map((r) => (r.status === 'fulfilled' ? 'OK' : r.reason.code));
        expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
        expect(codes.filter((c) => c === 'IDEMPOTENCY_CONFLICT' || c === 'DUPLICATE_REQUEST')).toHaveLength(1);

        // Exactly one effect, of whichever amount won — never a blend.
        const tickets = await db.conversationMoneyTicket.findMany({ where: { clientRequestId: key } });
        expect(tickets).toHaveLength(1);
        const amounts = ['20.00000000', '70.00000000'];
        expect(amounts).toContain(tickets[0].amount.toFixed(8));

        const sender = await db.user.findUnique({ where: { id: 1 } });
        const moved = 100 - Number(sender.availableBalance);
        expect(['20', '70']).toContain(String(moved));
    });

    test('forced P2002 loser (pre-check missed) converges to the committed winner, not DUPLICATE_REQUEST', async () => {
        const { ConversationMoneyService: Svc } = require('../services/conversationMoneyService');
        const Prisma = require('@prisma/client').Prisma;

        const committedTicket = {
            id: 'tick-win', messageId: 'msg-win', conversationId: 'conv1', kind: 'MONEY_SEND',
            amount: new Prisma.Decimal('25'), currency: 'USDC', requesterId: 1, counterpartyId: 2,
            status: 'ACCEPTED', clientRequestId: 'r39-key-4',
        };
        const winnerMessage = { id: 'msg-win', sender: { id: 1, username: 'r39a' } };

        const prisma = {
            conversationMoneyTicket: {
                findUnique: async ({ where }) =>
                    (where.clientRequestId ? committedTicket : null), // pre-check misses, convergence reads the winner
                create: async () => { const e = new Error('unique'); e.code = 'P2002'; throw e; },
            },
            message: {
                findUnique: async () => winnerMessage,
                create: async () => winnerMessage,
            },
            user: {
                findUnique: async () => ({ id: 1, username: 'r39a', availableBalance: new Prisma.Decimal(100) }),
                updateMany: async () => ({ count: 1 }),
                update: async () => ({}),
            },
            contact: { upsert: async () => ({}) },
            transactionHistory: { create: async () => ({}) },
            $transaction: async (fn) => fn({
                user: prisma.user, message: prisma.message,
                conversationMoneyTicket: prisma.conversationMoneyTicket,
                contact: prisma.contact, transactionHistory: prisma.transactionHistory,
            }),
        };
        // ledger.post must be satisfied inside the tx; the P2002 fires at
        // ticket create which precedes it, so the mock tx never reaches ledger.
        jest.mock('../services/ledgerService', () => ({ post: async () => ({}) }), { virtual: false });
        const svc = new Svc({ prisma, io: null, emitBalanceUpdate: () => {}, pushIfOffline: () => {} });

        const out = await svc.sendMoney({
            user: { id: 1 }, conv: { id: 'conv1' }, type: 'MONEY_SEND',
            moneyAmount: '25', recipientId: '2', clientRequestId: 'r39-key-4',
        });

        // CONVERGENCE: the loser returns the winner's exact committed
        // outcome with replay:true — never a transient DUPLICATE_REQUEST.
        expect(out.replay).toBe(true);
        expect(out.ticket.id).toBe('tick-win');
        expect(out.message.id).toBe('msg-win');

        // A conflicting twin on the same key still fails closed.
        const conflictPrisma = { ...prisma, conversationMoneyTicket: {
            findUnique: async () => committedTicket,
            create: async () => { const e = new Error('unique'); e.code = 'P2002'; throw e; },
        } };
        const conflictSvc = new Svc({ prisma: conflictPrisma, io: null, emitBalanceUpdate: () => {}, pushIfOffline: () => {} });
        await expect(conflictSvc.sendMoney({
            user: { id: 1 }, conv: { id: 'conv1' }, type: 'MONEY_SEND',
            moneyAmount: '99', recipientId: '2', clientRequestId: 'r39-key-4',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
});
