const logger = require('../src/config/logger');
// infra/autoRelease.js
// =============================================================================
// Boot-time, idempotent "release" step for free-tier hosting (Render free
// instances have no Shell and no Pre-Deploy hook). Runs ONCE per process start,
// in the background, and NEVER crashes the server if it fails.
//
// What it does:
//   1. Converges the retail checkout integrity schema after production db-push.
//   2. Installs the additive Susu overlay schema objects.
//   3. Installs the transaction quote overlay schema objects.
//   4. Installs the Marketplace Mix discovery surface (PR #349).
//   5. Seeds the azaman-treasury wallet + v1.0 liability contract when needed.
// =============================================================================

const releaseStatus = {
  ran: false,
  marketplaceDiscoveryInstalled: null,
  marketplaceDiscoveryResult: null,
  startedAt: null,
  finishedAt: null,
  overlayInstalled: null,
  quoteOverlayInstalled: null,
  retailCheckoutIntegrityInstalled: null,
  driftRemediationInstalled: null,
  driftRemediationResult: null,
  driftRemediationErrors: null,
  installerResult: null,
  quoteInstallerResult: null,
  retailCheckoutIntegrityResult: null,
  installerErrors: null,
  quoteInstallerErrors: null,
  retailCheckoutIntegrityErrors: null,
  seedOk: null,
  seedOutput: null,
  skipped: false,
  error: null,
  steps: [],
};

function log(msg) {
  logger.info(`[autoRelease] ${msg}`);
  releaseStatus.steps.push(`${new Date().toISOString()} ${msg}`);
  if (releaseStatus.steps.length > 50) releaseStatus.steps.shift();
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<typeof releaseStatus>}
 */
