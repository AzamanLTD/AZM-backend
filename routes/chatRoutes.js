// routes/chatRoutes.js
// =============================================================================
// AZAMAN V2 — CHAT ROUTES
// Mounted at /api/chat. Read endpoints stay open to banned users;
// any chat write (send, upload, transfer) is gated by the ban guard.
// =============================================================================

const express                  = require('express');
const router                   = express.Router();
const multer                   = require('multer');
const path                     = require('path');
const chatController           = require('../controllers/chatController');
const ChatTransferController   = require('../controllers/chatTransferController');
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

// 4. In-Chat Crypto Transfer (write — gated). Lazy-init the controller so we
//    pick up the live prisma + io instances per request.
let chatTransferController;
router.post('/transfer', protectActive, (req, res, next) => {
    if (!chatTransferController) {
        const prisma = req.app.get('prisma');
        const io     = req.app.get('socketio');
        chatTransferController = new ChatTransferController(prisma, io);
    }
    req.chatTransferController = chatTransferController;
    next();
}, (req, res) => {
    req.chatTransferController.executeTransfer(req, res);
});

module.exports = router;
