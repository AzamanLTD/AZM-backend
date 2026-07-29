// routes/walletPassRoutes.js
// =============================================================================
// AZAMAN — Apple/Google Wallet Pass Routes (Phase 3)
//
// POST /api/wallet-pass/loyalty/:cardId   — generate pass for loyalty card
// POST /api/wallet-pass/vault/:vaultId    — generate pass for vault
// =============================================================================

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/walletPassController');
const { protect } = require('../middleware/authMiddleware');

router.post('/loyalty/:cardId', protect, ctrl.generateLoyaltyPass);
router.post('/vault/:vaultId', protect, ctrl.generateVaultPass);

module.exports = router;
