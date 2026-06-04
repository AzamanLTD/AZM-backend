// routes/tradeAccountRoutes.js
// =============================================================================
// AZAMAN — TRADE ACCOUNT ROUTES
//
// Mounted at /api/trade-accounts. These are the GLOBAL FIAT handles a
// vendor publishes on a P2P ad (CashApp, Zelle, Venmo, PayPal, Apple Pay,
// Bank Transfer). They are NOT the same as Withdrawal Addresses (which
// are MoMo / Telecel / crypto-only and live on the SavedWallet table).
//
// Endpoints:
//   POST   /                       — create a trade account (status PENDING)
//   GET    /approved               — list of the caller's APPROVED accounts
//   POST   /upload-screenshot      — multer endpoint that accepts the
//                                    vendor's profile screenshot (e.g. their
//                                    CashApp profile screen) and returns a
//                                    URL. The URL is then passed to
//                                    `POST /` as `verificationScreenshot`.
// =============================================================================

const express              = require('express');
const router               = express.Router();
const multer               = require('multer');
const path                 = require('path');
const fs                   = require('fs');

const tradeAccountController = require('../controllers/tradeAccountController');
const authMiddleware         = require('../middleware/authMiddleware');

const protect = authMiddleware.protect;

// ── Multer configuration ─────────────────────────────────────────────────────
//
// Vendors must prove ownership of a global-fiat handle by uploading a
// screenshot of their profile inside the third-party app (CashApp profile
// screen, Zelle profile, etc.). Screenshots are stored under
// `uploads/trade-accounts/`. The frontend uploads via this endpoint, gets
// back a URL, then includes that URL in the `verificationScreenshot` field
// of the create-account payload.
const TRADE_ACCOUNT_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'trade-accounts');
if (!fs.existsSync(TRADE_ACCOUNT_UPLOAD_DIR)) {
    fs.mkdirSync(TRADE_ACCOUNT_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: TRADE_ACCOUNT_UPLOAD_DIR,
    filename:    (req, file, cb) => {
        const userId = req.user?.id ?? 'anon';
        const ext    = path.extname(file.originalname).toLowerCase();
        cb(null, `ta-${userId}-${Date.now()}${ext}`);
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/;
    const extOk   = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk  = file.mimetype.startsWith('image/');
    // Accept if EITHER extension OR mime type indicates an image
    // (Android devices frequently report incorrect MIME types for camera captures)
    if (extOk || mimeOk) return cb(null, true);
    cb(new Error('Only image files (JPEG, PNG, GIF, WebP, HEIC) are allowed.'));
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

// ── Routes ───────────────────────────────────────────────────────────────────

router.post('/upload-screenshot', protect, upload.single('screenshot'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No screenshot received. Pick an image and try again.',
        });
    }

    // Upload to Cloudinary for persistent storage
    const { uploadToCloudinary } = require('../services/cloudinaryService');
    const { url } = await uploadToCloudinary(req.file, 'trade-accounts');

    res.status(201).json({
        success: true,
        url,
        filename: req.file.filename,
        size: req.file.size,
    });
});

router.post('/', protect, tradeAccountController.addTradeAccount);
router.get('/', protect, tradeAccountController.getTradeAccounts);
router.get('/approved', protect, tradeAccountController.getApprovedTradeAccounts);

module.exports = router;
