// routes/e2eeRoutes.js
// =============================================================================
// E2EE key directory routes (server-blind — docs/e2ee-protocol.md).
//
//   POST   /api/e2ee/devices          — register/rotate a device's PUBLIC keys
//   GET    /api/e2ee/keys/:userId    — prekey bundle (atomic one-time claim)
//   POST   /api/e2ee/keys/prekeys    — replenish public one-time prekeys
//   GET    /api/e2ee/fingerprint     — own identity fingerprint
//   GET    /api/e2ee/fingerprint/:userId — peer fingerprint (safety numbers)
//   DELETE /api/e2ee/devices/:deviceId — deactivate a device
//
// Removed in r40: /keys/init and /keys/register (the server must never
// generate or store private keys), /session/:peerId GET+POST (ratchet state
// belongs to the CLIENT — the server must never hold session keys), and
// /evidence/encrypt (the server must not receive plaintext history).
//
// The canonical application Prisma instance (req.app.get('prisma')) is used —
// no private PrismaClient, no second connection pool.
// =============================================================================

'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { E2EEKeyService } = require('../services/e2ee/keyService');
const logger = require('../src/config/logger');

const service = (req) => new E2EEKeyService(req.app.get('prisma'));

function wrap(handler) {
    return async (req, res) => {
        try { await handler(req, res); }
        catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code || 'E2EE_INVALID_REQUEST' });
            logger.error({ err: err.message }, '[e2ee] Unexpected error');
            return res.status(500).json({ success: false, message: 'E2EE request failed.' });
        }
    };
}

router.use(protect);

// Register / rotate a device's public keys. Idempotent per deviceId.
router.post('/devices', wrap(async (req, res) => {
    const result = await service(req).registerDevice({ userId: req.user.id, ...req.body });
    res.json({ success: true, data: result });
}));

// Prekey bundle for starting a session with a user.
router.get('/keys/:userId', wrap(async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ success: false, message: 'Invalid user id.' });
    const bundle = await service(req).fetchBundle(targetUserId);
    if (!bundle) return res.status(404).json({ success: false, message: 'No active E2EE device for this user.' });
    res.json({ success: true, data: bundle });
}));

// Replenish public one-time prekeys (bounded, verified shapes).
router.post('/keys/prekeys', wrap(async (req, res) => {
    const result = await service(req).replenishOneTimePreKeys({ userId: req.user.id, oneTimePreKeys: req.body.oneTimePreKeys });
    res.json({ success: true, data: result });
}));

// Safety numbers.
router.get('/fingerprint', wrap(async (req, res) => {
    const fp = await service(req).identityFingerprint(req.user.id);
    if (!fp) return res.status(404).json({ success: false, message: 'E2EE not initialized for this account.' });
    res.json({ success: true, data: fp });
}));

router.get('/fingerprint/:userId', wrap(async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ success: false, message: 'Invalid user id.' });
    const fp = await service(req).identityFingerprint(targetUserId);
    if (!fp) return res.status(404).json({ success: false, message: 'User has no active E2EE device.' });
    res.json({ success: true, data: fp });
}));

// Deactivate a device (rotation / logout).
router.delete('/devices/:deviceId', wrap(async (req, res) => {
    const result = await service(req).deactivateDevice({ userId: req.user.id, deviceId: req.params.deviceId });
    res.json({ success: true, data: result });
}));

module.exports = router;
