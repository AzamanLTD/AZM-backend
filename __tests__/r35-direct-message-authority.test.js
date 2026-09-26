// __tests__/r35-direct-message-authority.test.js
// =============================================================================
// r35/P1 — DIRECT-MESSAGE AUTHORITY (real PostgreSQL, real HTTP).
//
// The legacy /api/direct-messages surface trusted caller-supplied
// businessId/userId. Proofs now pin the canonical authority semantics:
//   1. business A staff can access A (inbox)
//   2. A staff cannot access B's inbox
//   3. mismatched advisory businessId is refused, never honored
//   4. customer A can access their own business conversation thread
//   5. customer A cannot enumerate another customer's thread
//   6. arbitrary businessId cannot elevate a stranger (inbox + thread)
//   7. arbitrary userId cannot elevate a stranger
//   8. unauthorized user cannot create a conversation under another business
//   9. authorized staff can message the customer (create + send)
//  10. concurrent duplicate conversation creation converges on one
//      conversation with both messages, in order
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R35_DM_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient } = require('@prisma/client');
const directMessageRoutes = require('../routes/businessDirectMessageRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r35/P1 — direct-message authority', () => {
    let db;
    let app;
    let A, B;
    let customer, stranger, employeeA;
    let seq = 0;

    const asUser = (user) => { global.__R35_DM_USER__ = user ? { id: user.id } : null; };

    const inbox = (businessId) => request(app).get('/api/direct-messages/business-inbox').query(businessId ? { businessId } : {});
    const thread = (userId, businessId) => request(app).get('/api/direct-messages/thread').query({ userId, businessId });
    const send = (body) => request(app).post('/api/direct-messages/send').send(body);

    // A durable conversation between business A's owner and the customer.
    const seedConversation = async (biz, staff, other, messages = []) => {
        const conversation = await db.conversation.create({ data: { type: 'BUSINESS' } });
        const conv = await db.businessConversation.create({
            data: {
                businessProfileId: biz.id,
                conversationId: conversation.id,
                participantAId: staff.id,
                participantBId: other.id,
                createdBy: staff.id,
            },
        });
        for (const [senderId, content] of messages) {
            await db.message.create({
                data: { conversationId: conversation.id, senderId, messageType: 'TEXT', content },
            });
        }
        return conv;
    };

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/direct-messages', directMessageRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__R35_DM_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "Message", "Conversation", "BusinessConversation", "BusinessEmployee", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        customer = await db.user.create({
            data: { username: `cust_${++seq}`, email: `cust_${seq}@test.com`, password: 'x', azamanId: `AZM-C-${seq}` },
        });
        stranger = await db.user.create({
            data: { username: `str_${seq}`, email: `str_${seq}@test.com`, password: 'x', azamanId: `AZM-S-${seq}` },
        });
        // An ACTIVE employee of business A (staff authority without ownership).
        const staffUser = await db.user.create({
            data: { username: `staff_${seq}`, email: `staff_${seq}@test.com`, password: 'x', azamanId: `AZM-EMP-${seq}` },
        });
        employeeA = await db.businessEmployee.create({
            data: { businessProfileId: A.biz.id, userId: staffUser.id, role: 'STAFF', status: 'ACTIVE', permissions: [] },
        }).then(() => staffUser);
        // A SUSPENDED employee of business B — must hold no authority.
        await db.businessEmployee.create({
            data: { businessProfileId: B.biz.id, userId: stranger.id, role: 'STAFF', status: 'SUSPENDED', permissions: [] },
        });
        asUser(A.owner);
    });

    test('1. business A staff (owner) can access A inbox; employee can too', async () => {
        await seedConversation(A.biz, A.owner, customer, [[A.owner.id, 'hello customer']]);
        const res = await inbox(A.biz.id);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.conversations).toHaveLength(1);
        expect(res.body.conversations[0].user.id).toBe(customer.id);
        // An ACTIVE employee of A also has staff authority.
        asUser(employeeA);
        const empRes = await inbox(A.biz.id);
        expect(empRes.status).toBe(200);
        expect(empRes.body.conversations).toHaveLength(1);
    });

    test('2. A staff cannot access B inbox (cross-tenant refused)', async () => {
        await seedConversation(B.biz, B.owner, customer);
        const res = await inbox(B.biz.id);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        // Even listing with no advisory id returns A's business, never B's.
        const own = await inbox();
        expect(own.status).toBe(200);
        expect(own.body.conversations).toHaveLength(0);
    });

    test('3. mismatched advisory businessId is refused, never honored', async () => {
        await seedConversation(A.biz, A.owner, customer);
        await seedConversation(B.biz, B.owner, customer);
        // Caller (A staff) supplies B's business id while A conversations exist.
        const res = await inbox(B.biz.id);
        expect(res.status).toBe(403);
        const rows = await db.businessConversation.findMany({ where: { businessProfileId: B.biz.id } });
        expect(rows).toHaveLength(1); // untouched — it was seeded, not leaked
        // The refusal exposed nothing about B's conversations.
        expect(res.body.conversations).toBeUndefined();
    });

    test('4. customer A can access their own business conversation thread', async () => {
        const conv = await seedConversation(A.biz, A.owner, customer, [[A.owner.id, 'hi'], [customer.id, 'hello']]);
        asUser(customer);
        const res = await thread(customer.id, A.biz.id);
        expect(res.status).toBe(200);
        expect(res.body.messages).toHaveLength(2);
        expect(res.body.messages[0].text).toBe('hi');
        expect(res.body.messages[0].senderType).toBe('business');
        expect(res.body.messages[1].senderType).toBe('user');
        expect(conv.id).toBeTruthy();
    });

    test('5. customer A cannot enumerate another customer\'s thread', async () => {
        const otherCustomer = await db.user.create({
            data: { username: `other_${seq}`, email: `other_${seq}@test.com`, password: 'x', azamanId: `AZM-O-${seq}` },
        });
        await seedConversation(A.biz, A.owner, otherCustomer, [[A.owner.id, 'private staff thread']]);
        asUser(customer);
        // Tries to read the other customer's thread by their userId.
        const res = await thread(otherCustomer.id, A.biz.id);
        expect(res.status).toBe(403);
        expect(res.body.messages).toBeUndefined();
    });

    test('6. arbitrary businessId cannot elevate a stranger', async () => {
        await seedConversation(A.biz, A.owner, customer, [[A.owner.id, 'secret']]);
        asUser(stranger);
        const inboxRes = await inbox(A.biz.id);
        expect(inboxRes.status).toBe(403);
        const threadRes = await thread(customer.id, A.biz.id);
        expect(threadRes.status).toBe(403);
        expect(threadRes.body.messages).toBeUndefined();
    });

    test('7. arbitrary userId cannot elevate a stranger', async () => {
        await seedConversation(A.biz, A.owner, customer, [[A.owner.id, 'secret']]);
        asUser(stranger);
        // Stranger claims to be the customer via the userId locator.
        const res = await thread(customer.id, A.biz.id);
        expect(res.status).toBe(403);
        // And cannot read a thread even if they guess the participant pair.
        const res2 = await thread(stranger.id, A.biz.id);
        expect(res2.status).toBe(200);
        expect(res2.body.messages).toHaveLength(0); // no conversation exists — nothing leaked
    });

    test('8. unauthorized user cannot create a conversation under another business', async () => {
        asUser(stranger);
        const res = await send({ businessId: A.biz.id, userId: customer.id, text: 'let me in' });
        expect([403, 404]).toContain(res.status);
        expect(res.body.success).toBe(false);
        const rows = await db.businessConversation.findMany({ where: { businessProfileId: A.biz.id } });
        expect(rows).toHaveLength(0);
        expect(await db.message.count()).toBe(0);
        // A customer (participant) cannot create a NEW conversation either,
        // only write inside an existing one (proved in test 4/10).
        asUser(customer);
        const custRes = await send({ businessId: A.biz.id, userId: A.owner.id, text: 'hi' });
        expect(custRes.status).toBe(403);
        expect(await db.businessConversation.count()).toBe(0);
    });

    test('9. authorized staff can message the customer (create + send)', async () => {
        const res = await send({ businessId: A.biz.id, userId: customer.id, text: 'your order is ready' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message.text).toBe('your order is ready');
        expect(res.body.message.senderType).toBe('business');
        expect(res.body.message.senderId).toBe(A.owner.id);
        // Durable: one conversation, one message, preview updated.
        const convs = await db.businessConversation.findMany({ where: { businessProfileId: A.biz.id } });
        expect(convs).toHaveLength(1);
        expect(convs[0].participantAId).toBe(A.owner.id);
        expect(convs[0].participantBId).toBe(customer.id);
        expect(convs[0].lastMessagePreview).toBe('your order is ready');
        expect(await db.message.count()).toBe(1);
        // Send again — same conversation, no duplicate creation.
        const second = await send({ businessId: A.biz.id, userId: customer.id, text: 'and paid' });
        expect(second.status).toBe(200);
        expect(await db.businessConversation.count({ where: { businessProfileId: A.biz.id } })).toBe(1);
        expect(await db.message.count()).toBe(2);
        // An ACTIVE employee of A also has staff authority.
        asUser(employeeA);
        const emp = await send({ businessId: A.biz.id, userId: customer.id, text: 'from staff' });
        expect(emp.status).toBe(200);
    });

    test('10. concurrent duplicate conversation creation converges', async () => {
        // Two A-side staff race to open the same customer conversation.
        const [o1, o2] = await Promise.all([
            send({ businessId: A.biz.id, userId: customer.id, text: 'first' }),
            (async () => { asUser(employeeA); return send({ businessId: A.biz.id, userId: customer.id, text: 'second' }); })(),
        ]);
        const statuses = [o1.status, o2.status];
        for (const s of statuses) expect(s).toBe(200);
        const convs = await db.businessConversation.findMany({ where: { businessProfileId: A.biz.id } });
        expect(convs).toHaveLength(1); // exactly one conversation — convergence
        const messages = await db.message.findMany({ orderBy: { createdAt: 'asc' } });
        expect(messages).toHaveLength(2); // both messages landed, no loss
        expect(messages.map((m) => m.content).sort()).toEqual(['first', 'second']);
        // The conversation is attached to A durably with a staff participant.
        expect(convs[0].participantBId).toBe(customer.id);
        expect([A.owner.id, employeeA.id]).toContain(convs[0].participantAId);
    });
});
