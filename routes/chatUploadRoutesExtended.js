/**
 * Chat Media Upload Routes — Extended
 *
 * Extracted from server.js to reduce its line count.
 * Handles:
 *   POST /api/chat/upload/image    — 10MB image upload → Cloudinary
 *   POST /api/chat/upload/audio    — 5MB audio upload → Cloudinary
 *   POST /api/chat/upload/video    — 50MB video upload → Cloudinary
 *   POST /api/chat/upload/document — 25MB document upload → Cloudinary
 *   POST /api/chat/upload-media    — Legacy 8MB image-only (kept for old builds)
 *   POST /api/chat/link-preview    — Fetch OpenGraph metadata for a URL
 *   POST /api/business/upload/image — Business image upload → Cloudinary
 *   POST /api/vendor/upload-docs   — Vendor KYC documents → Cloudinary
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../src/config/logger');
const { protect } = require('../middleware/authMiddleware');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const LinkPreviewService = require('../services/linkPreviewService');

const router = express.Router();

// ── Cloudinary folder per media kind ──────────────────────────────────────
const _chatFolderFor = { image: 'chat/images', audio: 'chat/audio', video: 'chat/video', document: 'chat/documents' };
const _chatStorageFor = () => multer.memoryStorage();

const _chatMimeFilter = (allowed) => (req, file, cb) => {
    if (allowed.some((p) => file.mimetype === p || file.mimetype.startsWith(p))) {
        cb(null, true);
    } else {
        cb(new Error(`Disallowed mime: ${file.mimetype}`), false);
    }
};

const chatImageUpload = multer({
    storage: _chatStorageFor('image'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: _chatMimeFilter(['image/'])
});
const chatAudioUpload = multer({
    storage: _chatStorageFor('audio'),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: _chatMimeFilter([
        'audio/mp4', 'audio/m4a', 'audio/x-m4a',
        'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/aac'
    ])
});
const chatVideoUpload = multer({
    storage: _chatStorageFor('video'),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: _chatMimeFilter(['video/'])
});
const chatDocumentUpload = multer({
    storage: _chatStorageFor('document'),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: _chatMimeFilter([
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/csv'
    ])
});

// Helper: upload a buffered multer file to Cloudinary and return its secure_url.
const _uploadChatMediaUrl = async (file, kind) => {
    const opts = kind === 'document' ? { resource_type: 'raw' } : {};
    const { url } = await uploadToCloudinary(file, _chatFolderFor[kind], opts);
    return url;
};

// ── POST /api/chat/upload/image ─────────────────────────────────────────────
router.post('/upload/image', protect, chatImageUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const url = await _uploadChatMediaUrl(req.file, 'image');
        res.status(200).json({
            success: true, url, mimeType: req.file.mimetype,
            size: req.file.size, filename: req.file.originalname
        });
    } catch (err) {
        logger.error({ err, mediaType: 'image' }, 'Chat media upload error');
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ── POST /api/chat/upload/audio ─────────────────────────────────────────────
router.post('/upload/audio', protect, chatAudioUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    let waveformPeaks = null;
    if (req.body.waveformPeaks) {
        try {
            const parsed = JSON.parse(req.body.waveformPeaks);
            if (Array.isArray(parsed) && parsed.length <= 100) waveformPeaks = parsed;
        } catch (_) { /* swallow */ }
    }
    const duration = parseInt(req.body.duration, 10);
    try {
        const url = await _uploadChatMediaUrl(req.file, 'audio');
        res.status(200).json({
            success: true, url, mimeType: req.file.mimetype,
            size: req.file.size, duration: Number.isFinite(duration) ? duration : null,
            waveformPeaks
        });
    } catch (err) {
        logger.error({ err, mediaType: 'audio' }, 'Chat media upload error');
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ── POST /api/chat/upload/video ─────────────────────────────────────────────
router.post('/upload/video', protect, chatVideoUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const duration = parseInt(req.body.duration, 10);
    try {
        const url = await _uploadChatMediaUrl(req.file, 'video');
        res.status(200).json({
            success: true, url, mimeType: req.file.mimetype,
            size: req.file.size, duration: Number.isFinite(duration) ? duration : null
        });
    } catch (err) {
        logger.error({ err, mediaType: 'video' }, 'Chat media upload error');
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ── POST /api/chat/upload/document ──────────────────────────────────────────
router.post('/upload/document', protect, chatDocumentUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const url = await _uploadChatMediaUrl(req.file, 'document');
        res.status(200).json({
            success: true, url, mimeType: req.file.mimetype,
            size: req.file.size, filename: req.file.originalname
        });
    } catch (err) {
        logger.error({ err, mediaType: 'document' }, 'Chat media upload error');
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ── POST /api/chat/link-preview ─────────────────────────────────────────────
let _linkPreviewService = null;
router.use((req, res, next) => {
    if (!_linkPreviewService) {
        _linkPreviewService = req.app.get('linkPreviewService') || new LinkPreviewService(req.prisma || req.app.get('prisma'));
    }
    next();
});

router.post('/link-preview', protect, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'url required' });
        const preview = await _linkPreviewService.fetch(url);
        if (!preview) return res.status(400).json({ success: false, message: 'invalid url' });
        return res.status(200).json({ success: true, preview });
    } catch (err) {
        logger.error({ err }, 'Link preview error');
        return res.status(500).json({ success: false, message: 'preview failed' });
    }
});

