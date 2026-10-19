'use strict';
// =============================================================================
// sweepTestUsers contract (REAL PG) — pins the shared battery-order-immunity
// helper against BOTH of its failure modes:
//
// 1. SCHEMA DRIFT: if a future schema/overlay adds a new ON DELETE
//    RESTRICT / NO ACTION foreign key into "User", an un-updated helper
//    silently misses it and later suites FK-fail again (the 2026-10-17 /
//    2026-10-19 CI poisonings). This suite re-derives the live blocking
//    closure from pg_constraint on the actual test database and fails if
//    it no longer matches the helper's documented set.
//
// 2. ORDERING: the swept tables reference each other (KitchenOrder ->
//    BusinessOrder -> SmartEscrow; Message/Review/DisputeResolution ->
//    Trade; ConversationMoneyTicket -> Message; AdminWarRoomAlert ->
//    SusuCycle; Withdrawal -> TransactionHistory; BusinessReview/DineInTab
//    -> BusinessInvoice ...). This suite seeds one row on EVERY ordering
//    edge, including rows whose ONLY link to the user population is the
//    parent row (counterparty messages, kitchen orders), then proves a
//    single sweepTestUsers() call deletes the entire graph without an FK
//    violation.
//
// Hermetic: every user it creates is `user_%` (the shared test population)
// and its final action is the sweep itself, so the suite leaves nothing
// behind by construction.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { sweepTestUsers } = require('./helpers/sweepTestUsers');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

// The helper's documented blocking set (see sweepTestUsers.js derivation):
// 40 tables with a direct RESTRICT/NO ACTION FK into "User", plus
// KitchenOrder which only blocks via BusinessOrder. If this test fails
// with a MISSING table, a new blocking child of "User" exists and the
// helper must be extended. If it fails with an EXTRA table, a blocking
// child was REMOVED and the helper (and this list) should be simplified.
const EXPECTED_BLOCKERS = new Set([
    'Ad', 'AdminApprovalRequest', 'AdminWarRoomAlert', 'BusinessConversation',
    'BusinessInvoice', 'BusinessOrder', 'BusinessReview',
    'BusinessVerificationDocument', 'ConversationMoneyTicket',
    'CrossBorderFxSnapshot', 'CrossBorderSusuConfig', 'DineInTab',
    'DineInTabItem', 'DisputeResolution', 'EscrowDispute',
    'GovernanceProposal', 'GroupChat', 'GroupMessage',
    'HotelHousekeepingTask', 'LiabilityAcceptance',
    'LiabilityContractVersion', 'Message', 'OrderBookTrade',
    'ProofOfReservesLeaf', 'Reservation', 'Review', 'SavedWallet',
    'ShiftSwap', 'SmartEscrow', 'SmartRouteRun', 'SusuContribution',
    'SusuCycle', 'SusuInvite', 'Trade', 'TransactionHistory',
    'TransitBooking', 'VendorApplication', 'VoucherSlashLog', 'WalletAddress',
    'Withdrawal',
]);

