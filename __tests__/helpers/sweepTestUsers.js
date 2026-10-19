// =============================================================================
// AZM — sweepTestUsers helper (battery-order immunity, complete version)
//
// Shared cleanup used by suites that create `user_%` test users: it deletes
// every row that can BLOCK `prisma.user.deleteMany({ username: user_% })`
// before deleting the users themselves, so a suite is immune to `user_%`
// rows leaked by earlier suites in the serial jest battery, whatever the
// run order.
//
// WHY A COMPLETE SWEEP (2026-10-17 CI failure, run 39007452456; recurrence
// 2026-10-19, run 39246041036): partial inline sweeps handled only
// TransactionHistory and Withdrawal children. Suites that leave `user_%`
// rows behind (e.g. r22-custody-execution-recovery, which historically had
// no DB afterAll) can also leave WalletAddress rows (RESTRICT on
// WalletAddress_userId_fkey), so the user sweep failed and the whole SUITE
// failed to run.
//
// DERIVATION (re-derived 2026-10-19 against a fresh CI-parity database
// built from main d6f7da149d527ad2d50f6126f6e28c6b2214a1e8 with the test
// lane's exact 20-step setup — `npx prisma db push` + all 19 overlay
// installers — and read back from pg_constraint): only ON DELETE RESTRICT /
// NO ACTION foreign keys into "User" can block a user delete; SET NULL and
// CASCADE columns never block. At this head the blocking set is 41 tables —
// the RESTRICT edges the original helper covered PLUS NO ACTION edges it
// did not (Message.senderId, GroupMessage.senderId,
// AdminWarRoomAlert.acknowledgedBy, BusinessVerificationDocument.reviewedById,
// EscrowDispute.assignedToId, GovernanceProposal.executedById,
// HotelHousekeepingTask.userId, LiabilityAcceptance.voucherUserId,
// ShiftSwap.claimingUserId, SusuInvite.inviteeUserId,
// VendorApplication.reviewedBy, VoucherSlashLog.voucherId).
//
// Deletion order matters among the swept tables themselves. The inter-table
// RESTRICT/NO ACTION edges within the blocking set are:
//   KitchenOrder.businessOrderId          -> BusinessOrder
//   BusinessReview.invoiceId/orderId/     -> BusinessInvoice, BusinessOrder,
//     reservationId/transitBookingId        Reservation, TransitBooking
//   ConversationMoneyTicket.messageId     -> Message
//   Message.tradeId                       -> Trade
//   Review.tradeId                        -> Trade
//   DisputeResolution.tradeId             -> Trade
//   AdminWarRoomAlert.cycleId             -> SusuCycle
//   DineInTab.invoiceId/escrowId          -> BusinessInvoice, SmartEscrow
//   BusinessOrder.escrowId                -> SmartEscrow
//   Reservation.escrowId                   -> SmartEscrow
//   TransitBooking.escrowId               -> SmartEscrow
//   Withdrawal.transactionHistoryId       -> TransactionHistory
// Every other cross-reference among swept tables (e.g. DineInTabItem -> DineInTab,
// GroupMessage -> GroupChat, SusuContribution -> SusuCycle) is SET NULL or
// CASCADE and is handled automatically by Postgres. The statements below run
// blockers FIRST, so no swept delete can hit one of these edges. The
// derivation was verified: the recursive closure over pg_constraint contains
// exactly 42 relations (User + 41 blockers), all FKs into User are
// single-column, and nothing outside the closure RESTRICT-references a
// swept table.
//
// SCOPE: every statement only touches rows whose RESTRICT/NO ACTION foreign
// key points at a user named `user_%` — a test-only naming convention on the
// disposable CI database. No other rows are ever deleted.
// =============================================================================

// LITERAL-prefix match (r44 review): LIKE 'user_%' leaves `_` as a SQL
// single-char wildcard, so it would also match e.g. 'username123' —
// a NON-test identity on a shared database. left(username, 5) = 'user_'
// is an exact literal-prefix comparison with the same semantics as the
// Prisma `startsWith: 'user_'` deleteMany below — no escaping ambiguity.
const USER_IDS = '(SELECT id FROM "User" WHERE left(username, 5) = \'user_\')';
const SWEPT_TRADES =
    '(SELECT id FROM "Trade" WHERE "userId" IN ' + USER_IDS + ' OR "vendorId" IN ' + USER_IDS + ')';
