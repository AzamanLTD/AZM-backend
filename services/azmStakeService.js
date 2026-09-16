'use strict';

// =============================================================================
// AZM Staking Service — Nitro tier staking with DEBIT/RETURN backing
//
// Economic invariant (2026-09-16, stake atomicity PR):
//   For every user U, sum(amountAzm of ACTIVE + UNSTAKING stakes) is backed
//   by AZM that has been REMOVED from U's freely spendable azmBalance and
//   remains unavailable until the completed unstake releases it.
//   azmBalance can never go negative; an ACTIVE/UNSTAKING stake never
//   represents AZM that is still spendable elsewhere.
//
// Mechanism: the stake principal lives in exactly one place at a time —
// in azmBalance (free) or locked inside AzmStake rows. createStake moves it
// out with a conditional (gte) debit inside the same transaction that creates
// the stake and its authoritative AzmSpendLog (source STAKE_LOCK);
// completeUnstake moves it back inside the same transaction that performs
// the UNSTAKING→COMPLETED claim and its authoritative AzmRewardLog (source
// STAKE_RELEASE). Every state transition is a database-authoritative
// conditional mutation (CAS) — no read-then-write authorization survives.
//
// NOTE: prisma is passed as the first argument to every function
// (req.app.get('prisma')).
// =============================================================================

const { NITRO_THRESHOLDS, getTierForStake } = require('./nitroPolicy');
const { AZM_SPEND_SOURCES } = require('./azmSpendService');
const { AZM_SOURCES } = require('./azmRewardService');

const TIER_THRESHOLDS = NITRO_THRESHOLDS;
const COOLDOWN_DAYS = 7;

// Product semantic (2026-09-16, stake atomicity PR): stakes that are ACTIVE
// or UNSTAKING still hold the user's locked principal — the AZM is only
// returned when the cooldown completes — so they continue to count toward
// the Nitro tier until COMPLETED. A COMPLETED stake has released its
// principal back to azmBalance and no longer counts. Without this, a user
// who requests an unstake would lose premium features for the whole cooldown
// while their AZM stays locked.
const BACKED_STAKE_STATUSES = ['ACTIVE', 'UNSTAKING'];

// ── Tier derivation ─────────────────────────────────────────────────────────

async function getStakedBalance(prisma, userId) {
  const stakes = await prisma.azmStake.findMany({
    where: { userId, status: { in: BACKED_STAKE_STATUSES } },
  });
  return stakes.reduce((sum, s) => sum + Number(s.amountAzm), 0);
}

async function getUserTier(prisma, userId) {
  return getTierForStake(await getStakedBalance(prisma, userId));
}

// ── Stake creation (debit + stake + ledger, ONE transaction) ─────────────────

async function createStake(prisma, userId, amountAzm) {
  const amount = Number(amountAzm);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Stake amount must be positive.');

  return prisma.$transaction(async (tx) => {
    // 1. Database-boundary affordability gate. The conditional mutation IS
    //    the authorization: the gte predicate is evaluated against the live
    //    row at UPDATE time, so no stale read can ever authorize this debit.
    //    0 affected rows = insufficient balance (fail-closed: nothing — not
    //    the stake, not the ledger row — has been written yet).
    const debit = await tx.user.updateMany({
      where: { id: userId, azmBalance: { gte: amount } },
      data: { azmBalance: { decrement: amount } },
    });
    if (debit.count === 0) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { azmBalance: true } });
      const err = new Error(
        `Insufficient AZM balance. Required: ${amount}, available: ${user ? Number(user.azmBalance) : 0}.`
      );
      throw err;
    }

    // 2. The stake row — same transaction, so an unbacked stake can never
    //    commit. tierAtStake records the tier the user held BEFORE this
    //    stake (pre-existing contract).
    const tierBefore = await getTierForStake(
      (await tx.azmStake.findMany({ where: { userId, status: { in: BACKED_STAKE_STATUSES } } }))
        .reduce((sum, s) => sum + Number(s.amountAzm), 0)
    );
    const stake = await tx.azmStake.create({
      data: { userId, amountAzm: amount, status: 'ACTIVE', tierAtStake: tierBefore, cooldownDays: COOLDOWN_DAYS },
    });

    // 3. Authoritative ledger event — exactly-once by construction: the
    //    dedupKey is the stake's own id, minted in this same transaction, so
    //    it cannot repeat for any other stake. Any failure here rolls the
    //    debit and the stake back (no swallowed ledger errors).
    const user = await tx.user.findUnique({ where: { id: userId }, select: { azmBalance: true } });
    await tx.azmSpendLog.create({
      data: {
        userId,
        amount: amount,
        reason: `Staked ${amount} AZM (Nitro tier lock)`,
        source: AZM_SPEND_SOURCES.STAKE_LOCK,
        metadata: { stakeId: stake.id },
        dedupKey: `stake_lock_${stake.id}`,
        balanceAfter: user.azmBalance,
      },
    });

    // Compute the post-stake tier/staked balance on the transaction client:
    // the outer client cannot see the uncommitted stake row (READ COMMITTED).
    const newTier = await getUserTier(tx, userId);
    return { stake, tier: newTier, stakedBalance: await getStakedBalance(tx, userId) };
  });
}

