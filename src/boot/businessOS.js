// src/boot/businessOS.js
// =============================================================================
// r39/P1 — BUSINESS OS BOOT READINESS GATE.
//
// The canonical Render deployment converges every schema overlay in the
// `npm run release` pre-deploy command. As defense-in-depth, boot also runs
// infra/install-business-os-overlay.js idempotently — but previously a boot
// failure was logged and SWALLOWED, leaving money-bearing Business OS routes
// serving traffic against an unverified schema.
//
// The deliberate contract (mirroring retailCheckoutIntegrityReady):
//   • app.set('businessOSReady', false) synchronously at boot start, so
//     requests racing startup can never enter the Business OS early;
//   • the overlay install flips the flag only on real convergence;
//   • in production the businessOSReadiness middleware fails CLOSED with a
//     retryable 503 while the flag is not true — the rest of the platform
//     (chat, wallet, marketplace, storefront discovery) keeps serving;
//   • test/dev environments are explicitly not gated: unit and integration
//     suites mount route modules directly and never run production boot.
// =============================================================================
const logger = require('../config/logger');

/**
 * Fail-closed request gate for the /api/business-os surface.
 * Production-only: the rest of the platform is unaffected.
 */
function businessOSReadiness(req, res, next) {
    if (process.env.NODE_ENV === 'production' && req.app.get('businessOSReady') !== true) {
        return res.status(503).json({
            success: false,
            message: 'Business OS is temporarily initializing. Please retry shortly.',
            retryable: true,
        });
    }
    next();
}

/**
 * Run the Business OS schema overlay install and mark readiness.
 * NEVER throws: convergence failure keeps the gate fail-closed and the
 * process alive (deliberate degraded availability, not a crash).
 *
 * @param {import('express').Express} app
 * @param {{ exec?: () => Promise<void> }} [injection] test seam for the installer
 * @returns {Promise<boolean>} true iff the overlay converged
 */
async function bootBusinessOSOverlay(app, { exec } = {}) {
    const run = exec || (() => new Promise((resolve, reject) => {
        try {
            const { execSync } = require('child_process');
            execSync('node infra/install-business-os-overlay.js', { stdio: 'inherit', timeout: 30000 });
            resolve();
        } catch (e) {
            reject(e);
        }
    }));

    try {
        await run();
        app.set('businessOSReady', true);
        logger.info('Business OS schema overlay converged; Business OS routes are ready for traffic.');
        return true;
    } catch (e) {
        app.set('businessOSReady', false);
        logger.error({ err: e }, 'Business OS overlay did not converge; Business OS routes remain fail-closed.');
        return false;
    }
}

module.exports = { businessOSReadiness, bootBusinessOSOverlay };