const SWEPT_MESSAGES =
    '(SELECT id FROM "Message" WHERE "senderId" IN ' + USER_IDS + ' OR "tradeId" IN ' + SWEPT_TRADES + ')';
const SWEPT_ESCROWS =
    '(SELECT id FROM "SmartEscrow" WHERE "payerId" IN ' + USER_IDS + ' OR "payeeId" IN ' + USER_IDS + ')';
const SWEPT_INVOICES =
    '(SELECT id FROM "BusinessInvoice" WHERE "customerId" IN ' + USER_IDS + ')';
const SWEPT_ORDERS =
    '(SELECT id FROM "BusinessOrder" WHERE "customerId" IN ' + USER_IDS + ' OR "escrowId" IN ' + SWEPT_ESCROWS + ')';
const SWEPT_RESERVATIONS =
    '(SELECT id FROM "Reservation" WHERE "customerId" IN ' + USER_IDS + ' OR "escrowId" IN ' + SWEPT_ESCROWS + ')';
const SWEPT_TRANSIT =
    '(SELECT id FROM "TransitBooking" WHERE "customerId" IN ' + USER_IDS + ' OR "escrowId" IN ' + SWEPT_ESCROWS + ')';
const SWEPT_CYCLES =
    '(SELECT id FROM "SusuCycle" WHERE "payoutUserId" IN ' + USER_IDS + ')';
const SWEPT_LEDGER =
    '(SELECT id FROM "TransactionHistory" WHERE "userId" IN ' + USER_IDS + ')';

// Inter-table blockers FIRST — each statement removes rows that RESTRICT /
// NO ACTION-block a delete later in this list (see derivation above).
const BLOCKERS_FIRST = [
    // blocks BusinessOrder deletion (no direct user column — scope by swept order)
    `DELETE FROM "KitchenOrder" WHERE "businessOrderId" IN ${SWEPT_ORDERS}`,
    // blocks BusinessInvoice / BusinessOrder / Reservation / TransitBooking
    `DELETE FROM "BusinessReview" WHERE "reviewerId" IN ${USER_IDS}`
        + ` OR "invoiceId" IN ${SWEPT_INVOICES} OR "orderId" IN ${SWEPT_ORDERS}`
        + ` OR "reservationId" IN ${SWEPT_RESERVATIONS} OR "transitBookingId" IN ${SWEPT_TRANSIT}`,
    // blocks Message deletion
    `DELETE FROM "ConversationMoneyTicket" WHERE "requesterId" IN ${USER_IDS}`
        + ` OR "counterpartyId" IN ${USER_IDS} OR "messageId" IN ${SWEPT_MESSAGES}`,
    // blocks Trade deletion
    `DELETE FROM "Message" WHERE "senderId" IN ${USER_IDS} OR "tradeId" IN ${SWEPT_TRADES}`,
    `DELETE FROM "Review" WHERE "reviewerId" IN ${USER_IDS} OR "revieweeId" IN ${USER_IDS}`
        + ` OR "tradeId" IN ${SWEPT_TRADES}`,
    `DELETE FROM "DisputeResolution" WHERE "adminId" IN ${USER_IDS} OR "tradeId" IN ${SWEPT_TRADES}`,
    // blocks SusuCycle deletion
    `DELETE FROM "AdminWarRoomAlert" WHERE "acknowledgedBy" IN ${USER_IDS} OR "cycleId" IN ${SWEPT_CYCLES}`,
    // blocks BusinessInvoice / SmartEscrow deletion
    `DELETE FROM "DineInTab" WHERE "customerId" IN ${USER_IDS}`
        + ` OR "invoiceId" IN ${SWEPT_INVOICES} OR "escrowId" IN ${SWEPT_ESCROWS}`,
    // blocks TransactionHistory deletion (in addition to its own user rows)
    `DELETE FROM "Withdrawal" WHERE "userId" IN ${USER_IDS} OR "transactionHistoryId" IN ${SWEPT_LEDGER}`,
    // block SmartEscrow deletion
    `DELETE FROM "BusinessOrder" WHERE "customerId" IN ${USER_IDS} OR "escrowId" IN ${SWEPT_ESCROWS}`,
    `DELETE FROM "Reservation" WHERE "customerId" IN ${USER_IDS} OR "escrowId" IN ${SWEPT_ESCROWS}`,
    `DELETE FROM "TransitBooking" WHERE "customerId" IN ${USER_IDS} OR "escrowId" IN ${SWEPT_ESCROWS}`,
];

