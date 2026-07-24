const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');
const AdminChatController = require('../controllers/adminChatController');

let controller;

router.use((req, res, next) => {
    if (!controller) {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        controller = new AdminChatController(prisma, io);
    }
    req.adminChatController = controller;
    next();
});

router.post('/intervene/:tradeId', protect, adminOnly, (req, res) => {
    req.adminChatController.intervene(req, res);
});

module.exports = router;
