// src/routes/health.js
// =============================================================================
// Extracted from server.js — the /health endpoint and the admin Susu release
// trigger. These were inline in server.js (~120 lines) and are now a clean,
// testable module. The health endpoint does a DB liveness probe (SELECT 1)
// plus optional escrow/business/susu stat queries, all independently guarded
// so a stats failure never flips /health to 503.
//
// Exposed: mountHealthRoutes(app, deps)
//   deps: { prisma, workerStatus, redisStatusRef, APP_VERSION, IS_PRODUCTION }
// ============================================================================

const logger = require('../config/logger');
const { protect, adminOnly } = require('../../middleware/authMiddleware');

/**
 * Mounts GET /health and POST /api/admin/susu/release onto the Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   prisma: import('@prisma/client').PrismaClient,
 *   workerStatus: Record<string, string>,
 *   redisStatusRef: () => string,
 *   APP_VERSION: string,
 *   IS_PRODUCTION: boolean
 * }} deps
 */
function mountHealthRoutes(app, { prisma, workerStatus, redisStatusRef, APP_VERSION, IS_PRODUCTION }) {
  // GET /health — DB liveness probe + optional system stats.
  app.get('/health', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;

      // Phase Q15: Include version gate info for client startup check.
      let versionGate = null;
      try {
        const settings = await prisma.globalSettings.findUnique({
          where: { id: 1 },
          select: { minAppVersion: true, forceUpdateUrl: true, updateMessage: true },
        });
        if (settings) {
          versionGate = {
            minVersion: settings.minAppVersion,
            updateUrl: settings.forceUpdateUrl,
            message: settings.updateMessage,
          };
        }
      } catch (_) { /* non-fatal */ }

      // WS7: Escrow + business system stats for the Admin Portal dashboard.
      // Each block is independently guarded — a stats query failure must NEVER
      // flip /health to 503 (the DB SELECT 1 above is the real liveness probe).
      let escrowSystem = null;
      try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const [activeEscrows, disputedEscrows, expiredToday] = await Promise.all([
          prisma.smartEscrow.count({ where: { status: { in: ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'] } } }),
          prisma.smartEscrow.count({ where: { status: { in: ['DISPUTED', 'ADMIN_REVIEW'] } } }),
          prisma.smartEscrow.count({ where: { status: 'EXPIRED', updatedAt: { gte: startOfToday } } }),
        ]);
        escrowSystem = { activeEscrows, disputedEscrows, expiredToday };
      } catch (_) { /* non-fatal */ }

      let businessSystem = null;
      try {
        const [totalBusinesses, verifiedBusinesses, pendingKyb, activeOrders] = await Promise.all([
          prisma.businessProfile.count(),
          prisma.businessProfile.count({ where: { kybStatus: 'VERIFIED' } }),
          prisma.businessProfile.count({ where: { kybStatus: 'PENDING' } }),
          prisma.businessOrder.count({ where: { status: { in: ['PAID', 'DELIVERED'] } } }),
        ]);
        businessSystem = { totalBusinesses, verifiedBusinesses, pendingKyb, activeOrders };
      } catch (_) { /* non-fatal */ }

      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: APP_VERSION,
        uptime: process.uptime(),
        database: 'connected',
        redis: redisStatusRef(),
        workers: workerStatus,
        escrowSystem,
        businessSystem,
        versionGate,
        susu: {
          treasuryCached: !!app.get('azamanTreasuryUserId'),
          release: (() => {
            try { return require('../../infra/autoRelease').releaseStatus; }
            catch (_) { return null; }
          })(),
        },
        sockets: (() => {
          try {
            const sio = app.get('socketio');
            return sio ? sio.sockets.sockets.size : 0;
          } catch (_) { return 0; }
        })(),
      });
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        version: APP_VERSION,
        database: 'disconnected',
        redis: redisStatusRef(),
        error: IS_PRODUCTION ? 'Service unavailable' : err.message,
      });
    }
  });

  // POST /api/admin/susu/release — manual one-time Susu release trigger.
  // Lets an authenticated admin run the idempotent migrate + seed on demand
  // without dashboard Shell access. Safe to call repeatedly.
  app.post('/api/admin/susu/release', protect, adminOnly, async (req, res) => {
    try {
      const { autoRelease } = require('../../infra/autoRelease');
      const status = await autoRelease(prisma, { force: true });
      // Re-resolve the treasury cache immediately so Susu comes online
      // without waiting for the 60s retry tick.
      try {
        const treasury = await prisma.user.findUnique({
          where: { username: 'azaman-treasury' },
          select: { id: true },
        });
        if (treasury) app.set('azamanTreasuryUserId', treasury.id);
      } catch (_) { /* non-fatal */ }
      res.status(200).json({
        success: true,
        data: { release: status, treasuryCached: !!app.get('azamanTreasuryUserId') },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

module.exports = { mountHealthRoutes };
