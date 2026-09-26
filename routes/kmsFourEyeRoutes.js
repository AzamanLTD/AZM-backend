'use strict';

// routes/kmsFourEyeRoutes.js
// ── Tatum KMS four-eye external validation endpoint (§P.2) ────────────────────
//
// Tatum's documented four-eye mechanism: when the KMS daemon (started with
// `tatum-kms daemon --externalUrl=<this server's URL>`) fetches a pending
// transaction to sign, it performs a plain HTTP GET to
//   <externalUrl>/<pendingTransactionId>
// and signs ONLY on a 2xx response; any non-2xx means the transaction is
// skipped and must not be signed.
//
// SECURITY BOUNDARY (deliberate, matches the KMS protocol):
//  • This route is NOT behind normal admin authentication — the KMS daemon
//    performs a bare GET and cannot present our JWT. This mirrors Tatum's
//    documented externalUrl contract. Do not add auth middleware the KMS
//    protocol cannot satisfy.
//  • Protection = deployment/network topology: the URL must be reachable by
//    the KMS daemon (internal network / VPN). An optional source-IP allowlist
//    (TATUM_KMS_VALIDATOR_ALLOWED_IPS, comma-separated) is enforced when set;
//    unset = allow all (for testnet/dev topologies).
//  • The endpoint is READ-ONLY: no financial mutation, no state transition,
//    no secrets in responses. It cannot approve anything — it only reports
//    whether a durably APPROVED, exact-matching execution exists; approval
//    itself happens exclusively through the internal, authenticated
//    approveKmsRequest() boundary.

const express = require('express');
const logger = require('../src/config/logger');

const router = express.Router();

function allowedByIpAllowlist(req) {
    const raw = process.env.TATUM_KMS_VALIDATOR_ALLOWED_IPS;
    if (!raw) return true; // unset = open (topology-protected)
    const allowed = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length === 0) return true;
    return allowed.includes(req.ip);
}

// GET /api/internal/custody/kms/validate/:pendingId
// 2xx ONLY when the pending transaction id maps to a durable, APPROVED,
// exact-matching custody execution. Everything else is a refusal (KMS skips).
router.get('/validate/:pendingId', async (req, res) => {
    if (!allowedByIpAllowlist(req)) {
        return res.status(403).json({ approved: false, reason: 'SOURCE_IP_NOT_ALLOWED' });
    }
    const prisma = req.app.get('prisma');
    if (!prisma) return res.status(500).json({ approved: false, reason: 'NO_DATABASE' });
    let custody;
    try {
        custody = require('../services/tatumCustodyExecutionService');
    } catch (err) {
        return res.status(500).json({ approved: false, reason: 'SERVICE_UNAVAILABLE' });
    }
    try {
        const result = await custody.validateKmsPendingRequest(prisma, { pendingId: req.params.pendingId });
        if (!result.approved) {
            logger.warn({ pendingId: req.params.pendingId, reason: result.reason },
                '[kms-four-eye] external validation REFUSED — KMS must not sign');
            return res.status(result.httpStatus || 403).json({ approved: false, reason: result.reason });
        }
        // 2xx: the exact authorized transaction. KMS may sign.
        return res.status(200).json(result);
    } catch (err) {
        // Any internal failure is a refusal — fail closed, never a blind 2xx.
        logger.error({ err: err.message }, '[kms-four-eye] validator error — refusing');
        return res.status(500).json({ approved: false, reason: 'VALIDATOR_ERROR' });
    }
});

module.exports = router;
