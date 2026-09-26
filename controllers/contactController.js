const logger = require('../src/config/logger');
const crypto = require('crypto');
 
// POST /api/contacts/sync
// Body: { hashedPhones: string[] } -- client computes SHA-256 BEFORE sending;
// the server never sees a raw phone number it didn't already have.
exports.syncContacts = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { hashedPhones } = req.body;
        if (!Array.isArray(hashedPhones) || hashedPhones.length === 0) {
            return res.status(400).json({ success: false, message: 'hashedPhones array required' });
        }
        const matches = await prisma.user.findMany({
            where: { phoneHash: { in: hashedPhones }, id: { not: req.user.id } },
            select: { id: true, azamanId: true, username: true, profilePictureUrl: true },
        });
        res.json({ success: true, matches });
    } catch (err) {
        logger.error({ err: err }, '[syncContacts]');
        res.status(500).json({ success: false, message: 'Sync failed' });
    }
};
 
// GET /api/contacts/recent -- union of most-recently-active friendships +
// group memberships, capped at 12, feeds the "Recent" rail.
exports.getRecent = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const friendships = await prisma.friendship.findMany({
            where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
            orderBy: { updatedAt: 'desc' },
            take: 12,
            include: {
                requester: { select: { id: true, username: true, profilePictureUrl: true } },
                addressee: { select: { id: true, username: true, profilePictureUrl: true } },
            },
        });
        const recent = friendships.map(f => {
            const other = f.requesterId === userId ? f.addressee : f.requester;
            return { friendshipId: f.id, userId: other.id, username: other.username, profilePictureUrl: other.profilePictureUrl, updatedAt: f.updatedAt };
        });
        res.json({ success: true, recent });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load recent contacts' });
    }
};
 
// GET /api/contacts/invite -- deep link for share_plus on the client.
exports.getInviteLink = async (req, res) => {
    try {
        const link = `https://azaman.app/invite/${req.user.azamanId}`;
        res.json({ success: true, link });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to build invite link' });
    }
};
