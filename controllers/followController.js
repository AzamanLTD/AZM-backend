const logger = require('../src/config/logger');
const { followBusiness, unfollowBusiness, isFollowing, getFollowers, getFollowing } = require('../services/businessFollowerService');
const FollowService = require('../services/marketplace/followService');

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
        // FIX (2026-07-06): the Flutter business profile screen reads both
        // `isFollowing` and `followerCount` from this response to render the
        // initial follow-button state, but followerCount was never returned
        // -- it silently defaulted to 0 on every page load until the user
        // toggled follow/unfollow themselves (which updates it optimistically
        // client-side only).
        const svc = new FollowService(req.prisma);
        const followerCount = await svc.getFollowerCount(req.params.businessProfileId);
        res.json({ success: true, isFollowing: following, followerCount });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.myFollowing = async (req, res) => {
    try {
        const result = await getFollowing(req.prisma, {
            customerId: req.user.id,
            limit: req.query.limit,
            offset: req.query.offset
        });
        // FIX (2026-07-06): getFollowing resolves to a bare array. Spreading
        // an array into a JSON object (`{ success: true, ...result }`)
        // produces numeric-string-keyed junk ({"0": {...}, "1": {...}}),
        // NOT a JSON array -- any real client reading `.following` (or
        // expecting an array at all) got nothing. Wrap it properly.
        res.json({ success: true, following: result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.myFollowers = async (req, res) => {
    try {
        const business = await req.prisma.businessProfile.findFirst({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!business) return res.status(404).json({ success: false, message: 'Business profile not found.' });
        const result = await getFollowers(req.prisma, {
            businessProfileId: business.id,
            limit: req.query.limit,
            offset: req.query.offset
        });
        // Same array-spread bug as myFollowing above -- fixed the same way.
        res.json({ success: true, followers: result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
