// routes/chatUploadRoutes.js
// AZAMAN PREMIUM CHAT UPLOADS — Chunked processing route

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadDir = path.join(__dirname, '../uploads/chat');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/chunk', upload.single('chunk'), async (req, res) => {
  try {
    const {
      userId, context, contextId, localId,
      mediaType, filename, totalBytes, chunkIndex, chunkCount
    } = req.body;
    const fileBuffer = req.file?.buffer;

    if (!localId || !fileBuffer) return res.status(400).json({ error: 'Missing data' });

    // UPSERT pending upload record
    let pending = await prisma.pendingUpload.findFirst({ where: { localId } });
    if (!pending) {
      pending = await prisma.pendingUpload.create({
        data: {
          userId: parseInt(userId), context, contextId, localId,
          mediaType, filename, totalBytes: parseInt(totalBytes), chunkCount: parseInt(chunkCount),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }
      });
    }

    // Append chunk to temp file
    const tempPath = path.join(uploadDir, `temp_${localId}`);
    fs.appendFileSync(tempPath, fileBuffer);

    // Update progress
    const updated = await prisma.pendingUpload.update({
      where: { id: pending.id },
      data: {
        uploadedBytes: pending.uploadedBytes + fileBuffer.length,
        chunksReceived: pending.chunksReceived + 1
      }
    });

    // If complete
    if (updated.chunksReceived === updated.chunkCount) {
      const finalExt = path.extname(filename) || '.bin';
      const finalName = `${localId}${finalExt}`;
      const finalPath = path.join(uploadDir, finalName);
      fs.renameSync(tempPath, finalPath);

      // In production, you would upload to Cloudinary or S3 here.
      // For local development, we return the local URL.
      const mediaUrl = `/uploads/chat/${finalName}`;

      await prisma.pendingUpload.update({
        where: { id: pending.id },
        data: { status: 'complete', storagePath: mediaUrl }
      });

      return res.json({ success: true, complete: true, mediaUrl });
    }

    res.json({ success: true, complete: false, progress: updated.chunksReceived / updated.chunkCount });

  } catch (error) {
    logger.error('Upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
