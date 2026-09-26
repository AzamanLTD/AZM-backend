const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/followController');

router.post('/',                    protect, ctrl.follow);
router.delete('/:businessProfileId', protect, ctrl.unfollow);
router.get('/check/:businessProfileId', protect, ctrl.checkFollowing);
router.get('/following',            protect, ctrl.myFollowing);
router.get('/followers',            protect, ctrl.myFollowers);

module.exports = router;
