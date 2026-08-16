// workers/savingsWorker.js
// =============================================================================
// AZAMAN V3 — SAVINGS REMINDER WORKER
//
// Runs on a 1-hour interval. Checks all active savings goals and fires
// notifications:
//   - 1 DAY BEFORE due date: "Your savings deposit of GHS X is due tomorrow!"
//   - ON due date: "Today is your savings day! Deposit GHS X now."
//   - 1 DAY AFTER missed: "You missed your savings deposit. Your streak is at risk!"
//
// Also handles streak-breaking for goals where the due date has passed
// without a deposit.
// =============================================================================

const logger = require('../src/config/logger');

class SavingsWorker {
    constructor(prisma, io) {
        this.prisma = prisma;
        this.io = io;
        this.interval = null;
    }

    start(intervalMs = 60 * 60 * 1000) { // Every hour
        logger.info('[SavingsWorker] Started — checking every 60 minutes');
        this._checkReminders();
        this.interval = setInterval(() => this._checkReminders(), intervalMs);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        logger.info('[SavingsWorker] Stopped');
    }

    async _checkReminders() {
        try {
            const now = new Date();
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            // Get all active goals with upcoming/overdue dates
            const goals = await this.prisma.savingsGoal.findMany({
                where: {
                    status: 'ACTIVE',
                    nextDueDate: { not: null }
                },
                select: {
                    id: true,
                    userId: true,
                    name: true,
                    frequencyAmount: true,
                    frequency: true,
                    nextDueDate: true,
                    streakCount: true,
                    longestStreak: true
                }
            });

            for (const goal of goals) {
                const dueDate = new Date(goal.nextDueDate);
                const hoursUntilDue = (dueDate.getTime() - now.getTime()) / (60 * 60 * 1000);
                const hoursOverdue = (now.getTime() - dueDate.getTime()) / (60 * 60 * 1000);

                // 1 day before reminder (between 23-25 hours before)
                if (hoursUntilDue >= 23 && hoursUntilDue <= 25) {
                    await this._sendReminder(goal, 'REMINDER_BEFORE', 
                        'Savings Due Tomorrow!',
                        `Your GHS ${goal.frequencyAmount.toFixed(2)} deposit for "${goal.name}" is due tomorrow. Stay consistent!`
                    );
                }

                // Due day reminder (between 0-2 hours after due)
                if (hoursOverdue >= 0 && hoursOverdue <= 2) {
                    await this._sendReminder(goal, 'REMINDER_DUE',
                        'Savings Day!',
                        `Today is your savings day! Deposit GHS ${goal.frequencyAmount.toFixed(2)} into "${goal.name}" to keep your ${goal.streakCount}-deposit streak alive.`
                    );
                }

                // Missed reminder (between 23-25 hours after due)
                if (hoursOverdue >= 23 && hoursOverdue <= 25) {
                    await this._sendReminder(goal, 'REMINDER_MISSED',
                        'Missed Savings Deposit',
                        `You missed your GHS ${goal.frequencyAmount.toFixed(2)} deposit for "${goal.name}". Your streak will reset if you don't deposit soon!`
                    );
                }

                // Break streak if 48+ hours overdue with no deposit
                if (hoursOverdue >= 48) {
                    await this._breakStreak(goal);
                }
            }
        } catch (error) {
            logger.error({ err: error }, '[SavingsWorker] Error');
        }
    }

    async _sendReminder(goal, type, title, body) {
        try {
            // Check if we already sent this type of reminder today for this goal
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const existing = await this.prisma.notification.findFirst({
                where: {
                    userId: goal.userId,
                    title,
                    createdAt: { gte: today }
                }
            });

            if (existing) return; // Already sent today

            // Phase N2: route through notificationService for DB + socket + FCM
            const NotificationService = require('../services/notificationService');
            const notifSvc = new NotificationService(this.prisma, this.io);
            await notifSvc.sendNotification({
                userId: goal.userId,
                title,
                body,
                category: 'GENERAL',
                actionPayload: {
                    action: 'VIEW_SAVINGS',
                    goalId: goal.id,
                    reminderType: type
                }
            });

        } catch (err) {
            logger.error(`[SavingsWorker] Reminder send failed for goal ${goal.id}:`, err.message);
        }
    }

    async _breakStreak(goal) {
        try {
            // BUGFIX (Phase H12, 2026-05-27): the previous version
            // didn't advance `nextDueDate` after breaking the streak.
            // Result: a missed goal stayed at the same nextDueDate
            // forever, and every subsequent worker tick kept firing
            // missed-reminder dedup checks + tried to break a
            // 0-streak again. Now we atomically advance to the next
            // cycle's due date so the goal moves forward.
            //
            // Also fixes a TOCTOU race: two worker ticks crossing the
            // 48-hour boundary simultaneously could both pass the
            // `streakCount === 0` early-return AND both increment
            // `missedCount`. Conditional updateMany scoped to the
            // current `nextDueDate` makes the second tick a no-op.
            const NotificationService = require('../services/notificationService');

            // Advance nextDueDate by computing one cycle from the
            // existing due date (NOT from `now` — we want the schedule
            // to stay aligned to the original cadence).
            const nextDue = this._advanceDueDate(goal.nextDueDate, goal.frequency);

            const claimed = await this.prisma.savingsGoal.updateMany({
                where: {
                    id: goal.id,
                    nextDueDate: goal.nextDueDate, // precondition: row hasn't moved
                    streakCount: { gt: 0 }         // and streak hasn't been broken yet
                },
                data: {
                    streakCount: 0,
                    missedCount: { increment: 1 },
                    nextDueDate: nextDue
                }
            });

            if (claimed.count === 0) {
                // Either streak already 0 (idempotent return), or
                // another tick already advanced the row. Quiet skip.
                return;
            }

            logger.info(`[SavingsWorker] Streak broken for goal ${goal.id} (was ${goal.streakCount}); advanced to ${nextDue.toISOString()}`);
        } catch (err) {
            logger.error(`[SavingsWorker] Streak break failed for goal ${goal.id}:`, err.message);
        }
    }

    /**
     * Compute the next due date by advancing one frequency cycle from
     * the given date. Mirrors `_calculateNextDueDate` in the controller
     * but takes an explicit anchor instead of `new Date()`.
     */
    _advanceDueDate(fromDate, frequency) {
        const date = new Date(fromDate);
        switch (frequency) {
            case 'DAILY':
                date.setDate(date.getDate() + 1);
                break;
            case 'WEEKLY':
                date.setDate(date.getDate() + 7);
                break;
            case 'BIWEEKLY':
                date.setDate(date.getDate() + 14);
                break;
            case 'MONTHLY':
                date.setMonth(date.getMonth() + 1);
                break;
            default:
                date.setDate(date.getDate() + 7); // safe default = WEEKLY
        }
        return date;
    }
}

module.exports = SavingsWorker;
