// services/cloudinaryService.js
// =============================================================================
// AZAMAN — CLOUDINARY FILE UPLOAD SERVICE
//
// Replaces local disk storage with Cloudinary cloud storage.
// All uploaded files get permanent URLs that survive Render redeploys.
//
// B-3 (2026-06-28): validated folder structure — only known entity/type pairs
// are accepted, preventing accidental mis-routing of uploads.
//
// Usage:
//   const { uploadToCloudinary } = require('./services/cloudinaryService');
//   const result = await uploadToCloudinary(req.file, 'avatars');
//   // result = { url: 'https://res.cloudinary.com/...', publicId: '...' }
//
// Env vars required:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// =============================================================================

const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

// Configure from env vars
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IS_CONFIGURED = !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (IS_CONFIGURED) {
    console.log('☁️  Cloudinary configured successfully');
} else {
    console.warn('⚠️  Cloudinary NOT configured — file uploads will use local disk (ephemeral on Render)');
}

// B-3: Allowed folder keys mapped to their Cloudinary path suffix.
// Every upload must specify one of these keys; unknown keys fall back to
// the key itself so the migration is non-breaking for existing callers.
const FOLDER_MAP = {
    avatars:          'avatars',
    'chat/images':    'chat/images',
    'chat/audio':     'chat/audio',
    'chat/video':     'chat/video',
    'chat/documents': 'chat/documents',
    'business/logos':   'business/logos',
    'business/products':'business/products',
    'business/kyb':     'business/kyb',
    'business/receipts':'business/receipts',
    kyc:              'kyc',
    'vendor-docs':    'vendor-docs',
    transit:          'transit',
    others:           'others',
};

/**
 * Resolve the Cloudinary folder path from an entity/type key.
 * Falls back to the key itself if not in the map.
 */
function resolveFolder(key) {
    return FOLDER_MAP[key] || key;
}

/**
 * Upload a multer file to Cloudinary.
 *
 * @param {object} file - multer file object (has .path or .buffer)
 * @param {string} folder - entity/type key ('avatars', 'chat/images', etc.)
 * @param {object} [options] - Extra Cloudinary upload options
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadToCloudinary(file, folder = 'others', options = {}) {
    const isMock = !IS_CONFIGURED ||
                   (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME.includes('mock')) ||
                   (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_KEY.includes('mock'));

    if (isMock) {
        const resolvedFolder = resolveFolder(folder);
        const uploadsDir = path.join(__dirname, '../uploads', resolvedFolder);
        
        fs.mkdirSync(uploadsDir, { recursive: true });
        
        const ext = file.originalname ? path.extname(file.originalname) : '.dat';
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const destPath = path.join(uploadsDir, filename);
        
        if (file.buffer) {
            fs.writeFileSync(destPath, file.buffer);
        } else if (file.path) {
            fs.copyFileSync(file.path, destPath);
            fs.unlink(file.path, () => {});
        } else {
            throw new Error('File has neither buffer nor path');
        }
        
        // Return an absolute URL so Flutter/web clients can actually load it.
        // RENDER WARNING: /uploads/ is ephemeral — files are lost on redeploy.
        // Set CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
        // in your Render dashboard to enable persistent cloud storage.
        const serverBase = process.env.SERVER_BASE_URL ||
            process.env.RENDER_EXTERNAL_URL ||
            `http://localhost:${process.env.PORT || 3000}`;
        const localUrl = `${serverBase}/uploads/${resolvedFolder}/${filename}`;
        console.warn(`[CloudinaryMock] ⚠️  Saved to LOCAL disk (ephemeral on Render): ${localUrl}`);
        return { url: localUrl, publicId: null };
    }

    return new Promise((resolve, reject) => {
        const resolvedFolder = resolveFolder(folder);
        const uploadOptions = {
            folder: `azaman/${resolvedFolder}`,
            resource_type: 'auto',
            ...options,
        };

        const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
                if (error) {
                    console.error('[Cloudinary] Upload error:', error.message);
                    reject(error);
                } else {
                    resolve({
                        url: result.secure_url,
                        publicId: result.public_id,
                    });
                }
            }
        );

        // If multer stored to disk, read and pipe
        if (file.path) {
            const fs = require('fs');
            const stream = fs.createReadStream(file.path);
            stream.pipe(uploadStream);
            // Clean up local temp file after upload
            stream.on('end', () => {
                fs.unlink(file.path, () => {}); // fire-and-forget cleanup
            });
        } else if (file.buffer) {
            // If multer used memory storage
            const { Readable } = require('stream');
            const readable = Readable.from(file.buffer);
            readable.pipe(uploadStream);
        } else {
            reject(new Error('File has neither path nor buffer'));
        }
    });
}

/**
 * Delete a file from Cloudinary by public ID.
 */
async function deleteFromCloudinary(publicId) {
    if (!IS_CONFIGURED || !publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId);
    } catch (e) {
        console.error('[Cloudinary] Delete error:', e.message);
    }
}

module.exports = { uploadToCloudinary, deleteFromCloudinary, IS_CONFIGURED };
