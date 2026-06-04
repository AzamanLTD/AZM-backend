// workers/susuCycleSchedulerV2.js
// =============================================================================
// Cycle_Scheduler (Phase 3) — Reqs 10, 11
//
// Sweeps SusuCycle rows whose status=PENDING and scheduledRunAt<=NOW() at
// 60-second cadence (Req 10.1). For each due cycle, calls
// SusuCycleService.processCycle which acquires a Postgres advisory lock,
// flips PENDING→COLLECTING atomically, processes per-member contributions
// in independent transactions, applies seizures + Voucher_Slash, fires
// the Circuit Breaker if needed, and finalizes with payout (or escrow
// diversion if the recipient has defaulted).
//
// Multi-worker safety: the advisory-lock guard inside processCycle makes
// it safe to start more than one of these workers without double-charge
// risk. Crash recovery: the conditional UPDATE pattern means a half-
// processed cycle that was interrupted mid-run will be picked up on the
// next tick — the per-member SusuContribution unique constraint ensures
// idempotency.
// =============================================================================

class SusuCycleSchedulerV2 {
  constructor(prisma, susuCycleService, { intervalMs = 60_000, batchSize = 25 } = {}) {
    this.prisma = prisma;
    this.cycleService = susuCycleService;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.interval = null;
    this._running = false;
  }

  start() {
    if (this.interval) return;
    console.log(`[SusuCycleSchedulerV2] starting (every ${this.intervalMs / 1000}s, batch ${this.batchSize})`);
    // Initial tick on next loop turn so the worker picks up cycles
    // already due at boot. Subsequent ticks every intervalMs.
    setImmediate(() => this._tick().catch(err => console.error('[SusuCycleSchedulerV2] initial tick error:', err.message)));
    this.interval = setInterval(() => this._tick().catch(err => console.error('[SusuCycleSchedulerV2] tick error:', err.message)), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async _tick() {
    if (this._running) return; // single-flight per process
    this._running = true;
    try {
      const now = new Date();
      // Two classes of cycle need processing each tick:
      //   1. PENDING cycles whose collectionDate has arrived (first run).
      //   2. COLLECTING_GRACE cycles (Phase 5 / Workstream C) — already due
      //      and parked in the 24h grace window. We re-evaluate them every
      //      tick so a member who tops up gets funded immediately, and so
      //      the cycle hard-defaults the moment graceUntil passes. These
      //      have no collectionDate gate (they're already past due).
      const due = await this.prisma.susuCycle.findMany({
        where: {
          OR: [
            { status: 'PENDING', collectionDate: { lte: now } },
            { status: 'COLLECTING_GRACE' },
          ],
          // Skip cycles whose parent Susu is frozen (Req 11.10)
          susu: { status: { notIn: ['FROZEN_DISPUTE', 'CANCELLED', 'COMPLETED'] } },
        },
        take: this.batchSize,
        orderBy: { collectionDate: 'asc' },
        select: { id: true, susuGroupId: true, cycleNumber: true },
      });
      for (const c of due) {
        try {
          await this.cycleService.processCycle(c.id);
        } catch (err) {
          console.error(`[SusuCycleSchedulerV2] cycle ${c.id} failed:`, err.message);
        }
      }
    } finally {
      this._running = false;
    }
  }
}

module.exports = SusuCycleSchedulerV2;
