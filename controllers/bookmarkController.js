// controllers/bookmarkController.js
// =============================================================================
// Business bookmark ("saved business") controller — marketplace
// personalisation, Backend A. Owner-scoped by construction: the customer id
// always comes from req.user (protect middleware), never from the request
// body/query, so cross-user reads or changes are structurally impossible.
// =============================================================================

const BookmarkService = require('../services/marketplace/bookmarkService');

// Routes for authenticated users; error responses follow the repo's
// { success: false, code, message } contract with service-supplied status.
exports.bookmark = async (req, res) => {
    try {
        const svc = new BookmarkService(req.prisma);
        const { alreadyBookmarked, bookmark } = await svc.bookmark(
            req.user.id,
            req.body.businessProfileId
        );
        res.status(alreadyBookmarked ? 200 : 201).json({
            success: true,
            state: 'BOOKMARKED',
            alreadyBookmarked,
            bookmark,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};

exports.unbookmark = async (req, res) => {
    try {
        const svc = new BookmarkService(req.prisma);
        const { removed } = await svc.unbookmark(
            req.user.id,
            req.params.businessProfileId
        );
        res.json({
            success: true,
            state: 'NOT_BOOKMARKED',
            removed,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};

exports.checkBookmarked = async (req, res) => {
    try {
        const svc = new BookmarkService(req.prisma);
        const bookmarked = await svc.isBookmarked(
            req.user.id,
            req.params.businessProfileId
        );
        res.json({ success: true, bookmarked });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};

exports.myBookmarks = async (req, res) => {
    try {
        const svc = new BookmarkService(req.prisma);
        const { total, bookmarks } = await svc.getBookmarks(req.user.id, {
            limit: req.query.limit,
            offset: req.query.offset,
        });
        res.json({ success: true, total, bookmarks });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};
