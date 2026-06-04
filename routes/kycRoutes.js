// routes/kycRoutes.js
// Phase Q6 — KYC Integration (Dojah) — 2026-05-25
//
// Route map:
//   GET  /api/kyc/status          — Current KYC status (auth-protected)
//   POST /api/kyc/initialize      — Create Dojah session (auth-protected)
//   POST /api/kyc/webhook/dojah   — Dojah webhook receiver (HMAC-only, NO auth)
//   POST /api/kyc/admin/override  — Admin manual approve/reject (admin-only)

const express = require('express');
const router = express.Router();
const kycController = require('../controllers/kycController');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

const protect = authMiddleware.protect;
const isAdmin = adminMiddleware.isAdmin;

// ── USER ENDPOINTS (auth-protected) ─────────────────────────────────────────

// Get current KYC status (enriched with re-initialization eligibility)
router.get('/status', protect, kycController.getKycStatus);

// Initialize a new Dojah KYC verification session
router.post('/initialize', protect, kycController.initializeKyc);

// ── WEBHOOK ENDPOINT (NO auth middleware — secured via HMAC signature) ───────

// Dojah sends verification results here after user completes the widget
router.post('/webhook/dojah', kycController.handleDojahWebhook);

// ── ADMIN ENDPOINTS ─────────────────────────────────────────────────────────

// Admin manual approve/reject override (works regardless of provider)
router.post('/admin/override', protect, isAdmin, kycController.adminKycOverride);

module.exports = router;