async function autoRelease(prisma, opts = {}) {
  const force = opts.force === true;
  try {
    releaseStatus.ran = true;
    releaseStatus.startedAt = new Date().toISOString();
    releaseStatus.error = null;

    try {
      const { installRetailCheckoutIntegrity } = require('./install-retail-checkout-integrity');
      const r = await installRetailCheckoutIntegrity(prisma);
      releaseStatus.retailCheckoutIntegrityResult = { ok: r.ok, steps: r.steps };
      releaseStatus.retailCheckoutIntegrityInstalled = r.ok === true;
      log(`retail checkout integrity: ${r.steps.length} schema steps converged`);
    } catch (e) {
      releaseStatus.retailCheckoutIntegrityInstalled = false;
      releaseStatus.retailCheckoutIntegrityErrors = [e.message];
      log(`retail checkout integrity failed (non-fatal): ${e.message}`);
    }

    // Prod schema-drift remediation (PR #267): converge the Prisma-model
    // objects (dedupKey, stakeBalance, BusinessOrderItem, OVERPAYMENT_FREEZE)
    // and the hand-written CHECK constraints (NOT VALID + VALIDATE) that
    // production never received. Idempotent — a no-op on converged DBs.
    try {
      const { installProdDriftRemediation } = require('./install-prod-drift-remediation');
      const r = await installProdDriftRemediation(prisma);
      releaseStatus.driftRemediationResult = r;
      releaseStatus.driftRemediationInstalled = r.ok === true;
      if (r.pendingValidation && r.pendingValidation.length) {
        releaseStatus.driftRemediationErrors = r.pendingValidation
          .map((pv) => `${pv.constraint} on ${pv.table}: ${pv.violations ?? pv.error}`)
          .slice(0, 10);
      }
      log(`prod drift remediation: ok=${r.ok}, pending validation=${(r.pendingValidation || []).length}`);
    } catch (e) {
      releaseStatus.driftRemediationInstalled = false;
      releaseStatus.driftRemediationErrors = [e.message];
      log(`prod drift remediation failed (non-fatal): ${e.message}`);
    }

    try {
      const { installSusuOverlay } = require('./install-susu-overlay');
      const r = await installSusuOverlay(prisma);
      releaseStatus.installerResult = { ok: r.ok, failed: r.failed };
      releaseStatus.overlayInstalled = r.failed === 0;
      if (r.errors && r.errors.length) releaseStatus.installerErrors = r.errors.slice(0, 10);
      log(`overlay installer: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      log(`overlay installer threw (non-fatal): ${e.message}`);
      releaseStatus.installerResult = { error: e.message };
    }

    try {
      const { installTransactionQuoteOverlay } = require('./install-transaction-quote-overlay');
      const r = await installTransactionQuoteOverlay(prisma);
      releaseStatus.quoteInstallerResult = { ok: r.ok, failed: r.failed };
      releaseStatus.quoteOverlayInstalled = r.failed === 0;
      if (r.errors && r.errors.length) releaseStatus.quoteInstallerErrors = r.errors.slice(0, 10);
      log(`transaction quote overlay: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      log(`transaction quote overlay threw (non-fatal): ${e.message}`);
      releaseStatus.quoteInstallerResult = { error: e.message };
    }

    try {
      const { installWalletAddressOverlay } = require('./install-wallet-address-overlay');
      const r = await installWalletAddressOverlay(prisma);
      releaseStatus.walletAddressInstallerResult = { ok: r.ok, failed: r.failed, backfilled: r.backfilled };
      releaseStatus.walletAddressOverlayInstalled = r.failed === 0;
      if (r.errors && r.errors.length) releaseStatus.walletAddressInstallerErrors = r.errors.slice(0, 10);
      log(`wallet address overlay: ${r.ok} ok, ${r.failed} failed, ${r.backfilled} backfilled`);
    } catch (e) {
      log(`wallet address overlay threw (non-fatal): ${e.message}`);
      releaseStatus.walletAddressInstallerResult = { error: e.message };
    }

    // Marketplace Mix discovery surface (PR #349): D-5 visibility flag, D-2
    // taxonomy column + mapping table + backfill, §3.3 indexes (built
    // CONCURRENTLY — see the installer). Converges the SAME surface as the
    // release chain via the exported installer (no subprocess). NOTE
    // (DEPLOY_RUNBOOK.md): the live Render Free-plan path invokes NEITHER
    // this boot step NOR `npm run release` — this wiring only heals
    // environments that actually run autoRelease.
    try {
      const { installMarketplaceDiscoveryOverlay } = require('./install-marketplace-discovery-overlay');
      const r = await installMarketplaceDiscoveryOverlay(prisma);
      releaseStatus.marketplaceDiscoveryInstalled = true;
      releaseStatus.marketplaceDiscoveryResult = r;
      log(`marketplace discovery overlay: ${r.taxonomyRows} taxonomy rows, ${r.sectionsBackfilled} backfilled, indexes ${r.indexesCreated}c/${r.indexesRebuilt}r/${r.indexesKept}k`);
    } catch (e) {
      releaseStatus.marketplaceDiscoveryInstalled = false;
      releaseStatus.marketplaceDiscoveryResult = { error: e.message };
      log(`marketplace discovery overlay failed (non-fatal): ${e.message}`);
    }

    try {
      const { backfillAzamanIds } = require('./backfill-azaman-ids');
      const r = await backfillAzamanIds(prisma);
      releaseStatus.azamanIdBackfill = r;
      log(`azamanId backfill: scanned=${r.scanned} assigned=${r.assigned} skipped=${r.skipped} phoneHashed=${r.phoneHashed}`);
    } catch (e) {
      log(`azamanId backfill failed (non-fatal): ${e.message}`);
    }

    let alreadySeeded = false;
    try {
      const treasury = await prisma.user.findUnique({
        where: { username: 'azaman-treasury' },
        select: { id: true },
      });
      alreadySeeded = !!treasury;
    } catch (e) {
      log(`treasury probe failed (will attempt seed): ${e.code || e.message}`);
      alreadySeeded = false;
    }

    if (alreadySeeded && !force) {
      releaseStatus.skipped = true;
      releaseStatus.finishedAt = new Date().toISOString();
      log('Treasury already present — schema converged, skipping seed.');
      return releaseStatus;
    }

    log(force ? 'Forced release requested — running seed…' : 'Treasury missing — seeding foundation…');

    try {
      const { seedSusuFoundation } = require('./seed-susu-foundation');
      await seedSusuFoundation(prisma);
      releaseStatus.seedOk = true;
      log('susu-foundation seed completed (in-process).');
    } catch (e) {
      releaseStatus.seedOk = false;
      releaseStatus.seedOutput = e.message;
      log(`susu-foundation seed failed (non-fatal): ${e.message}`);
    }

    try {
      const { encryptIdNumbers } = require('./encrypt-id-numbers');
      const r = await encryptIdNumbers(prisma);
      releaseStatus.idEncryptBackfill = r;
      log(`idNumber backfill: scanned=${r.scanned} encrypted=${r.encrypted} skipped=${r.skipped}`);
    } catch (e) {
      log(`idNumber backfill failed (non-fatal): ${e.message}`);
    }

    // WORKSTREAM D (PR #366) — offeredCategories column. Same exported-
    // function convention as the other boot-time installers; idempotent
    // and additive (ADD COLUMN IF NOT EXISTS), fail-closed on drift.
    // This is the REAL production path on the Render Free plan, where the
    // pre-deploy command does not run and boot-time provisioning applies.
    try {
      const { installBusinessOfferedCategoriesOverlay } = require('./install-business-offered-categories-overlay');
      const r = await installBusinessOfferedCategoriesOverlay(prisma);
      releaseStatus.offeredCategoriesOverlay = r;
      log(`offered-categories overlay: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      releaseStatus.offeredCategoriesOverlay = { error: e.message };
      log(`offered-categories overlay failed (non-fatal): ${e.message}`);
    }

    // MARKETPLACE PERSONALISATION (Backend A) — BusinessBookmark table.
    // Same exported-function convention; idempotent, additive, fail-closed
    // on drift. Part of the REAL boot-time production path on Render Free.
    try {
      const { installBusinessBookmarkOverlay } = require('./install-business-bookmark-overlay');
      const r = await installBusinessBookmarkOverlay(prisma);
      releaseStatus.businessBookmarkOverlay = r;
      log(`business-bookmark overlay: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      releaseStatus.businessBookmarkOverlay = { error: e.message };
      log(`business-bookmark overlay failed (non-fatal): ${e.message}`);
    }

    // MARKETPLACE PERSONALISATION (Backend D) — per-user recommendation
    // feedback ("Show less like this"). Same convention: idempotent,
    // additive, fail-closed on drift; part of the boot-time path.
    try {
      const { installBusinessRecommendationFeedbackOverlay } = require('./install-business-recommendation-feedback-overlay');
      const r = await installBusinessRecommendationFeedbackOverlay(prisma);
      releaseStatus.businessRecommendationFeedbackOverlay = r;
      log(`business-recommendation-feedback overlay: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      releaseStatus.businessRecommendationFeedbackOverlay = { error: e.message };
      log(`business-recommendation-feedback overlay failed (non-fatal): ${e.message}`);
    }

    releaseStatus.finishedAt = new Date().toISOString();
    log('Release step finished.');
    return releaseStatus;
  } catch (err) {
    releaseStatus.error = err.message;
    releaseStatus.finishedAt = new Date().toISOString();
    log(`unexpected error (non-fatal): ${err.message}`);
    return releaseStatus;
  }
}

module.exports = { autoRelease, releaseStatus };