// ── Unstake request (ACTIVE → UNSTAKING, single-winner CAS) ──────────────────

async function requestUnstake(prisma, userId, stakeId) {
  // Read only immutable attributes (owner, cooldown). The status read is a
  // convenience for the error contract — the conditional mutation below is
  // the authoritative single-winner gate.
  const stake = await prisma.azmStake.findUnique({ where: { id: stakeId } });
  if (!stake || stake.userId !== userId) throw new Error('Stake not found.');

  const now = new Date();
  const unstakeAvailableAt = new Date(now.getTime() + stake.cooldownDays * 86400000);

  const claim = await prisma.azmStake.updateMany({
    where: { id: stakeId, userId, status: 'ACTIVE' },
    data: { status: 'UNSTAKING', unstakeRequestedAt: now, unstakeAvailableAt },
  });
  if (claim.count === 0) throw new Error('Stake is not active.');

  return prisma.azmStake.findUnique({ where: { id: stakeId } });
}

// ── Unstake completion (release: claim + credit + ledger, ONE transaction) ────

async function completeUnstake(prisma, stakeId) {
  return prisma.$transaction(async (tx) => {
    // Fast path + immutable attributes for the release. The status/cooldown
    // decision is NOT made here — the CAS below re-evaluates both live.
    const stake = await tx.azmStake.findUnique({ where: { id: stakeId } });
    if (!stake || stake.status !== 'UNSTAKING') return null;
    if (!stake.unstakeAvailableAt || stake.unstakeAvailableAt > new Date()) return null;

    // Exactly-once terminal claim: the conditional UPDATE matches UNSTAKING
    // rows whose cooldown has elapsed. A racing worker's identical UPDATE
    // blocks on the row lock, then re-evaluates against the committed
    // COMPLETED row and matches 0 — it returns null without ever crediting.
    // There is no committed state in which the stake is COMPLETED but the
    // principal was not released, or the reverse: claim, credit and ledger
    // commit together.
    const claim = await tx.azmStake.updateMany({
      where: { id: stakeId, status: 'UNSTAKING', unstakeAvailableAt: { lte: new Date() } },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (claim.count === 0) return null;

    // Principal release. The increment returns the authoritative post-credit
    // balance, which becomes the ledger's balanceAfter.
    const { azmBalance: balanceAfter } = await tx.user.update({
      where: { id: stake.userId },
      data: { azmBalance: { increment: stake.amountAzm } },
      select: { azmBalance: true },
    });

    // Authoritative release ledger event — (userId, source, dedupKey=stakeId)
    // unique is the belt-and-suspenders exactly-once gate: if any future
    // refactor ever lets a second release reach this insert, the composite
    // unique aborts the WHOLE transaction (claim + credit roll back too).
    // Fail-closed: a ledger failure here rolls the claim and credit back.
    await tx.azmRewardLog.create({
      data: {
        userId: stake.userId,
        amount: stake.amountAzm,
        reason: `Stake release: unstake completed (${stake.amountAzm} AZM returned)`,
        source: AZM_SOURCES.STAKE_RELEASE,
        metadata: { stakeId: stake.id },
        dedupKey: `stake_release_${stake.id}`,
        balanceAfter,
      },
    });

    return tx.azmStake.findUnique({ where: { id: stakeId } });
  });
}

// ── Read model ───────────────────────────────────────────────────────────────

async function getUserStakes(prisma, userId) {
  return prisma.azmStake.findMany({ where: { userId }, orderBy: { stakedAt: 'desc' } });
}

// ── Worker surface (unchanged contracts) ────────────────────────────────────

async function processUnstakeQueue(prisma) {
  const now = new Date();
  const pending = await prisma.azmStake.findMany({ where: { status: 'UNSTAKING', unstakeAvailableAt: { lte: now } } });
  let completed = 0;
  for (const stake of pending) if (await completeUnstake(prisma, stake.id)) completed++;
  return { completed, total: pending.length };
}

async function checkActiveStakes(prisma) {
  const activeStakes = await prisma.azmStake.findMany({ where: { status: 'ACTIVE' } });
  return { checked: activeStakes.length };
}

module.exports = { TIER_THRESHOLDS, COOLDOWN_DAYS, BACKED_STAKE_STATUSES, getStakedBalance, getUserTier, createStake, requestUnstake, completeUnstake, getUserStakes, processUnstakeQueue, checkActiveStakes };
