// routes/e2eeRoutes.js
// =============================================================================
// E2EE Key Management & Session Routes
//
//   POST /api/e2ee/keys/init          — Generate + register identity key + signed preKey + one-time preKeys
//   GET  /api/e2ee/keys/:userId       — Fetch a user's preKey bundle (to start a session)
//   POST /api/e2ee/keys/prekeys       — Upload more one-time preKeys (replenish)
//   GET  /api/e2ee/session/:peerId    — Get session state with a peer
//   POST /api/e2ee/session/:peerId    — Initialize/update session state
//   GET  /api/e2ee/fingerprint         — Get own identity key fingerprint
//   POST /api/e2ee/fingerprint/:userId— Get another user's fingerprint (safety numbers)
//   POST /api/e2ee/evidence/encrypt   — Encrypt message history as dispute evidence
//
// NOTE: Private keys for one-time preKeys MUST be stored on the server
// temporarily because the X3DH receiver-side computation needs them.
// They are deleted after session establishment (consumed = true).
// =============================================================================

const express = require('express');
const router = express.Router();
const e2ee = require('../services/e2eeService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');

const { protect, adminOnly } = authMiddleware;

// Use a lazy-loaded prisma to avoid circular deps
let _prisma;
function prisma() {
  if (!_prisma) {
    const { PrismaClient } = require('@prisma/client');
    _prisma = new PrismaClient();
  }
  return _prisma;
}

