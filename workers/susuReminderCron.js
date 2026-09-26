// workers/susuReminderCron.js
// =============================================================================
// Reminder_Cron — Reqs 13.4, 13.5
//
// Every 5 minutes, finds SusuCycle rows with collectionDate ≈ now+24h ±5min
// and ACTIVE members whose availableBalance is below the Susu's
// contributionUsdc. Fires a SUSU notification with action
// OPEN_DEPOSIT_FOR_SUSU and the shortfall pre-fill. Idempotent on
// (susuMemberId, susuCycleId, 'T_24H_SHORTFALL') — the SusuReminderSent
// unique index is the source of truth, so the cron can safely re-run.
// =============================================================================

const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');

const REMINDER_TYPE = 'T_24H_SHORTFALL';
const WINDOW_TARGET_MS = 24 * 60 * 60 * 1000;
const WINDOW_HALF_MS = 5 * 60 * 1000;

class SusuReminderCron {
  constructor(prisma, notificationService, { intervalMs = 5 * 60 * 1000 } = {}) {
    this.prisma = prisma;
    this.notificationService = notificationService;
    this.intervalMs = intervalMs;
    this.interval = null;
    this._running = false;
  }

  start() {
    if (this.interval) return;
    logger.info(`[SusuReminderCron] starting (every ${this.intervalMs / 1000}s)`);
    setImmediate(() => this._tick().catch(err => logger.error({ err: err }, '[SusuReminderCron] initial tick')));
    this.interval = setInterval(() => this._tick().catch(err => logger.error({ err: err }, '[SusuReminderCron] tick')), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async _tick() {
    if (this._running) return;
    this._running = true;
    try {
      const now = Date.now();
      const lo = new Date(now + WINDOW_TARGET_MS - WINDOW_HALF_MS);
      const hi = new Date(now + WINDOW_TARGET_MS + WINDOW_HALF_MS);

      const cycles = await this.prisma.susuCycle.findMany({
        where: {
          status: 'PENDING',
          collectionDate: { gte: lo, lte: hi },
          susu: { status: 'ACTIVE' },
        },
        include: {
          susu: {
            select: {
              id: true,
              contributionUsdc: true,
              groupChat: { select: { name: true } },
              members: {
                where: { status: 'ACTIVE' },
                select: { id: true, userId: true },
              },
            },
          },
        },
      });

      for (const cycle of cycles) {
        const contribution = new Prisma.Decimal(cycle.susu.contributionUsdc);
        for (const member of cycle.susu.members) {
          const u = await this.prisma.user.findUnique({
            where: { id: member.userId },
            select: { availableBalance: true },
          });
          if (!u) continue;
          const balance = new Prisma.Decimal(u.availableBalance);
          if (balance.gte(contribution)) continue; // no shortfall
          const shortfall = contribution.minus(balance);

          // Idempotent insert (Property 11). If the unique constraint
          // fires, we know the reminder has already been sent.
          let inserted = false;
          try {
            await this.prisma.susuReminderSent.create({
              data: {
                susuMemberId: member.id,
                susuCycleId: cycle.id,
                susuGroupId: cycle.susu.id,
                reminderType: REMINDER_TYPE,
              },
            });
            inserted = true;
          } catch (err) {
            // P2002 unique constraint = already sent. Anything else
            // bubbles up.
            if (err.code !== 'P2002') throw err;
          }

          if (inserted && this.notificationService) {
            try {
              await this.notificationService.sendNotification({
                userId: member.userId,
                title: 'Susu cycle in 24 hours',
                body: `You're $${shortfall.toFixed(2)} short for "${cycle.susu.groupChat?.name || 'Susu'}". Tap to top up.`,
                category: 'SUSU',
                actionPayload: {
                  action: 'OPEN_DEPOSIT_FOR_SUSU',
                  amount: shortfall.toFixed(2),
                  susuId: cycle.susu.id,
                  cycleId: cycle.id,
                },
              });
            } catch (err) {
              logger.warn(`[SusuReminderCron] notify ${member.userId} failed:`, err.message);
            }
          }
        }
      }
    } finally {
      this._running = false;
    }
  }
}

module.exports = SusuReminderCron;
