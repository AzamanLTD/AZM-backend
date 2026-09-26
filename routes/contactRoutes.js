const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const contactController = require('../controllers/contactController');
 
router.post('/sync',   protect, contactController.syncContacts);
router.get('/recent',  protect, contactController.getRecent);
router.get('/invite',  protect, contactController.getInviteLink);
 
module.exports = router;
