// routes/smartRouteRoutes.js
const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/smartRouteController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requireFreshFxRate } = require('../middleware/fxTransactionGateMiddleware');

router.post('/',           protectActive, ctrl.create);
router.get('/',            protect,       ctrl.list);
router.get('/:id',         protect,       ctrl.getDetail);
router.patch('/:id',       protectActive, ctrl.update);
router.post('/:id/pause',  protectActive, ctrl.pause);
router.post('/:id/resume', protectActive, ctrl.resume);
router.delete('/:id',      protectActive, ctrl.cancel);
router.post('/:id/run-now', protectActive, requireFreshFxRate(), ctrl.runNow);

module.exports = router;
