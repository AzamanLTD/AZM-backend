const logger = require('../src/config/logger');
// infra/autoRelease.js
// =============================================================================
// Boot-time, idempotent "release" step for free-tier hosting (Render free
// instances have no Shell and no Pre-Deploy hook). Runs ONCE per process
// start, in the background, and NEVER crashes the server if it fails.
//
// What it does:
//   1. Installs the additive Susu overlay schema objects.
//   2. Installs the additive platform control-plane access schema.
//   3. Seeds the azaman-treasury wallet + v1.0 liability contract when needed.
//
// Production Neon is db-push managed behind PgBouncer, so the installers use
// plain idempotent SQL rather than prisma migrate deploy.
// =============================================================================

const releaseStatus = {
  ran: false,
  startedAt: null,
  finishedAt: null,
  overlayInstalled: null,
  controlPlaneInstalled: null,
  installerResult: null,
  installerErrors: null,
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
      const { installControlPlaneOverlay } = require('./install-control-plane-overlay');
      const r = await installControlPlaneOverlay(prisma);
      releaseStatus.controlPlaneInstalled = r.failed === 0;
      if (r.errors && r.errors.length) releaseStatus.installerErrors = [
        ...(releaseStatus.installerErrors || []),
        ...r.errors.slice(0, 10),
      ].slice(0, 20);
      log(`control-plane installer: ${r.ok} ok, ${r.failed} failed`);
    } catch (e) {
      log(`control-plane installer threw (non-fatal): ${e.message}`);
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