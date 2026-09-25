'use strict';

// routes/e2eeRoutes.js
// =============================================================================
// AZAMAN E2EE v2 routes (r40) — docs/e2ee/PROTOCOL.md §7
//
// The server is a BLIND RELAY:
//   • It stores ONLY public key material (validated, signature-bound).
//   • It never generates, sees, or stores private keys.
//   • It never derives or stores session/ratchet state.
//
//   POST /api/e2ee/keys/init        — register a client-generated, public-only
//                                      bundle (identity + signed prekey + a
//                                      batch of one-time prekeys)
//   GET  /api/e2ee/keys/:userId     — fetch a peer's public bundle; atomically
//                                      claims one unused one-time prekey
//   POST /api/e2ee/keys/prekeys      — replenish one-time prekeys (client-
//                                      generated public halves only)
//   GET  /api/e2ee/fingerprint       — own safety number
//   GET  /api/e2ee/fingerprint/:userId — peer safety number (verification)
//   POST /api/e2ee/evidence/encrypt  — dispute evidence (client-supplied
//                                      plaintext history; admin-only flow)
//
// REMOVED in v2 (they made the server a decryption authority — the r40 P0):
//   POST/GET /api/e2ee/session/:peerId  — server-held ratchet state
//   POST /api/e2ee/keys/register        — legacy "simple ECDH" surface
//   GET  /api/e2ee/keys/public/:userId   — legacy "simple ECDH" surface
// Native clients must implement the v2 protocol contract instead.
//
// The routes use the application's canonical Prisma instance (req.app), NOT
// a private PrismaClient: no duplicate connection pool, no lifecycle drift,
// transactions participate in the app's client, and tests share the app's
// isolation.
// =============================================================================

const express = require('express');
const router = express.Router();
const e2ee = require('../services/e2eeService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');

const { protect } = authMiddleware;

const _prisma = (req) => req.app.get('prisma');

// ── Register a public-only bundle (client-generated keys) ─────────────────────
router.post('/keys/init', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const prisma = _prisma(req);
        const {
            identityPublicKey, identityDhPublicKey, identityKeySignature,
            signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature,
            oneTimePreKeys,
        } = req.body || {};

        // Strict validation of every public key byte and both Ed25519
        // signatures (binding + prekey) BEFORE anything is stored.
        await e2ee.validateBundle({ identityPublicKey, identityDhPublicKey, identityKeySignature, signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature });
        await e2ee.validateOneTimePreKeys(oneTimePreKeys);

        // Preserve the previous identity for peer-side key-change detection
        // (audit trail), then register the public-only bundle.
        const existing = await prisma.e2EEPreKeyBundle.findUnique({ where: { userId } });
        const identityChanged = !!existing && existing.identityPublicKey !== identityPublicKey;

        await prisma.$transaction(async (tx) => {
            await tx.e2EEPreKeyBundle.upsert({
                where: { userId },
                create: {
                    userId,
                    identityPublicKey,
                    identityDhPublicKey,
                    identityKeySignature,
                    signedPreKeyId,
                    signedPreKeyPublicKey,
                    signedPreKeySignature,
                },
                update: {
                    identityPublicKey,
                    identityDhPublicKey,
                    identityKeySignature,
                    signedPreKeyId,
                    signedPreKeyPublicKey,
                    signedPreKeySignature,
                    previousIdentityPublicKey: existing ? existing.identityPublicKey : null,
                    previousIdentityDhPublicKey: existing ? existing.identityDhPublicKey : null,
                },
            });
            // One-time prekeys are client-generated PUBLIC halves; replace any
            // unused leftovers with the fresh batch (a rotation resets the pool).
            await tx.e2EEOneTimePreKey.deleteMany({ where: { userId, isUsed: false } });
            await tx.e2EEOneTimePreKey.createMany({
                data: oneTimePreKeys.map(k => ({ userId, keyId: k.keyId, publicKey: k.publicKey })),
            });
        });

        return res.json({
            success: true,
            data: {
                identityChanged,
                previousIdentityPublicKey: identityChanged ? existing.previousIdentityPublicKey ?? existing.identityPublicKey : null,
                bundle: { identityPublicKey, identityDhPublicKey, identityKeySignature, signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature },
                oneTimePreKeyCount: oneTimePreKeys.length,
            },
        });
    } catch (err) {
        if (err.status && err.code) {
            return res.status(err.status).json({ success: false, code: err.code, message: err.message });
        }
        logger.error({ err: err.message }, '[e2ee] Keys init failed');
        return res.status(500).json({ success: false, message: 'Failed to register E2EE keys.' });
    }
});

