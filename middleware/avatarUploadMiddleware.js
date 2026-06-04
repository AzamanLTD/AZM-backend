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
// Phase K: avatars get their own /uploads/avatars/ directory with a
// stricter filename scheme (no user-controlled tradeId in the path) and
// a tighter 2MB limit (avatars don't need 5MB; that ceiling was for
// KYC document scans).
//
// Existing avatar URLs in the DB pointing at /uploads/proofs/<filename>
// continue to work — the static-file mount in server.js still serves
// the entire /uploads tree. Only NEW uploads land in the avatars
// directory.
// =============================================================================

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const avatarDir = 'uploads/avatars';
if (!fs.existsSync(avatarDir)) {
    fs.mkdirSync(avatarDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, avatarDir);
    },
    filename: (req, file, cb) => {
        // Filename scheme: avatar-<userId>-<8 random hex>.<ext>
        // Why not use the original filename? Two reasons:
        //   1. originalname is user-controlled — could contain path traversal
        //      attempts (..%2F..%2F) that some browsers normalise weirdly.
        //   2. Re-uploading the same name overwrites silently. With a random
        //      suffix, every upload has a distinct URL — handy if a CDN
        //      caches by URL.
        const userId = (req.user && req.user.id) || 'anon';
        const suffix = crypto.randomBytes(4).toString('hex');
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `avatar-${userId}-${suffix}${ext}`);
    }
});

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
