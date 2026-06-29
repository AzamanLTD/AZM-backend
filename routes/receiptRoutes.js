// routes/receiptRoutes.js
// =============================================================================
// AZAMAN — RECEIPT ROUTES (Phase Q11)
//
// Mounts under /api/receipts
//
// Endpoints:
//   GET /api/receipts/trade/:tradeId       — Download trade receipt PDF
//   GET /api/receipts/withdrawal/:id       — Download withdrawal receipt PDF
//
// All routes require authentication (protect middleware).
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const receiptController = require('../controllers/receiptController');

// Trade receipt
router.get('/trade/:tradeId', protect, receiptController.getTradeReceipt);

// Withdrawal receipt
router.get('/withdrawal/:id', protect, receiptController.getWithdrawalReceipt);

// Phase UI-5 (2026-05-26): peer-to-peer transfer receipt — powers the
// download chip on each row of the Chat Profile vault's Receipts tab.
router.get('/transfer/:id', protect, receiptController.getTransferReceipt);

// B-8: Transaction receipt data endpoint — returns JSON data for PDF receipt.
router.get('/transaction/:id', protect, receiptController.getTransactionReceipt);

module.exports = router;
