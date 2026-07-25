// controllers/changelogController.js
// =============================================================================
// AZM — In-app "What's New" / Changelog
//
// GET  /api/changelog               — list published entries (user-facing)
// GET  /api/changelog/unread-count  — count of unseen entries for badge
// POST /api/changelog/:id/dismiss   — mark an entry as seen
// POST /api/changelog/dismiss-all   — mark all as seen
//
// Admin endpoints:
// GET    /api/admin/changelog        — list all entries
// POST   /api/admin/changelog        — create entry
// PUT    /api/admin/changelog/:id    — update entry
// DELETE /api/admin/changelog/:id    — delete entry
// =============================================================================

const logger = require('../src/config/logger');

// ── User-facing endpoints ──────────────────────────────────────────────────

exports.listChangelog = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = Math.min(parseInt(req.query.offset) || 0, 1000);

    try {
        const entries = await prisma.changelog.findMany({
            where: { publishedAt: { lte: new Date() } },
            orderBy: { publishedAt: 'desc' },
            take: limit,
            skip: offset,
            include: {
                views: { where: { userId }, select: { id: true } },
            },
        });

        const result = entries.map(e => ({
            id: e.id,
            version: e.version,
            title: e.title,
            body: e.body,
            category: e.category,
            severity: e.severity,
            imageUrl: e.imageUrl,
            publishedAt: e.publishedAt,
            seen: e.views.length > 0,
        }));

        return res.json({ success: true, data: result });
    } catch (e) {
        logger.error({ err: e, userId }, '[changelog] list error');
        return res.status(500).json({ success: false, message: 'Could not fetch changelog.' });
    }
};

exports.unreadCount = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const total = await prisma.changelog.count({
            where: { publishedAt: { lte: new Date() } },
        });
        const seen = await prisma.changelogView.count({
            where: { userId },
        });
        const unread = Math.max(0, total - seen);

        return res.json({ success: true, data: { unread } });
    } catch (e) {
        logger.error({ err: e, userId }, '[changelog] unread-count error');
        return res.status(500).json({ success: false, message: 'Could not fetch unread count.' });
    }
};

exports.dismissEntry = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const entryId = parseInt(req.params.id);

    if (!entryId) return res.status(400).json({ success: false, message: 'Invalid entry ID.' });

    try {
        await prisma.changelogView.upsert({
            where: { changelogId_userId: { changelogId: entryId, userId } },
            create: { changelogId: entryId, userId },
            update: {},
        });

        return res.json({ success: true, message: 'Entry dismissed.' });
    } catch (e) {
        if (e.code === 'P2003') {
            return res.status(404).json({ success: false, message: 'Changelog entry not found.' });
        }
        logger.error({ err: e, userId, entryId }, '[changelog] dismiss error');
        return res.status(500).json({ success: false, message: 'Could not dismiss entry.' });
    }
};

exports.dismissAll = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const entries = await prisma.changelog.findMany({
            where: { publishedAt: { lte: new Date() } },
            select: { id: true },
        });

        if (entries.length === 0) {
            return res.json({ success: true, message: 'No entries to dismiss.' });
        }

        await prisma.changelogView.createMany({
            data: entries.map(e => ({ changelogId: e.id, userId })),
            skipDuplicates: true,
        });

        return res.json({ success: true, message: `${entries.length} entries dismissed.` });
    } catch (e) {
        logger.error({ err: e, userId }, '[changelog] dismiss-all error');
        return res.status(500).json({ success: false, message: 'Could not dismiss all entries.' });
    }
};

// ── Admin endpoints ────────────────────────────────────────────────────────

exports.adminList = async (req, res) => {
    const prisma = req.app.get('prisma');
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    try {
        const [entries, total] = await Promise.all([
            prisma.changelog.findMany({
                orderBy: { publishedAt: 'desc' },
                take: limit,
                skip: offset,
                include: { _count: { select: { views: true } } },
            }),
            prisma.changelog.count(),
        ]);

        return res.json({
            success: true,
            data: entries,
            pagination: { total, limit, offset, hasMore: offset + entries.length < total },
        });
    } catch (e) {
        logger.error({ err: e }, '[changelog] admin list error');
        return res.status(500).json({ success: false, message: 'Could not fetch entries.' });
    }
};

exports.adminCreate = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { version, title, body, category, severity, imageUrl, publishedAt } = req.body;

    if (!version || !title || !body) {
        return res.status(400).json({ success: false, message: 'version, title, and body are required.' });
    }

    const validCategories = ['feature', 'improvement', 'fix', 'security'];
    const validSeverities = ['info', 'warning', 'critical'];

    if (category && !validCategories.includes(category)) {
        return res.status(400).json({ success: false, message: `category must be one of: ${validCategories.join(', ')}` });
    }
    if (severity && !validSeverities.includes(severity)) {
        return res.status(400).json({ success: false, message: `severity must be one of: ${validSeverities.join(', ')}` });
    }

    try {
        const entry = await prisma.changelog.create({
            data: {
                version,
                title,
                body,
                category: category || 'feature',
                severity: severity || 'info',
                imageUrl: imageUrl || null,
                publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
            },
        });

        logger.info({ entryId: entry.id, version }, '[changelog] entry created');
        return res.status(201).json({ success: true, data: entry });
    } catch (e) {
        logger.error({ err: e }, '[changelog] admin create error');
        return res.status(500).json({ success: false, message: 'Could not create entry.' });
    }
};

exports.adminUpdate = async (req, res) => {
    const prisma = req.app.get('prisma');
    const entryId = parseInt(req.params.id);
    const { version, title, body, category, severity, imageUrl, publishedAt } = req.body;

    if (!entryId) return res.status(400).json({ success: false, message: 'Invalid entry ID.' });

    const updateData = {};
    if (version !== undefined) updateData.version = version;
    if (title !== undefined) updateData.title = title;
    if (body !== undefined) updateData.body = body;
    if (category !== undefined) updateData.category = category;
    if (severity !== undefined) updateData.severity = severity;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (publishedAt !== undefined) updateData.publishedAt = new Date(publishedAt);

    try {
        const entry = await prisma.changelog.update({
            where: { id: entryId },
            data: updateData,
        });

        logger.info({ entryId }, '[changelog] entry updated');
        return res.json({ success: true, data: entry });
    } catch (e) {
        if (e.code === 'P2025') {
            return res.status(404).json({ success: false, message: 'Entry not found.' });
        }
        logger.error({ err: e, entryId }, '[changelog] admin update error');
        return res.status(500).json({ success: false, message: 'Could not update entry.' });
    }
};

exports.adminDelete = async (req, res) => {
    const prisma = req.app.get('prisma');
    const entryId = parseInt(req.params.id);

    if (!entryId) return res.status(400).json({ success: false, message: 'Invalid entry ID.' });

    try {
        await prisma.changelog.delete({ where: { id: entryId } });
        logger.info({ entryId }, '[changelog] entry deleted');
        return res.json({ success: true, message: 'Entry deleted.' });
    } catch (e) {
        if (e.code === 'P2025') {
            return res.status(404).json({ success: false, message: 'Entry not found.' });
        }
        logger.error({ err: e, entryId }, '[changelog] admin delete error');
        return res.status(500).json({ success: false, message: 'Could not delete entry.' });
    }
};