// ── Initialize E2EE keys ─────────────────────────────────────────────────────
router.post('/keys/init', protect, async (req, res) => {
  try {
    const userId = req.user.id;

    // Generate identity key pair
    const identityKp = await e2ee.generateIdentityKeyPair();
    // Generate signed preKey
    const signedPreKey = await e2ee.generateSignedPreKey(identityKp.privateKey);
    // Generate 50 one-time preKeys
    const oneTimePreKeys = await e2ee.generatePreKeys(50);

    // Store in database
    const bundle = await prisma().e2eePreKeyBundle.upsert({
      where: { userId },
      create: {
        userId,
        identityPublicKey: identityKp.publicKey,
        identityPrivateKey: identityKp.privateKey,
        signedPreKeyId: signedPreKey.keyId,
        signedPreKeyPublicKey: signedPreKey.publicKey,
        signedPreKeyPrivateKey: signedPreKey.privateKey,
        signedPreKeySignature: signedPreKey.signature,
      },
      update: {
        identityPublicKey: identityKp.publicKey,
        identityPrivateKey: identityKp.privateKey,
        signedPreKeyId: signedPreKey.keyId,
        signedPreKeyPublicKey: signedPreKey.publicKey,
        signedPreKeyPrivateKey: signedPreKey.privateKey,
        signedPreKeySignature: signedPreKey.signature,
        activeRootKey: null,
        activeChainKey: null,
        messageNumber: 0,
      },
    });

    // Delete old one-time preKeys and insert new ones
    await prisma().e2eeOneTimePreKey.deleteMany({ where: { userId } });
    await prisma().e2eeOneTimePreKey.createMany({
      data: oneTimePreKeys.map(k => ({
        userId,
        keyId: k.keyId,
        publicKey: k.publicKey,
        privateKey: k.privateKey,
      })),
    });

    // Return only public keys + private keys (client stores private keys locally)
    return res.json({
      success: true,
      data: {
        identityKeyPair: identityKp,
        signedPreKey,
        oneTimePreKeys,
        bundle: {
          identityPublicKey: bundle.identityPublicKey,
          signedPreKeyId: bundle.signedPreKeyId,
          signedPreKeyPublicKey: bundle.signedPreKeyPublicKey,
          signedPreKeySignature: bundle.signedPreKeySignature,
        },
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Keys init failed');
    return res.status(500).json({ success: false, message: 'Failed to initialize E2EE keys.' });
  }
});

// ── Fetch preKey bundle (to start a session) ─────────────────────────────────
router.get('/keys/:userId', protect, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);

    const bundle = await prisma().e2eePreKeyBundle.findUnique({
      where: { userId: targetUserId },
    });
    if (!bundle) {
      return res.status(404).json({ success: false, message: 'No E2EE keys found for this user.' });
    }

    // Get an unused one-time preKey
    const oneTimePreKey = await prisma().e2eeOneTimePreKey.findFirst({
      where: { userId: targetUserId, isUsed: false },
      orderBy: { createdAt: 'asc' },
    });

    // Mark one-time preKey as used (atomic)
    if (oneTimePreKey) {
      await prisma().e2eeOneTimePreKey.update({
        where: { id: oneTimePreKey.id },
        data: { isUsed: true, usedAt: new Date() },
      });
    }

    return res.json({
      success: true,
      data: {
        identityPublicKey: bundle.identityPublicKey,
        signedPreKeyId: bundle.signedPreKeyId,
        signedPreKeyPublicKey: bundle.signedPreKeyPublicKey,
        signedPreKeySignature: bundle.signedPreKeySignature,
        oneTimePreKey: oneTimePreKey
          ? { keyId: oneTimePreKey.keyId, publicKey: oneTimePreKey.publicKey, id: oneTimePreKey.id }
          : null,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Fetch bundle failed');
    return res.status(500).json({ success: false, message: 'Failed to fetch preKey bundle.' });
  }
});

// ── Replenish one-time preKeys ────────────────────────────────────────────────
router.post('/keys/prekeys', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const { count = 25 } = req.body;

    const newPreKeys = await e2ee.generatePreKeys(count);
    await prisma().e2eeOneTimePreKey.createMany({
      data: newPreKeys.map(k => ({
        userId,
        keyId: k.keyId,
        publicKey: k.publicKey,
        privateKey: k.privateKey,
      })),
    });

    return res.json({
      success: true,
      message: `${count} one-time preKeys added.`,
      data: newPreKeys,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Replenish prekeys failed');
    return res.status(500).json({ success: false, message: 'Failed to replenish preKeys.' });
  }
});

// ── Get session state with a peer ────────────────────────────────────────────
router.get('/session/:peerId', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const peerId = parseInt(req.params.peerId);

    const session = await prisma().e2eeSession.findUnique({
      where: { userId_peerUserId: { userId, peerUserId: peerId } },
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'No session found with this peer.' });
    }

    return res.json({
      success: true,
      data: {
        rootKey: session.rootKey,
        sendingChainKey: session.sendingChainKey,
        receivingChainKey: session.receivingChainKey,
        sendMessageNumber: session.sendMessageNumber,
        receiveMessageNumber: session.receiveMessageNumber,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Get session failed');
    return res.status(500).json({ success: false, message: 'Failed to get session.' });
  }
});

// ── Initialize/update session state ──────────────────────────────────────────
router.post('/session/:peerId', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const peerId = parseInt(req.params.peerId);
    const { rootKey, sendingChainKey, receivingChainKey, sendMessageNumber, receiveMessageNumber } = req.body;

    if (!rootKey) {
      return res.status(400).json({ success: false, message: 'rootKey is required.' });
    }

    const session = await prisma().e2eeSession.upsert({
      where: { userId_peerUserId: { userId, peerUserId: peerId } },
      create: {
        userId,
        peerUserId: peerId,
        rootKey,
        sendingChainKey: sendingChainKey || null,
        receivingChainKey: receivingChainKey || null,
        sendMessageNumber: sendMessageNumber || 0,
        receiveMessageNumber: receiveMessageNumber || 0,
      },
      update: {
        rootKey,
        sendingChainKey: sendingChainKey || undefined,
        receivingChainKey: receivingChainKey || undefined,
        sendMessageNumber: sendMessageNumber !== undefined ? sendMessageNumber : undefined,
        receiveMessageNumber: receiveMessageNumber !== undefined ? receiveMessageNumber : undefined,
      },
    });

    return res.json({ success: true, data: session });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Save session failed');
    return res.status(500).json({ success: false, message: 'Failed to save session.' });
  }
});

// ── Get own fingerprint ────────────────────────────────────────────────────────
router.get('/fingerprint', protect, async (req, res) => {
  try {
    const bundle = await prisma().e2eePreKeyBundle.findUnique({
      where: { userId: req.user.id },
    });
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

// ── Get another user's fingerprint (for safety number verification) ────────────
router.get('/fingerprint/:userId', protect, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const bundle = await prisma().e2eePreKeyBundle.findUnique({
      where: { userId: targetUserId },
    });
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

// ── Encrypt dispute evidence ─────────────────────────────────────────────────
router.post('/evidence/encrypt', protect, async (req, res) => {
  try {
    const { adminPublicKey, messages } = req.body;
    if (!adminPublicKey || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ success: false, message: 'adminPublicKey and messages[] are required.' });
    }

    const encrypted = await e2ee.encryptEvidenceForAdmin(adminPublicKey, messages);
    return res.json({ success: true, data: { evidence: encrypted } });
  } catch (err) {
    logger.error({ err: err.message }, '[e2ee] Evidence encryption failed');
    return res.status(500).json({ success: false, message: 'Failed to encrypt evidence.' });
  }
});

module.exports = router;
