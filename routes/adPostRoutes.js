const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { kybGate } = require('../middleware/kybGateMiddleware');
const ctrl = require('../controllers/adPostController');

// Create ad post — requires KYB verification
router.post('/',                      protect, kybGate, ctrl.create);
router.delete('/:id',                 protect, ctrl.remove);
router.get('/active/:businessProfileId', ctrl.active); // public
router.get('/feed',                   protect, ctrl.feed);

module.exports = router;
