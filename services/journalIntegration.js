// services/journalIntegration.js
// =============================================================================
// Integration helpers — wraps existing financial operations to also record
// double-entry journal entries alongside the current single-entry system.
//
// This is a non-breaking migration: the old TransactionHistory records are still
// created, but now each financial action ALSO creates balanced journal entries.
//
// Reference: Stripe's incremental migration from single to double-entry ledger
// =============================================================================

const journalService = require('./journalService');
const logger = require('../src/config/logger');

/**
 * Record a deposit journal entry.
 * Debit: user:{userId}:available  (asset increases)
 * Credit: external:deposit        (external funds in)
 */
async function recordDeposit(userId, amountUsdc, reference, metadata) {
  const txnId = journalService.generateTransactionId('DEP');
  await journalService.record({
    transactionId: txnId,
    entryType: 'DEPOSIT',
    description: `Deposit of ${amountUsdc} USDC`,
    reference: reference || txnId,
    userId,
    metadata,
    lines: [
      { account: `user:${userId}:available`, debit: amountUsdc, credit: 0 },
      { account: 'external:deposit', debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a withdrawal journal entry.
 * Debit: external:withdrawal  (funds leaving system)
 * Credit: user:{userId}:available  (asset decreases)
 */
async function recordWithdrawal(userId, amountUsdc, reference, metadata) {
  const txnId = journalService.generateTransactionId('WTH');
  await journalService.record({
    transactionId: txnId,
    entryType: 'WITHDRAWAL',
    description: `Withdrawal of ${amountUsdc} USDC`,
    reference: reference || txnId,
    userId,
    metadata,
    lines: [
      { account: 'external:withdrawal', debit: amountUsdc, credit: 0 },
      { account: `user:${userId}:available`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a trade escrow lock.
 * Debit: user:{userId}:escrow  (escrow asset increases)
 * Credit: user:{userId}:available  (available decreases)
 */
async function recordEscrowLock(userId, amountUsdc, tradeId, metadata) {
  const txnId = journalService.generateTransactionId('ESC');
  await journalService.record({
    transactionId: txnId,
    entryType: 'ESCROW_LOCK',
    description: `Escrow lock for trade ${tradeId}`,
    reference: tradeId,
    userId,
    relatedEntity: 'trade',
    relatedEntityId: tradeId,
    metadata,
    lines: [
      { account: `user:${userId}:escrow`, debit: amountUsdc, credit: 0 },
      { account: `user:${userId}:available`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a trade escrow release (trade completed, funds to counterparty).
 * Debit: user:{buyerId}:available  (buyer gets the funds)
 * Credit: user:{sellerId}:escrow  (seller's escrow released)
 */
async function recordEscrowRelease(sellerId, buyerId, amountUsdc, tradeId, metadata) {
  const txnId = journalService.generateTransactionId('REL');
  await journalService.record({
    transactionId: txnId,
    entryType: 'ESCROW_RELEASE',
    description: `Escrow release for trade ${tradeId}`,
    reference: tradeId,
    userId: buyerId,
    relatedEntity: 'trade',
    relatedEntityId: tradeId,
    metadata,
    lines: [
      { account: `user:${buyerId}:available`, debit: amountUsdc, credit: 0 },
      { account: `user:${sellerId}:escrow`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a platform fee.
 * Debit: user:{userId}:available  (fee deducted)
 * Credit: platform:revenue  (platform earns)
 */
async function recordFee(userId, feeAmount, sourceTradeId, metadata) {
  if (parseFloat(feeAmount) === 0) return null;
  const txnId = journalService.generateTransactionId('FEE');
  await journalService.record({
    transactionId: txnId,
    entryType: 'FEE',
    description: `Platform fee from trade ${sourceTradeId}`,
    reference: sourceTradeId,
    userId,
    relatedEntity: 'trade',
    relatedEntityId: sourceTradeId,
    metadata,
    lines: [
      { account: 'platform:revenue', debit: 0, credit: feeAmount },
      { account: `user:${userId}:available`, debit: feeAmount, credit: 0 },
    ],
  });
  return txnId;
}

/**
 * Record a P2P transfer.
 * Debit: user:{senderId}:available  (sender balance decreases)
 * Credit: user:{receiverId}:available  (receiver balance increases)
 */
async function recordTransfer(senderId, receiverId, amountUsdc, reference, metadata) {
  const txnId = journalService.generateTransactionId('TRF');
  await journalService.record({
    transactionId: txnId,
    entryType: 'TRANSFER',
    description: `Transfer of ${amountUsdc} USDC`,
    reference: reference || txnId,
    userId: senderId,
    metadata,
    lines: [
      { account: `user:${receiverId}:available`, debit: amountUsdc, credit: 0 },
      { account: `user:${senderId}:available`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a vault deposit.
 * Debit: user:{userId}:vault  (vault balance increases)
 * Credit: user:{userId}:available  (available decreases)
 */
async function recordVaultDeposit(userId, amountUsdc, vaultId, metadata) {
  const txnId = journalService.generateTransactionId('VLT');
  await journalService.record({
    transactionId: txnId,
    entryType: 'VAULT_DEPOSIT',
    description: `Vault deposit to ${vaultId}`,
    reference: vaultId,
    userId,
    relatedEntity: 'vault',
    relatedEntityId: vaultId,
    metadata,
    lines: [
      { account: `user:${userId}:vault`, debit: amountUsdc, credit: 0 },
      { account: `user:${userId}:available`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record a vault release (vault completed or broken early).
 * Debit: user:{userId}:available  (funds return to available)
 * Credit: user:{userId}:vault  (vault balance decreases)
 */
async function recordVaultRelease(userId, amountUsdc, vaultId, metadata) {
  const txnId = journalService.generateTransactionId('VLR');
  await journalService.record({
    transactionId: txnId,
    entryType: 'VAULT_RELEASE',
    description: `Vault release from ${vaultId}`,
    reference: vaultId,
    userId,
    relatedEntity: 'vault',
    relatedEntityId: vaultId,
    metadata,
    lines: [
      { account: `user:${userId}:available`, debit: amountUsdc, credit: 0 },
      { account: `user:${userId}:vault`, debit: 0, credit: amountUsdc },
    ],
  });
  return txnId;
}

/**
 * Record an AZM reward.
 * Debit: platform:rewards  (platform rewards pool)
 * Credit: user:{userId}:azm  (user AZM balance increases)
 */
async function recordReward(userId, azmAmount, source, metadata) {
  const txnId = journalService.generateTransactionId('RWD');
  await journalService.record({
    transactionId: txnId,
    entryType: 'REWARD',
    description: `AZM reward from ${source}`,
    userId,
    metadata,
    lines: [
      { account: `user:${userId}:azm`, debit: azmAmount, credit: 0 },
      { account: 'platform:rewards', debit: 0, credit: azmAmount },
    ],
  });
  return txnId;
}

module.exports = {
  recordDeposit,
  recordWithdrawal,
  recordEscrowLock,
  recordEscrowRelease,
  recordFee,
  recordTransfer,
  recordVaultDeposit,
  recordVaultRelease,
  recordReward,
};
