// services/cloudinaryService.js
// =============================================================================
// AZAMAN — CLOUDINARY FILE UPLOAD SERVICE
//
// Replaces local disk storage with Cloudinary cloud storage.
// All uploaded files get permanent URLs that survive Render redeploys.
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

/**
 * Upload a multer file to Cloudinary.
 *
 * @param {object} file - multer file object (has .path or .buffer)
 * @param {string} folder - Cloudinary folder name ('avatars', 'proofs', 'chat')
 * @param {object} [options] - Extra Cloudinary upload options
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadToCloudinary(file, folder = 'uploads', options = {}) {
    if (!IS_CONFIGURED) {
        // Fallback for local dev without Cloudinary: only possible when multer
        // wrote the file to disk (file.path exists). Callers that use
        // memoryStorage (chat media, avatars, proof-of-residency) have no local
        // path to fall back to — surface a clear error instead of a cryptic
        // TypeError on `undefined.replace`.
        if (!file.path) {
            throw new Error('Cloudinary not configured; in-memory upload cannot be persisted locally. Set CLOUDINARY_* env vars.');
        }
        const localUrl = '/' + file.path.replace(/\\/g, '/');
        return { url: localUrl, publicId: null };
    }

    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `azaman/${folder}`,
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
