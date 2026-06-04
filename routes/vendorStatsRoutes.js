// routes/vendorStatsRoutes.js
// =============================================================================
// AZAMAN V3 — VENDOR STATS & GAMIFICATION ROUTES
// Mounted at /api/vendor in server.js
//
// All routes require authentication (protect middleware).
// The vendor check is soft — users can see their stats even if they haven't
// formally become vendors yet (they just won't have much data).
// =============================================================================

const express = require('express');
const router = express.Router();
const vendorStatsController = require('../controllers/vendorStatsController');
const vendorApplicationController = require('../controllers/vendorApplicationController');
const { protect } = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/adminMiddleware');
const multer = require('multer');
const { uploadToCloudinary } = require('../services/cloudinaryService');

// ── VENDOR DOCUMENT UPLOAD ───────────────────────────────────────────────────
// POST /api/vendor/upload-docs (multipart: idFront, idBack, selfie, addressProof)
const vendorDocUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const fs = require('fs');
            const dir = 'uploads/vendor/';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const path = require('path');
            cb(null, `vendor-${req.user?.id || 'anon'}-${uniqueSuffix}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    // No fileFilter — image_picker on the client already constrains to images,
    // and Cloudinary validates on upload. Removing the filter fixes Android
    // devices that report incorrect MIME types for camera captures.
});

router.post('/upload-docs', protect, vendorDocUpload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
    { name: 'addressProof', maxCount: 1 },
]), async (req, res) => {
    try {
        const urls = {};
        const fields = ['idFront', 'idBack', 'selfie', 'addressProof'];

        for (const field of fields) {
            if (req.files && req.files[field] && req.files[field][0]) {
                const { url } = await uploadToCloudinary(req.files[field][0], 'vendor-docs');
                urls[field] = url;
            }
        }

        return res.status(200).json({ success: true, urls });
    } catch (error) {
        console.error('[vendor.uploadDocs] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ── VENDOR APPLICATION ENDPOINTS ─────────────────────────────────────────────

// Submit vendor application (non-vendors only)
// POST /api/vendor/apply
router.post('/apply', protect, vendorApplicationController.submitApplication);

// Get current application status
// GET /api/vendor/application-status
router.get('/application-status', protect, vendorApplicationController.getApplicationStatus);

// Admin: List all applications (filterable by status)
// GET /api/vendor/applications?status=PENDING&page=1&limit=20
router.get('/applications', protect, isAdmin, vendorApplicationController.listApplications);

// Admin: Approve or reject an application
// POST /api/vendor/applications/:id/review
router.post('/applications/:id/review', protect, isAdmin, vendorApplicationController.reviewApplication);

// ── VENDOR STATS & GAMIFICATION ──────────────────────────────────────────────

// 1. Get full gamified vendor profile
//    GET /api/vendor/stats
router.get('/stats', protect, vendorStatsController.getVendorStats);

// 1b. Get quick vendor stats (lightweight — for floating pull-tab)
//     GET /api/vendor/stats/quick
router.get('/stats/quick', protect, vendorStatsController.getVendorStatsQuick);

// 2. Get all achievements (earned + locked with progress hints)
//    GET /api/vendor/achievements
router.get('/achievements', protect, vendorStatsController.getAchievements);

// 3. Get vendor leaderboard
//    GET /api/vendor/leaderboard?metric=xp|volume|trades|profit|streak&limit=20
router.get('/leaderboard', protect, vendorStatsController.getLeaderboard);

// 4. Internal: Award XP for review (called after review submission)
//    POST /api/vendor/xp/review
//    Body: { vendorId, isPositive }
router.post('/xp/review', protect, vendorStatsController.awardXpForReview);

// 5. Get vendor analytics dashboard (Phase Q16)
//    GET /api/vendor/analytics?period=7d|30d|90d
const vendorAnalyticsController = require('../controllers/vendorAnalyticsController');
router.get('/analytics', protect, vendorAnalyticsController.getVendorAnalytics);

// 6. Get vendor verification badges (Phase Q13)
//    GET /api/vendor/badges/:vendorId
//    Public — anyone can see a vendor's trust badges (marketplace ad cards)
router.get('/badges/:vendorId', async (req, res) => {
    const prisma = req.app.get('prisma');
    const { computeVendorBadges } = require('../services/vendorBadgeService');

    try {
        const vendorId = parseInt(req.params.vendorId, 10);
        if (isNaN(vendorId)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor ID' });
        }

        const badges = await computeVendorBadges(prisma, vendorId);

        return res.status(200).json({
            success: true,
            data: { vendorId, badges, count: badges.length },
        });
    } catch (error) {
        console.error('[vendor.badges] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch badges' });
    }
});

// 6. Get all badge definitions (Phase Q13)
//    GET /api/vendor/badges
//    Public — FE uses this to show all possible badges
router.get('/badges', (req, res) => {
    const { getAllBadgeDefinitions } = require('../services/vendorBadgeService');
    return res.status(200).json({
        success: true,
        data: { badges: getAllBadgeDefinitions() },
    });
});

module.exports = router;
