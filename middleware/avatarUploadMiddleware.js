// middleware/avatarUploadMiddleware.js
// =============================================================================
// AZAMAN — Phase K avatar upload middleware
//
// Avatars used to be stored in /uploads/proofs/ alongside KYC documents
// and trade payment proofs. This was a P1 finding in AUDIT.md §6 —
// avatars are public profile assets while proofs are sensitive PII.
// Sharing the directory means a future "list /uploads/proofs/" feature
// (or a misconfigured static-file serve) leaks KYC data.
//
// Phase K gave avatars their own directory; the Cloudinary migration takes
// that further — avatars now upload to the dedicated `users/avatars`
// Cloudinary folder, fully separated from KYC/proof storage. This middleware
// only buffers the file in memory (2MB cap — avatars don't need the 5MB
// ceiling that was for KYC document scans); profileController.uploadAvatar
// streams it to Cloudinary and persists the secure_url.
//
// Existing avatar URLs in the DB (older /uploads/... paths or prior Cloudinary
// URLs) continue to resolve unchanged; only NEW uploads land in users/avatars.
// =============================================================================

const logger = require('../src/config/logger');
const multer = require('multer');
const path = require('path');

// In-memory buffering only. The consumer (profileController.uploadAvatar)
// streams the buffer to Cloudinary via uploadToCloudinary() and stores the
// returned secure_url, so avatars never touch the (ephemeral) local disk.
// The old disk filename scheme (avatar-<userId>-<hex>.<ext>) is no longer
// needed — Cloudinary assigns its own public_id and the upload is scoped to
// the users/avatars folder.
const storage = multer.memoryStorage();

const avatarUpload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — avatars don't need 5MB
    fileFilter: (req, file, cb) => {
        // Phase K review-pass tightening: BOTH mimetype AND extension must
        // pass. The original was `||` which let an arbitrary mime through
        // if the extension was OK, and vice versa. Real exposure was
        // bounded by express.static serving by extension (so the served
        // Content-Type follows the saved extension, not the upload mime),
        // but a user could still consume the 2 MB cap with non-image
        // bytes that get served as image/png. Tightening to AND closes
        // both paths. A future hardening would sniff magic bytes after
        // upload via the `file-type` package.
        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeOk = file.mimetype.startsWith('image/');
        const extOk = allowedExtensions.includes(ext);
        if (mimeOk && extOk) {
            cb(null, true);
        } else {
            cb(new Error('Only images are allowed for avatars.'), false);
        }
    }
});

module.exports = avatarUpload;
