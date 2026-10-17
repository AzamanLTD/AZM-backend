// =============================================================================
// AZAM — sweepTestUsers helper (battery-order immunity, complete version)
//
// Shared cleanup used by suites that create `user_%` test users: it deletes
// every row that can BLOCK `prisma.user.deleteMany({ username: user_% })`
// before deleting the users themselves, so a suite is immune to `user_%`
// rows leaked by earlier suites in the serial jest battery, whatever the
// run order.
//
// WHY A COMPLETE SWEEP (2026-10-17 CI failure, run 39007452456):
// the previous inline sweep in business-ad-adapter/business-follower-adapter
// handled only TransactionHistory and Withdrawal children. Suites that leave
// `user_%` rows behind (e.g. r22-custody-execution-recovery, which has no DB
// afterAll) can also leave WalletAddress rows (RESTRICT on
// WalletAddress_userId_fkey), so the user sweep failed and the whole SUITE
// failed to run. This helper covers the full blocking set.
//
// DERIVATION (verified read-only against the live CI database's
// pg_constraint graph, 2026-10-17): only ON DELETE RESTRICT / NO ACTION
// foreign keys into "User" can block a user delete; SET NULL and CASCADE
// columns never block. The only inter-child RESTRICT edges among the
// blocking tables are Review.tradeId -> Trade and
// DisputeResolution.tradeId -> Trade, so those two tables must be swept
// BEFORE Trade. All other cross-references among swept tables (KitchenOrder,
// DineInTab, BusinessReview, Message, AdminWarRoomAlert, ConversationMoneyTicket
// -> Message, Withdrawal -> TransactionHistory, ProviderSettlementAttempt)
// are SET NULL or CASCADE and are handled automatically by Postgres.
//
// SCOPE: every statement only touches rows whose RESTRICT foreign key points
// at a user named `user_%` — a test-only naming convention on the disposable
// CI database. No other rows are ever deleted.
// =============================================================================

const USER_IDS = '(SELECT id FROM "User" WHERE username LIKE \'user_%\')';
const SWEPT_TRADES =
    '(SELECT id FROM "Trade" WHERE "userId" IN ' + USER_IDS + ' OR "vendorId" IN ' + USER_IDS + ')';

// Level-2 RESTRICT children first (they block the Trade sweep below).
const LEVEL2 = [
    `DELETE FROM "Review" WHERE "tradeId" IN ${SWEPT_TRADES} `
        + `OR "reviewerId" IN ${USER_IDS} OR "revieweeId" IN ${USER_IDS}`,
    `DELETE FROM "DisputeResolution" WHERE "tradeId" IN ${SWEPT_TRADES} `
        + `OR "adminId" IN ${USER_IDS}`,
];

// Level-1 RESTRICT children of "User" — one statement per table, each scoped
// to the exact RESTRICT column(s) observed in the live constraint graph.
const LEVEL1 = [
    `DELETE FROM "Ad" WHERE "vendorId" IN ${USER_IDS}`,
    `DELETE FROM "AdminApprovalRequest" WHERE "requestedBy" IN ${USER_IDS}`,
    `DELETE FROM "BusinessConversation" WHERE "participantAId" IN ${USER_IDS} OR "participantBId" IN ${USER_IDS}`,
    `DELETE FROM "BusinessInvoice" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "BusinessOrder" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "BusinessReview" WHERE "reviewerId" IN ${USER_IDS}`,
    `DELETE FROM "ConversationMoneyTicket" WHERE "counterpartyId" IN ${USER_IDS} OR "requesterId" IN ${USER_IDS}`,
    `DELETE FROM "CrossBorderFxSnapshot" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "CrossBorderSusuConfig" WHERE "createdBy" IN ${USER_IDS}`,
    `DELETE FROM "DineInTab" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "DineInTabItem" WHERE "addedBy" IN ${USER_IDS}`,
    `DELETE FROM "EscrowDispute" WHERE "raisedById" IN ${USER_IDS}`,
    `DELETE FROM "GovernanceProposal" WHERE "proposerId" IN ${USER_IDS}`,
    `DELETE FROM "GroupChat" WHERE "createdById" IN ${USER_IDS}`,
    `DELETE FROM "LiabilityAcceptance" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "LiabilityContractVersion" WHERE "publishedBy" IN ${USER_IDS}`,
    `DELETE FROM "OrderBookTrade" WHERE "makerUserId" IN ${USER_IDS} OR "takerUserId" IN ${USER_IDS}`,
    `DELETE FROM "ProofOfReservesLeaf" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "Reservation" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "SavedWallet" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SmartEscrow" WHERE "payerId" IN ${USER_IDS} OR "payeeId" IN ${USER_IDS}`,
    `DELETE FROM "SmartRouteRun" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SusuContribution" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SusuCycle" WHERE "payoutUserId" IN ${USER_IDS}`,
    `DELETE FROM "SusuInvite" WHERE "inviterId" IN ${USER_IDS}`,
    `DELETE FROM "Trade" WHERE "userId" IN ${USER_IDS} OR "vendorId" IN ${USER_IDS}`,
    `DELETE FROM "TransactionHistory" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "TransitBooking" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "VoucherSlashLog" WHERE "vouchedUserId" IN ${USER_IDS}`,
    `DELETE FROM "WalletAddress" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "Withdrawal" WHERE "userId" IN ${USER_IDS}`,
];

/**
 * Deletes every row that RESTRICTs the deletion of `user_%` test users and
 * then the users themselves. Safe on an empty database (all deletes are
 * no-ops) and idempotent across repeated suite runs.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function sweepTestUsers(prisma) {
    for (const sql of [...LEVEL2, ...LEVEL1]) {
        await prisma.$executeRawUnsafe(sql);
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: 'user_' } } });
}

module.exports = { sweepTestUsers };
