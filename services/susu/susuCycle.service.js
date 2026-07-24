// services/susu/susuCycle.service.js
// =============================================================================
// SusuCycle_Service — Reqs 10, 11
//
// The Phase-3 cycle-execution algorithm. Sits beside the legacy
// services/susuService.js#processCycle and supersedes it. The Cycle_Scheduler
// worker calls processCycle(cycleId) on this service for any cycle whose
// parent SusuGroup has the new contractVersion column populated (i.e.
// activated through the Phase-2 onboarding flow). Legacy SusuGroups remain
// on the original code path.
//
// Owns:
//   - Multi-worker safe transition PENDING → COLLECTING via advisory lock +
//     conditional UPDATE (Property 10)
//   - Per-member atomic deduction (Req 10.3, 10.4, 10.5)
//   - Default seizure routing (Property 2 — defaulter-IS-recipient → treasury)
//   - Voucher_Slash invocation atomic with seizure (Req 7.7)
//   - Circuit Breaker firing (Req 11.9, Property 17)
//   - Escrow diversion when recipient is DEFAULTED (Req 10.8, Property 14
//     not — that's the privacy property; here it's Req 10.8 / 10.12)
//   - Parent SusuGroup COMPLETED transition when last cycle finishes
//     (Req 10.10)
// =============================================================================

const logger = require('../../src/config/logger');
const { Prisma } = require('@prisma/client');
const { SusuError, ErrorCodes } = require('./errors');

const CIRCUIT_BREAKER_DEFAULT_THRESHOLD = 2;

// ── PHASE 5 / Workstream C (2026-06-01): Penalty ladder constants ────────────
// Operator-locked business rules:
//   • Grace window = exactly 24 hours from the moment a cycle first detects
//     a shortfall (cycle → COLLECTING_GRACE, SusuCycle.graceUntil set).
//   • Minor penalty applied at grace entry = 5% of the shorting member's own
//     azmBalance, floored at 0, rounded down to whole AZM. Applied exactly
//     once per (member, cycle) — idempotency tracked via a SusuReminderSent
//     row of reminderType GRACE_MINOR_PENALTY.
//   • Hard default at grace expiry reuses the standard seizure + 25%
//     Voucher_Slash + DEFAULTED transition. A defaulter's own future payout
//     cycles divert to treasury escrow automatically (the recipient-defaulted
//     branch in _finalizeCycle), which is the "strip future payouts" rule.
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const MINOR_PENALTY_RATE = '0.05';
const GRACE_PENALTY_MARKER = 'GRACE_MINOR_PENALTY';

class SusuCycleService {
  constructor(prisma, {
    susuVouchService,
    susuMemberService,
    adminWarRoomService,
    notificationService,
    io,
    treasuryUserId, // resolved at startup; see server.js
  } = {}) {
    if (!prisma) throw new Error('SusuCycleService: prisma required');
    this.prisma = prisma;
    this.susuVouchService = susuVouchService;
    this.susuMemberService = susuMemberService;
    this.adminWarRoomService = adminWarRoomService;
    this.notificationService = notificationService;
    this.io = io;
    this.treasuryUserId = treasuryUserId;
  }

  // ── Public entry ──────────────────────────────────────────────────────
  async processCycle(cycleId) {
    if (!this.treasuryUserId) {
      throw new Error('SusuCycleService: treasuryUserId not configured');
    }
    return this._processCycleInternal(cycleId);
  }

