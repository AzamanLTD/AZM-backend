// __tests__/r38-direct-message-thread-routing.test.js
// =============================================================================
// r38/P1 — STAFF THREAD ROUTING (real PostgreSQL).
//
// The staff send path located an existing conversation with
// OR: [participantA = target, participantB = target] across ALL channels.
// participantA is the STAFF slot on canonical CUSTOMER_SUPPORT threads; on
// legacy/business conversations either slot can hold anyone. A customer who
// merely SITS in participantA of an unrelated business conversation made
// staff sends attach to that WRONG thread — the message surface diverged
// from the support rail the r36 invariants protect.
//
// r38 routing contract: canonical-first
//   1. canonical CUSTOMER_SUPPORT thread with the target durably in
//      participantB — else
//   2. legacy (channel NULL) row with the target in the CUSTOMER slot
//      (participantB) — else
//   3. create a canonical thread. participantA matches are NEVER customer
//      matches.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { BusinessDirectMessageService } = require('../services/businessOS/businessDirectMessageService');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P1 — staff thread routing (participantA is never the customer)', () => {
    let db;
    let A;
    let owner, staffUser, customer, otherUser;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "Message", "Conversation", "BusinessConversation", "BusinessEmployee", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        owner = A.owner;
        staffUser = await seedUser(db);
        await db.businessEmployee.create({
            data: { businessProfileId: A.biz.id, userId: staffUser.id, role: 'STAFF', status: 'ACTIVE', permissions: [] },
        });
        customer = await seedUser(db);
        otherUser = await seedUser(db);
    });

    const mkLegacyConv = async (participantAId, participantBId, createdBy) => {
        const conversation = await db.conversation.create({ data: { type: 'BUSINESS' } });
        return db.businessConversation.create({
            data: {
                businessProfileId: A.biz.id,
                conversationId: conversation.id,
                participantAId,
                participantBId,
                createdBy,
                // channel stays NULL — a pre-r36 row
            },
        });
    };

    test('a customer sitting in participantA of a legacy row is NOT treated as the customer — staff send opens the CANONICAL thread instead', async () => {
        // Malformed topology: the target customer in participantA (the STAFF
        // slot), someone else in participantB.
        const legacy = await mkLegacyConv(customer.id, otherUser.id, otherUser.id);

        const svc = new BusinessDirectMessageService(db);
        const result = await svc.send({
            user: { id: staffUser.id }, businessId: A.biz.id, userId: customer.id, text: 'hello?',
        });

        // The message went to a NEW canonical thread, never the legacy row.
        const legacyConv = await db.conversation.findUnique({ where: { id: legacy.conversationId }, include: { messages: true } });
        expect(legacyConv.messages.length).toBe(0);

        const canonical = await db.businessConversation.findFirst({
            where: { businessProfileId: A.biz.id, channel: 'CUSTOMER_SUPPORT', participantBId: customer.id },
        });
        expect(canonical).not.toBeNull();
        expect(canonical.id).not.toBe(legacy.id);
        expect(result.conversation.id).toBe(canonical.id);
        expect(result.message.text).toBe('hello?');
        const canonicalConv = await db.conversation.findUnique({
            where: { id: canonical.conversationId }, include: { messages: true },
        });
        expect(canonicalConv.messages.length).toBe(1);
    });

    test('second staff send REUSES the canonical thread (no duplicates, no drift back to the legacy row)', async () => {
        await mkLegacyConv(customer.id, otherUser.id, otherUser.id);
        const svc = new BusinessDirectMessageService(db);
        await svc.send({ user: { id: staffUser.id }, businessId: A.biz.id, userId: customer.id, text: 'one' });
        const second = await svc.send({ user: { id: staffUser.id }, businessId: A.biz.id, userId: customer.id, text: 'two' });

        const canonicalRows = await db.businessConversation.findMany({
            where: { businessProfileId: A.biz.id, channel: 'CUSTOMER_SUPPORT', participantBId: customer.id },
        });
        expect(canonicalRows.length).toBe(1);
        expect(second.conversation.id).toBe(canonicalRows[0].id);
        const conv = await db.conversation.findUnique({
            where: { id: canonicalRows[0].conversationId }, include: { messages: true },
        });
        expect(conv.messages.length).toBe(2);
    });

    test('legacy row with the customer in participantB (the customer slot) is still REUSED, not duplicated', async () => {
        // Explicit legacy semantic: target occupies the durable customer slot.
        const legacy = await mkLegacyConv(staffUser.id, customer.id, staffUser.id);
        await db.message.create({
            data: { conversationId: legacy.conversationId, senderId: staffUser.id, messageType: 'TEXT', content: 'history' },
        });

        const svc = new BusinessDirectMessageService(db);
        const result = await svc.send({
            user: { id: staffUser.id }, businessId: A.biz.id, userId: customer.id, text: 'follow-up',
        });

        expect(result.conversation.id).toBe(legacy.id);
        const allRows = await db.businessConversation.findMany({ where: { businessProfileId: A.biz.id } });
        expect(allRows.length).toBe(1); // no canonical duplicate was created
        const conv = await db.conversation.findUnique({
            where: { id: legacy.conversationId }, include: { messages: true },
        });
        expect(conv.messages.map((m) => m.content).sort()).toEqual(['follow-up', 'history']);
    });

    test('canonical thread wins over a legacy participantB row when BOTH exist', async () => {
        const legacy = await mkLegacyConv(staffUser.id, customer.id, staffUser.id);
        const conv = await db.conversation.create({ data: { type: 'BUSINESS' } });
        const canonical = await db.businessConversation.create({
            data: {
                businessProfileId: A.biz.id, conversationId: conv.id,
                participantAId: owner.id, participantBId: customer.id,
                createdBy: owner.id, channel: 'CUSTOMER_SUPPORT',
            },
        });
        const svc = new BusinessDirectMessageService(db);
        const result = await svc.send({ user: { id: staffUser.id }, businessId: A.biz.id, userId: customer.id, text: 'hi' });
        expect(result.conversation.id).toBe(canonical.id);
        expect(canonical.id).not.toBe(legacy.id);
    });
});
