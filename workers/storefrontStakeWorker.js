'use strict';

// =============================================================================
// AZAMAN — Storefront Stake Worker
//
// Runs two jobs:
// 1. Daily: check active stakes for tier enforcement
// 2. Hourly: complete unstakes that have passed their cooldown
//
// The worker receives the prisma instance from server.js on init.
// =============================================================================

const azmStakeService = require('../services/azmStakeService');

let prismaInstance = null;
let dailyIntervalId = null;
let hourlyIntervalId = null;

function start(prisma) {
  prismaInstance = prisma;

  // Daily check at 00:00 UTC (every 24 hours)
  const dailyCheck = async () => {
    try {
      console.log('[StorefrontStakeWorker] Daily stake check starting...');
      const result = await azmStakeService.checkActiveStakes(prismaInstance);
      console.log('[StorefrontStakeWorker] Daily check complete:', result);
    } catch (err) {
      console.error('[StorefrontStakeWorker] Daily check error:', err.message);
    }
  };

  // Hourly unstake completion
  const hourlyUnstake = async () => {
    try {
      console.log('[StorefrontStakeWorker] Hourly unstake queue processing...');
      const result = await azmStakeService.processUnstakeQueue(prismaInstance);
      if (result.completed > 0) {
        console.log(`[StorefrontStakeWorker] Completed ${result.completed} unstakes.`);
      }
    } catch (err) {
      console.error('[StorefrontStakeWorker] Unstake queue error:', err.message);
    }
  };

  // Run immediately on start (for unstake queue)
  hourlyUnstake();

  // Schedule: daily every 24 hours, hourly every 60 minutes
  dailyIntervalId = setInterval(dailyCheck, 24 * 60 * 60 * 1000);
  hourlyIntervalId = setInterval(hourlyUnstake, 60 * 60 * 1000);

  console.log('[StorefrontStakeWorker] Started — daily check + hourly unstake queue');
}

function stop() {
  if (dailyIntervalId) clearInterval(dailyIntervalId);
  if (hourlyIntervalId) clearInterval(hourlyIntervalId);
  dailyIntervalId = null;
  hourlyIntervalId = null;
  console.log('[StorefrontStakeWorker] Stopped');
}

module.exports = { start, stop };
