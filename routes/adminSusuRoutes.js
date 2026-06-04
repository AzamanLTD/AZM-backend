// routes/adminSusuRoutes.js
// =============================================================================
// /api/admin/susu — Admin Portal Susu monitoring + operator actions
// (Phase 5 / Workstream E). All routes adminOnly.
//
//   GET  /api/admin/susu                  → list all Susus (paginated)
//   GET  /api/admin/susu/members/:userId  → member detail (idNumber decrypted)
//                                            + strike/default history
//   GET  /api/admin/susu/:id              → single Susu drill-down
//   POST /api/admin/susu/:id/resolve      → RESUME | REFUND_AND_CLOSE a
//                                            FROZEN_DISPUTE Susu
// =============================================================================

const express = require('express');
const ctrl = require('../controllers/susu/adminSusuMonitorController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.use(adminOnly);

router.get('/', ctrl.listSusus);
// Static segment before the :id catch-all so it isn't shadowed.
router.get('/members/:userId', ctrl.getMemberDetail);
router.get('/:id', ctrl.getSusuDetail);
router.post('/:id/resolve', ctrl.resolveSusu);

module.exports = router;
