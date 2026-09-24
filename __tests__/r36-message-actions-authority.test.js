// __tests__/r36-message-actions-authority.test.js
// =============================================================================
// r36 — MESSAGE ACTION AUTHORITY (real PostgreSQL, real HTTP).
//
// The legacy authorizeTrade passed ANY tradeId-less Message through to ANY
// caller: knowing a message id was enough authority to pin, star, or forward
// it. The r36 fix makes every trade-context message resolve through its
// owning context:
//   • tradeId set → the caller must be a participant of that trade;
//   • tradeId unset → the caller must be a participant of the message's
//     CONVERSATION.
//
// forwardMessage additionally re-authorizes the destination (friendship
// membership / group membership) before creating the forwarded copy.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_MA_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_MA_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const controller = require('../controllers/messageActionController');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36 — message action authority', () => {
    let db;
    let app;
    let u1, u2, outsider;
    let friendship;
    let conv;
    let trade;
    let tradeMsg;        // Message with tradeId
    let convMsg;         // Message with NO tradeId (lives in a conversation)
    let otherConvMsg;    // Message in a conversation outsider is NOT part of

    const asUser = (user) => { global.__R36_MA_USER__ = user ? { id: user.id, username: user.username } : null; };
    const pin = (context, id) => request(app).patch(`/api/messages/${context}/${id}/pin`).send({});
    const star = (context, id) => request(app).patch(`/api/messages/${context}/${id}/star`).send({});
    const fwd = (body) => request(app).post('/api/messages/forward').send(body);

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/messages', require('../routes/messageActionRoutes'));
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R36_MA_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "Message", "Conversation", "_ConversationParticipants", "Trade", "DirectMessage", "Friendship", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        u1 = await seedUser(db);
        u2 = await seedUser(db);
        outsider = await seedUser(db);

        friendship = await db.friendship.create({
            data: { requesterId: u1.id, addresseeId: u2.id, status: 'ACCEPTED' },
        });

        conv = await db.conversation.create({
            data: { type: 'PERSONAL', participants: { connect: [{ id: u1.id }, { id: u2.id }] } },
        });

        trade = await db.trade.create({
            data: {
                crypto: 'USDC', amountCrypto: 10, amountFiat: 100, type: 'BUY', rate: 10, expiresAt: new Date(Date.now() + 3600e3),
                userId: u1.id, vendorId: u2.id,
            },
        });

        tradeMsg = await db.message.create({
            data: { conversationId: conv.id, senderId: u1.id, tradeId: trade.id, content: 'on my way' },
        });
        convMsg = await db.message.create({
            data: { conversationId: conv.id, senderId: u1.id, content: 'no trade here' },
        });

        // A private conversation outsider cannot touch: u1 ↔ a fresh user.
        const stranger = await seedUser(db);
        const otherConv = await db.conversation.create({
            data: { type: 'PERSONAL', participants: { connect: [{ id: u1.id }, { id: stranger.id }] } },
        });
        otherConvMsg = await db.message.create({
            data: { conversationId: otherConv.id, senderId: u1.id, content: 'private' },
        });
    });

    describe('authorizeTrade — trade-context messages', () => {
        test('a trade PARTICIPANT can pin and star the trade message', async () => {
            asUser(u2);
            const p = await pin('trade', tradeMsg.id);
            expect(p.status).toBe(200);
            expect(p.body.data.isPinned).toBe(true);
            const s = await star('trade', tradeMsg.id);
            expect(s.status).toBe(200);
            expect(s.body.data.isStarred).toBe(true);
        });

        test('an OUTSIDER is refused on a trade message (participant check via tradeId)', async () => {
            asUser(outsider);
            expect((await pin('trade', tradeMsg.id)).status).toBe(404);
            expect((await star('trade', tradeMsg.id)).status).toBe(404);
            const row = await db.message.findUnique({ where: { id: tradeMsg.id } });
            expect(row.isPinned).toBe(false);
            expect(row.isStarred).toBe(false);
        });

        test('r36 FIX: tradeId-LESS messages resolve through the CONVERSATION — outsider refused', async () => {
            // u2 IS a conversation participant → allowed.
            asUser(u2);
            expect((await star('trade', convMsg.id)).status).toBe(200);

            // outsider is NOT in the conversation → refused, legacy passed this through.
            asUser(outsider);
            expect((await pin('trade', convMsg.id)).status).toBe(404);
            const row = await db.message.findUnique({ where: { id: convMsg.id } });
            expect(row.isPinned).toBe(false);
        });

        test('a message in a conversation the caller is not part of — refused even for the sender-less case', async () => {
            asUser(outsider);
            expect((await star('trade', otherConvMsg.id)).status).toBe(404);
        });
    });

    describe('forwardMessage — source authority + destination authority', () => {
        test('a participant can forward a trade message to an accepted friendship', async () => {
            asUser(u2);
            const res = await fwd({
                messageId: tradeMsg.id, fromContext: 'trade',
                toContext: 'direct', toConversationId: friendship.id,
            });
            expect(res.status).toBe(200);
            const copy = await db.directMessage.findFirst({
                where: { friendshipId: friendship.id, forwardedFromId: tradeMsg.id },
            });
            expect(copy).toBeTruthy();
            expect(copy.content).toBe('on my way');
            expect(copy.senderId).toBe(u2.id);
        });

        test('an OUTSIDER cannot forward a trade message (source authorization)', async () => {
            asUser(outsider);
            const res = await fwd({
                messageId: tradeMsg.id, fromContext: 'trade',
                toContext: 'direct', toConversationId: friendship.id,
            });
            expect(res.status).toBe(404);
            expect(await db.directMessage.count({ where: { forwardedFromId: tradeMsg.id } })).toBe(0);
        });

        test('forward to a friendship the caller is NOT part of → 403', async () => {
            asUser(outsider);
            const res = await fwd({
                messageId: tradeMsg.id, fromContext: 'trade',
                toContext: 'direct', toConversationId: friendship.id, // u1-u2 only
            });
            // outsider already fails source auth; use u2 forwarding to a
            // friendship they are not in: seed one more friendship u1↔stranger.
            const stranger = await seedUser(db);
            const fs = await db.friendship.create({
                data: { requesterId: u1.id, addresseeId: stranger.id, status: 'ACCEPTED' },
            });
            asUser(u2);
            const res2 = await fwd({
                messageId: tradeMsg.id, fromContext: 'trade',
                toContext: 'direct', toConversationId: fs.id,
            });
            expect(res2.status).toBe(403);
            expect(res.status).toBe(404);
            expect(await db.directMessage.count({ where: { friendshipId: fs.id } })).toBe(0);
        });

        test('a DELETED source message cannot be forwarded', async () => {
            await db.message.update({ where: { id: tradeMsg.id }, data: { deletedAt: new Date() } });
            asUser(u2);
            const res = await fwd({
                messageId: tradeMsg.id, fromContext: 'trade',
                toContext: 'direct', toConversationId: friendship.id,
            });
            expect(res.status).toBe(400);
        });
    });

    describe('getStarredMessages reflects only the caller’s own conversations', () => {
        test('starred rows the caller can see are returned', async () => {
            asUser(u2);
            await star('trade', tradeMsg.id);
            const res = await request(app).get('/api/messages/starred').send({});
            expect(res.status).toBe(200);
            const tradeIds = (Array.isArray(res.body.data) ? res.body.data : []).filter((m) => m.context === 'trade').map((m) => m.id);
            expect(tradeIds).toContain(tradeMsg.id);

            // An outsider sees NOTHING of it.
            asUser(outsider);
            const res2 = await request(app).get('/api/messages/starred').send({});
            const ids2 = (Array.isArray(res2.body.data) ? res2.body.data : []).map((m) => m.id);
            expect(ids2).not.toContain(tradeMsg.id);
        });
    });
});