  // ── Multi-worker safe lock + state transition ─────────────────────────
  // Returns { acquired, cycle, susu, priorStatus } or { acquired: false }.
  //
  // Claims a cycle from PENDING (first run), COLLECTING_GRACE (grace
  // re-evaluation — members may have topped up, or the 24h window may have
  // expired), or a STALLED COLLECTING cycle (crash recovery: a prior run
  // flipped it to the transient COLLECTING state then died). In every case
  // the row is moved into the transient COLLECTING state under the advisory
  // lock so exactly one worker proceeds; the caller decides the terminal
  // disposition (grace / payout / default).
  async _acquireCycle(cycleId) {
    return this.prisma.$transaction(async (tx) => {
      const lockKey = await this._cycleIdToBigint(cycleId);
      const [{ pg_try_advisory_xact_lock: locked }] = await tx.$queryRawUnsafe(
        `SELECT pg_try_advisory_xact_lock(${lockKey}) AS pg_try_advisory_xact_lock`,
      );
      if (!locked) return { acquired: false };

      // Read current status so we can record what we transitioned from
      // (PENDING vs COLLECTING_GRACE) — the caller needs this to know
      // whether graceUntil is already set and to revert correctly when the
      // parent Susu is frozen.
      const current = await tx.susuCycle.findUnique({
        where: { id: cycleId },
        select: { status: true, startedCollectingAt: true },
      });
      if (!current) return { acquired: false };

      let priorStatus = null;
      if (current.status === 'PENDING') {
        const upd = await tx.susuCycle.updateMany({
          where: { id: cycleId, status: 'PENDING' },
          data: { status: 'COLLECTING', startedCollectingAt: new Date() },
        });
        if (upd.count === 0) return { acquired: false };
        priorStatus = 'PENDING';
      } else if (current.status === 'COLLECTING_GRACE') {
        const upd = await tx.susuCycle.updateMany({
          where: { id: cycleId, status: 'COLLECTING_GRACE' },
          data: { status: 'COLLECTING' },
        });
        if (upd.count === 0) return { acquired: false };
        priorStatus = 'COLLECTING_GRACE';
      } else if (current.status === 'COLLECTING') {
        // Stalled transient state (crash recovery). Only reclaim if the
        // collection started more than 5 minutes ago, so we never steal a
        // cycle a sibling worker is actively processing.
        const startedAt = current.startedCollectingAt
          ? new Date(current.startedCollectingAt).getTime() : 0;
        if (Date.now() - startedAt < 5 * 60 * 1000) return { acquired: false };
        priorStatus = 'COLLECTING';
      } else {
        return { acquired: false };
      }

      const cycle = await tx.susuCycle.findUnique({
        where: { id: cycleId },
        include: {
          susu: {
            include: {
              members: { include: { user: true } },
              groupChat: { select: { id: true, name: true, createdById: true } },
            },
          },
          payoutUser: { select: { id: true } },
        },
      });
      return { acquired: true, cycle, susu: cycle.susu, priorStatus };
    });
  }

