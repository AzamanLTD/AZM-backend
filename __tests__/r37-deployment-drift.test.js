// __tests__/r37-deployment-drift.test.js
// =============================================================================
// r37/P0 — PRODUCTION DEPLOYMENT DRIFT (real PostgreSQL).
//
// Production schema is managed via `prisma db push` (no migrations), and the
// CI battery creates missing objects by running infra/install-*-overlay.js.
// The r35/r36 waves added BusinessLedgerEntry + ConversationMoneyTicket to
// prisma/schema.prisma, so every FRESH db-push database has them — but the
// PRODUCTION database predates those waves: it has neither table, and a
// db push that only ADDS columns would still leave older production rows
// without the durable structures the code now depends on
// (unique reversalOfId, clientRequestId uniqueness, FKs, indexes).
//
// This suite simulates the drifted production shape, then proves the overlay
// (the deployment path) repairs it COMPLETELY and IDEMPOTENTLY, and that the
// result is runtime-compatible with the Prisma client the code ships with.
// =============================================================================
const { execFileSync } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r37/P0 — production deployment drift repair', () => {
    let db;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });

    const runOverlay = () => execFileSync('node', [path.join(__dirname, '..', 'infra', 'install-business-os-overlay.js')], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });

    const columnsOf = async (table) =>
        (await db.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
            table
        )).map((r) => r.column_name);

    const indexesOn = async (table) =>
        (await db.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
            table
        )).map((r) => r.indexname);

    const typeExists = async (t) =>
        (await db.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = $1 AND n.nspname = 'public'`,
            t
        ))[0].n > 0;

    const tableExists = async (t) =>
        (await db.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            t
        ))[0].n > 0;

    test('BEFORE: simulate production drift (both tables absent)', async () => {
        // Production predates r35/r36: neither table exists.
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "ConversationMoneyTicket" CASCADE');
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "BusinessLedgerEntry" CASCADE');
        await db.$executeRawUnsafe('DROP TYPE IF EXISTS "LedgerEntryType" CASCADE');
        expect(await tableExists('BusinessLedgerEntry')).toBe(false);
        expect(await tableExists('ConversationMoneyTicket')).toBe(false);
    });

    test('overlay repairs the drift: every object created with full shape', async () => {
        runOverlay();

        expect(await tableExists('BusinessLedgerEntry')).toBe(true);
        expect(await tableExists('ConversationMoneyTicket')).toBe(true);
        expect(await typeExists('LedgerEntryType')).toBe(true);

        // Full column sets — matching the shipped Prisma models exactly.
        // (the model is append-only: no updatedAt — matched exactly)
        expect(await columnsOf('BusinessLedgerEntry')).toEqual([
            'amount', 'amountGhs', 'businessProfileId', 'category', 'createdAt',
            'description', 'id', 'metadata', 'reversalOfId', 'sourceId',
            'sourceType', 'type',
        ]);
        expect(await columnsOf('ConversationMoneyTicket')).toEqual([
            'amount', 'clientRequestId', 'conversationId', 'counterpartyId',
            'createdAt', 'currency', 'id', 'kind', 'messageId',
            'requesterId', 'resultMessageId', 'status', 'updatedAt',
        ]);

        // Durable uniqueness + lookup indexes.
        const ledgerIdx = await indexesOn('BusinessLedgerEntry');
        for (const idx of [
            'BusinessLedgerEntry_pkey',
            'BusinessLedgerEntry_businessProfileId_type_idx',
            'BusinessLedgerEntry_sourceType_sourceId_idx',
            'BusinessLedgerEntry_reversalOfId_key', // r37 durable reversal identity
        ]) expect(ledgerIdx).toContain(idx);

        const ticketIdx = await indexesOn('ConversationMoneyTicket');
        for (const idx of [
            'ConversationMoneyTicket_pkey',
            'ConversationMoneyTicket_messageId_key',
            'ConversationMoneyTicket_clientRequestId_key', // r36 idempotency contract
            'ConversationMoneyTicket_conversationId_idx',
        ]) expect(ticketIdx).toContain(idx);

        // FK from the ledger to the business profile.
        const fk = await db.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
             WHERE constraint_name = 'BusinessLedgerEntry_businessProfileId_fkey'`
        );
        expect(fk[0].n).toBe(1);
    });

    test('repaired schema is RUNTIME-compatible with the shipped Prisma client', async () => {
        // What production does at boot after the overlay: real writes through
        // the generated client, including the r37 reversal identity.
        const { seedBusiness } = require('./helpers/factories');
        const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
        const svc = new BusinessLedgerService(db);
        const { biz, owner } = await seedBusiness(db);

        const entry = await svc.createEntry({
            businessProfileId: biz.id, type: 'EXPENSE', category: 'Fuel',
            description: 'drift check', amount: 12.5,
        });
        const { reversal } = await svc.createReversalEntry({ businessProfileId: biz.id, entryId: entry.id, reason: 'drift' });
        expect(Number(reversal.amount)).toBe(12.5);

        // The unique reversalOfId actually enforces at the DATABASE level.
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "BusinessLedgerEntry" ("id", "businessProfileId", "type", "category", "description", "amount", "reversalOfId")
             VALUES ('dup-test', $1, 'EXPENSE', 'Fuel', 'dup', 1, $2)`,
            biz.id, entry.id
        )).rejects.toThrow();

        // Money ticket with the idempotency key round-trips.
        const msgConv = await db.conversation.create({ data: { type: 'PERSONAL' } });
        const msg = await db.message.create({
            data: { conversationId: msgConv.id, senderId: owner.id, messageType: 'TEXT', content: 'x' },
        });
        const ticket = await db.conversationMoneyTicket.create({
            data: {
                messageId: msg.id, conversationId: msgConv.id, kind: 'MONEY_SEND',
                amount: '5', status: 'ACCEPTED', requesterId: owner.id,
                counterpartyId: owner.id, clientRequestId: `drift-${Date.now()}`,
            },
        });
        expect(ticket.status).toBe('ACCEPTED');

        // Cleanup so later suites stay hermetic.
        await db.$executeRawUnsafe('TRUNCATE TABLE "ConversationMoneyTicket", "Message", "Conversation", "BusinessLedgerEntry", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    test('overlay rerun is idempotent (no-op on a repaired database)', async () => {
        expect(() => runOverlay()).not.toThrow();
        expect(await tableExists('BusinessLedgerEntry')).toBe(true);
        expect(await tableExists('ConversationMoneyTicket')).toBe(true);
    });
});
