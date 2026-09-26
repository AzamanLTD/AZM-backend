// __tests__/r38-chat-money-asset-contract.test.js
// =============================================================================
// r38/P0 — CHAT-MONEY ASSET/CURRENCY CONTRACT (real PostgreSQL, real HTTP).
//
// The chat-money rail debits User.availableBalance, which is the canonical
// ledger's user-liability mirror (ledgerService: user:{id}:liability, asset
// USDC) and is recorded in TransactionHistory.amountUsdc. The rail therefore
// moves exactly ONE asset. Proofs:
//   • accepted asset: omitted/lowercase/explicit USDC all normalize to USDC
//     on the ticket, message content and the API envelope;
//   • rejected asset: any other label (GHS, USD, arbitrary) → 400
//     UNSUPPORTED_CURRENCY with ZERO mutation — a free-form string can never
//     mislabel a single-asset balance;
//   • replay identity: same key + same USDC economics → exact replay; a
//     replay with a foreign label fails at validation (never mislabeled
//     replay economics).
//
// r38/P1 — IDEMPOTENCY KEY INTEGRITY (same suite, same money surface):
//   • a valid key is preserved EXACTLY after trim-only normalization;
//   • an overlong key (≥ 200 chars) is REJECTED, never silently truncated
//     into a different identity;
//   • two distinct overlong keys sharing a 200-char prefix CANNOT collapse
//     into one database identity (both rejected, zero rows).
//
// r38/P1 — EXACT SERIALIZATION:
//   • a legal 8dp amount (0.00000100) is returned EXACTLY in the new
//     moneyAmountExact / amountExact machine fields through the real GET
//     envelope — the legacy 2dp display string stays for existing clients.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R38_MONEY_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R38_MONEY_USER__; next(); } };
});

