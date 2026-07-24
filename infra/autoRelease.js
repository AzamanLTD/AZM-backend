// infra/autoRelease.js
// =============================================================================
// Boot-time, idempotent "release" step for free-tier hosting (Render free
// instances have no Shell and no Pre-Deploy hook). Runs ONCE per process
// start, in the background, and NEVER crashes the server if it fails.
//
// What it does (only when the treasury row is missing):
//   1. Installs the additive Susu overlay schema objects via the idempotent
//      SQL installer (infra/install-susu-overlay.js), over the app's
//      existing Prisma connection.
//   2. Seeds the azaman-treasury wallet + v1.0 liability contract
//      (infra/seed-susu-foundation.js, idempotent existence checks).
//
// Why not `prisma migrate deploy`: production Neon uses the `-pooler`
// (PgBouncer) DSN, through which `prisma migrate` cannot acquire its
// advisory lock (fails P1002), and the DB has no `_prisma_migrations`
// baseline (P3005). The installer sidesteps both by running plain,
// IF NOT EXISTS-guarded DDL over the normal pooled connection.
//
// Guard: before doing any work, it checks whether the treasury row already
// exists. If it does, the release already ran — skip everything, so
// steady-state restarts pay only one cheap query.
//
// Safety: fully wrapped in try/catch; any failure is logged and swallowed
// so the rest of the backend is never affected. All DDL is additive and
// idempotent, so a partial/failed run is safe to retry on the next boot.
//
// This is a one-shot at boot, NOT a cron job: the work is a one-time
// idempotent install+seed, not recurring scheduled work.
// =============================================================================

// Module-level status so the running server can report the outcome of the
// boot-time release without needing dashboard log access (free tier). The
// /health endpoint surfaces this object.
const releaseStatus = {
  ran: false,
  startedAt: null,
  finishedAt: null,
  overlayInstalled: null,
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
  // Keep the step log bounded.
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

    // Always run the idempotent overlay installer (schema convergence).
    // Production Neon is `db push`-managed (no migration baseline) and
    // sits behind the PgBouncer pooler, so `prisma migrate deploy` can't
    // be used. Running the IF NOT EXISTS-guarded installer on every boot
    // is how additive columns/tables introduced over time actually land
    // in prod. It's cheap (all statements no-op once applied) and never
    // drops or alters existing objects.
    try {
      const logger = require('../src/config/logger');
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

    // Azaman ID + phoneHash backfill (Phase 6). Runs on EVERY boot,
    // independent of the treasury-seed gate below, so existing users always
    // converge to having an Azaman ID. Idempotent: rows that already have an
    // azamanId/phoneHash are skipped, so steady-state boots are cheap.
    try {
      const { backfillAzamanIds } = require('./backfill-azaman-ids');
      const r = await backfillAzamanIds(prisma);
      releaseStatus.azamanIdBackfill = r;
      log(`azamanId backfill: scanned=${r.scanned} assigned=${r.assigned} skipped=${r.skipped} phoneHashed=${r.phoneHashed}`);
    } catch (e) {
      log(`azamanId backfill failed (non-fatal): ${e.message}`);
    }

    // The seed (treasury wallet + v1.0 contract) only needs to run once.
    // Use the treasury row as the marker: present → already seeded, skip.
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

    log(force
      ? 'Forced release requested — running seed…'
      : 'Treasury missing — seeding foundation…');

    // Seed treasury wallet + v1.0 contract (idempotent). Run in-process so
    // it uses the same connection the installer just prepared.
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

    // Encrypt-at-rest backfill for KYC idNumber (Phase 5 / Workstream A).
    // No-op when ENCRYPTION_KEY is unset or all rows are already encrypted.
    try {
      const { encryptIdNumbers } = require('./encrypt-id-numbers');
      const r = await encryptIdNumbers(prisma);
      releaseStatus.idEncryptBackfill = r;
      log(`idNumber backfill: scanned=${r.scanned} encrypted=${r.encrypted} skipped=${r.skipped}`);
    } catch (e) {
      log(`idNumber backfill failed (non-fatal): ${e.message}`);
    }

    // Azaman ID + phoneHash backfill (Phase 6 / Social & Vouching Evolution).
    // Assigns 'AZM-#########' to every user missing one and hashes existing
    // verified phones for Contact_Discovery. Idempotent; safe every boot.
    try {
      const { backfillAzamanIds } = require('./backfill-azaman-ids');
      const r = await backfillAzamanIds(prisma);
      releaseStatus.azamanIdBackfill = r;
      log(`azamanId backfill: scanned=${r.scanned} assigned=${r.assigned} skipped=${r.skipped} phoneHashed=${r.phoneHashed}`);
    } catch (e) {
      log(`azamanId backfill failed (non-fatal): ${e.message}`);
    }

    // Azaman ID + phoneHash backfill (Phase 6 / Social & Vouching Evolution).
    // Assigns 'AZM-#########' to every user missing one and hashes existing
    // verified phones for Contact_Discovery. Idempotent; safe every boot.
    try {
      const { backfillAzamanIds } = require('./backfill-azaman-ids');
      const r = await backfillAzamanIds(prisma);
      releaseStatus.azamanIdBackfill = r;
      log(`azamanId backfill: scanned=${r.scanned} assigned=${r.assigned} skipped=${r.skipped} phoneHashed=${r.phoneHashed}`);
    } catch (e) {
      log(`azamanId backfill failed (non-fatal): ${e.message}`);
    }

    releaseStatus.finishedAt = new Date().toISOString();
    log('Release step finished. Susu features will come online as the treasury cache resolves.');
    return releaseStatus;
  } catch (err) {
    releaseStatus.error = err.message;
    releaseStatus.finishedAt = new Date().toISOString();
    log(`unexpected error (non-fatal): ${err.message}`);
    return releaseStatus;
  }
}

module.exports = { autoRelease, releaseStatus };
