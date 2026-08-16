// routes/journalRoutes.js
// =============================================================================
// Journal / Ledger admin routes — Phase 4
//
//   GET  /api/journal/trial-balance     — Verify debits == credits
//   GET  /api/journal/account/:account — Get balance for an account
//   GET  /api/journal/transaction/:id  — Get entries for a transaction
//   GET  /api/journal/user/:userId     — Get user's journal entries
//   GET  /api/journal/stats            — Aggregate stats
// =============================================================================

const express = require('express');
const router = express.Router();
const journalService = require('../services/journalService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');

const protect = authMiddleware.protect;
const adminOnly = authMiddleware.adminOnly;

// ── Trial Balance ────────────────────────────────────────────────────────────
// Admin can verify the entire ledger is balanced
router.get('/trial-balance', protect, adminOnly, async (req, res) => {
  try {
    const { fromDate, toDate, account } = req.query;
    const result = await journalService.trialBalance({
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      account: account || undefined,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Trial balance failed');
    return res.status(500).json({ success: false, message: 'Failed to compute trial balance.' });
  }
});

// ── Account Balance ──────────────────────────────────────────────────────────
router.get('/account/:account', protect, adminOnly, async (req, res) => {
  try {
    const account = decodeURIComponent(req.params.account);
    const balance = await journalService.getAccountBalance(account);
    return res.json({ success: true, data: balance });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Account balance failed');
    return res.status(500).json({ success: false, message: 'Failed to get account balance.' });
  }
});

// ── Transaction Entries ──────────────────────────────────────────────────────
// Any user can view their own transaction entries; admin can view any
router.get('/transaction/:transactionId', protect, async (req, res) => {
  try {
    const { transactionId } = req.params;
    const entries = await journalService.getTransactionEntries(transactionId);

    // Access control: non-admin can only see their own entries
    const isAdmin = req.user.role === 'ADMIN';
    if (!isAdmin) {
      const userEntry = entries.find(e => e.userId === req.user.id);
      if (!userEntry) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
    }

    return res.json({ success: true, data: entries });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Transaction entries failed');
    return res.status(500).json({ success: false, message: 'Failed to get transaction entries.' });
  }
});

// ── User Journal Entries ─────────────────────────────────────────────────────
router.get('/user/:userId', protect, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const isAdmin = req.user.role === 'ADMIN';

    // Users can only view their own entries unless admin
    if (!isAdmin && userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const { limit = 50, offset = 0, entryType } = req.query;
    const entries = await journalService.getUserEntries(userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      entryType: entryType || undefined,
    });

    return res.json({ success: true, data: entries });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] User entries failed');
    return res.status(500).json({ success: false, message: 'Failed to get user entries.' });
  }
});

// ── Verify Transaction ───────────────────────────────────────────────────────
router.get('/verify/:transactionId', protect, adminOnly, async (req, res) => {
  try {
    const { transactionId } = req.params;
    const result = await journalService.verifyTransaction(transactionId);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Verify transaction failed');
    return res.status(500).json({ success: false, message: 'Failed to verify transaction.' });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', protect, adminOnly, async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const [totalCount, typeBreakdown, last24h] = await Promise.all([
      prisma.journalEntry.count(),
      prisma.journalEntry.groupBy({
        by: ['entryType'],
        _count: { id: true },
        _sum: { debit: true, credit: true },
      }),
      prisma.journalEntry.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        totalEntries: totalCount,
        entriesLast24h: last24h,
        byType: typeBreakdown.map(t => ({
          type: t.entryType,
          count: t._count.id,
          totalDebit: parseFloat(t._sum.debit || 0),
          totalCredit: parseFloat(t._sum.credit || 0),
        })),
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Stats failed');
    return res.status(500).json({ success: false, message: 'Failed to get journal stats.' });
  }
});

module.exports = router;
