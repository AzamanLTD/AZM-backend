const logger = require('../src/config/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure the folder exists so the server doesn't crash
const uploadDir = 'uploads/proofs';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Name format: proof-tradeID-timestamp.jpg
        const tradeId = req.body.tradeId || 'unknown';
        cb(null, `proof-${tradeId}-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        // THE FIX: Check both the mimetype AND the file extension
        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (file.mimetype.startsWith('image/') || allowedExtensions.includes(ext)) {
            cb(null, true); // It's a valid image, let it in!
        } else {
            cb(new Error(`Only images are allowed! File was rejected.`), false);
        }
    }
});

module.exports = upload;