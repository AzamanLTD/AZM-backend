// src/boot/treasury.js
// =============================================================================
// Treasury wallet boot-time resolution + caching.
//
// Caches the treasury wallet's User id at startup so cycle workers and service
// code can look it up via app.get('azamanTreasuryUserId') in O(1) instead of
// querying every cycle.
//
// Boot-time auto-release (Susu Sprint): free-tier hosting has no Shell /
// Pre-Deploy hook, so we run the one-time, idempotent migrate + seed step here
// at boot (infra/autoRelease.js). It only does work when the treasury row is
// missing, never blocks request handling, and never crashes the process.
//
// Resilience: the treasury check is intentionally NON-FATAL. A missing row must
// NOT take down the entire backend. If the seed hasn't run yet, we log a loud
// warning, leave `azamanTreasuryUserId` unset, and let the Susu cycle workers
// skip themselves. A self-heal retry re-checks every 60s so a seed applied while
// the process is live is picked up without a restart.
// =============================================================================

const logger = require('../config/logger');

/**
 * Run the boot-time auto-release + treasury caching sequence.
 *
 * @param {import('express').Express} app
 * @param {object} prisma
 */
async function bootTreasury(app, prisma) {
    const { autoRelease } = require('../../infra/autoRelease');

    const cacheTreasury = async () => {
        const treasury = await prisma.user.findUnique({
            where: { username: 'azaman-treasury' },
            select: { id: true },
        });
        if (treasury) {
            app.set('azamanTreasuryUserId', treasury.id);
            return treasury.id;
        }
        return null;
    };

    try {
        // Run the boot release (installer converges schema; seed is internally
        // gated on treasury-missing). Skipped under test.
        if (process.env.NODE_ENV !== 'test') {
            await autoRelease(prisma);

            // Apply business OS schema additions (Modules 01+03) idempotently.
            try {
                const { execSync } = require('child_process');
                execSync('node infra/install-business-os-overlay.js', { stdio: 'inherit', timeout: 30000 });
            } catch (e) {
                logger.warn({ err: e }, 'business-os-overlay: boot-time install skipped');
            }
        }

        const id = await cacheTreasury();

        if (id) {
            logger.info({ userId: id }, 'Susu: treasury wallet cached');
        } else {
            logger.warn('Susu: azaman-treasury User row not found after auto-release. Susu escrow/cycle features are DISABLED until it is seeded. Retrying every 60s.');
            const retry = setInterval(async () => {
                try {
                    const rid = await cacheTreasury();
                    if (rid) {
                        logger.info({ userId: rid }, 'Susu: treasury wallet cached on retry');
                        clearInterval(retry);
                    }
                } catch (e) {
                    logger.warn({ err: e }, 'Susu: treasury retry failed');
                }
            }, 60_000);
            retry.unref?.();
        }
    } catch (err) {
        // Non-fatal: log and continue. Susu stays dark; everything else runs.
        logger.warn({ err }, 'Susu: treasury wallet cache failed (non-fatal)');
    }
}

module.exports = { bootTreasury };
