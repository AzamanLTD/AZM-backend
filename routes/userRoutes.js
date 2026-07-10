// routes/userRoutes.js
// =============================================================================
// AZAMAN V4 — USER ROUTES
// Mounted at /api/users. Includes profile, preferences, onboarding, balance.
// =============================================================================

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const userPreferencesController = require('../controllers/userPreferencesController');
const profileController = require('../controllers/profileController');
const identityController = require('../controllers/identityController');
const milestoneController = require('../controllers/milestoneController');
const securityLogController = require('../controllers/securityLogController');
const businessInvoiceController = require('../controllers/businessInvoiceController');
const authMiddleware = require('../middleware/authMiddleware.js');
const avatarUpload = require('../middleware/avatarUploadMiddleware.js');
const { strictLimiter } = require('../middleware/rateLimitMiddleware');

const protect = authMiddleware.protect;

// ─── PHASE 6: IDENTITY + CONTACT DISCOVERY ───────────────────────────────────
// Find a user by Azaman ID; discover contacts (hash-matched, rate-limited);
// toggle discoverability. All require auth; discovery is strictly limited
// because it accepts a batch of phone-number hashes.
router.get('/lookup/:azamanId', protect, identityController.lookup);
router.post('/discover', protect, strictLimiter, identityController.discover);
router.put('/discoverable', protect, identityController.setDiscoverable);

// ─── PROFILE ─────────────────────────────────────────────────────────────────
router.get('/profile', protect, profileController.getProfile);
router.put('/profile', protect, profileController.updateProfile);
// Phase K — dedicated avatar upload endpoint. Stores under /uploads/avatars/
// (was de-facto /uploads/proofs/ via the trade-proof multer config — KYC
// docs and avatars must not share storage).
router.post(
    '/profile/avatar',
    protect,
    (req, res, next) => {
        // Catch multer errors (file too large, wrong type) and return JSON
        avatarUpload.single('avatar')(req, res, (err) => {
            if (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message || 'File upload error.',
                });
            }
            next();
        });
    },
    profileController.uploadAvatar
);

// ─── BALANCE (REST fallback for socket) ──────────────────────────────────────
router.get('/balance', protect, profileController.getBalance);

// ─── DASHBOARD (Home screen data — single call) ─────────────────────────────
router.get('/dashboard', protect, profileController.getDashboard);

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
router.get('/onboarding', protect, profileController.getOnboarding);
router.put('/onboarding', protect, profileController.updateOnboarding);
router.post('/onboarding/complete', protect, profileController.completeOnboarding);

// ─── USER PREFERENCES (cross-device sync) ────────────────────────────────────
router.get('/preferences', protect, userPreferencesController.getPreferences);
router.put('/preferences/theme', protect, userPreferencesController.updateTheme);
router.put('/preferences/shortcuts', protect, userPreferencesController.updateShortcuts);
router.put('/preferences', protect, userPreferencesController.updateAll);
// B-10: preferred display currency (USD, GHS, NGN, KES, etc.)
router.put('/preferences/currency', protect, userPreferencesController.updatePreferredCurrency);

// ─── MILESTONES & SECURITY LOGS ──────────────────────────────────────────────
router.get('/me/milestones', protect, milestoneController.getMilestones);
router.get('/me/security-logs', protect, securityLogController.getSecurityLogs);

// ─── INCOMING INVOICES (Discovery Sprint 2026-06-20) ─────────────────────────
// Customer-facing list of bills sent to this user by businesses.
// Reachable at GET /api/users/invoices.
router.get('/invoices', protect, businessInvoiceController.listMyInvoices);

// ─── C-9: User online status for chat top nav ────────────────────────────────
router.get('/:id/status', protect, userController.getUserStatus);

// ─── ACCOUNT MANAGEMENT ──────────────────────────────────────────────────────
router.post('/delete', protect, userController.deleteAccount);

module.exports = router;
