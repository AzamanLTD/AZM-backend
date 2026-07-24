'use strict';

// =============================================================================
// AZAMAN — Storefront Stake Worker
//
// Runs three jobs:
// 1. Daily: check active stakes for tier enforcement + auto-downgrade lapsed layouts
// 2. Hourly: complete unstakes that have passed their cooldown
// 3. On cooldown completion: downgrade published layouts with premium widgets
//
// The worker receives the prisma instance from server.js on init.
// =============================================================================

const azmStakeService = require('../services/azmStakeService');
const storefrontService = require('../services/storefrontService');

let prismaInstance = null;
let dailyIntervalId = null;
let hourlyIntervalId = null;

/**
 * Find all published storefront layouts whose owners no longer meet the
 * stake requirement for premium widgets/themes, and auto-downgrade them.
 */
async function autoDowngradeLapsedStakes(prisma) {
  // Find all published layouts
  const publishedLayouts = await prisma.businessStorefrontLayout.findMany({
    where: { status: 'PUBLISHED' },
    include: { theme: true, businessProfile: { select: { userId: true } } },
  });

  let downgradedCount = 0;

  for (const layout of publishedLayouts) {
    try {
      const themeKey = layout.theme?.key || null;
      const eligibility = await storefrontService.validateNitroEligibility(
        prisma, layout.businessProfileId, layout.layoutJson, themeKey
      );

      if (!eligibility.eligible) {
        // Downgrade the layout in place
        const { layoutJson: downgradedLayout, downgraded } = storefrontService.downgradePremiumWidgets(layout.layoutJson);

        // Determine if theme also needs downgrading
        let themeId = layout.themeId;
        const themeViolation = eligibility.violations.find(v => v.type === 'theme');
        if (themeViolation) {
          const freeTheme = await prisma.businessStorefrontTheme.findFirst({
            where: { key: 'classic_light', isActive: true },
          });
          if (freeTheme) themeId = freeTheme.id;
        }

        // Update the published layout with downgraded widgets/theme
        await prisma.businessStorefrontLayout.update({
          where: { id: layout.id },
          data: { layoutJson: downgradedLayout, themeId },
        });

        // Track the downgrade event
        await prisma.storefrontAnalyticsEvent.create({
          data: {
            businessProfileId: layout.businessProfileId,
            eventType: 'nitro_auto_downgrade',
            metadata: { downgraded, tier: eligibility.tier, stakedBalance: eligibility.stakedBalance },
          },
        }).catch(() => {});

        downgradedCount++;
        console.log(`[StorefrontStakeWorker] Auto-downgraded layout for business ${layout.businessProfileId}: ${downgraded.length} widgets downgraded`);
      }
    } catch (err) {
      console.error(`[StorefrontStakeWorker] Error checking layout ${layout.id}:`, err.message);
    }
  }

  return { downgradedCount, totalChecked: publishedLayouts.length };
}

function start(prisma) {
  prismaInstance = prisma;

  // Daily check at 00:00 UTC (every 24 hours)
  const dailyCheck = async () => {
    try {
      console.log('[StorefrontStakeWorker] Daily stake check starting...');
      const result = await azmStakeService.checkActiveStakes(prismaInstance);

      // PHASE 8: Auto-downgrade layouts with lapsed stakes
      const downgradeResult = await autoDowngradeLapsedStakes(prismaInstance);
      if (downgradeResult.downgradedCount > 0) {
        console.log(`[StorefrontStakeWorker] Auto-downgraded ${downgradeResult.downgradedCount} layouts out of ${downgradeResult.totalChecked} checked.`);
      }

      console.log('[StorefrontStakeWorker] Daily check complete:', { ...result, ...downgradeResult });
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

        // PHASE 8: After completing unstakes, check for layouts needing downgrade
        const downgradeResult = await autoDowngradeLapsedStakes(prismaInstance);
        if (downgradeResult.downgradedCount > 0) {
          console.log(`[StorefrontStakeWorker] Post-unstake downgrade: ${downgradeResult.downgradedCount} layouts.`);
        }
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

  console.log('[StorefrontStakeWorker] Started — daily check + hourly unstake queue + auto-downgrade');
}

function stop() {
  if (dailyIntervalId) clearInterval(dailyIntervalId);
  if (hourlyIntervalId) clearInterval(hourlyIntervalId);
  dailyIntervalId = null;
  hourlyIntervalId = null;
  console.log('[StorefrontStakeWorker] Stopped');
}

module.exports = { start, stop, autoDowngradeLapsedStakes };
