// services/susu/adminWarRoom.service.js
// =============================================================================
// AdminWarRoom_Service — Reqs 10.12, 11.9
//
// Owns:
//   - Alert insertion (ESCROW_DIVERSION, ADMIN_DEFAULT, MASS_DEFAULT_THRESHOLD,
//     VOUCH_SLASH_TX_FAILURE)
//   - Alert feed read (acknowledged filter, pagination cursor)
//   - Acknowledge mutation
//   - FCM fan-out to every ADMIN-role user (excluding the treasury sentinel)
// =============================================================================

const logger = require('../../src/config/logger');
const AdminWarRoomRepo = require('../../repositories/adminWarRoomRepo');

class AdminWarRoomService {
  constructor(prisma, { notificationService } = {}) {
    this.prisma = prisma;
    this.repo = new AdminWarRoomRepo(prisma);
    this.notificationService = notificationService;
  }

  /**
   * Persist the alert + fan a critical SUSU notification to every
   * ADMIN-role user (except the treasury sentinel). The notification
   * fanout is fire-and-forget so the caller's transaction commits
   * before any FCM call leaves the box.
   */
  async fireAlert({ alertType, susuGroupId, cycleId, payload }, tx = this.prisma) {
    const row = await this.repo.fire({ alertType, susuGroupId, cycleId, payload }, tx);

    // Fan to admins on next tick so the cycle/seizure transaction commits first.
    if (this.notificationService) {
      setImmediate(() => this._fanToAdmins(alertType, payload, row.id).catch(err => {
        logger.warn('[AdminWarRoom] fan-out failed:', err.message);
      }));
    }
    return row;
  }

  async _fanToAdmins(alertType, payload, alertId) {
    const admins = await this.prisma.user.findMany({
      where: {
        role: 'ADMIN',
        username: { not: 'azaman-treasury' },
      },
      select: { id: true },
    });
    const title = `[War Room] ${alertType.replaceAll('_', ' ')}`;
    const body = (payload && payload.summary) ||
      `Alert ${alertType} fired. Open the War Room to investigate.`;
    for (const a of admins) {
      try {
        await this.notificationService.sendNotification({
          userId: a.id,
          title,
          body,
          category: 'ADMIN_SYSTEM',
          actionPayload: { action: 'OPEN_WAR_ROOM', alertId, alertType },
        });
      } catch (err) {
        logger.warn(`[AdminWarRoom] notify admin ${a.id} failed:`, err.message);
      }
    }
  }

  async getAlerts({ acknowledged, take, cursor } = {}) {
    return this.repo.list({ acknowledged, take, cursor });
  }

  async acknowledge(adminUserId, alertId) {
    return this.repo.acknowledge(alertId, adminUserId);
  }
}

module.exports = AdminWarRoomService;
