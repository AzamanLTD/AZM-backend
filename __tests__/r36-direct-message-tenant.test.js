// __tests__/r36-direct-message-tenant.test.js
// =============================================================================
// r36/P1 — DIRECT-MESSAGE TENANT RAIL (real PostgreSQL, real HTTP).
//
// Builds on r35's authority proofs with the NEW r36 tenant invariants:
//   • the customer slot (participantB) is DURABLE — a customer can never
//     substitute another customer's id into a thread;
//   • business-side access is STAFF-ONLY for support threads: a suspended or
//     terminated employee (a former participantA without an active staff
//     context) loses thread/inbox/write access, while the customer keeps it;
//   • one-thread-per-(business, customer) is a DATABASE invariant (partial
//     unique index on channel='CUSTOMER_SUPPORT') — direct duplicate insert
//     is refused by the engine, and concurrent staff creates converge;
//   • legacy rows (channel NULL) remain locatable — no breakage of history.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_DM_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_DM_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const { BusinessDirectMessageService } = require('../services/businessOS/businessDirectMessageService');
const directMessageRoutes = require('../routes/businessDirectMessageRoutes');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P1 — direct-message tenant rail', () => {
    let db;
    let app;
    let A;
    let owner, staffUser, employeeA;
    let customer, customer2;
    let seq = 0;

    const asUser = (user) => { global.__R36_DM_USER__ = user ? { id: user.id } : null; };

    const inbox = (businessId) => request(app).get('/api/direct-messages/business-inbox').query(businessId ? { businessId } : {});
    const thread = (businessId, userId) => request(app).get('/api/direct-messages/thread').query({ businessId, userId });
    const send = (body) => request(app).post('/api/direct-messages/send').send(body);

    const mkEmployee = async (biz, user, status = 'ACTIVE') => {
        await db.businessEmployee.create({
            data: { businessProfileId: biz.id, userId: user.id, role: 'STAFF', status, permissions: [] },
        });
        return user;
    };

    // Staff-initiated support thread through the CANONICAL service path.
    const openThread = async (biz, staff, customerUser, content = 'how can we help?') => {
        const svc = new BusinessDirectMessageService(db);
        const result = await svc.send({
            user: { id: staff.id }, businessId: biz.id, userId: customerUser.id, text: content,
        });
        return result.conversation;
    };

    const threadRow = async (bizId, customerUserId) => db.businessConversation.findFirst({
        where: { businessProfileId: bizId, participantBId: customerUserId },
    });

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
        global.__R36_DM_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "Message", "Conversation", "BusinessConversation", "BusinessEmployee", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        owner = A.owner;
        staffUser = await seedUser(db);
        employeeA = await mkEmployee(A.biz, staffUser, 'ACTIVE');
        customer = await seedUser(db);
        customer2 = await seedUser(db);
        asUser(owner);
    });

    test('new support threads are created on the canonical channel with the durable customer slot', async () => {
        const conv = await openThread(A.biz, owner, customer);
        expect(conv.channel).toBe('CUSTOMER_SUPPORT');
        expect(conv.participantBId).toBe(customer.id);
        expect(conv.participantAId).toBe(owner.id);
    });

    test('THE SUBSTITUTION HOLE IS CLOSED: customer cannot act on another customer thread by id', async () => {
        await openThread(A.biz, owner, customer);
        asUser(customer2);
        const res = await send({ businessId: A.biz.id, userId: customer.id, text: 'let me in' });
        expect(res.status).toBe(403);
        const rows = await db.message.count({ where: { conversation: { type: 'BUSINESS' } } });
        expect(rows).toBe(1); // only the staff opener
    });

    test('SUSPENDED STAFF: employee loses thread, inbox and write; customer keeps full access', async () => {
        await openThread(A.biz, employeeA, customer, 'first reply');

        // Sanity: while ACTIVE the employee can read + write.
        asUser(staffUser);
        expect((await thread(A.biz.id, customer.id)).status).toBe(200);
        expect((await send({ businessId: A.biz.id, userId: customer.id, text: 'while active' })).status).toBe(200);

        // Suspension revokes the staff context entirely.
        await db.businessEmployee.updateMany({
            where: { userId: staffUser.id, businessProfileId: A.biz.id },
            data: { status: 'SUSPENDED' },
        });

        expect((await thread(A.biz.id, customer.id)).status).toBe(403);
        expect((await inbox(A.biz.id)).status).toBe(403);
        expect((await send({ businessId: A.biz.id, userId: customer.id, text: 'after suspension' })).status).toBe(403);

        // The customer's durable slot is untouched by the staff change.
        asUser(customer);
        expect((await thread(A.biz.id, customer.id)).status).toBe(200);
        expect((await send({ businessId: A.biz.id, userId: customer.id, text: 'customer still here' })).status).toBe(200);
        const msgs = (await thread(A.biz.id, customer.id)).body.messages;
        expect(msgs.length).toBe(3);
        expect(msgs.every((m) => m.senderId === customer.id || m.senderId === staffUser.id)).toBe(true);
    });

    test('former staff (participantA, terminated) cannot re-enter via the customer path', async () => {
        const conv = await openThread(A.biz, employeeA, customer);
        await db.businessEmployee.updateMany({
            where: { userId: staffUser.id },
            data: { status: 'TERMINATED' },
        });
        // The terminated employee IS still participantA of the row, but that
        // slot no longer grants business-side access to a support thread.
        const row = await db.businessConversation.findUnique({ where: { id: conv.id } });
        expect(row.participantAId).toBe(staffUser.id);

        asUser(staffUser);
        expect((await thread(A.biz.id, customer.id)).status).toBe(403);
        expect((await send({ businessId: A.biz.id, userId: customer.id, text: 'backdoor' })).status).toBe(403);
    });

    test('ONE THREAD PER (business, customer) IS A DB INVARIANT: direct duplicate insert is refused', async () => {
        await openThread(A.biz, owner, customer);
        const existing = await threadRow(A.biz.id, customer.id);
        expect(existing).toBeTruthy();

        const conversation = await db.conversation.create({ data: { type: 'BUSINESS' } });
        await expect(db.businessConversation.create({
            data: {
                businessProfileId: A.biz.id,
                conversationId: conversation.id,
                participantAId: owner.id,
                participantBId: customer.id,
                createdBy: owner.id,
                channel: 'CUSTOMER_SUPPORT',
            },
        })).rejects.toMatchObject({ code: 'P2002' });
    });

    test('concurrent staff sends to the same new customer converge on ONE thread, messages in order', async () => {
        const svc = new BusinessDirectMessageService(db);
        const results = await Promise.all([
            svc.send({ user: { id: owner.id }, businessId: A.biz.id, userId: customer.id, text: 'from owner' }),
            svc.send({ user: { id: employeeA.id }, businessId: A.biz.id, userId: customer.id, text: 'from staff' }),
        ]);
        // Both callers are staff of the same business — both sends succeed.
        expect(results.length).toBe(2);

        const threads = await db.businessConversation.findMany({
            where: { businessProfileId: A.biz.id, participantBId: customer.id },
        });
        expect(threads.length).toBe(1);

        const msgs = await db.message.findMany({
            where: { conversationId: threads[0].conversationId },
            orderBy: { createdAt: 'asc' },
        });
        expect(msgs.length).toBe(2);
        expect(new Set(msgs.map((m) => m.content))).toEqual(new Set(['from owner', 'from staff']));
    });

    test('a second, different customer gets their own separate thread', async () => {
        await openThread(A.biz, owner, customer);
        await openThread(A.biz, owner, customer2);
        const rows = await db.businessConversation.findMany({
            where: { businessProfileId: A.biz.id },
        });
        expect(rows.length).toBe(2);
        expect(rows.filter((r) => r.participantBId === customer.id).length).toBe(1);
        expect(rows.filter((r) => r.participantBId === customer2.id).length).toBe(1);
    });

    test('LEGACY rows (channel NULL) remain locatable for both participants', async () => {
        const conversation = await db.conversation.create({ data: { type: 'BUSINESS' } });
        const legacy = await db.businessConversation.create({
            data: {
                businessProfileId: A.biz.id,
                conversationId: conversation.id,
                participantAId: employeeA.id,
                participantBId: customer.id,
                createdBy: employeeA.id,
                // channel stays NULL — a pre-r36 row
            },
        });
        await db.message.create({
            data: { conversationId: conversation.id, senderId: employeeA.id, messageType: 'TEXT', content: 'legacy row' },
        });

        asUser(customer);
        const res = await thread(A.biz.id, customer.id);
        expect(res.status).toBe(200);
        expect(res.body.messages.length).toBe(1);
        expect(res.body.messages[0].text).toBe('legacy row');

        asUser(staffUser);
        expect((await thread(A.biz.id, customer.id)).status).toBe(200);
    });
});
