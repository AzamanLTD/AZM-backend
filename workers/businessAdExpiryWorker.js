// workers/businessAdExpiryWorker.js
// =============================================================================
// AZAMAN — BUSINESS AD EXPIRY WORKER (Marketplace v2, 2026-07-03)
//
// Runs every 30 minutes. Marks ad posts as EXPIRED when their expiresAt
// has passed. The linked Stories are cleaned up by the existing
// StoryService.expireOldStories() cron.
//
// Registration in server.js:
//   const { sweepExpiredAds } = require('./workers/businessAdExpiryWorker');
//   cron.schedule('*/30 * * * *', () => sweepExpiredAds(prisma));
// =============================================================================

const sweepExpiredAds = async (prisma) => {
    try {
        const { expireOldAds } = require('../services/businessAdService');
        const result = await expireOldAds(prisma);
        if (result.expired > 0) {
            console.log(`[businessAdExpiryWorker] Expired ${result.expired} ad posts.`);
        }
        return result;
    } catch (err) {
        console.error('[businessAdExpiryWorker]', err.message);
        return { expired: 0, error: err.message };
    }
};

module.exports = { sweepExpiredAds };
