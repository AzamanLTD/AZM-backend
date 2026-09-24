// __tests__/r39-money-ticket-lifecycle.test.js
// =============================================================================
// r39/P1 — CONVERSATION MONEY TICKET LIFECYCLE + CURRENCY CONTRACT
// (real PostgreSQL).
//
// A ConversationMoneyTicket is an immutable financial record. This suite
// proves the durable contract:
//
//   1. CURRENCY DEFAULT — the ticket is USDC-denominated: the DATABASE
//      default (raw SQL insert, no currency column) and the SCHEMA default
//      (Prisma create, field omitted) both produce 'USDC'. The legacy
//      'GHS' copy-forward is gone.
//   2. WORKER GUARD — the disappearing-message sweep EXCLUDES money-bearing
//      messages by predicate; a plain expiring message in the same tick is
//      still deleted.
//   3. RESTRICT BACKSTOP — a direct hard delete of a ticketed message (or
//      its conversation, which cascades) FAILS CLOSED (P2003 / FK error),
//      so no future code path can orphan a financial record.
//   4. ORPHAN ARCHIVE — running the overlay on data with LEGACY orphans
//      (created by the pre-FK soft-pointer era) moves them verbatim into
//      ConversationMoneyTicketOrphanArchive with the missing edge recorded
//      and then recreates the FK — financial records are never deleted.
// =============================================================================
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PrismaClient } = require('@prisma/client');
const DisappearingMessageWorker = require('../workers/disappearingMessageWorker');