  async _cycleIdToBigint(cycleId) {
    // Postgres has hashtextextended(text, bigint) which yields a stable
    // 64-bit signed result we can hand to pg_try_advisory_xact_lock.
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT hashtextextended('${cycleId.replace(/'/g, "''")}'::text, 0)::int8 AS k`,
    );
    return rows[0].k;
  }

  // ── Top-level orchestration ───────────────────────────────────────────
  async _processCycleInternal(cycleId) {
    const acquired = await this._acquireCycle(cycleId);
    if (!acquired.acquired) {
      return { skipped: true, reason: 'cycle locked or already advanced' };
    }
    const { cycle, susu, priorStatus } = acquired;

    // Property 18: a frozen Susu's cycles never advance.
    if (susu.status === 'FROZEN_DISPUTE') {
      // Revert the transient COLLECTING flip back to whatever the cycle was
      // before we acquired it (PENDING or COLLECTING_GRACE) so it resumes
      // when the freeze lifts.
      await this.prisma.susuCycle.update({
        where: { id: cycle.id },
        data: priorStatus === 'COLLECTING_GRACE'
          ? { status: 'COLLECTING_GRACE' }
          : { status: 'PENDING', startedCollectingAt: null },
      });
      return { skipped: true, reason: 'parent Susu FROZEN_DISPUTE' };
    }

    const contribution = new Prisma.Decimal(susu.contributionUsdc);
    const activeMembers = [...susu.members]
      .filter(m => m.status === 'ACTIVE')
      .sort((a, b) => {
        const dt = a.createdAt - b.createdAt;
        if (dt !== 0) return dt;
        return a.id.localeCompare(b.id);
      });

    // Penalty-ladder gate (Phase 5 / Workstream C). A non-null graceUntil
    // means the cycle already opened its 24h grace window on a prior tick.
    // graceExpired => we hard-default any member who is STILL short now.
    const now = new Date();
    const graceActive = !!cycle.graceUntil;
    const graceExpired = graceActive && now.getTime() >= new Date(cycle.graceUntil).getTime();

    const defaultsThisCycle = [];   // members hard-defaulted in this pass
    const shortingMembers = [];     // members short but still within grace
    let circuitBreakerFired = false;

    for (const member of activeMembers) {
      if (circuitBreakerFired) break;

      let memberDefaulted = false;
      let defaultIsAdmin = false;
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          // Idempotency guard (Property 13): a contribution row already
          // exists if a prior tick fully processed this member (PAID or
          // SEIZED). Skip silently.
          const existing = await tx.susuContribution.findUnique({
            where: { cycleId_memberId: { cycleId: cycle.id, memberId: member.id } },
          });
          if (existing) return { idempotent: true };

          const u = await tx.user.findUnique({
            where: { id: member.userId },
            select: { availableBalance: true },
          });
          const balance = new Prisma.Decimal(u.availableBalance);

          // ── Happy path — full deduction (Req 10.4). Available on every
          // tick: a member who tops up DURING the grace window funds the
          // cycle and avoids the hard default entirely.
          if (balance.gte(contribution)) {
            await tx.user.update({
              where: { id: member.userId },
              data: { availableBalance: { decrement: contribution } },
            });
            await tx.susuContribution.create({
              data: {
                cycleId: cycle.id,
                memberId: member.id,
                userId: member.userId,
                amountUsdc: contribution,
                status: 'PAID',
              },
            });
            await tx.transactionHistory.create({
              data: {
                userId: member.userId,
                type: 'SUSU_CONTRIBUTION',
                amountUsdc: contribution.neg(),
                status: 'COMPLETED',
                metadata: { cycleId: cycle.id, susuGroupId: susu.id },
              },
            }).catch(() => {});
            return { paid: true };
          }

          // ── Shortfall. If we're not yet past the grace deadline, leave
          // the member untouched (no contribution row, no seizure) so the
          // cycle can hold in COLLECTING_GRACE and give them 24h to fund.
          if (!graceExpired) {
            return { short: true };
          }

          // ── Grace expired → HARD DEFAULT. Seize available balance, route
          // per Req 11.3 (defaulter IS recipient → treasury), record the
          // contribution, flip to DEFAULTED, apply the 25% Voucher_Slash.
          const seizable = balance;
          const shortfall = contribution.minus(seizable);
          const isSelfPayout = cycle.payoutUserId === member.userId;
          const seizureCreditUserId = isSelfPayout
            ? this.treasuryUserId
            : cycle.payoutUserId;

          if (seizable.gt(0)) {
            await tx.user.update({
              where: { id: member.userId },
              data: { availableBalance: { decrement: seizable } },
            });
            await tx.user.update({
              where: { id: seizureCreditUserId },
              data: { availableBalance: { increment: seizable } },
            });
            await tx.transactionHistory.create({
              data: {
                userId: member.userId,
                type: 'SUSU_SEIZURE',
                amountUsdc: seizable.neg(),
                status: 'COMPLETED',
                metadata: { cycleId: cycle.id, susuGroupId: susu.id, creditedTo: seizureCreditUserId },
              },
            }).catch(() => {});
          }

          await tx.susuContribution.create({
            data: {
              cycleId: cycle.id,
              memberId: member.id,
              userId: member.userId,
              amountUsdc: contribution,
              status: seizable.gt(0) ? 'SEIZED' : 'FAILED_INSUFFICIENT',
              seizedFromAvailable: seizable,
              shortfall,
            },
          });

          if (this.susuMemberService) {
            await this.susuMemberService.transitionToDefaulted(member.id, tx);
          } else {
            await tx.susuMember.update({
              where: { id: member.id },
              data: { status: 'DEFAULTED', defaultedAt: new Date() },
            });
          }

          if (this.susuVouchService) {
            await this.susuVouchService.applySlash(
              {
                defaultingMemberId: member.id,
                defaultingUserId: member.userId,
                susuGroupId: susu.id,
                cycleId: cycle.id,
              },
              tx,
            );
          }

          const gm = await tx.groupMember.findFirst({
            where: { groupId: susu.groupChat.id, userId: member.userId },
            select: { role: true },
          });
          return {
            defaulted: true,
            seizable,
            shortfall,
            isAdmin: gm?.role === 'ADMIN',
          };
        });

        if (result.idempotent) continue;

        if (result.short) {
          shortingMembers.push(member);
          continue;
        }

        if (result.defaulted) {
          memberDefaulted = true;
          defaultIsAdmin = result.isAdmin;
          defaultsThisCycle.push({
            memberId: member.id,
            userId: member.userId,
            seized: result.seizable,
            shortfall: result.shortfall,
            isAdmin: result.isAdmin,
          });

          if (this.notificationService) {
            setImmediate(() => this.notificationService.sendNotification({
              userId: member.userId,
              title: 'Susu Default Recorded',
              body: `Cycle ${cycle.cycleNumber}: $${result.seizable.toFixed(2)} seized for "${susu.groupChat.name}" after the 24h grace period lapsed.`,
              category: 'SUSU',
              actionPayload: { action: 'OPEN_SUSU', susuId: susu.id, cycleId: cycle.id },
            }).catch(() => {}));
          }
        }
      } catch (err) {
        logger.error(`[SusuCycleService] member ${member.id} cycle ${cycle.id} error:`, err.message);
        continue;
      }

      // ── Circuit Breaker check (Req 11.9, Property 17) ─────────────────
      if (memberDefaulted) {
        const triggerAdmin = defaultIsAdmin;
        const triggerThreshold = defaultsThisCycle.length >= CIRCUIT_BREAKER_DEFAULT_THRESHOLD;
        if (triggerAdmin || triggerThreshold) {
          const reason = triggerAdmin ? 'ADMIN_DEFAULT' : 'MASS_DEFAULT_THRESHOLD';
          await this._fireCircuitBreaker(susu, cycle, reason, defaultsThisCycle);
          circuitBreakerFired = true;
        }
      }
    }

    // ── Disposition ───────────────────────────────────────────────────
    if (circuitBreakerFired) {
      await this.prisma.susuCycle.update({
        where: { id: cycle.id },
        data: { status: 'DEFAULTED' },
      });
      return { circuitBreaker: true, defaults: defaultsThisCycle.length };
    }

    // Members short and still inside the grace window → hold the cycle in
    // COLLECTING_GRACE. On the FIRST detection (graceUntil null) open the
    // 24h window, apply the −5% minor penalty + warning strike. On a repeat
    // grace tick (graceUntil already set, not yet expired) just re-park.
    if (shortingMembers.length > 0 && !graceExpired) {
      return this._enterOrHoldGrace(cycle, susu, shortingMembers, contribution);
    }

    // No outstanding shortfalls (everyone PAID, or laggards hard-defaulted)
    // → finalize with payout / escrow diversion.
    return this._finalizeCycle(cycle, susu);
  }

  // ── Grace entry / hold (Phase 5 / Workstream C) ───────────────────────
  // First detection: set graceUntil = now+24h, apply the minor AZM penalty
  // (−5%, floor 0, idempotent per member+cycle) and send the severe warning
  // strike. Subsequent grace ticks (window still open) just re-park the
  // cycle in COLLECTING_GRACE without re-penalising.
  async _enterOrHoldGrace(cycle, susu, shortingMembers, contribution) {
    const firstEntry = !cycle.graceUntil;
    const graceUntil = firstEntry
      ? new Date(Date.now() + GRACE_PERIOD_MS)
      : new Date(cycle.graceUntil);

    if (firstEntry) {
      for (const member of shortingMembers) {
        try {
          await this._applyMinorPenalty(member, cycle, susu);
        } catch (err) {
          logger.error(`[SusuCycleService] minor penalty member ${member.id} cycle ${cycle.id}:`, err.message);
        }
      }
    }

    await this.prisma.susuCycle.update({
      where: { id: cycle.id },
      data: { status: 'COLLECTING_GRACE', graceUntil },
    });

    if (this.io) {
      this.io.to(`susu_${susu.id}`).emit('susu:cycle_grace', {
        cycleId: cycle.id,
        cycleNumber: cycle.cycleNumber,
        graceUntil: graceUntil.toISOString(),
        shortMemberCount: shortingMembers.length,
      });
    }

    return {
      grace: true,
      firstEntry,
      graceUntil: graceUntil.toISOString(),
      shortMembers: shortingMembers.length,
    };
  }

  // Apply the minor AZM penalty exactly once per (member, cycle). Uses a
  // SusuReminderSent row (reminderType GRACE_MINOR_PENALTY) as the
  // idempotency marker — the unique (susuMemberId, susuCycleId,
  // reminderType) index guarantees one penalty per cycle even across
  // worker restarts / re-acquisitions. Penalty = 5% of the member's own
  // azmBalance, floored at 0, rounded down to whole AZM.
  async _applyMinorPenalty(member, cycle, susu) {
    let deduction = new Prisma.Decimal(0);
    try {
      deduction = await this.prisma.$transaction(async (tx) => {
        // Idempotency marker first — if it already exists, P2002 aborts the
        // txn and we skip the deduction.
        await tx.susuReminderSent.create({
          data: {
            susuMemberId: member.id,
            susuCycleId: cycle.id,
            susuGroupId: susu.id,
            reminderType: GRACE_PENALTY_MARKER,
          },
        });

        const u = await tx.user.findUnique({
          where: { id: member.userId },
          select: { azmBalance: true },
        });
        const azmBefore = new Prisma.Decimal(u?.azmBalance || 0);
        const ded = Prisma.Decimal.min(
          azmBefore.mul(MINOR_PENALTY_RATE).floor(),
          azmBefore,
        );

        if (ded.gt(0)) {
          await tx.user.update({
            where: { id: member.userId },
            data: { azmBalance: azmBefore.sub(ded) },
          });
        }
        return ded;
      });
    } catch (err) {
      // P2002 = penalty already applied on a prior tick (idempotent skip).
      // Anything else is logged and swallowed so a single member's penalty
      // failure never derails the cycle.
      if (err && err.code !== 'P2002') {
        logger.error(`[SusuCycleService] _applyMinorPenalty ${member.id}:`, err.message);
      }
      return;
    }

    // Severe warning strike (post-commit, best-effort).
    if (this.notificationService) {
      const contributionStr = new Prisma.Decimal(susu.contributionUsdc).toFixed(2);
      setImmediate(() => this.notificationService.sendNotification({
        userId: member.userId,
        title: '⚠️ Susu Grace Period — Fund Within 24h',
        body: `You fell short on cycle ${cycle.cycleNumber} of "${susu.groupChat.name}". `
          + `${deduction.gt(0) ? `${deduction.toFixed(0)} AZM penalty applied. ` : ''}`
          + `Top up within 24 hours or your balance will be seized and your AZM slashed 25%.`,
        category: 'SUSU',
        actionPayload: {
          action: 'OPEN_DEPOSIT_FOR_SUSU',
          amount: contributionStr,
          susuId: susu.id,
          cycleId: cycle.id,
          azmPenalty: deduction.toString(),
        },
      }).catch(() => {}));
    }
  }

  // ── Cycle finalization (payout or escrow divert) ──────────────────────
  async _finalizeCycle(cycle, susu) {
    return this.prisma.$transaction(async (tx) => {
      const contributions = await tx.susuContribution.findMany({
        where: { cycleId: cycle.id, status: 'PAID' },
        select: { amountUsdc: true },
      });
      const seizures = await tx.susuContribution.findMany({
        where: { cycleId: cycle.id, status: 'SEIZED' },
        select: { seizedFromAvailable: true },
      });
      const pooled = contributions.reduce(
        (a, c) => a.plus(c.amountUsdc),
        new Prisma.Decimal(0),
      );
      const seizedTotal = seizures.reduce(
        (a, c) => a.plus(c.seizedFromAvailable || 0),
        new Prisma.Decimal(0),
      );

      // Default-only cycle (no PAID rows) → DEFAULTED, no payout (Req 10.7)
      if (contributions.length === 0) {
        await tx.susuCycle.update({
          where: { id: cycle.id },
          data: {
            status: 'DEFAULTED',
            paidOutAt: new Date(),
            payoutAmount: new Prisma.Decimal(0),
            defaultsCount: await tx.susuMember.count({
              where: { susuGroupId: susu.id, status: 'DEFAULTED' },
            }),
          },
        });
        return { cycleStatus: 'DEFAULTED', pooled: 0 };
      }

      // Recipient defaulted before/at this cycle → divert (Req 10.8)
      const recipient = await tx.susuMember.findUnique({
        where: {
          susuGroupId_userId: { susuGroupId: susu.id, userId: cycle.payoutUserId },
        },
        select: { status: true },
      });
      const recipientDefaulted = recipient?.status === 'DEFAULTED';

      // The contribution-side debits already happened in the per-member
      // transactions. We only need to credit the destination side now.
      // Seizures from defaulters were already credited to recipient (or
      // treasury for self-default) inside the seizure txn — pooled is
      // distinct from seizedTotal. Final payout = pooled only.
      const creditUserId = recipientDefaulted
        ? this.treasuryUserId
        : cycle.payoutUserId;

      // ── Auto-retain enforcement (Phase 5 / Workstream C) ──────────────
      // If the recipient opted into autoRetainNextCycle AND they still owe
      // a contribution to a later cycle in this Susu, keep the exact next
      // contribution amount reserved in their availableBalance instead of
      // treating the whole pool as freely-withdrawable. Because payouts and
      // contributions share the single availableBalance ledger, the funds
      // physically remain on the recipient (we credit the full pool), but
      // we tag the payout with the retained amount so the client surfaces
      // "set aside for next cycle" and the next cycle self-funds without a
      // manual top-up. Only meaningful for a non-diverted payout to an
      // ACTIVE recipient.
      let autoRetained = new Prisma.Decimal(0);
      if (!recipientDefaulted) {
        const recipientMember = await tx.susuMember.findUnique({
          where: {
            susuGroupId_userId: { susuGroupId: susu.id, userId: cycle.payoutUserId },
          },
          select: { autoRetainNextCycle: true },
        });
        if (recipientMember?.autoRetainNextCycle) {
          const hasFutureCycle = await tx.susuCycle.count({
            where: {
              susuGroupId: susu.id,
              cycleNumber: { gt: cycle.cycleNumber },
              status: { notIn: ['PAID_OUT', 'DEFAULTED'] },
            },
          });
          if (hasFutureCycle > 0) {
            const contributionAmt = new Prisma.Decimal(susu.contributionUsdc);
            autoRetained = Prisma.Decimal.min(contributionAmt, pooled);
          }
        }
      }

      await tx.user.update({
        where: { id: creditUserId },
        data: { availableBalance: { increment: pooled } },
      });

      await tx.transactionHistory.create({
        data: {
          userId: creditUserId,
          type: 'SUSU_PAYOUT',
          amountUsdc: pooled,
          status: 'COMPLETED',
          metadata: {
            cycleId: cycle.id,
            susuGroupId: susu.id,
            divertReason: recipientDefaulted ? 'DEFAULTED_RECIPIENT' : null,
            autoRetained: autoRetained.gt(0) ? autoRetained.toString() : null,
          },
        },
      }).catch(() => {});

      const updateData = {
        status: 'PAID_OUT',
        paidOutAt: new Date(),
        payoutAmount: pooled,
      };
      if (recipientDefaulted) updateData.escrowDivertedAt = new Date();
      await tx.susuCycle.update({ where: { id: cycle.id }, data: updateData });

      // Fire ESCROW_DIVERSION War Room alert if needed (Req 10.12)
      if (recipientDefaulted && this.adminWarRoomService) {
        await this.adminWarRoomService.fireAlert({
          alertType: 'ESCROW_DIVERSION',
          susuGroupId: susu.id,
          cycleId: cycle.id,
          payload: {
            summary: `Cycle ${cycle.cycleNumber} diverted to treasury`,
            defaultedRecipientId: cycle.payoutUserId,
            pooled: pooled.toString(),
          },
        }, tx);
      }

      // Notify ACTIVE members (Req 10.11 / 10.12)
      if (this.notificationService) {
        const activeMembers = await tx.susuMember.findMany({
          where: { susuGroupId: susu.id, status: 'ACTIVE' },
          select: { userId: true },
        });
        for (const m of activeMembers) {
          const isRecipient = m.userId === cycle.payoutUserId;
          const retainNote = isRecipient && autoRetained.gt(0)
            ? ` $${autoRetained.toFixed(2)} was set aside for your next cycle.`
            : '';
          setImmediate(() => this.notificationService.sendNotification({
            userId: m.userId,
            title: recipientDefaulted ? 'Susu Cycle — Payout Diverted' : 'Susu Cycle Paid Out',
            body: recipientDefaulted
              ? `Cycle ${cycle.cycleNumber} pool ($${pooled.toFixed(2)}) was diverted to platform escrow because the designated recipient defaulted.`
              : `Cycle ${cycle.cycleNumber}: $${pooled.toFixed(2)} paid out.${retainNote}`,
            category: 'SUSU',
            actionPayload: { action: 'OPEN_SUSU', susuId: susu.id, cycleId: cycle.id },
          }).catch(() => {}));
        }
      }

      // Socket fanout
      if (this.io) {
        this.io.to(`susu_${susu.id}`).emit('susu:cycle_paid_out', {
          cycleId: cycle.id,
          cycleNumber: cycle.cycleNumber,
          payoutUserId: cycle.payoutUserId,
          amount: Number(pooled.toFixed(2)),
          escrowDiverted: !!recipientDefaulted,
          autoRetained: Number(autoRetained.toFixed(2)),
        });
      }

      // Parent Susu COMPLETED check (Req 10.10)
      const remainingNonTerminal = await tx.susuCycle.count({
        where: {
          susuGroupId: susu.id,
          status: { notIn: ['PAID_OUT', 'DEFAULTED'] },
        },
      });
      if (remainingNonTerminal === 0) {
        await tx.susuGroup.update({
          where: { id: susu.id },
          data: { status: 'COMPLETED' },
        });
      }

      return {
        cycleStatus: 'PAID_OUT',
        pooled: pooled.toString(),
        escrowDiverted: !!recipientDefaulted,
        autoRetained: autoRetained.toString(),
      };
    });
  }

  // ── Circuit Breaker (Req 11.9) ────────────────────────────────────────
  async _fireCircuitBreaker(susu, cycle, reason, defaultsSoFar) {
    const startedAt = Date.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.susuGroup.update({
        where: { id: susu.id },
        data: {
          status: 'FROZEN_DISPUTE',
          frozenAt: new Date(),
          frozenReason: reason,
        },
      });
      if (this.adminWarRoomService) {
        await this.adminWarRoomService.fireAlert({
          alertType: reason,
          susuGroupId: susu.id,
          cycleId: cycle.id,
          payload: {
            summary: reason === 'ADMIN_DEFAULT'
              ? 'Susu admin defaulted — Susu frozen'
              : `${defaultsSoFar.length} simultaneous defaults — Susu frozen`,
            defaultingUserIds: defaultsSoFar.map(d => d.userId),
            cycleNumber: cycle.cycleNumber,
          },
        }, tx);
      }
    });

    // Property 17 SLA: halt within 5 seconds. Log if we miss it.
    const elapsed = Date.now() - startedAt;
    if (elapsed > 5000) {
      logger.warn(`[SusuCycle] Circuit Breaker took ${elapsed}ms (>5s SLA)`);
    }
  }
}

module.exports = SusuCycleService;
