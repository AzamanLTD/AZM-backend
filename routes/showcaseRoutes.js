const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/showcaseController');

router.post('/',                      protect, ctrl.add);
router.get('/:businessProfileId',     ctrl.list); // public
router.patch('/:id',                  protect, ctrl.update);
router.delete('/:id',                 protect, ctrl.delete);
router.post('/reorder',               protect, ctrl.reorder);

module.exports = router;
