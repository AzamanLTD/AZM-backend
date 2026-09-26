// services/journalService.js
// =============================================================================
// Double-Entry Journal Service — Phase 4
//
// Every financial operation must create balanced journal entries:
//   • Debit from source account
//   • Credit to destination account
//   • sum(debits) == sum(credits) for each transactionId
//
// Account naming convention:
//   user:{userId}:available     — User's available USDC balance
//   user:{userId}:escrow        — User's escrow-locked balance
//   user:{userId}:vault         — User's vault-locked balance
//   user:{userId}:susu          — User's susu contribution balance
//   platform:revenue            — Platform fee revenue
//   platform:treasury           — Platform treasury (deposits in)
   // external:deposit           — External funds entering the system
//   external:withdrawal         — Funds leaving the system
//
// Usage:
//   await journalService.record({
//     transactionId: 'tx_abc123',
//     entryType: 'DEPOSIT',
//     description: 'Fiat deposit via Moolre',
//     lines: [
//       { account: 'user:42:available', debit: 100, credit: 0 },
//       { account: 'external:deposit',  debit: 0,    credit: 100 },
//     ],
//     userId: 42,
//     reference: 'DEP-2026-001',
//   });
//
// Reference: Stripe (double-entry ledger), Wise (TransferWise ledger),
//            Revolut (real-time trial balance)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

class JournalService {
  /**
   * Record a balanced double-entry transaction.
   * Creates one JournalEntry per line. Validates that debits == credits.
   *
   * @param {Object} params
   * @param {string} params.transactionId — Unique ID grouping all entries
   * @param {string} params.entryType — JournalEntryType enum value
   * @param {string} params.description — Human-readable description
   * @param {Array}  params.lines — Array of { account, debit, credit }
   * @param {number} [params.userId] — Optional user ID for indexing
   * @param {string} [params.reference] — Optional reference code
   * @param {string} [params.relatedEntity] — Optional related entity type
   * @param {string} [params.relatedEntityId] — Optional related entity ID
   * @param {Object} [params.metadata] — Optional JSON metadata
   * @returns {Promise<Array>} Created journal entries
   */
  async record({ transactionId, entryType, description, lines, userId, reference, relatedEntity, relatedEntityId, metadata }) {
    if (!transactionId || !entryType || !description || !lines || lines.length < 2) {
      throw new Error('journalService.record: transactionId, entryType, description, and at least 2 lines are required');
    }

    // Validate balanced: sum(debits) == sum(credits)
    const totalDebit = lines.reduce((sum, l) => sum + parseFloat(l.debit || 0), 0);
    const totalCredit = lines.reduce((sum, l) => sum + parseFloat(l.credit || 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.00000001) {
      logger.error({ transactionId, totalDebit, totalCredit }, '[journal] Unbalanced entry rejected');
      throw new Error(`Unbalanced journal entry: debits (${totalDebit}) != credits (${totalCredit})`);
    }

    if (totalDebit === 0 && totalCredit === 0) {
      throw new Error('Zero-value journal entry rejected');
    }

    // Create all entries in a transaction
    const entries = await prisma.$transaction(
      lines.map(line =>
        prisma.journalEntry.create({
          data: {
            transactionId,
            entryType,
            account: line.account,
            debit: parseFloat(line.debit || 0),
            credit: parseFloat(line.credit || 0),
            description,
            reference: reference || null,
            metadata: metadata || null,
            userId: userId || null,
            relatedEntity: relatedEntity || null,
            relatedEntityId: relatedEntityId || null,
          },
        })
      )
    );

    logger.info({ transactionId, entryType, totalDebit, lines: lines.length }, '[journal] Recorded');
    return entries;
  }

  /**
   * Verify trial balance — sum of all debits should equal sum of all credits.
   * If it doesn't, the ledger is corrupted.
   *
   * @param {Object} [opts] — Optional filters { fromDate, toDate, account }
   * @returns {Promise<{ balanced: boolean, totalDebit: number, totalCredit: number, difference: number }>}
   */
  async trialBalance(opts = {}) {
    const where = {};
    if (opts.fromDate || opts.toDate) {
      where.createdAt = {};
      if (opts.fromDate) where.createdAt.gte = new Date(opts.fromDate);
      if (opts.toDate) where.createdAt.lte = new Date(opts.toDate);
    }
    if (opts.account) {
      where.account = { startsWith: opts.account };
    }

    const result = await prisma.journalEntry.aggregate({
      where,
      _sum: { debit: true, credit: true },
    });

    const totalDebit = parseFloat(result._sum.debit || 0);
    const totalCredit = parseFloat(result._sum.credit || 0);
    const difference = Math.abs(totalDebit - totalCredit);

    return {
      balanced: difference < 0.00000001,
      totalDebit,
      totalCredit,
      difference,
    };
  }

  /**
   * Get the balance for a specific account (sum of debits - sum of credits).
   * For asset accounts (user:*, platform:treasury), debit increases balance.
   * For liability/revenue accounts (platform:revenue, external:*), credit increases balance.
   *
   * @param {string} account — Account name (supports prefix matching with *)
   * @returns {Promise<{ account: string, debit: number, credit: number, balance: number }>}
   */
  async getAccountBalance(account) {
    const where = account.endsWith('*')
      ? { account: { startsWith: account.slice(0, -1) } }
      : { account };

    const result = await prisma.journalEntry.aggregate({
      where,
      _sum: { debit: true, credit: true },
    });

    const totalDebit = parseFloat(result._sum.debit || 0);
    const totalCredit = parseFloat(result._sum.credit || 0);

    return {
      account,
      debit: totalDebit,
      credit: totalCredit,
      // For asset accounts, balance = debits - credits
      // For liability/revenue, balance = credits - debits
      // We return the raw net; caller interprets based on account type
      netBalance: totalDebit - totalCredit,
    };
  }

  /**
   * Get all journal entries for a transaction ID (the paired debit+credit).
   * @param {string} transactionId
   * @returns {Promise<Array>}
   */
  async getTransactionEntries(transactionId) {
    return prisma.journalEntry.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get journal entries for a user, paginated.
   * @param {number} userId
   * @param {Object} [opts] — { limit, offset, entryType }
   * @returns {Promise<Array>}
   */
  async getUserEntries(userId, opts = {}) {
    const { limit = 50, offset = 0, entryType } = opts;
    return prisma.journalEntry.findMany({
      where: {
        userId,
        ...(entryType ? { entryType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Verify that a specific transaction is balanced.
   * @param {string} transactionId
   * @returns {Promise<{ balanced: boolean, entries: number, debit: number, credit: number }>}
   */
  async verifyTransaction(transactionId) {
    const entries = await prisma.journalEntry.findMany({
      where: { transactionId },
    });

    const totalDebit = entries.reduce((sum, e) => sum + parseFloat(e.debit || 0), 0);
    const totalCredit = entries.reduce((sum, e) => sum + parseFloat(e.credit || 0), 0);
    const difference = Math.abs(totalDebit - totalCredit);

    return {
      balanced: difference < 0.00000001,
      entries: entries.length,
      debit: totalDebit,
      credit: totalCredit,
      difference,
    };
  }

  /**
   * Generate a unique transaction ID for grouping journal entries.
   * @param {string} prefix — e.g. 'DEP', 'WTH', 'TRD'
   * @returns {string}
   */
  generateTransactionId(prefix = 'TXN') {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${prefix}_${timestamp}${random}`;
  }
}

// Singleton
const journalService = new JournalService();
module.exports = journalService;
