// __tests__/r36-conversation-money-state-machine.test.js
// =============================================================================
// r36/P0 — CONVERSATION MONEY STATE MACHINE (real PostgreSQL, real HTTP).
//
// The legacy /api/conversations money handlers had four structural flaws:
//   1. messageId resolved GLOBALLY — actions could act on foreign
//      conversations' money messages;
//   2. accept-money moved money BEFORE the state claim — concurrent accepts
//      both transferred;
//   3. fund-escrow's `status: { not: 'ESCROW_FUNDED' }` claim re-matched
//      RELEASED/DISPUTED tickets, and dispute-after-release OVERWROTE a
//      settled outcome;
//   4. amounts were parsed from emoji text and counterparties came from
//      unchecked client fields.
//
// Proofs pinned here:
//   • structured amounts (strict exact-decimal validation, no text parsing)
//   • the durable counterparty is derived from membership, not the client
//   • every financial transition is a CAS whose predicate binds messageId to
//     the URL conversationId (foreign message → 404, no mutation)
//   • explicit terminal state machine (accept/decline, fund/release/dispute)
//   • concurrent duplicates converge on ONE financial effect
//   • MONEY_SEND idempotency: same key replays, conflicts fail closed,
//     concurrent duplicates produce one transfer
//   • legacy money messages without a ticket fail closed (404)
//   • GET messages returns real structured money fields (additive)
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_MONEY_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_MONEY_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const conversationRoutes = require('../routes/conversationRoutes');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P0 — conversation money state machine', () => {
    // r37 contract: every money-bearing creation needs a durable
    // idempotency key. Unique per call so lifecycle tests that create
    // several requests in one millisecond never accidentally replay.
    let _legacySeq = 0;
    const _legacyKey = () => 'r36-legacy-' + Date.now() + '-' + (++_legacySeq);
    let db;
    let app;
    let A, B, C;
    let convAB, convBC;

    const asUser = (user) => { global.__R36_MONEY_USER__ = user ? { id: user.id } : null; };

    const post = (convId, body) => request(app).post(`/api/conversations/${convId}/messages`).send(body);
    const accept = (convId, messageId) => request(app).post(`/api/conversations/${convId}/messages/${messageId}/accept-money`);
    const decline = (convId, messageId) => request(app).post(`/api/conversations/${convId}/messages/${messageId}/decline-money`);
    const fund = (convId, messageId) => request(app).post(`/api/conversations/${convId}/messages/${messageId}/fund-escrow`);
    const release = (convId, messageId) => request(app).post(`/api/conversations/${convId}/messages/${messageId}/release-escrow`);
    const dispute = (convId, messageId, reason) => request(app).post(`/api/conversations/${convId}/messages/${messageId}/dispute-escrow`).send({ reason });
    const history = (convId) => request(app).get(`/api/conversations/${convId}/messages`);

    const bal = async (id) => Number((await db.user.findUnique({ where: { id }, select: { availableBalance: true } })).availableBalance);

    const mkConv = async (...users) => {
        const conv = await db.conversation.create({ data: { type: 'PERSONAL' } });
        for (const u of users) await db.$executeRawUnsafe(
            'INSERT INTO "_ConversationParticipants" ("A", "B") VALUES ($1, $2)', conv.id, u.id);
        return conv;
    };

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/conversations', conversationRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R36_MONEY_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "TransactionHistory", "Contact", "JournalEntry", "LedgerTransaction", "LedgerAccount", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedUser(db, { availableBalance: 1000 });
        B = await seedUser(db, { availableBalance: 1000 });
        C = await seedUser(db, { availableBalance: 1000 });
        convAB = await mkConv(A, B);
        convBC = await mkConv(B, C);
    });

    // ── MONEY_SEND ────────────────────────────────────────────────────────────

    describe('MONEY_SEND', () => {
        test('happy path: transfers, tickets, history, ledger, envelope', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '25.5', clientRequestId: 'send-1', note: 'lunch' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.moneyAmount).toBe('25.50');
            expect(res.body.data.moneyStatus).toBe('ACCEPTED');
            expect(res.body.data.type).toBe('PAYMENT_TRANSFER');
            expect(res.body.data.status).toBe('ACCEPTED');

            expect(await bal(A.id)).toBeCloseTo(974.5, 6);
            expect(await bal(B.id)).toBeCloseTo(1025.5, 6);

            const ticket = await db.conversationMoneyTicket.findFirst({ where: { conversationId: convAB.id } });
            expect(ticket.kind).toBe('MONEY_SEND');
            expect(ticket.status).toBe('ACCEPTED');
            expect(ticket.counterpartyId).toBe(B.id);
            expect(ticket.requesterId).toBe(A.id);

            const thA = await db.transactionHistory.findFirst({ where: { userId: A.id, type: 'INTERNAL_TRANSFER' } });
            const thB = await db.transactionHistory.findFirst({ where: { userId: B.id, type: 'INTERNAL_TRANSFER' } });
            expect(Number(thA.amountUsdc)).toBeCloseTo(-25.5, 6);
            expect(Number(thB.amountUsdc)).toBeCloseTo(25.5, 6);
            expect(thB.status).toBe('COMPLETED');

            const entries = await db.journalEntry.findMany({
                where: { ledgerTransaction: { description: { contains: 'Chat money transfer' } } },
            });
            expect(entries.length).toBe(2);
        });

        test('same clientRequestId replay returns the ORIGINAL outcome, no second transfer', async () => {
            asUser(A);
            const first = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10', clientRequestId: 'send-2' });
            expect(first.status).toBe(201);
            const replay = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10', clientRequestId: 'send-2' });
            expect(replay.status).toBe(201);
            expect(replay.body.data.id).toBe(first.body.data.id);

            expect(await bal(A.id)).toBeCloseTo(990, 6);
            expect(await bal(B.id)).toBeCloseTo(1010, 6);
            expect(await db.conversationMoneyTicket.count({ where: { kind: 'MONEY_SEND' } })).toBe(1);
        });

        test('same key with different amount / recipient / conversation fails closed (409)', async () => {
            asUser(A);
            await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10', clientRequestId: 'send-3' });
            const diffAmount = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '20', clientRequestId: 'send-3' });
            const diffRecipient = await post(convAB.id, { type: 'MONEY_SEND', recipientId: C.id, moneyAmount: '10', clientRequestId: 'send-3' });
            const convAC = await mkConv(A, C);
            const diffConv = await post(convAC.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10', clientRequestId: 'send-3' });
            expect(diffAmount.status).toBe(409);
            expect(diffRecipient.status).toBe(409);
            expect(diffConv.status).toBe(409);
            expect(await bal(A.id)).toBeCloseTo(990, 6);
        });

        test('missing clientRequestId → 400 IDEMPOTENCY_REQUIRED, no mutation', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10' });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/clientRequestId/);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
        });

        test('concurrent duplicates with the same key converge on ONE transfer', async () => {
            asUser(A);
            const results = await Promise.all(Array.from({ length: 5 }, () =>
                post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10', clientRequestId: 'send-race' })));
            const created = results.filter((r) => r.status === 201 && r.body.data);
            expect(created.length).toBe(1);
            expect(await bal(A.id)).toBeCloseTo(990, 6);
            expect(await bal(B.id)).toBeCloseTo(1010, 6);
            expect(await db.conversationMoneyTicket.count({ where: { kind: 'MONEY_SEND' } })).toBe(1);
            const msgIds = new Set(created.map((r) => r.body.data.id));
            expect(msgIds.size).toBe(1);
        });

        test.each([
            ['abc'], [-5], [0], ['1e3'], ['1.123456789'], [null], [undefined], ['NaN'],
        ])('malformed amount %p → 400, no mutation', async (bad) => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: bad, clientRequestId: 'send-x' });
            expect(res.status).toBe(400);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
        });

        test('insufficient balance → 400, no mutation anywhere', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '10000', clientRequestId: 'send-ib' });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/Insufficient/i);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            // seedUser backs seeded balances with DEPOSIT_CRYPTO rows; assert
            // no NEW economic rows were written by the refused send.
            expect(await db.transactionHistory.count({ where: { type: { not: 'DEPOSIT_CRYPTO' } } })).toBe(0);
        });

        test('send to self and invalid recipientId → 400', async () => {
            asUser(A);
            expect((await post(convAB.id, { type: 'MONEY_SEND', recipientId: A.id, moneyAmount: '1', clientRequestId: 's1' })).status).toBe(400);
            expect((await post(convAB.id, { type: 'MONEY_SEND', recipientId: 'nope', moneyAmount: '1', clientRequestId: 's2' })).status).toBe(400);
        });

        test('non-participant of the conversation cannot post into it (403)', async () => {
            asUser(C);
            const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '1', clientRequestId: 's3' });
            expect(res.status).toBe(403);
        });
    });

    // ── MONEY_REQUEST ────────────────────────────────────────────────────────

    describe('MONEY_REQUEST lifecycle', () => {
        test('happy path: request is a ticket, no money moves at creation', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', fromUserId: B.id, note: 'wifi bill' , clientRequestId: _legacyKey() });
            expect(res.status).toBe(201);
            expect(res.body.data.type).toBe('MONEY_REQUEST');
            expect(res.body.data.moneyAmount).toBe('30.00');
            expect(res.body.data.moneyStatus).toBe('sent');
            const ticket = await db.conversationMoneyTicket.findFirst({ where: { kind: 'MONEY_REQUEST' } });
            expect(ticket.status).toBe('sent');
            expect(ticket.counterpartyId).toBe(B.id);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
        });

        test('only PERSONAL conversations: TRADE-like BUSINESS conversation → 400', async () => {
            const bizConv = await db.conversation.create({ data: { type: 'BUSINESS' } });
            await db.$executeRawUnsafe('INSERT INTO "_ConversationParticipants" ("A", "B") VALUES ($1, $2), ($1, $3)', bizConv.id, A.id, B.id);
            asUser(A);
            const res = await post(bizConv.id, { type: 'MONEY_REQUEST', moneyAmount: '5' , clientRequestId: _legacyKey() });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/personal/i);
        });

        test('client-supplied fromUserId that disagrees with membership → 400', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '5', fromUserId: C.id , clientRequestId: _legacyKey() });
            expect(res.status).toBe(400);
        });

        test('accept moves money exactly once and records the outcome', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            const msgId = req.body.data.id;

            asUser(B);
            const res = await accept(convAB.id, msgId);
            expect(res.status).toBe(200);
            expect(res.body.data.moneyStatus).toBe('ACCEPTED');

            expect(await bal(A.id)).toBeCloseTo(1030, 6);
            expect(await bal(B.id)).toBeCloseTo(970, 6);
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(ticket.status).toBe('ACCEPTED');
            expect(ticket.resultMessageId).toBeTruthy();
            const msg = await db.message.findUnique({ where: { id: msgId } });
            expect(msg.status).toBe('ACCEPTED');
            const th = await db.transactionHistory.findMany({ where: { type: 'INTERNAL_TRANSFER' } });
            expect(th.length).toBe(2);
        });

        test('requester cannot accept their own request', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            const res = await accept(convAB.id, req.body.data.id);
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/own request/i);
        });

        test('a stranger (non-participant) cannot accept — 403 at the route', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            asUser(C);
            const res = await accept(convAB.id, req.body.data.id);
            expect(res.status).toBe(403);
        });

        test('foreign messageId from ANOTHER conversation → 404, original untouched', async () => {
            asUser(B);
            const bcReq = await post(convBC.id, { type: 'MONEY_REQUEST', moneyAmount: '15' , clientRequestId: _legacyKey() });
            const bcMsgId = bcReq.body.data.id;

            // A requests money from B inside convAB.
            asUser(A);
            const abReq = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            const abMsgId = abReq.body.data.id;

            // B tries to act on the convBC message THROUGH convAB's URL.
            asUser(B);
            const res = await accept(convAB.id, bcMsgId);
            expect(res.status).toBe(404);

            const bcTicket = await db.conversationMoneyTicket.findUnique({ where: { messageId: bcMsgId } });
            expect(bcTicket.status).toBe('sent');
            expect(await bal(C.id)).toBeCloseTo(1000, 6);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
            expect(await db.conversationMoneyTicket.findUnique({ where: { messageId: abMsgId } }).then((t) => t.status)).toBe('sent');
        });

        test('concurrent accepts converge on ONE transfer', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            const msgId = req.body.data.id;

            asUser(B);
            const results = await Promise.all([accept(convAB.id, msgId), accept(convAB.id, msgId), accept(convAB.id, msgId)]);
            for (const r of results) expect([200, 400, 409]).toContain(r.status);

            expect(await bal(A.id)).toBeCloseTo(1030, 6);
            expect(await bal(B.id)).toBeCloseTo(970, 6);
            const th = await db.transactionHistory.findMany({ where: { type: 'INTERNAL_TRANSFER' } });
            expect(th.length).toBe(2);
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(ticket.status).toBe('ACCEPTED');
        });

        test('insufficient balance at accept → 400 and NO mutation (request stays sent)', async () => {
            asUser(B);
            await db.user.update({ where: { id: B.id }, data: { availableBalance: 5 } });
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            asUser(B);
            const res = await accept(convAB.id, req.body.data.id);
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/Insufficient/i);
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: req.body.data.id } });
            expect(ticket.status).toBe('sent');
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            expect(await bal(B.id)).toBeCloseTo(5, 6);
        });

        test('decline moves no money; replay of decline returns the outcome; cross-state flips rejected', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            const msgId = req.body.data.id;

            asUser(B);
            expect((await decline(convAB.id, msgId)).status).toBe(200);
            const replay = await decline(convAB.id, msgId);
            expect(replay.status).toBe(200);
            const after = await accept(convAB.id, msgId);
            expect(after.status).toBe(400);

            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(ticket.status).toBe('DECLINED');
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
        });

        test('accept after decline → 400 ALREADY_DECLINED', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            asUser(B);
            await decline(convAB.id, req.body.data.id);
            const res = await accept(convAB.id, req.body.data.id);
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(/declined/i);
        });

        test('accept replay after accept returns the original outcome, no double payment', async () => {
            asUser(A);
            const req = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30' , clientRequestId: _legacyKey() });
            asUser(B);
            const first = await accept(convAB.id, req.body.data.id);
            const replay = await accept(convAB.id, req.body.data.id);
            expect(replay.status).toBe(200);
            expect(replay.body.data.id).toBe(first.body.data.id);
            expect(await bal(A.id)).toBeCloseTo(1030, 6);
            expect(await bal(B.id)).toBeCloseTo(970, 6);
        });
    });

    // ── ESCROW_TICKET ─────────────────────────────────────────────────────────

    describe('ESCROW_TICKET lifecycle', () => {
        const mkTicket = async (amount = '40') => {
            asUser(A);
            const res = await post(convAB.id, { type: 'ESCROW_TICKET', amount, itemName: 'Sneakers', counterpartyId: B.id , clientRequestId: _legacyKey() });
            expect(res.status).toBe(201);
            return res.body.data.id;
        };

        test('creation requires a real itemName; ticket is unfunded at birth', async () => {
            asUser(A);
            const noItem = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40' , clientRequestId: _legacyKey() });
            expect(noItem.status).toBe(400);

            const ok = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers' , clientRequestId: _legacyKey() });
            expect(ok.status).toBe(201);
            expect(ok.body.data.moneyAmount).toBe('40.00');
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: ok.body.data.id } });
            expect(ticket.kind).toBe('ESCROW_TICKET');
            expect(ticket.status).toBe('sent');
            expect(ticket.counterpartyId).toBe(B.id);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
        });

        test('client-supplied counterpartyId that disagrees with membership → 400', async () => {
            asUser(A);
            const res = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', counterpartyId: C.id , clientRequestId: _legacyKey() });
            expect(res.status).toBe(400);
        });

        test('release before fund → 400 NOT_FUNDED; non-owner fund/release → 403', async () => {
            const msgId = await mkTicket();
            asUser(A);
            expect((await release(convAB.id, msgId)).status).toBe(400);

            asUser(B);
            expect((await fund(convAB.id, msgId)).status).toBe(403);
            expect((await release(convAB.id, msgId)).status).toBe(403);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
        });

        test('full happy lifecycle: fund locks, release pays the durable counterparty exactly once', async () => {
            const msgId = await mkTicket('40');

            asUser(A);
            const f = await fund(convAB.id, msgId);
            expect(f.status).toBe(200);
            expect(f.body.data.moneyStatus).toBe('ESCROW_FUNDED');
            expect(await bal(A.id)).toBeCloseTo(960, 6);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
            const lockEntries = await db.journalEntry.findMany({ where: { account: `escrow:chatmsg-${msgId}:locked` } });
            expect(lockEntries.length).toBe(1);
            const thA = await db.transactionHistory.findFirst({ where: { userId: A.id, type: 'ESCROW_FUNDING' } });
            expect(thA.status).toBe('PENDING');

            const r = await release(convAB.id, msgId);
            expect(r.status).toBe(200);
            expect(r.body.data.moneyStatus).toBe('ESCROW_RELEASED');
            expect(await bal(A.id)).toBeCloseTo(960, 6);
            expect(await bal(B.id)).toBeCloseTo(1040, 6);
            const thB = await db.transactionHistory.findFirst({ where: { userId: B.id, type: 'ESCROW_RELEASE' } });
            expect(Number(thB.amountUsdc)).toBeCloseTo(40, 6);
            const msg = await db.message.findUnique({ where: { id: msgId } });
            expect(msg.status).toBe('ESCROW_RELEASED');
        });

        test('fund is idempotent: replay returns the fund outcome with NO second lock', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, msgId);
            const replay = await fund(convAB.id, msgId);
            expect(replay.status).toBe(200);
            expect(await bal(A.id)).toBeCloseTo(960, 6);
            expect(await db.transactionHistory.count({ where: { type: 'ESCROW_FUNDING' } })).toBe(1);
        });

        test('THE LEGACY RE-FUND HOLE IS CLOSED: released/disputed tickets can never be re-funded', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, msgId);
            await release(convAB.id, msgId);
            const ref = await fund(convAB.id, msgId);
            expect(ref.status).toBe(400);
            expect(ref.body.message).toMatch(/already released/i);
            expect(await bal(A.id)).toBeCloseTo(960, 6);
            expect(await bal(B.id)).toBeCloseTo(1040, 6);
        });

        test('release is idempotent: replay pays the seller ONCE', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, msgId);
            const first = await release(convAB.id, msgId);
            const replay = await release(convAB.id, msgId);
            expect(replay.status).toBe(200);
            expect(replay.body.data.id).toBe(first.body.data.id);
            expect(await bal(B.id)).toBeCloseTo(1040, 6);
            expect(await db.transactionHistory.count({ where: { type: 'ESCROW_RELEASE' } })).toBe(1);
        });

        test('concurrent funds converge on ONE lock', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            const results = await Promise.all([fund(convAB.id, msgId), fund(convAB.id, msgId), fund(convAB.id, msgId)]);
            for (const r of results) expect([200, 400, 409]).toContain(r.status);
            expect(await bal(A.id)).toBeCloseTo(960, 6);
            expect(await db.transactionHistory.count({ where: { type: 'ESCROW_FUNDING' } })).toBe(1);
        });

        test('THE LEGACY DISPUTE-OVERWRITE IS CLOSED: dispute after release → 400, settled outcome untouched', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, msgId);
            await release(convAB.id, msgId);
            const d = await dispute(convAB.id, msgId, 'never got it');
            expect(d.status).toBe(400);
            expect(d.body.message).toMatch(/already released/i);
            expect(await bal(B.id)).toBeCloseTo(1040, 6);
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(ticket.status).toBe('ESCROW_RELEASED');
        });

        test('dispute from sent or funded is terminal: fund and release afterwards are refused', async () => {
            const sentTicket = await mkTicket('40');
            asUser(B);
            await dispute(convAB.id, sentTicket, 'fake');
            asUser(A);
            expect((await fund(convAB.id, sentTicket)).status).toBe(400);
            expect((await release(convAB.id, sentTicket)).status).toBe(400);

            const fundedTicket = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, fundedTicket);
            asUser(B);
            const d = await dispute(convAB.id, fundedTicket, 'wrong item');
            expect(d.status).toBe(200);
            asUser(A);
            expect((await release(convAB.id, fundedTicket)).status).toBe(400);
            expect((await fund(convAB.id, fundedTicket)).status).toBe(400);
            expect(await bal(B.id)).toBeCloseTo(1000, 6);
            expect(await bal(A.id)).toBeCloseTo(960, 6);
        });

        test('dispute replay is idempotent; stranger cannot dispute (route 403)', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            const first = await dispute(convAB.id, msgId, 'r1');
            expect(first.status).toBe(200);
            const replay = await dispute(convAB.id, msgId, 'r1');
            expect(replay.status).toBe(200);
            expect(replay.body.data.id).toBe(first.body.data.id);

            asUser(C);
            const stranger = await dispute(convAB.id, msgId, 'x');
            expect(stranger.status).toBe(403);
        });

        test('concurrent release vs dispute: exactly one wins, money never lands twice', async () => {
            const msgId = await mkTicket('40');
            asUser(A);
            await fund(convAB.id, msgId);

            // Same caller races release vs dispute (double-tap / retry storm):
            // the two CAS claims fight over one ticket, exactly one wins.
            const [rel, dis] = await Promise.all([
                release(convAB.id, msgId),
                dispute(convAB.id, msgId, 'racing dispute'),
            ]);
            // 409 CLAIM_LOST is an honest loser outcome of the CAS race.
            expect([200, 400, 409]).toContain(rel.status);
            expect([200, 400, 409]).toContain(dis.status);
            // Both cannot claim: at most one 200.
            expect([rel.status, dis.status].filter((s) => s === 200).length).toBe(1);

            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(['ESCROW_RELEASED', 'ESCROW_DISPUTED']).toContain(ticket.status);
            if (ticket.status === 'ESCROW_RELEASED') {
                expect(await bal(B.id)).toBeCloseTo(1040, 6);
            } else {
                expect(await bal(B.id)).toBeCloseTo(1000, 6);
                expect(await bal(A.id)).toBeCloseTo(960, 6);
            }
        });

        test('foreign escrow messageId through another conversation → 404', async () => {
            const msgId = await mkTicket('40');
            // C and B share convBC; C tries to fund A-B's ticket through convBC.
            asUser(C);
            const res = await fund(convBC.id, msgId);
            expect(res.status).toBe(404);
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { messageId: msgId } });
            expect(ticket.status).toBe('sent');
        });

        test('LEGACY money message with no ticket fails closed (404), never parses text', async () => {
            asUser(A);
            const legacy = await db.message.create({
                data: { conversationId: convAB.id, senderId: A.id, messageType: 'ESCROW_TICKET', content: '🛡️ Escrow: Sneakers — 40.00 GHS' },
            });
            const res = await fund(convAB.id, legacy.id);
            expect(res.status).toBe(404);
            expect(await bal(A.id)).toBeCloseTo(1000, 6);
        });
    });

    // ── GET messages enrichment ──────────────────────────────────────────────

    describe('GET messages: real structured money fields', () => {
        test('financial messages carry moneyAmount/moneyStatus/escrowTicket; TEXT stays null', async () => {
            asUser(A);
            await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '12.5', clientRequestId: 'hist-1' });
            const ticketMsg = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers' , clientRequestId: _legacyKey() });
            await post(convAB.id, { type: 'TEXT', text: 'hello' });

            asUser(B);
            const res = await history(convAB.id);
            expect(res.status).toBe(200);
            const msgs = res.body.data;
            expect(msgs.length).toBe(3);

            const send = msgs.find((m) => m.type === 'PAYMENT_TRANSFER');
            expect(send.moneyAmount).toBe('12.50');
            expect(send.moneyStatus).toBe('ACCEPTED');

            const esc = msgs.find((m) => m.type === 'ESCROW_TICKET');
            expect(esc.moneyAmount).toBe('40.00');
            // r38/P0 — the chat-money rail's canonical asset is USDC (the wallet
            // it debits is the ledger's user-liability mirror, asset USDC).
            expect(esc.escrowTicket).toMatchObject({ status: 'sent', currency: 'USDC' });

            const text = msgs.find((m) => m.type === 'TEXT');
            expect(text.moneyAmount).toBeNull();
            expect(text.escrowTicket).toBeNull();
            expect(text.text).toBe('hello');
            expect(text.senderName).toBe(A.username);
        });

        test('non-participant cannot read history (403)', async () => {
            asUser(C);
            const res = await history(convAB.id);
            expect(res.status).toBe(403);
        });
    });
});
