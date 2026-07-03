const { followBusiness, unfollowBusiness, isFollowing, getFollowers, getFollowing } = require('../services/businessFollowerService');

exports.follow = async (req, res) => {
    try {
        const result = await followBusiness(req.prisma, {
            customerId: req.user.id,
            businessProfileId: req.body.businessProfileId
        });
        res.status(201).json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.unfollow = async (req, res) => {
    try {
        const result = await unfollowBusiness(req.prisma, {
            customerId: req.user.id,
            businessProfileId: req.params.businessProfileId
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.checkFollowing = async (req, res) => {
    try {
        const following = await isFollowing(req.prisma, {
            customerId: req.user.id,
            businessProfileId: req.params.businessProfileId
        });
        res.json({ success: true, isFollowing: following });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.myFollowing = async (req, res) => {
    try {
        const result = await getFollowing(req.prisma, {
            customerId: req.user.id,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.myFollowers = async (req, res) => {
    try {
        const business = await req.prisma.businessProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!business) return res.status(404).json({ success: false, message: 'Business profile not found.' });
        const result = await getFollowers(req.prisma, {
            businessProfileId: business.id,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
