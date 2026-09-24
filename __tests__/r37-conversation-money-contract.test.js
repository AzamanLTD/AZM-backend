// __tests__/r37-conversation-money-contract.test.js
// =============================================================================
// r37/P1 — CONVERSATION MONEY CONTRACT (real PostgreSQL).
//
// Pins the three hardening points added on top of the r36 state machine:
//   • MANDATORY idempotency key for every money-bearing creation — money
//     requests and escrow tickets join money sends. A creation without a
//     durable request identity has no replay contract: 400, zero mutation.
//   • The conflict identity binds EVERY economically relevant field:
//     kind, conversation, requester, counterparty, amount AND currency. A
//     replay with a different currency fails closed instead of silently
//     replaying the original economics.
//   • Two-party is ENFORCED, not assumed: a malformed 3-participant
//     PERSONAL conversation fails closed (400 NOT_TWO_PARTY) —
//     `participants.find(...)` can never pick an arbitrary counterparty for
//     a money-bearing flow.
//   • Escrow outcome messages are INSIDE the financial transaction: an
//     injected message-write failure rolls the payment back with the state
//     transition, and the durable result stays replayable afterwards.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { ConversationMoneyService } = require('../services/conversationMoneyService');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r37/P1 — conversation money contract', () => {
    let db;
    let svc;
    let A, B, C;
    let convAB, convABC;

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
        A = await seedUser(db, { availableBalance: 1000 });
        B = await seedUser(db, { availableBalance: 1000 });
        C = await seedUser(db, { availableBalance: 1000 });
        const mk = async (...users) => {
            const conv = await db.conversation.create({ data: { type: 'PERSONAL' } });
            for (const u of users) await db.$executeRawUnsafe(
                'INSERT INTO "_ConversationParticipants" ("A", "B") VALUES ($1, $2)', conv.id, u.id);
            return db.conversation.findUnique({ where: { id: conv.id }, include: { participants: true } });
        };
        convAB = await mk(A, B);
        convABC = await mk(A, B, C);
    });

    const counts = async () => ({
        tickets: await db.conversationMoneyTicket.count(),
        messages: await db.message.count(),
    });

    const send = (user, conv, body) => svc.sendMoney({ user, conv, ...body });

    // ── Mandatory key ────────────────────────────────────────────────────────

    test('MONEY_REQUEST without clientRequestId → 400, zero mutation', async () => {
        await expect(send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30' }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_REQUIRED' });
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    test('ESCROW_TICKET without clientRequestId → 400, zero mutation', async () => {
        await expect(send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers' }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_REQUIRED' });
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    test('empty/whitespace clientRequestId counts as missing', async () => {
        await expect(send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: '   ' }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_REQUIRED' });
        await expect(send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', clientRequestId: '' }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_REQUIRED' });
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    // ── Replay + conflict identity ───────────────────────────────────────────

    test('same key, same parameters → replay of the exact original outcome', async () => {
        const first = await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-1' });
        expect(first.replay).toBe(false);
        const again = await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-1' });
        expect(again.replay).toBe(true);
        expect(again.message.id).toBe(first.message.id);
        expect(again.ticket.id).toBe(first.ticket.id);
        expect(await counts()).toEqual({ tickets: 1, messages: 1 });
    });

    test.each([
        ['different amount', { type: 'MONEY_REQUEST', moneyAmount: '31', clientRequestId: 'req-key-2' }],
        ['different currency', { type: 'MONEY_REQUEST', moneyAmount: '30', currency: 'USD', clientRequestId: 'req-key-2' }],
    ])('same key, %s → 409, zero mutation', async (_label, secondBody) => {
        await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-2' });
        const before = await counts();
        await expect(send(A, convAB, secondBody))
            .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        expect(await counts()).toEqual(before);
        expect(await db.message.count()).toBe(1);
    });

    test('same key, different conversation → 409', async () => {
        await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-3' });
        const convAC = await mkTwoParty(A, C);
        await expect(send(A, convAC, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-3' }))
            .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });

    test('same key, different KIND (money request key reused for escrow) → 409', async () => {
        await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '40', clientRequestId: 'req-key-4' });
        await expect(send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', clientRequestId: 'req-key-4' }))
            .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });

    test('different requester on the same key → 409', async () => {
        await send(A, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-5' });
        await expect(send(B, convAB, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'req-key-5' }))
            .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });

    test('escrow ticket replay + conflict (amount)', async () => {
        const first = await send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'esc-key-1' });
        const again = await send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'esc-key-1' });
        expect(again.replay).toBe(true);
        expect(again.message.id).toBe(first.message.id);
        await expect(send(A, convAB, { type: 'ESCROW_TICKET', amount: '41', itemName: 'Sneakers', clientRequestId: 'esc-key-1' }))
            .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        expect(await counts()).toEqual({ tickets: 1, messages: 1 });
    });

    // helper: fresh two-party personal conversation for the given users
    async function mkTwoParty(...users) {
        const conv = await db.conversation.create({ data: { type: 'PERSONAL' } });
        for (const u of users) await db.$executeRawUnsafe(
            'INSERT INTO "_ConversationParticipants" ("A", "B") VALUES ($1, $2)', conv.id, u.id);
        return db.conversation.findUnique({ where: { id: conv.id }, include: { participants: true } });
    }

    // ── Two-party enforcement ────────────────────────────────────────────────

    test('3-participant PERSONAL conversation: money request fails closed', async () => {
        await expect(send(A, convABC, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'tp-1' }))
            .rejects.toMatchObject({ status: 400, code: 'NOT_TWO_PARTY' });
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    test('3-participant PERSONAL conversation: escrow ticket fails closed', async () => {
        await expect(send(A, convABC, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', clientRequestId: 'tp-2' }))
            .rejects.toMatchObject({ status: 400, code: 'NOT_TWO_PARTY' });
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    test('3-participant PERSONAL conversation: money SEND still routes by recipientId', async () => {
        // MONEY_SEND is recipient-addressed by design; it is not the derived
        // counterparty flow, so it keeps working in the malformed group.
        const res = await send(A, convABC, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '5', clientRequestId: 'tp-3' });
        expect(res.replay).toBe(false);
    });

    // ── Escrow outcome transactionality ──────────────────────────────────────

    test('fund + release write resultMessageId inside the transaction', async () => {
        const created = await send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'dur-1' });
        const funded = await svc.fundEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        expect(funded.ticket.status).toBe('ESCROW_FUNDED');
        expect(funded.ticket.resultMessageId).toBeTruthy();
        const fundedMsg = await db.message.findUnique({ where: { id: funded.ticket.resultMessageId } });
        expect(fundedMsg.content).toContain('Escrow funded');

        const released = await svc.releaseEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        expect(released.ticket.status).toBe('ESCROW_RELEASED');
        expect(released.ticket.resultMessageId).toBeTruthy();
        const relMsg = await db.message.findUnique({ where: { id: released.ticket.resultMessageId } });
        expect(relMsg.content).toContain('Escrow released');
        expect(Number(await db.user.findUnique({ where: { id: B.id } }).then((u) => u.availableBalance))).toBeCloseTo(1040, 6);
    });

    test('message-write failure inside the release transaction rolls EVERYTHING back', async () => {
        const created = await send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'dur-2' });
        await svc.fundEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });

        // Poisoned client: every operation passes through EXCEPT the outcome
        // message write for the release — the exact crash window the r35
        // code left stranded (ticket committed, message lost).
        const poisoned = new Proxy(db, {
            get(target, prop) {
                if (prop !== '$transaction') return target[prop];
                return (fn) => target.$transaction((tx) => {
                    const txProxy = new Proxy(tx, {
                        get(t, p) {
                            if (p !== 'message') return t[p];
                            return new Proxy(t.message, {
                                get(tm, mp) {
                                    if (mp !== 'create') return tm[mp];
                                    return (args) => {
                                        if (String(args?.data?.content || '').startsWith('✅ Escrow released')) {
                                            throw new Error('INJECTED: outcome message write failed');
                                        }
                                        return tm.create(args);
                                    };
                                },
                            });
                        },
                    });
                    return fn(txProxy);
                });
            },
        });
        const poisonedSvc = new ConversationMoneyService({ prisma: poisoned });

        await expect(poisonedSvc.releaseEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id }))
            .rejects.toThrow('INJECTED');

        // Nothing moved: ticket still funded, B (seller) NOT paid, original
        // escrow message still in its funded status.
        const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: created.message.id } });
        expect(ticket.status).toBe('ESCROW_FUNDED');
        expect(Number((await db.user.findUnique({ where: { id: B.id } })).availableBalance)).toBeCloseTo(1000, 6);
        expect((await db.message.findUnique({ where: { id: created.message.id } })).status).toBe('ESCROW_FUNDED');

        // The durable path still works afterwards — no stranded state.
        const released = await svc.releaseEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        expect(released.ticket.status).toBe('ESCROW_RELEASED');
        expect(Number((await db.user.findUnique({ where: { id: B.id } })).availableBalance)).toBeCloseTo(1040, 6);
    });

    test('release replay after commit returns the durable outcome message', async () => {
        const created = await send(A, convAB, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'dur-3' });
        await svc.fundEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        const first = await svc.releaseEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        const replay = await svc.releaseEscrow({ user: A, conversationId: convAB.id, messageId: created.message.id });
        expect(replay.ticket.id).toBe(first.ticket.id);
        expect(replay.ticket.resultMessageId).toBe(first.ticket.resultMessageId);
        expect(replay.message.id).toBe(first.ticket.resultMessageId);
        expect(Number((await db.user.findUnique({ where: { id: B.id } })).availableBalance)).toBeCloseTo(1040, 6); // paid exactly once
    });
});
