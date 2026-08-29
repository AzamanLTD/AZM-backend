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
// Retail checkout integrity is different: it is a financial safety boundary.
// The app exposes checkout only after its schema/idempotency/inventory overlay
// has converged. If convergence fails, checkout stays fail-closed while the
// rest of the platform can continue serving non-checkout traffic.
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

    // Checkout is unavailable until the integrity installer explicitly marks
    // the database ready. This is set synchronously before the first await so
    // requests racing startup cannot enter the checkout transaction early.
    app.set('retailCheckoutIntegrityReady', false);

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
            const release = await autoRelease(prisma);
            if (release.retailCheckoutIntegrityInstalled === true) {
                app.set('retailCheckoutIntegrityReady', true);
                logger.info('Retail checkout integrity is ready for traffic.');
            } else {
                logger.error('Retail checkout integrity did not converge; storefront checkout remains fail-closed.');
            }

            // Apply business OS schema additions (Modules 01+03) idempotently.
            try {
                const { execSync } = require('child_process');
                execSync('node infra/install-business-os-overlay.js', { stdio: 'inherit', timeout: 30000 });
            } catch (e) {
                logger.warn({ err: e }, 'business-os-overlay: boot-time install skipped');
            }
        } else {
            // Unit/integration tests mount route modules directly and do not run
            // production boot. They must not be blocked by the production gate.
            app.set('retailCheckoutIntegrityReady', true);
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
        // Non-fatal for the rest of the platform, but explicitly fail closed
        // for storefront checkout if the integrity release itself errors.
        app.set('retailCheckoutIntegrityReady', false);
        logger.warn({ err }, 'Susu/retail boot sequence failed; checkout remains fail-closed');
    }
}

module.exports = { bootTreasury };