run('sweepTestUsers contract (real PostgreSQL)', () => {
    let db;

    beforeAll(async () => {
        db = new PrismaClient();
    });
    afterAll(async () => {
        if (db) await db.$disconnect();
    });

    test('the live pg_constraint blocking closure matches the helper\'s documented set', async () => {
        // Tables with an ON DELETE RESTRICT / NO ACTION foreign key into
        // "User" — the complete set that can block user_% deletion.
        const rows = await db.$queryRawUnsafe(`
            SELECT DISTINCT cl.relname AS table_name
            FROM pg_constraint con
            JOIN pg_class cl ON cl.oid = con.conrelid
            JOIN pg_class parent ON parent.oid = con.confrelid
            WHERE parent.relname = 'User'
              AND con.contype = 'f'
              AND con.confdeltype IN ('r', 'n')
        `);
        const live = new Set(rows.map((r) => r.table_name));

        const missing = [...live].filter((t) => !EXPECTED_BLOCKERS.has(t));
        const extra = [...EXPECTED_BLOCKERS].filter((t) => !live.has(t));
        expect(missing).toEqual([]);
        expect(extra).toEqual([]);
    });

    test('a full ordering-edge graph of user_% rows is swept in one call, FK-safely', async () => {
        const seq = Date.now();
        const pid = (name) => `swpcov-${seq}-${name}`;

        // Start from a clean user population so assertions below are
        // unambiguous (the sweep is idempotent and scoped to user_% rows).
        await sweepTestUsers(db);

        // User.id is an integer sequence — capture the seeded ids and use
        // them numerically in every child insert below.
        const seeded = await db.$queryRawUnsafe(`
            INSERT INTO "User" (username, email, password, "availableBalance", "createdAt")
            VALUES ('user_swpcov1-${seq}', '${pid('u1')}@t.test', 'x', 0, now()),
                   ('user_swpcov2-${seq}', '${pid('u2')}@t.test', 'x', 0, now())
            RETURNING id
        `);
        const u1 = seeded[0].id;
        const u2 = seeded[1].id;

        const sqls = [
            // BusinessProfile cascades away with its user (BusinessProfile_userId_fkey is CASCADE).
            `INSERT INTO "BusinessProfile" (id, "userId", "bizId", "businessName", "updatedAt")
             VALUES ('${pid('bp')}', ${u1}, '${pid('bz')}', 'SwpCov Biz ${seq}', now())`,
            `INSERT INTO "SusuGroup" (id, "contributionUsdc", frequency, status, "totalCycles", "startDate", "contractRequiredCount", "rotationSnapshot", "updatedAt")
             VALUES ('${pid('sg')}', 10, 'WEEKLY', 'ACTIVE', 4, now(), 4, '{}', now())`,
            // Trade has an integer sequence id — RETURNING is not possible
            // inside the batch, so it is inserted below first and its id
            // captured for the Message/Review/DisputeResolution references.
        ];

        await db.$executeRawUnsafe(`
            INSERT INTO "Conversation" (id, type, "updatedAt")
            VALUES ('${pid('conv')}', 'TRADE', now())
        `);

        // SmartEscrow requires a real Ticket row (SmartEscrow_ticketId_fkey).
        // Ticket's user FKs are not in the blocking closure (they cannot
        // block the sweep), so seeding it is safe.
        await db.$executeRawUnsafe(`
            INSERT INTO "Ticket" (id, "creatorId", "counterpartyId", name, type, "targetAmount", "targetCurrency", "updatedAt")
            VALUES ('${pid('tk')}', ${u1}, ${u2}, 'swpcov', 'ESCROW', 1, 'USDC', now())
        `);

        // Trade -> Message -> ConversationMoneyTicket, Review, DisputeResolution
        // (Message is sent by u2 but references u1's trade — the sweep must
        // catch it through the tradeId scope, not a user column.)
        const trade = await db.$queryRawUnsafe(`
            INSERT INTO "Trade" (crypto, "amountCrypto", "amountFiat", type, "expiresAt", "userId", "vendorId")
            VALUES ('USDC', 1, 1, 'BUY', now() + interval '1 day', ${u1}, ${u2})
            RETURNING id
        `);
        const tId = trade[0].id;
        await db.$executeRawUnsafe(`
            INSERT INTO "Message" (id, "conversationId", content, "senderId", "tradeId")
            VALUES ('${pid('msg')}', '${pid('conv')}', 'hi', ${u2}, ${tId})
        `);
        await db.$executeRawUnsafe(`
            INSERT INTO "ConversationMoneyTicket" (id, "messageId", "conversationId", kind, amount, "requesterId", "counterpartyId", "updatedAt")
            VALUES ('${pid('cmt')}', '${pid('msg')}', '${pid('conv')}', 'ESCROW', 1, ${u2}, ${u1}, now())
        `);
        await db.$executeRawUnsafe(`
            INSERT INTO "Review" ("tradeId", "reviewerId", "revieweeId", "isPositive")
            VALUES (${tId}, ${u2}, ${u1}, true)
        `);
        await db.$executeRawUnsafe(`
            INSERT INTO "DisputeResolution" (id, "tradeId", "adminId", ruling, reason, "totalEscrow")
            VALUES ('${pid('dr')}', ${tId}, ${u2}, 'REFUND', 'x', 1)
        `);

        const sqlsTail = [
            // SusuCycle -> AdminWarRoomAlert
            `INSERT INTO "SusuCycle" (id, "susuGroupId", "cycleNumber", "collectionDate", "payoutAmount", "payoutUserId")
             VALUES ('${pid('sc')}', '${pid('sg')}', 1, now(), 10, ${u1})`,
            `INSERT INTO "AdminWarRoomAlert" (id, "alertType", "susuGroupId", "cycleId", payload, "acknowledgedBy")
             VALUES ('${pid('awra')}', 'VOUCH_SLASH_TX_FAILURE', '${pid('sg')}', '${pid('sc')}', '{}', ${u1})`,
            // SmartEscrow -> BusinessOrder -> KitchenOrder, plus Reservation/TransitBooking on the escrow
            `INSERT INTO "SmartEscrow" (id, "ticketId", "payerId", "payeeId", "amountUsdc", "updatedAt")
             VALUES ('${pid('se')}', '${pid('tk')}', ${u1}, ${u2}, 1, now())`,
            `INSERT INTO "BusinessOrder" (id, "businessProfileId", "customerId", "orderRef", title, "amountUsdc", "escrowId", "updatedAt")
             VALUES ('${pid('bo')}', '${pid('bp')}', ${u1}, '${pid('or')}', 'o', 1, '${pid('se')}', now())`,
            `INSERT INTO "KitchenOrder" (id, "businessProfileId", "businessOrderId", "ticketNumber", "updatedAt")
             VALUES ('${pid('ko')}', '${pid('bp')}', '${pid('bo')}', 1, now())`,
            `INSERT INTO "Reservation" (id, "reservationRef", "businessProfileId", "customerId", "startDatetime", "endDatetime", "amountUsdc", "escrowId", "updatedAt")
             VALUES ('${pid('rz')}', '${pid('rr')}', '${pid('bp')}', ${u1}, now(), now() + interval '1 hour', 1, '${pid('se')}', now())`,
            `INSERT INTO "TransitBooking" (id, "businessProfileId", "customerId", "pickupAddress", "dropoffAddress", "amountUsdc", "bookingRef", "escrowId", "updatedAt")
             VALUES ('${pid('tb')}', '${pid('bp')}', ${u1}, 'a', 'b', 1, '${pid('br')}', '${pid('se')}', now())`,
            // BusinessInvoice -> BusinessReview / DineInTab -> DineInTabItem
            `INSERT INTO "BusinessInvoice" (id, "businessProfileId", "customerId", "invoiceRef", "subtotalUsdc", "billTotalUsdc", "updatedAt")
             VALUES ('${pid('bi')}', '${pid('bp')}', ${u1}, '${pid('ir')}', 1, 1, now())`,
            `INSERT INTO "BusinessReview" (id, "businessProfileId", "reviewerId", rating, "sourceType", "invoiceId")
             VALUES ('${pid('brev')}', '${pid('bp')}', ${u2}, 5, 'INVOICE', '${pid('bi')}')`,
            `INSERT INTO "DineInTab" (id, "businessProfileId", "customerId", "invoiceId", "escrowId")
             VALUES ('${pid('dit')}', '${pid('bp')}', ${u2}, '${pid('bi')}', '${pid('se')}')`,
            `INSERT INTO "DineInTabItem" (id, "dineInTabId", name, "unitPriceUsdc", "lineTotalUsdc", "addedBy")
             VALUES ('${pid('diti')}', '${pid('dit')}', 'rice', 1, 1, ${u2})`,
            // TransactionHistory -> Withdrawal (the 2026-10-17/19 CI failure family)
            `INSERT INTO "TransactionHistory" (id, "userId", type, status, "amountUsdc")
             VALUES ('${pid('th')}', ${u1}, 'WITHDRAWAL_CRYPTO', 'PENDING', 1)`,
            `INSERT INTO "Withdrawal" (amount, "userId", "transactionHistoryId", "updatedAt")
             VALUES (1, ${u1}, '${pid('th')}', now())`,
            // Plain RESTRICT/NO ACTION children
            `INSERT INTO "WalletAddress" (id, "userId", network, asset, "contractAddress", address, "derivationIndex", status, "firstSeenAt", "lastObservedAt", "lastSweepAt", "subscriptionId", metadata, "createdAt", "updatedAt")
             VALUES ('${pid('wa')}', ${u1}, 'BASE', 'USDC', '', '0xabc', 0, 'ACTIVE', now(), now(), now(), '', '{}', now(), now())`,
            `INSERT INTO "SavedWallet" (label, address, network, "userId", "riskLevel", provider, "accountName", "secondaryDetail")
             VALUES ('l', '0xdef', 'BASE', ${u2}, 'LOW', 'm', 'n', 's')`,
            `INSERT INTO "GroupChat" (id, name, "createdById", "updatedAt")
             VALUES ('${pid('gc')}', 'g', ${u2}, now())`,
            `INSERT INTO "GroupMessage" (id, "groupId", type, "senderId")
             VALUES ('${pid('gm')}', '${pid('gc')}', 'TEXT', ${u1})`,
        ];
        for (const sql of [...sqls, ...sqlsTail]) await db.$executeRawUnsafe(sql);

        // THE PROOF: one sweep deletes the entire graph with no FK error.
        await sweepTestUsers(db);

        const remainingUsers = await db.user.count({ where: { username: { startsWith: 'user_' } } });
        expect(remainingUsers).toBe(0);
        const remainingTrades = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "Trade" WHERE "userId" = ${u1} OR "vendorId" = ${u2}`
        );
        expect(remainingTrades[0].n).toBe(0);
        const remainingMessages = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "Message" WHERE id = '${pid('msg')}'`
        );
        expect(remainingMessages[0].n).toBe(0);
        const remainingKitchen = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "KitchenOrder" WHERE id = '${pid('ko')}'`
        );
        expect(remainingKitchen[0].n).toBe(0);
        const remainingEscrows = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "SmartEscrow" WHERE id = '${pid('se')}'`
        );
        expect(remainingEscrows[0].n).toBe(0);
        const remainingLedger = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "TransactionHistory" WHERE id = '${pid('th')}'`
        );
        expect(remainingLedger[0].n).toBe(0);
        const remainingGroups = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "GroupChat" WHERE id = '${pid('gc')}'`
        );
        expect(remainingGroups[0].n).toBe(0);
    });
});
