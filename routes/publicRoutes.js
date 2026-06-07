// routes/publicRoutes.js
// =============================================================================
// AZAMAN — PUBLIC (unauthenticated) endpoints
//
// Surface for the marketing website. No auth, conservative rate limit, and a
// short server-side cache so a burst of homepage loads can't turn into a burst
// of COUNT/SUM queries against the primary DB.
//
//   GET /api/public/stats   — headline platform numbers for the website
//                             StatsSection (W-01).
// =============================================================================

const express = require('express');
const router = express.Router();

// In-process cache. The numbers are vanity counters — a few minutes of
// staleness is fine, and it means N homepage visitors in a 5-minute window
// cost one set of aggregate queries, not N. (Resets per process; good enough
// until there's a Redis layer to share it across instances.)
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, payload: null };

async function computeStats(prisma) {
    const [totalUsers, totalTrades, volumeAgg, activeSusuGroups, activeVendors] =
        await Promise.all([
            prisma.user.count({ where: { isDeleted: false } }),
            prisma.trade.count({ where: { status: 'COMPLETED' } }),
            prisma.trade.aggregate({
                where: { status: 'COMPLETED' },
                _sum: { amountCrypto: true },
            }),
            prisma.susuGroup.count({ where: { status: 'ACTIVE' } }),
            prisma.user.count({ where: { role: 'VENDOR', isDeleted: false } }),
        ]);

    // amountCrypto is a Prisma Decimal (or null when there are no completed
    // trades). The global Decimal->Number JSON patch in server.js makes it
    // serialize cleanly, but round here so the wire value is a tidy 2dp number.
    const rawVolume = volumeAgg._sum.amountCrypto;
    const totalVolumeUsdc = rawVolume ? Math.round(Number(rawVolume) * 100) / 100 : 0;

    return {
        totalUsers,
        totalTrades,
        totalVolumeUsdc,
        activeSusuGroups,
        activeVendors,
    };
}

// GET /api/public/stats
router.get('/stats', async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const now = Date.now();

        if (!cache.payload || now - cache.at > CACHE_TTL_MS) {
            cache = { at: now, payload: await computeStats(prisma) };
        }

        // Let CDNs / browsers cache too, matching the server TTL.
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).json({ success: true, stats: cache.payload });
    } catch (err) {
        console.error('[public/stats] error:', err.message);
        return res.status(500).json({ success: false, message: 'Could not load stats.' });
    }
});

module.exports = router;