// ── POST /api/chat/upload-media (LEGACY — kept for old builds) ───────────────
const imageFileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'), false);
};

const chatMediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: imageFileFilter
});

router.post('/upload-media', chatMediaUpload.any(), async (req, res) => {
    try {
        const file = Array.isArray(req.files) ? req.files[0] : req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        const mediaUrl = await _uploadChatMediaUrl(file, 'image');
        res.status(200).json({ mediaUrl, path: mediaUrl, url: mediaUrl });
    } catch (err) {
        logger.error({ err }, 'Chat media upload error');
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ── POST /api/business/upload/image ─────────────────────────────────────────
router.post('/business-upload', protect, chatImageUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const folder = req.query.folder === 'logos' ? 'business/logos'
                     : req.query.folder === 'kyb'   ? 'business/kyb'
                     : 'business/products';
        const { url } = await uploadToCloudinary(req.file, folder);
        res.status(200).json({
            success: true, url, mimeType: req.file.mimetype,
            size: req.file.size, filename: req.file.originalname
        });
    } catch (err) {
        logger.error({ err }, 'Business image upload error');
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ── POST /api/vendor/upload-docs ─────────────────────────────────────────────
const vendorDocsDir = 'uploads/vendor/';
if (!fs.existsSync(vendorDocsDir)) fs.mkdirSync(vendorDocsDir, { recursive: true });

const vendorDocsStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, vendorDocsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'vendor-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const vendorDocsUpload = multer({
    storage: vendorDocsStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: imageFileFilter
});

router.post('/vendor-docs', protect, vendorDocsUpload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
    { name: 'addressProof', maxCount: 1 },
]), async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }
        const urls = {};
        for (const [field, files] of Object.entries(req.files)) {
            if (files && files.length > 0) {
                const { url } = await uploadToCloudinary(files[0], 'vendor-docs');
                urls[field] = url;
            }
        }
        logger.info({ userId: req.user.id, keys: Object.keys(urls) }, 'Vendor: documents uploaded');
        return res.status(200).json({ success: true, urls });
    } catch (err) {
        logger.error({ err }, 'Vendor docs upload error');
        return res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

module.exports = router;


// Export multer configs and key middleware for use in server.js
module.exports.imageUpload = chatImageUpload;
module.exports.vendorDocsUpload = vendorDocsUpload;