const { PrismaClient, Prisma } = require('@prisma/client');
const conversationRoutes = require('../routes/conversationRoutes');
const { ConversationMoneyService } = require('../services/conversationMoneyService');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P0 — chat-money asset contract (+ key integrity, exact serialization)', () => {
    let db;
    let app;
    let svc;
    let A, B;
    let convAB, convABFull;

    const asUser = (user) => { global.__R38_MONEY_USER__ = user ? { id: user.id } : null; };
    const post = (convId, body) => request(app).post(`/api/conversations/${convId}/messages`).send(body);
    const history = (convId) => request(app).get(`/api/conversations/${convId}/messages`);
    const bal = async (id) => new Prisma.Decimal(
        (await db.user.findUnique({ where: { id }, select: { availableBalance: true } })).availableBalance);

    const counts = async () => ({
        tickets: await db.conversationMoneyTicket.count(),
        messages: await db.message.count(),
    });

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
        app.set('io', null);
        app.use('/api/conversations', conversationRoutes);
        svc = new ConversationMoneyService({ prisma: db });
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R38_MONEY_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "TransactionHistory", "Contact", "JournalEntry", "LedgerTransaction", "LedgerAccount", "BusinessLedgerEntry", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedUser(db, { availableBalance: 1000 });
        B = await seedUser(db, { availableBalance: 1000 });
        convAB = await mkConv(A, B);
        convABFull = await db.conversation.findUnique({
            where: { id: convAB.id }, include: { participants: true },
        });
        asUser(A);
    });

    const send = (user, conv, body) => svc.sendMoney({ user, conv, ...body });

    // ── Accepted asset ────────────────────────────────────────────────────────

    test('omitted currency → canonical USDC on ticket, content and HTTP envelope', async () => {
        const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'asset-1' });
        expect(res.status).toBe(201);
        const ticket = await db.conversationMoneyTicket.findFirst({ where: { clientRequestId: 'asset-1' } });
        expect(ticket.currency).toBe('USDC');
        expect(res.body.data.text).toContain('USDC');
        expect(res.body.data.text).not.toContain('GHS');
        expect(res.body.data.moneyAmountExact).toBe('30.00000000');
    });

    test('explicit uppercase/lowercase USDC → canonical USDC', async () => {
        const up = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: 'USDC', clientRequestId: 'asset-2' });
        expect(up.status).toBe(201);
        const low = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: 'usdc', clientRequestId: 'asset-3' });
        expect(low.status).toBe(201);
        expect((await db.conversationMoneyTicket.findMany({ where: { clientRequestId: { in: ['asset-2', 'asset-3'] } } }))
            .every((t) => t.currency === 'USDC')).toBe(true);
    });

    test('MONEY_SEND and ESCROW_TICKET also post under the canonical asset', async () => {
        const s = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '5', clientRequestId: 'asset-4' });
        expect(s.status).toBe(201);
        expect(s.body.data.text).toContain('USDC');
        expect(s.body.data.moneyStatus).toBe('ACCEPTED');
        const e = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40', itemName: 'Sneakers', clientRequestId: 'asset-5' });
        expect(e.status).toBe(201);
        expect(e.body.data.escrowTicket.currency).toBe('USDC');
        expect(e.body.data.text).toContain('USDC');
    });

    test('same key, same USDC economics → exact replay of the original', async () => {
        const first = await send(A, convABFull, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: 'USDC', clientRequestId: 'asset-6' });
        expect(first.replay).toBe(false);
        const again = await send(A, convABFull, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'asset-6' });
        expect(again.replay).toBe(true);
        expect(again.ticket.id).toBe(first.ticket.id);
        expect(again.ticket.currency).toBe('USDC');
        expect(await counts()).toEqual({ tickets: 1, messages: 1 });
    });

    // ── Rejected asset ────────────────────────────────────────────────────────

    test.each(['GHS', 'USD', 'USDT', 'ghs ', 'MoolreCoin'])('currency %j → 400 UNSUPPORTED_CURRENCY, zero mutation', async (bad) => {
        const before = await counts();
        const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: bad, clientRequestId: 'asset-bad' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/USDC/);
        await expect(send(A, convABFull, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: bad, clientRequestId: 'asset-bad2' }))
            .rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_CURRENCY' });
        expect(await counts()).toEqual(before);
    });

    test('MONEY_SEND with foreign currency → 400, zero financial mutation', async () => {
        const before = await bal(A.id);
        const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '5', currency: 'GHS', clientRequestId: 'asset-bad-send' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/USDC/);
        expect((await bal(A.id)).toFixed(8)).toBe(before.toFixed(8));
        expect(await counts()).toEqual({ tickets: 0, messages: 0 });
    });

    test('replay of an existing ticket with a foreign label → 400 UNSUPPORTED_CURRENCY (never mislabeled replay)', async () => {
        await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'asset-7' });
        const before = await counts();
        const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', currency: 'GHS', clientRequestId: 'asset-7' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/USDC/);
        expect(await counts()).toEqual(before);
    });

    // ── Idempotency key integrity ─────────────────────────────────────────────

    test('valid key preserved EXACTLY after trim-only normalization', async () => {
        const key = `  req-${'x'.repeat(50)}-ABC-123  `;
        const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: key });
        expect(res.status).toBe(201);
        const ticket = await db.conversationMoneyTicket.findFirst({ where: { clientRequestId: key.trim() } });
        expect(ticket).not.toBeNull();
        const replay = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: key.trim() });
        expect(replay.status).toBe(201); // replays the SAME original row
        expect(await db.conversationMoneyTicket.count()).toBe(1);
    });

    test('200-character key → 400 IDEMPOTENCY_KEY_TOO_LONG (rejected, not truncated)', async () => {
        const before = await counts();
        await expect(send(A, convABFull, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'k'.repeat(200) }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_TOO_LONG' });
        const res = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: 'k'.repeat(200) });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/clientRequestId/i);
        expect(await counts()).toEqual(before);
        expect(await db.conversationMoneyTicket.count()).toBe(0);
    });

    test('two distinct >200-char keys sharing a 200-char prefix CANNOT collapse into one identity', async () => {
        const shared = 'p'.repeat(210);
        const k1 = shared + 'AAA';
        const k2 = shared + 'BBB';
        const res1 = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: k1 });
        const res2 = await post(convAB.id, { type: 'MONEY_REQUEST', moneyAmount: '30', clientRequestId: k2 });
        expect(res1.status).toBe(400);
        expect(res1.body.message).toMatch(/clientRequestId/i);
        expect(res2.status).toBe(400);
        expect(res2.body.message).toMatch(/clientRequestId/i);
        // Zero tickets persisted — neither key was truncated into a row,
        // and they certainly did not collapse onto one row.
        expect(await db.conversationMoneyTicket.count()).toBe(0);
        expect(await db.message.count()).toBe(0);
    });

    test('escrow ticket with an overlong key → 400, zero mutation', async () => {
        const before = await counts();
        await expect(send(A, convABFull, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', clientRequestId: 'e'.repeat(201) }))
            .rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_TOO_LONG' });
        const res = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '40', itemName: 'X', clientRequestId: 'e'.repeat(201) });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/clientRequestId/i);
        expect(await counts()).toEqual(before);
    });

    // ── Exact serialization (tiny values) ─────────────────────────────────────

    test('legal 8dp amount survives exactly: moneyAmountExact/amountExact via the real GET envelope', async () => {
        const res = await post(convAB.id, { type: 'MONEY_SEND', recipientId: B.id, moneyAmount: '0.000001', clientRequestId: 'tiny-1' });
        expect(res.status).toBe(201);

        const esc = await post(convAB.id, { type: 'ESCROW_TICKET', amount: '0.000001', itemName: 'Pin', clientRequestId: 'tiny-2' });
        expect(esc.status).toBe(201);

        const hist = await history(convAB.id);
        expect(hist.status).toBe(200);
        const sendMsg = hist.body.data.find((m) => m.type === 'PAYMENT_TRANSFER');
        const escMsg = hist.body.data.find((m) => m.type === 'ESCROW_TICKET');

        // Machine value: exact Decimal(20,8) representation — a valid 8dp
        // amount can never round to "0.00" in the envelope again.
        expect(sendMsg.moneyAmountExact).toBe('0.00000100');
        expect(escMsg.moneyAmountExact).toBe('0.00000100');
        expect(escMsg.escrowTicket.amountExact).toBe('0.00000100');
        // Legacy 2dp display string unchanged for existing clients.
        expect(sendMsg.moneyAmount).toBe('0.00');

        // Stored authority is the full 8dp decimal; the transfer really moved.
        const stored = await db.conversationMoneyTicket.findFirst({ where: { messageId: sendMsg.id } });
        expect(new Prisma.Decimal(stored.amount).toFixed(8)).toBe('0.00000100');
        expect((await bal(B.id)).toFixed(8)).toBe(new Prisma.Decimal(1000).plus('0.000001').toFixed(8));
    });
});
