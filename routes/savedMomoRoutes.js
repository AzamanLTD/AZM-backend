// routes/savedMomoRoutes.js
const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/savedMomoController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

router.post('/lookup',     protect,        ctrl.lookup);
router.post('/',           protectActive,  ctrl.create);
router.get('/',            protect,        ctrl.list);
router.patch('/:id',       protectActive,  ctrl.update);
router.delete('/:id',      protectActive,  ctrl.remove);

module.exports = router;
