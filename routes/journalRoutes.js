// routes/journalRoutes.js
// =============================================================================
// Journal / Ledger admin routes — Phase 4
// =============================================================================

const express = require('express');
const router = express.Router();
const journalService = require('../services/journalService');
const porIntegrity = require('../services/proofOfReservesIntegrityService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');

const protect = authMiddleware.protect;
const adminOnly = authMiddleware.adminOnly;

router.get('/trial-balance', protect, adminOnly, async (req, res) => {
  try {
    const { fromDate, toDate, account } = req.query;
    const result = await journalService.trialBalance({ fromDate: fromDate || undefined, toDate: toDate || undefined, account: account || undefined });
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Trial balance failed');
    return res.status(500).json({ success: false, message: 'Failed to compute trial balance.' });
  }
});

router.get('/account/:account', protect, adminOnly, async (req, res) => {
  try {
    const account = decodeURIComponent(req.params.account);
    return res.json({ success: true, data: await journalService.getAccountBalance(account) });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Account balance failed');
    return res.status(500).json({ success: false, message: 'Failed to get account balance.' });
  }
});

router.get('/transaction/:transactionId', protect, async (req, res) => {
  try {
    const entries = await journalService.getTransactionEntries(req.params.transactionId);
    if (req.user.role !== 'ADMIN' && !entries.some(e => e.userId === req.user.id)) return res.status(403).json({ success: false, message: 'Access denied.' });
    return res.json({ success: true, data: entries });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Transaction entries failed');
    return res.status(500).json({ success: false, message: 'Failed to get transaction entries.' });
  }
});

router.get('/user/:userId', protect, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (req.user.role !== 'ADMIN' && userId !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    const { limit = 50, offset = 0, entryType } = req.query;
    return res.json({ success: true, data: await journalService.getUserEntries(userId, { limit: parseInt(limit, 10), offset: parseInt(offset, 10), entryType: entryType || undefined }) });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] User entries failed');
    return res.status(500).json({ success: false, message: 'Failed to get user entries.' });
  }
});

router.get('/verify/:transactionId', protect, adminOnly, async (req, res) => {
  try {
    return res.json({ success: true, data: await journalService.verifyTransaction(req.params.transactionId) });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Verify transaction failed');
    return res.status(500).json({ success: false, message: 'Failed to verify transaction.' });
  }
});

// Admin integrity surface: combines double-entry trial balance with the latest
// immutable proof-of-reserves snapshot and its per-user commitment coverage.
router.get('/integrity', protect, adminOnly, async (req, res) => {
  try {
    const report = await porIntegrity.getIntegrityReport();
    return res.status(report.status === 'EXCEPTION' ? 409 : 200).json({ success: report.status !== 'EXCEPTION', data: report });
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Integrity report failed');
    return res.status(500).json({ success: false, message: 'Failed to compute financial integrity report.' });
  }
});

router.get('/stats', protect, adminOnly, async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const [totalCount, typeBreakdown, last24h] = await Promise.all([
        prisma.journalEntry.count(),
        prisma.journalEntry.groupBy({ by: ['entryType'], _count: { id: true }, _sum: { debit: true, credit: true } }),
        prisma.journalEntry.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      ]);
      return res.json({ success: true, data: { totalEntries: totalCount, entriesLast24h: last24h, byType: typeBreakdown.map(t => ({ type: t.entryType, count: t._count.id, totalDebit: parseFloat(t._sum.debit || 0), totalCredit: parseFloat(t._sum.credit || 0) })) } });
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    logger.error({ err: err.message }, '[journal] Stats failed');
    return res.status(500).json({ success: false, message: 'Failed to get journal stats.' });
  }
});

module.exports = router;
