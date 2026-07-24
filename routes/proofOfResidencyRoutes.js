// routes/proofOfResidencyRoutes.js
// =============================================================================
// User-facing PoR submission + own-status; admin review queue + decision.
// Mounted from server.js as:
//   app.use('/api/users/proof-of-residency', userPoRRouter);
//   app.use('/api/admin/proof-of-residency', adminPoRRouter);
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/susu/proofOfResidencyController');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 + 1 }, // service rejects > 10MB; +1 to let our own check fire
});

const userRouter = express.Router();
userRouter.post('/', protectActive, upload.single('file'), ctrl.uploadOwnPoR);
userRouter.get('/me', protect, ctrl.getOwnStatus);

const adminRouter = express.Router();
adminRouter.get('/queue', protect, adminOnly, ctrl.getReviewQueue);
adminRouter.post('/:userId/review', protect, adminOnly, ctrl.reviewSubmission);

module.exports = { userRouter, adminRouter };
