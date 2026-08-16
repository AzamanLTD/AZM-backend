const logger = require('../src/config/logger');
const { uploadToCloudinary } = require('../services/cloudinaryService');

exports.createStory = async (req, res) => {
    const storyService = req.app.get('storyService');
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        const mediaType = req.file.mimetype.startsWith('video') ? 'VIDEO' : 'IMAGE';
        
        // Use cloudinaryService directly instead of app.get('_uploadChatMediaUrl')
        const uploadResult = await uploadToCloudinary(req.file, 'stories');
        const mediaUrl = uploadResult.url;

        const story = await storyService.create({
            authorId: req.user.id, mediaUrl, mediaType,
            caption: req.body.caption, linkedBizId: req.body.linkedBizId,
            durationSeconds: parseInt(req.body.durationSeconds, 10) || undefined,
        });
        res.status(201).json({ success: true, story });
    } catch (err) {
        logger.error({ err: err }, '[createStory]');
        res.status(500).json({ success: false, message: err.message });
    }
};
 
exports.getFeed = async (req, res) => {
    const storyService = req.app.get('storyService');
    try {
        const groups = await storyService.getFeed(req.user.id);
        res.json({ success: true, groups });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
 
exports.markViewed = async (req, res) => {
    const storyService = req.app.get('storyService');
    try {
        await storyService.markViewed(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
 
exports.boostStory = async (req, res) => {
    const storyService = req.app.get('storyService');
    try {
        const amount = parseInt(req.body.amount, 10);
        const story = await storyService.boost(req.params.id, req.user.id, amount);
        res.json({ success: true, story });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};
 
exports.deleteStory = async (req, res) => {
    const storyService = req.app.get('storyService');
    try {
        await storyService.remove(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};
