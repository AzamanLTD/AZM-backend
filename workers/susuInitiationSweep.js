// workers/susuInitiationSweep.js
// =============================================================================
// SusuInitiationSweep — Phase 5 / Workstream D (2026-06-01)
//
// Every minute, enforces the Susu initiation countdown deadline. For each
// CONFIGURING SusuGroup whose initiationDeadline has passed, the sweep:
//   • removes members who haven't reached ACTIVE (KYC+PoR+contract) from
//     the parent GroupChat and drops their SusuMember row,
//   • activates the Susu if ≥2 verified members remain (AZM-rank slots +
//     cycles, via Susu_Service.activateSusuIfReady),
const logger = require('../src/config/logger');
//   • otherwise aborts the initiation and unbinds the SusuGroup so the
//     chat returns to a plain group.
//
// All the logic lives in SusuInitiation_Service.sweepExpiredInitiations();
// this worker is just the scheduler shell. Idempotent — re-running after a
// crash mid-sweep is safe (already-removed members are no-ops).
// =============================================================================

class SusuInitiationSweep {
  constructor(prisma, susuInitiationService, { intervalMs = 60 * 1000 } = {}) {
    this.prisma = prisma;
    this.svc = susuInitiationService;
    this.intervalMs = intervalMs;
    this.interval = null;
    this._running = false;
  }

  start() {
    if (this.interval) return;
    logger.info(`[SusuInitiationSweep] starting (every ${this.intervalMs / 1000}s)`);
    setImmediate(() => this._tick().catch((e) => logger.error({ err: e }, '[SusuInitiationSweep] initial tick')));
    this.interval = setInterval(
      () => this._tick().catch((e) => logger.error({ err: e }, '[SusuInitiationSweep] tick')),
      this.intervalMs,
    );
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
      const results = await this.svc.sweepExpiredInitiations();
      if (results && results.length) {
        logger.info(`[SusuInitiationSweep] processed ${results.length} expired initiation(s):`,
          results.map((r) => `${r.susuId}=${r.outcome}`).join(', '));
      }
    } finally {
      this._running = false;
    }
  }
}

module.exports = SusuInitiationSweep;
