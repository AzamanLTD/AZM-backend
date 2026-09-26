// routes/chatRoutes.js
// =============================================================================
// AZAMAN V2 — CHAT ROUTES
// Mounted at /api/chat. Read endpoints stay open to banned users;
// any chat write (send, upload, transfer) is gated by the ban guard.
// =============================================================================

const logger = require('../src/config/logger');
const express                  = require('express');
const router                   = express.Router();
const multer                   = require('multer');
const path                     = require('path');
const chatController           = require('../controllers/chatController');
const { protect }              = require('../middleware/authMiddleware');
const { protectActive }        = require('../middleware/banGuardMiddleware');

// ── Multer configuration ─────────────────────────────────────────────────────
// In-memory buffering; the controller streams the file to Cloudinary so the
// stored URL survives Render redeploys (local disk is ephemeral).
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname  = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Only images (jpeg, jpg, png) are allowed.'));
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// ── Routes ───────────────────────────────────────────────────────────────────

// 1. Read-only history (banned users keep access)
router.get('/:tradeId',  protect,       chatController.getChatHistory);

// 2. Send text message (write — gated)
router.post('/send',     protectActive, chatController.sendMessage);

// 3. Upload screenshot / payment proof (write — gated)
router.post('/upload',   protectActive, upload.single('screenshot'), chatController.sendImageMessage);

// 4. In-Chat Crypto Transfer — REMOVED (r25 §6, Option A).
//    The route mounted `new ChatTransferController(prisma, io)` while the
//    controller module exports a plain object (exports.chatTransfer) — every
//    live call failed with `ChatTransferController is not a constructor`
//    before reaching any financial code. The live product's canonical
//    internal-transfer flow is the peer-transfer rail
//    (POST /api/friends/transfer/... — peerTransferController), which is
//    what the Flutter client actually calls. The broken legacy duplicate
//    is unmounted rather than left as an active 500-ing financial endpoint.

module.exports = router;
