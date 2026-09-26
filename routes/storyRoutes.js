const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middleware/authMiddleware');
const storyController = require('../controllers/storyController');
 
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
 
router.post('/',              protect, upload.single('file'), storyController.createStory);
router.get('/feed',           protect, storyController.getFeed);
router.post('/:id/view',      protect, storyController.markViewed);
router.post('/:id/boost',     protect, storyController.boostStory);
router.delete('/:id',         protect, storyController.deleteStory);
 
module.exports = router;
