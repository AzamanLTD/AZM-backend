// routes/susuRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/susuController');
const overlay = require('../controllers/susu/susuOverlayController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

// ── Legacy GroupChat-bound flow (kept as-is) ──────────────────────────────
router.post('/groups',                    protectActive, ctrl.createSusu);
router.get('/groups/:id',                 protect,       ctrl.getDetail);
router.post('/groups/:id/contract',       protectActive, ctrl.acceptContract);
router.post('/groups/:id/cancel',         protectActive, ctrl.cancel);
router.get('/groups/:id/my-position',     protect,       ctrl.myPosition);

router.post('/vouches',                   protectActive, ctrl.submitVouch);
router.get('/vouches/pending',            protect,       ctrl.pendingVouches);

// ── Private Susu Ecosystem overlay (2026-05-31) ───────────────────────────
//
// All paths under /api/susu/... per Phase 2 / design.md API Contracts.
// Standalone create (no pre-existing GroupChat needed)
router.post('/',                                      protectActive, overlay.createSusu);
router.get('/me',                                     protect,       overlay.listMine);
router.get('/:id',                                    protect,       overlay.getSusuDetail);
router.get('/:id/members',                            protect,       overlay.listMembers);
router.get('/:id/cycles',                             protect,       overlay.listCycles);
router.post('/:id/cancel',                            protectActive, overlay.cancelSusu);
router.post('/:id/auto-retain',                       protectActive, overlay.setAutoRetain);

// Invites
router.post('/:id/invites',                           protectActive, overlay.createInvite);
router.get('/invites/preview/:token',                 overlay.previewInvite); // public, rate-limited at app level
router.post('/invites/:token/redeem',                 protectActive, overlay.redeemInvite);
router.post('/invites/:id/accept',                    protectActive, overlay.acceptInvite);
router.post('/invites/:id/decline',                   protectActive, overlay.declineInvite);
router.post('/invites/:id/revoke',                    protectActive, overlay.revokeInvite);

// Per-Susu pinned contract + acceptance (overlay)
router.get('/:id/contract',                           protectActive, overlay.getContractForSusu);
router.post('/:id/contract/accept',                   protectActive, overlay.acceptContract);

module.exports = router;
