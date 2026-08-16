const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/showcaseController');
const { kybGate } = require('../middleware/kybGateMiddleware');

router.post('/',                      protect, kybGate, ctrl.add);
router.get('/:businessProfileId',     ctrl.list); // public
router.patch('/:id',                  protect, kybGate, ctrl.update);
router.delete('/:id',                 protect, kybGate, ctrl.delete);
router.post('/reorder',               protect, kybGate, ctrl.reorder);

// Storefront version history
router.post('/:businessProfileId/publish',     protect, kybGate, ctrl.publishVersion);
router.get('/:businessProfileId/versions',      protect, kybGate, ctrl.listVersions);
router.post('/:businessProfileId/revert/:versionId', protect, kybGate, ctrl.revertToVersion);

module.exports = router;
