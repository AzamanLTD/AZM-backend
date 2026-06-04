// workers/porExpirySweep.js
// =============================================================================
// PoR_Expiry_Sweep — Req 3.9
//
// Daily sweep that flips User.proofOfResidencyStatus from VERIFIED to
// EXPIRED whenever proofOfResidencyVerifiedAt is older than 365 days.
// Affected users have their ACTIVE SusuMember rows reverted to
// PENDING_VOUCH (Req 14.5) and the parent SusuGroup pushed back to
// CONFIGURING (Req 2.6). A SUSU notification fires per affected user.
//
// Idempotent: the UPDATE is guarded by status='VERIFIED' so re-runs
// against already-EXPIRED rows are no-ops.
// =============================================================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS = 365;

class PorExpirySweep {
  constructor(prisma, susuMemberService, notificationService, { intervalMs = ONE_DAY_MS } = {}) {
    this.prisma = prisma;
    this.susuMemberService = susuMemberService;
    this.notificationService = notificationService;
    this.intervalMs = intervalMs;
    this.interval = null;
    this._running = false;
  }

  start() {
    if (this.interval) return;
    console.log(`[PorExpirySweep] starting (every ${this.intervalMs / 1000}s)`);
    // First tick fires soon after boot to catch anything that expired
    // while the server was down. Subsequent ticks at intervalMs cadence.
    setTimeout(() => this._tick().catch(err => console.error('[PorExpirySweep] initial tick:', err.message)), 30_000);
    this.interval = setInterval(() => this._tick().catch(err => console.error('[PorExpirySweep] tick:', err.message)), this.intervalMs);
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
      const cutoff = new Date(Date.now() - EXPIRY_DAYS * ONE_DAY_MS);

      // Capture which users are about to flip so we can act on them
      // post-update.
      const candidates = await this.prisma.user.findMany({
        where: {
          proofOfResidencyStatus: 'VERIFIED',
          proofOfResidencyVerifiedAt: { lt: cutoff },
        },
        select: { id: true },
      });
      if (candidates.length === 0) return;

      await this.prisma.user.updateMany({
        where: {
          proofOfResidencyStatus: 'VERIFIED',
          proofOfResidencyVerifiedAt: { lt: cutoff },
        },
        data: { proofOfResidencyStatus: 'EXPIRED' },
      });

      for (const u of candidates) {
        await this._handleExpiredUser(u.id);
      }
    } finally {
      this._running = false;
    }
  }

  async _handleExpiredUser(userId) {
    // Walk every ACTIVE SusuMember row of this user and revert it back
    // to PENDING_VOUCH. The parent SusuGroup falls to CONFIGURING.
    // Cycle_Scheduler then refuses to advance any cycle of that
    // SusuGroup (Req 11.10 / 2.6) until the user re-uploads PoR.
    const members = await this.prisma.susuMember.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, susuGroupId: true },
    });
    for (const m of members) {
      try {
        await this.prisma.$transaction(async (tx) => {
          if (this.susuMemberService) {
            await this.susuMemberService.revertActiveToPendingVouch(m.id, tx);
          } else {
            await tx.susuMember.update({
              where: { id: m.id },
              data: { status: 'PENDING_VOUCH' },
            });
          }
          await tx.susuGroup.update({
            where: { id: m.susuGroupId },
            data: { status: 'CONFIGURING' },
          });
        });
      } catch (err) {
        console.error(`[PorExpirySweep] revert member ${m.id} failed:`, err.message);
      }
    }

    if (this.notificationService) {
      try {
        await this.notificationService.sendNotification({
          userId,
          title: 'Proof of Residency expired',
          body: 'Your residency document has expired. Re-upload a recent one to keep participating in any active Susu.',
          category: 'SUSU',
          actionPayload: { action: 'OPEN_PROOF_OF_RESIDENCY' },
        });
      } catch (err) {
        console.warn(`[PorExpirySweep] notify ${userId} failed:`, err.message);
      }
    }
  }
}

module.exports = PorExpirySweep;
