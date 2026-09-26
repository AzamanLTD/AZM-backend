'use strict';

// routes/custodyRoutes.js
// Admin-only custody execution diagnostics. The preflight endpoint is
// NON-DESTRUCTIVE: it verifies configuration and KMS/Tatum compatibility
// without broadcasting or creating any transaction, and it never exposes
// secrets (signature ids and API keys are reported only as present/absent).

const express = require('express');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const custody = require('../services/tatumCustodyExecutionService');

const router = express.Router();

router.use(protect);
router.use(adminOnly);

// GET /api/admin/custody/preflight — capability/config diagnostics.
// Optionally pass ?walletAddressId=... to include the signer/address
// correspondence check for that registry row.
router.get('/preflight', async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        let walletAddress = null;
        if (req.query.walletAddressId) {
            walletAddress = await prisma.walletAddress.findUnique({
                where: { id: String(req.query.walletAddressId) },
                select: { address: true, derivationIndex: true },
            });
            if (!walletAddress) {
                return res.status(404).json({ success: false, message: 'WalletAddress not found.' });
            }
        }
        const result = await custody.preflight(prisma, { walletAddress });
        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Preflight failed.', error: error.message });
    }
});

module.exports = router;