// Remaining RESTRICT/NO ACTION children of "User" with no inter-table
// blockers among the swept set — order among these does not matter.
const SWEPT_CHILDREN = [
    `DELETE FROM "Ad" WHERE "vendorId" IN ${USER_IDS}`,
    `DELETE FROM "AdminApprovalRequest" WHERE "requestedBy" IN ${USER_IDS}`,
    `DELETE FROM "BusinessConversation" WHERE "participantAId" IN ${USER_IDS} OR "participantBId" IN ${USER_IDS}`,
    `DELETE FROM "BusinessInvoice" WHERE "customerId" IN ${USER_IDS}`,
    `DELETE FROM "BusinessVerificationDocument" WHERE "reviewedById" IN ${USER_IDS}`,
    `DELETE FROM "CrossBorderFxSnapshot" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "CrossBorderSusuConfig" WHERE "createdBy" IN ${USER_IDS}`,
    `DELETE FROM "DineInTabItem" WHERE "addedBy" IN ${USER_IDS}`,
    `DELETE FROM "EscrowDispute" WHERE "raisedById" IN ${USER_IDS} OR "assignedToId" IN ${USER_IDS}`,
    `DELETE FROM "GovernanceProposal" WHERE "proposerId" IN ${USER_IDS} OR "executedById" IN ${USER_IDS}`,
    `DELETE FROM "GroupChat" WHERE "createdById" IN ${USER_IDS}`,
    `DELETE FROM "GroupMessage" WHERE "senderId" IN ${USER_IDS}`,
    `DELETE FROM "HotelHousekeepingTask" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "LiabilityAcceptance" WHERE "userId" IN ${USER_IDS} OR "voucherUserId" IN ${USER_IDS}`,
    `DELETE FROM "LiabilityContractVersion" WHERE "publishedBy" IN ${USER_IDS}`,
    `DELETE FROM "OrderBookTrade" WHERE "makerUserId" IN ${USER_IDS} OR "takerUserId" IN ${USER_IDS}`,
    `DELETE FROM "ProofOfReservesLeaf" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SavedWallet" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "ShiftSwap" WHERE "claimingUserId" IN ${USER_IDS}`,
    `DELETE FROM "SmartEscrow" WHERE "payerId" IN ${USER_IDS} OR "payeeId" IN ${USER_IDS}`,
    `DELETE FROM "SmartRouteRun" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SusuContribution" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "SusuCycle" WHERE "payoutUserId" IN ${USER_IDS}`,
    `DELETE FROM "SusuInvite" WHERE "inviterId" IN ${USER_IDS} OR "inviteeUserId" IN ${USER_IDS}`,
    `DELETE FROM "Trade" WHERE "userId" IN ${USER_IDS} OR "vendorId" IN ${USER_IDS}`,
    `DELETE FROM "TransactionHistory" WHERE "userId" IN ${USER_IDS}`,
    `DELETE FROM "VendorApplication" WHERE "reviewedBy" IN ${USER_IDS}`,
    `DELETE FROM "VoucherSlashLog" WHERE "vouchedUserId" IN ${USER_IDS} OR "voucherId" IN ${USER_IDS}`,
    `DELETE FROM "WalletAddress" WHERE "userId" IN ${USER_IDS}`,
];

/**
 * Deletes every row that RESTRICT/NO ACTION-blocks the deletion of `user_%`
 * test users and then the users themselves. Safe on an empty database (all
 * deletes are no-ops) and idempotent across repeated suite runs.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
async function sweepTestUsers(prisma) {
    for (const sql of [...BLOCKERS_FIRST, ...SWEPT_CHILDREN]) {
        await prisma.$executeRawUnsafe(sql);
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: 'user_' } } });
}

module.exports = { sweepTestUsers };