const execFileP = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r39/P1 — money ticket lifecycle + currency contract', () => {
    let db;
    let worker;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        worker = new DisappearingMessageWorker(db, { intervalMs: 3600_000 });
    });
    // r39/P1 BATTERY-HERMETIC TEARDOWN: the raw explicit-id User seeds above
    // (ids 1..k) do NOT advance User_id_seq, and this suite's beforeEach
    // TRUNCATE ... RESTART IDENTITY parks the sequence at 1. Without this
    // cleanup, every LATER battery suite that creates users collides on
    // User.id (unique-violation on auto-increment). Ending on the same
    // clean, identity-restarted state the beforeEach produces keeps the
    // shared battery database hermetic.
    afterAll(async () => {
        try {
            await raw('TRUNCATE TABLE "ConversationMoneyTicketOrphanArchive", "ConversationMoneyTicket", "Message", "Conversation", "_ConversationParticipants", "User" RESTART IDENTITY CASCADE');
        } catch (e) { /* teardown is best-effort; beforeEach re-truncates */ }
        await db.$disconnect();
    });

    const raw = (sql) => db.$executeRawUnsafe(sql);

    const seedUser = (id) => raw(
        `INSERT INTO "User" ("id", "username", "email", "password", "createdAt")
         VALUES (${id}, 'r39u${id}', 'r39u${id}@t.test', 'pw', NOW())`
    );

    const seedConversation = (id) => raw(
        `INSERT INTO "Conversation" ("id", "type", "createdAt", "updatedAt")
         VALUES ('${id}', 'PERSONAL', NOW(), NOW())`
    );

    const seedMessage = (id, conversationId, expiresAt) => raw(
        `INSERT INTO "Message" ("id", "conversationId", "messageType", "content", "createdAt", "expiresAt")
         VALUES ('${id}', '${conversationId}', 'TEXT', 'r39', NOW(), ${expiresAt === null ? 'NULL' : `'${expiresAt}'`})`
    );

    const seedTicket = (id, messageId, conversationId, requesterId, counterpartyId, withCurrency = true) => raw(
        `INSERT INTO "ConversationMoneyTicket"
            ("id", "messageId", "conversationId", "kind", "amount", ${withCurrency ? '"currency", ' : ''}"requesterId", "counterpartyId", "status", "createdAt", "updatedAt")
         VALUES ('${id}', '${messageId}', '${conversationId}', 'MONEY_SEND', 12.5, ${withCurrency ? `'USDC', ` : ''}${requesterId}, ${counterpartyId}, 'sent', NOW(), NOW())`
    );

    beforeEach(async () => {
        await raw('TRUNCATE TABLE "ConversationMoneyTicketOrphanArchive", "ConversationMoneyTicket", "Message", "Conversation", "_ConversationParticipants", "User" RESTART IDENTITY CASCADE');
    });

    describe('1. currency default contract', () => {
        test('DATABASE default (raw SQL insert, currency omitted) is USDC', async () => {
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            await seedMessage('m1', 'conv1', null);
            await seedTicket('t1', 'm1', 'conv1', 1, 2, false); // no currency column at all

            const t = await db.conversationMoneyTicket.findUnique({ where: { id: 't1' } });
            expect(t.currency).toBe('USDC');
            expect(Number(t.amount)).toBe(12.5);
        });

        test('SCHEMA default (Prisma create, currency omitted) is USDC', async () => {
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            await seedMessage('m1', 'conv1', null);
            const t = await db.conversationMoneyTicket.create({
                data: {
                    id: 't1', messageId: 'm1', conversationId: 'conv1', kind: 'MONEY_SEND',
                    amount: 5, requesterId: 1, counterpartyId: 2,
                },
            });
            expect(t.currency).toBe('USDC');
        });
    });

    describe('2. disappearing sweep excludes money-bearing messages', () => {
        test('plain expired message deleted, ticketed expired message preserved', async () => {
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            const past = new Date(Date.now() - 60_000).toISOString();
            await seedMessage('m_plain', 'conv1', past);
            await seedMessage('m_money', 'conv1', past);
            await seedTicket('t1', 'm_money', 'conv1', 1, 2);

            await worker._tick();

            expect(await db.message.findUnique({ where: { id: 'm_plain' } })).toBeNull();
            const money = await db.message.findUnique({ where: { id: 'm_money' } });
            expect(money).not.toBeNull();
            const ticket = await db.conversationMoneyTicket.findUnique({ where: { id: 't1' } });
            expect(ticket).not.toBeNull(); // financial identity intact
        });

        test('ticketless expired messages still sweep (no guard regression)', async () => {
            await seedConversation('conv1');
            const past = new Date(Date.now() - 60_000).toISOString();
            await seedMessage('m_plain', 'conv1', past);

            await worker._tick();
            expect(await db.message.findUnique({ where: { id: 'm_plain' } })).toBeNull();
        });
    });

    describe('3. RESTRICT backstop (the durable constraint)', () => {
        test('direct hard delete of a ticketed message fails closed (P2003)', async () => {
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            await seedMessage('m_money', 'conv1', null);
            await seedTicket('t1', 'm_money', 'conv1', 1, 2);

            await expect(db.message.deleteMany({ where: { id: 'm_money' } })).rejects.toMatchObject({
                code: 'P2003',
            });
            expect(await db.message.findUnique({ where: { id: 'm_money' } })).not.toBeNull();
        });

        test('conversation deletion (cascade to message) fails closed with a ticket inside', async () => {
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            await seedMessage('m_money', 'conv1', null);
            await seedTicket('t1', 'm_money', 'conv1', 1, 2);

            await expect(db.conversation.delete({ where: { id: 'conv1' } })).rejects.toThrow();
            expect(await db.conversationMoneyTicket.findUnique({ where: { id: 't1' } })).not.toBeNull();
        });
    });

    describe('4. orphan archive (deployment guard)', () => {
        test('legacy orphan is archived verbatim, FK recreated, financial record preserved', async () => {
            // Simulate the legacy soft-pointer era: drop the FK, insert an
            // orphan ticket whose message was already hard-deleted.
            await raw('ALTER TABLE "ConversationMoneyTicket" DROP CONSTRAINT IF EXISTS "ConversationMoneyTicket_messageId_fkey"');
            await seedUser(1); await seedUser(2);
            await seedConversation('conv1');
            await seedTicket('t_orphan', 'm_gone', 'conv1', 1, 2);

            // Re-run the real production installer against this DB.
            await execFileP('node', ['infra/install-business-os-overlay.js'], {
                cwd: process.cwd(),
                env: { ...process.env, DATABASE_URL: url },
            });

            // The orphan ticket is GONE from the live table but VERBATIM in
            // the archive with its missing edge recorded — never deleted.
            expect(await db.conversationMoneyTicket.findUnique({ where: { id: 't_orphan' } })).toBeNull();
            const archived = await db.$queryRawUnsafe(
                'SELECT "id", "messageId", "amount", "currency", "orphanReason" FROM "ConversationMoneyTicketOrphanArchive" WHERE "id" = \'t_orphan\''
            );
            expect(archived).toHaveLength(1);
            expect(archived[0].messageId).toBe('m_gone');
            expect(Number(archived[0].amount)).toBe(12.5);
            expect(archived[0].currency).toBe('USDC');
            expect(archived[0].orphanReason).toBe('missing_message');

            // And the FK is back, enforcing the lifecycle from now on.
            const fk = await db.$queryRawUnsafe(
                'SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = \'ConversationMoneyTicket_messageId_fkey\''
            );
            expect(fk).toHaveLength(1);
        }, 60_000);
    });
});
