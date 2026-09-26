// __tests__/r39-dm-admin-impersonation.test.js
// =============================================================================
// r39/P1 — DIRECT-MESSAGE ADMIN IMPERSONATION HANDOFF (real PostgreSQL,
// real HTTP).
//
// The intended contract is now explicit: a genuine ADMIN may act on a
// business's support inbox, with authority derived SOLELY from the
// validated req.adminBusinessScope produced by the global
// adminBusinessScope middleware. The service never re-trusts the raw
// x-admin-business-id header. Proofs:
//
//   1. an ADMIN scoped to business A reads A's inbox (no durable
//      relationship with A required) and a mismatched advisory id is refused;
//   2. the scoped ADMIN reads A's support thread as staff;
//   3. the scoped ADMIN sends into A's thread as staff;
//   4. the scope is EXACTLY one business: the ADMIN scoped to A gets
//      nothing from business B;
//   5. an ordinary user sending the same header gets NOTHING (no scope
//      property, own-relationships fallback only);
//   6. an ADMIN without the header gets own-relationships fallback only;
//   7. customer participant authority is unchanged (customer still reads
//      their own thread; the scoped admin never impersonates a customer).
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R39_DM_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (_req, _res, next) => next(),
}));

const { PrismaClient } = require('@prisma/client');
const directMessageRoutes = require('../routes/businessDirectMessageRoutes');
const { adminBusinessScope } = require('../middleware/adminBusinessScope');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r39/P1 — DM admin impersonation handoff', () => {
    let db;
    let app;
    let A, B;
    let admin, pleb, customer;
    let seq = 0;

    const asUser = (user) => {
        global.__R39_DM_USER__ = user ? { id: user.id, role: user.role } : null;
    };

    // The scope middleware must see req.user BEFORE the per-route protect:
    // mirror the production mount order (global scope, then route protect).
    const setUser = (req, _res, next) => { req.user = global.__R39_DM_USER__ ?? req.user; next(); };

    const inbox = (biz, headers = {}) => request(app)
        .get('/api/direct-messages/business-inbox')
        .set(headers)
        .query(biz ? { businessId: biz } : {});
    const thread = (userId, biz, headers = {}) => request(app)
        .get('/api/direct-messages/thread')
        .set(headers)
        .query({ userId, businessId: biz });
    const send = (body, headers = {}) => request(app)
        .post('/api/direct-messages/send')
        .set(headers)
        .send(body);

    const seedSupportThread = async (biz, staff, cust, messages = []) => {
        const conversation = await db.conversation.create({ data: { type: 'BUSINESS' } });
        const conv = await db.businessConversation.create({
            data: {
                businessProfileId: biz.id,
                conversationId: conversation.id,
                participantAId: staff.id,
                participantBId: cust.id,
                channel: 'CUSTOMER_SUPPORT',
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
        app.use(setUser);
        app.use(adminBusinessScope); // real, unmocked scope middleware
        app.use('/api/direct-messages', directMessageRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__R39_DM_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "Message", "Conversation", "BusinessConversation", "BusinessEmployee", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        admin = await db.user.create({
            data: { username: `adm_${++seq}`, email: `adm_${seq}@test.com`, password: 'x', role: 'ADMIN', azamanId: `AZM-ADM-${seq}` },
        });
        pleb = await db.user.create({
            data: { username: `pleb_${seq}`, email: `pleb_${seq}@test.com`, password: 'x', azamanId: `AZM-P-${seq}` },
        });
        customer = await db.user.create({
            data: { username: `cust_${seq}`, email: `cust_${seq}@test.com`, password: 'x', azamanId: `AZM-C-${seq}` },
        });
        await seedSupportThread(A.biz, A.owner, customer, [[A.owner.id, 'how can we help?']]);
    });

    test('1. ADMIN scoped to A reads A inbox; mismatched advisory id refused', async () => {
        asUser(admin);
        const res = await inbox(A.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.conversations).toHaveLength(1);

        // Advisory id must match the server-derived scope — refusal, not downgrade.
        const mismatch = await inbox(B.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(mismatch.status).toBe(403);
    });

    test('2. scoped ADMIN reads the support thread as staff', async () => {
        asUser(admin);
        const res = await thread(customer.id, A.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.messages).toHaveLength(1);
        expect(res.body.messages[0].text).toBe('how can we help?');
    });

    test('3. scoped ADMIN sends into the thread as staff', async () => {
        asUser(admin);
        const res = await send(
            { businessId: A.biz.id, userId: customer.id, text: 'admin support here' },
            { 'x-admin-business-id': A.biz.id },
        );
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const rows = await db.message.findMany({
            where: { content: 'admin support here' },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].senderId).toBe(admin.id);
    });

    test('4. the scope is exactly ONE business: scoped to A, B is invisible', async () => {
        await seedSupportThread(B.biz, B.owner, customer, [[B.owner.id, 'B private']]);
        asUser(admin);
        const res = await thread(customer.id, B.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(res.status).toBe(403);
        const sendRes = await send(
            { businessId: B.biz.id, userId: customer.id, text: 'sneak' },
            { 'x-admin-business-id': A.biz.id },
        );
        expect(sendRes.status).toBe(403);
    });

    test('5. an ordinary user sending the header gets NOTHING', async () => {
        asUser(pleb); // no business, no employment
        const res = await inbox(A.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(res.status).toBe(403); // NO_BUSINESS_CONTEXT — header ignored
        const threadRes = await thread(customer.id, A.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(threadRes.status).toBe(403);
        const sendRes = await send(
            { businessId: A.biz.id, userId: customer.id, text: 'impersonate' },
            { 'x-admin-business-id': A.biz.id },
        );
        expect(sendRes.status).toBe(403);
        expect(await db.message.count({ where: { content: 'impersonate' } })).toBe(0);
    });

    test('6. ADMIN without the header gets own-relationships fallback only', async () => {
        asUser(admin);
        const res = await inbox(A.biz.id);
        expect(res.status).toBe(403); // admin owns no business — no context
    });

    test('7. customer participant authority unchanged; admin is staff-side, never the customer', async () => {
        asUser(customer);
        const res = await thread(customer.id, A.biz.id);
        expect(res.status).toBe(200);
        expect(res.body.messages).toHaveLength(1);

        // The scoped admin is business-side staff: it can read the thread the
        // customer participates in, but never substitutes for the customer.
        asUser(admin);
        const adminRead = await thread(customer.id, A.biz.id, { 'x-admin-business-id': A.biz.id });
        expect(adminRead.status).toBe(200);
        // The customer's OWN send path (participant) is untouched by the scope.
        asUser(customer);
        const custSend = await send({ businessId: A.biz.id, userId: customer.id, text: 'thanks!' });
        expect(custSend.status).toBe(200);
        const rows = await db.message.findMany({ where: { content: 'thanks!' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].senderId).toBe(customer.id);
    });
});