// ── Fetch a peer's bundle + atomically claim one one-time prekey ──────────────
router.get('/keys/:userId', protect, async (req, res) => {
    try {
        const prisma = _prisma(req);
        const targetUserId = parseInt(req.params.userId, 10);
        if (!Number.isInteger(targetUserId)) {
            return res.status(400).json({ success: false, message: 'Invalid user id.' });
        }

        const bundle = await prisma.e2EEPreKeyBundle.findUnique({ where: { userId: targetUserId } });
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'No E2EE keys found for this user.' });
        }

        // Atomic claim (r40 E): a single UPDATE ... WHERE ... FOR UPDATE SKIP
        // LOCKED inside a transaction. Two concurrent callers can never be
        // handed the same prekey — the loser of the race gets a different row
        // (or none). This closes the read-then-write race of the old code.
        const claimed = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw`
                UPDATE "E2EEOneTimePreKey"
                SET "isUsed" = true, "usedAt" = NOW()
                WHERE id = (
                    SELECT id FROM "E2EEOneTimePreKey"
                    WHERE "userId" = ${targetUserId} AND "isUsed" = false
                    ORDER BY "createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING "keyId", "publicKey"`;
            return rows[0] || null;
        });

        return res.json({
            success: true,
            data: {
                identityPublicKey: bundle.identityPublicKey,
                identityDhPublicKey: bundle.identityDhPublicKey,
                identityKeySignature: bundle.identityKeySignature,
                signedPreKeyId: bundle.signedPreKeyId,
                signedPreKeyPublicKey: bundle.signedPreKeyPublicKey,
                signedPreKeySignature: bundle.signedPreKeySignature,
                oneTimePreKey: claimed ? { keyId: claimed.keyId, publicKey: claimed.publicKey } : null,
            },
        });
    } catch (err) {
        logger.error({ err: err.message }, '[e2ee] Fetch bundle failed');
        return res.status(500).json({ success: false, message: 'Failed to fetch preKey bundle.' });
    }
});

// ── Replenish one-time prekeys (public halves, client-generated) ──────────────
router.post('/keys/prekeys', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const prisma = _prisma(req);
        const { oneTimePreKeys } = req.body || {};

        // Strict bounded validation (r40 F): explicit list only, no
        // server-side generation, no count-driven memory amplification.
        await e2ee.validateOneTimePreKeys(oneTimePreKeys);

        // Never allow the pool to grow without bound: cap the TOTAL number of
        // unused prekeys per user.
        const [{ unused }] = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS unused FROM "E2EEOneTimePreKey"
            WHERE "userId" = ${userId} AND "isUsed" = false`;
        if (unused + oneTimePreKeys.length > 200) {
            return res.status(400).json({ success: false, code: 'E2EE_PREKEY_POOL_FULL', message: `Too many unused one-time preKeys (${unused}). Replenish later.` });
        }

        await prisma.e2EEOneTimePreKey.createMany({
            data: oneTimePreKeys.map(k => ({ userId, keyId: k.keyId, publicKey: k.publicKey })),
        });

        return res.json({ success: true, message: `${oneTimePreKeys.length} one-time preKeys added.`, data: { added: oneTimePreKeys.length } });
    } catch (err) {
        if (err.status && err.code) {
            return res.status(err.status).json({ success: false, code: err.code, message: err.message });
        }
        logger.error({ err: err.message }, '[e2ee] Replenish prekeys failed');
        return res.status(500).json({ success: false, message: 'Failed to replenish preKeys.' });
    }
});

// ── Safety numbers (public data) ───────────────────────────────────────────────
router.get('/fingerprint', protect, async (req, res) => {
    try {
        const prisma = _prisma(req);
        const bundle = await prisma.e2EEPreKeyBundle.findUnique({ where: { userId: req.user.id } });
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'E2EE not initialized. Call /keys/init first.' });
        }
        const fp = await e2ee.fingerprint(bundle.identityPublicKey);
        return res.json({ success: true, data: { fingerprint: fp, identityPublicKey: bundle.identityPublicKey } });
    } catch (err) {
        logger.error({ err: err.message }, '[e2ee] Fingerprint failed');
        return res.status(500).json({ success: false, message: 'Failed to get fingerprint.' });
    }
});

router.get('/fingerprint/:userId', protect, async (req, res) => {
    try {
        const prisma = _prisma(req);
        const targetUserId = parseInt(req.params.userId, 10);
        const bundle = await prisma.e2EEPreKeyBundle.findUnique({ where: { userId: targetUserId } });
        if (!bundle) {
            return res.status(404).json({ success: false, message: 'User has not initialized E2EE.' });
        }
        const fp = await e2ee.fingerprint(bundle.identityPublicKey);
        return res.json({ success: true, data: { fingerprint: fp, identityPublicKey: bundle.identityPublicKey } });
    } catch (err) {
        logger.error({ err: err.message }, '[e2ee] Peer fingerprint failed');
        return res.status(500).json({ success: false, message: 'Failed to get peer fingerprint.' });
    }
});

// ── Dispute evidence (explicitly out of the ordinary-message E2EE guarantee —
// the CLIENT uploads plaintext history for admin dispute processing; see
// PROTOCOL.md §6 exclusions) ─────────────────────────────────────────────────────
router.post('/evidence/encrypt', protect, async (req, res) => {
    try {
        const { adminPublicKey, messages } = req.body;
        if (!adminPublicKey || typeof adminPublicKey !== 'string' || !messages || !Array.isArray(messages) || messages.length > 1000) {
            return res.status(400).json({ success: false, message: 'adminPublicKey and messages[] (max 1000) are required.' });
        }
        const encrypted = await e2ee.encryptEvidenceForAdmin(adminPublicKey, messages);
        return res.json({ success: true, data: { evidence: encrypted } });
    } catch (err) {
        logger.error({ err: err.message }, '[e2ee] Evidence encryption failed');
        return res.status(500).json({ success: false, message: 'Failed to encrypt evidence.' });
    }
});

module.exports = router;
