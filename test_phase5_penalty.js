// test_phase5_penalty.js
// =============================================================================
// Phase 5 / Workstream C — Penalty Ladder & 24h Grace Period verification.
//
// Exercises SusuCycleService.processCycle directly against the local DB to
// prove the operator-locked penalty ladder:
//
//   T=0  (cycle due, member short)  → cycle enters COLLECTING_GRACE,
//                                      graceUntil = now+24h, −5% AZM minor
//                                      penalty applied (floor 0, idempotent),
//                                      NO seizure, NO DEFAULT, member ACTIVE.
//   T<24h (member tops up)          → next tick funds the cycle, payout,
//                                      no hard default, no extra penalty.
//   T+24h (still short)             → HARD DEFAULT: seize availableBalance,
//                                      25% Voucher_Slash, member DEFAULTED,
//                                      cycle finalized.
//   Auto-retain                     → recipient with autoRetainNextCycle and a
//                                      future cycle keeps the next contribution
//                                      tagged as retained in the payout.
//
// Run:  node test_phase5_penalty.js   (against local DB)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { Prisma } = require('@prisma/client');
const prisma = new PrismaClient();

const SusuCycleService = require('./services/susu/susuCycle.service');
const SusuMemberService = require('./services/susu/susuMember.service');
const SusuVouchService = require('./services/susu/susuVouch.service');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const TAG = `pen_${Date.now()}`;

async function mkUser(suffix, { available = '0', azm = '0' } = {}) {
  return prisma.user.create({
    data: {
      username: `${TAG}_${suffix}`,
      email: `${TAG}_${suffix}@test.local`,
      password: 'x',
      kycStatus: 'VERIFIED',
      proofOfResidencyStatus: 'VERIFIED',
      proofOfResidencyVerifiedAt: new Date(),
      availableBalance: new Prisma.Decimal(available),
      azmBalance: new Prisma.Decimal(azm),
      trustRating: 100,
    },
  });
}

async function ensureTreasury() {
  let t = await prisma.user.findUnique({ where: { username: 'azaman-treasury' } });
  if (!t) {
    t = await prisma.user.create({
      data: {
        username: 'azaman-treasury',
        email: 'treasury@azaman.internal',
        password: '!unusable!',
        role: 'ADMIN',
        kycStatus: 'VERIFIED',
      },
    });
  }
  return t;
}

// Build a 2-member ACTIVE Susu with a group chat, and one PENDING cycle whose
// payoutUser is the given recipient. Returns { susu, group, members, cycle }.
async function buildActiveSusu({ contribution, members, payoutUserId, cycleNumber = 1, totalCycles = 2 }) {
  const group = await prisma.groupChat.create({
    data: {
      name: `${TAG} grp ${cycleNumber}`,
      createdById: members[0].id,
      members: {
        create: members.map((u, i) => ({ userId: u.id, role: i === 0 ? 'ADMIN' : 'MEMBER' })),
      },
    },
  });
  const susu = await prisma.susuGroup.create({
    data: {
      status: 'ACTIVE',
      contributionUsdc: new Prisma.Decimal(contribution),
      frequency: 'WEEKLY',
      totalCycles,
      startDate: new Date(),
      contractRequiredCount: members.length,
      contractAcceptedCount: members.length,
      rotationSnapshot: [],
      activatedAt: new Date(),
      contractVersion: 'v1.0',
      groupChat: { connect: { id: group.id } },
      members: {
        create: members.map((u, i) => ({
          userId: u.id,
          cycleSlot: i + 1,
          trustScore: new Prisma.Decimal(0),
          status: 'ACTIVE',
          contractAcceptedAt: new Date(),
        })),
      },
    },
    include: { members: true },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      susuGroupId: susu.id,
      cycleNumber,
      collectionDate: new Date(Date.now() - 60 * 1000), // already due
      payoutAmount: new Prisma.Decimal(contribution).mul(members.length),
      payoutUserId,
      status: 'PENDING',
    },
  });
  return { susu, group, members: susu.members, cycle };
}

async function cleanup(susuId, groupId, userIds) {
  await prisma.susuReminderSent.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.voucherSlashLog.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.susuContribution.deleteMany({ where: { cycle: { susuGroupId: susuId } } });
  await prisma.adminWarRoomAlert.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.susuCycle.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.susuMember.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.groupMessage.deleteMany({ where: { groupId } });
  await prisma.groupMember.deleteMany({ where: { groupId } });
  await prisma.groupChat.update({ where: { id: groupId }, data: { susuGroupId: null } }).catch(() => {});
  await prisma.susuGroup.delete({ where: { id: susuId } }).catch(() => {});
  await prisma.groupChat.delete({ where: { id: groupId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  const treasury = await ensureTreasury();
  const memberSvc = new SusuMemberService(prisma);
  const vouchSvc = new SusuVouchService(prisma, {});
  const cycleSvc = new SusuCycleService(prisma, {
    susuVouchService: vouchSvc,
    susuMemberService: memberSvc,
    treasuryUserId: treasury.id,
  });

  // ────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: T=0 shortfall → COLLECTING_GRACE + −5% AZM + warning, no seize.
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[1] T=0 shortfall → grace window opens, minor penalty applied');
  {
    // recipient u1 funded; u2 short on a $20 contribution. u2 holds 200 AZM.
    const u1 = await mkUser('s1_recip', { available: '100', azm: '0' });
    const u2 = await mkUser('s1_short', { available: '5', azm: '200' });
    const { susu, group, cycle } = await buildActiveSusu({
      contribution: '20', members: [u1, u2], payoutUserId: u1.id,
    });

    const r = await cycleSvc.processCycle(cycle.id);
    check('processCycle reports grace', r && r.grace === true);
    check('grace firstEntry true', r && r.firstEntry === true);
    check('1 short member', r && r.shortMembers === 1);

    const after = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
    check('cycle status COLLECTING_GRACE', after.status === 'COLLECTING_GRACE');
    check('graceUntil set ~24h out', after.graceUntil &&
      Math.abs(new Date(after.graceUntil).getTime() - (Date.now() + 24 * 3600 * 1000)) < 5 * 60 * 1000);

    const u2After = await prisma.user.findUnique({ where: { id: u2.id } });
    // 5% of 200 = 10 AZM
    check('minor penalty −5% AZM (200 → 190)', new Prisma.Decimal(u2After.azmBalance).equals(190));
    check('u2 availableBalance untouched (no seizure yet)',
      new Prisma.Decimal(u2After.availableBalance).equals(5));

    const u2Member = await prisma.susuMember.findFirst({ where: { susuGroupId: susu.id, userId: u2.id } });
    check('u2 still ACTIVE (not defaulted in grace)', u2Member.status === 'ACTIVE');

    const contribs = await prisma.susuContribution.count({ where: { cycleId: cycle.id } });
    check('only recipient contribution recorded (1 PAID, short member none)', contribs === 1);

    const penaltyMarker = await prisma.susuReminderSent.count({
      where: { susuCycleId: cycle.id, reminderType: 'GRACE_MINOR_PENALTY' },
    });
    check('penalty idempotency marker written', penaltyMarker === 1);

    // Re-run while still in grace (not expired) → no double penalty, holds.
    const r2 = await cycleSvc.processCycle(cycle.id);
    check('second grace tick still grace', r2 && r2.grace === true && r2.firstEntry === false);
    const u2After2 = await prisma.user.findUnique({ where: { id: u2.id } });
    check('no double penalty on re-tick (still 190 AZM)',
      new Prisma.Decimal(u2After2.azmBalance).equals(190));

    await cleanup(susu.id, group.id, [u1.id, u2.id]);
  }

  // ────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: member tops up DURING grace → next tick funds, payout, no default.
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[2] top-up during grace → cycle funds & pays out, no hard default');
  {
    const u1 = await mkUser('s2_recip', { available: '0', azm: '0' });
    const u2 = await mkUser('s2_short', { available: '5', azm: '200' });
    const { susu, group, cycle } = await buildActiveSusu({
      contribution: '20', members: [u1, u2], payoutUserId: u1.id,
    });
    // u1 funds, u2 short → grace
    await prisma.user.update({ where: { id: u1.id }, data: { availableBalance: new Prisma.Decimal('20') } });
    await cycleSvc.processCycle(cycle.id);
    let c = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
    check('entered grace', c.status === 'COLLECTING_GRACE');

    // u2 tops up to cover contribution.
    await prisma.user.update({ where: { id: u2.id }, data: { availableBalance: new Prisma.Decimal('25') } });
    const r = await cycleSvc.processCycle(cycle.id);
    check('cycle paid out after top-up', r && r.cycleStatus === 'PAID_OUT');

    c = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
    check('cycle status PAID_OUT', c.status === 'PAID_OUT');
    const u2Member = await prisma.susuMember.findFirst({ where: { susuGroupId: susu.id, userId: u2.id } });
    check('u2 NOT defaulted (funded in grace)', u2Member.status === 'ACTIVE');
    const u2After = await prisma.user.findUnique({ where: { id: u2.id } });
    check('u2 charged exactly the contribution (25 → 5)',
      new Prisma.Decimal(u2After.availableBalance).equals(5));
    // recipient u1 got pooled = 20 (u1) + 20 (u2) = 40
    const u1After = await prisma.user.findUnique({ where: { id: u1.id } });
    check('recipient received full pool ($40)', new Prisma.Decimal(u1After.availableBalance).equals(40));

    await cleanup(susu.id, group.id, [u1.id, u2.id]);
  }

  // ────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: grace expires still short → HARD DEFAULT (seize + 25% slash).
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[3] grace expiry while short → hard default (seizure + 25% voucher slash)');
  {
    // u1 = recipient + voucher of u2. u2 short, has 8 available + 400 AZM voucher? 
    // Voucher slash hits the INVITER's azm. Set u1 as inviter/voucher of u2.
    const u1 = await mkUser('s3_recip', { available: '20', azm: '400' });
    const u2 = await mkUser('s3_short', { available: '8', azm: '100' });
    const { susu, group, cycle } = await buildActiveSusu({
      contribution: '20', members: [u1, u2], payoutUserId: u1.id,
    });
    // Wire a COMPLETED VouchRecord so the slash has a target (u1 vouches u2).
    await prisma.vouchRecord.create({
      data: {
        groupId: group.id,
        voucherId: u1.id,
        inviteeId: u2.id,
        isInviter: true,
        relationship: 'test',
        durationKnown: 'test',
        reasonForTrust: 'test',
        acknowledgesPenalty: true,
        status: 'COMPLETED',
      },
    });
    // Set u2 inviter linkage on the member row.
    await prisma.susuMember.updateMany({
      where: { susuGroupId: susu.id, userId: u2.id },
      data: { inviterId: u1.id, vouchedById: u1.id },
    });

    // Tick 1 → grace.
    await cycleSvc.processCycle(cycle.id);
    let c = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
    check('entered grace', c.status === 'COLLECTING_GRACE');
    const u1AzmAfterGrace = await prisma.user.findUnique({ where: { id: u1.id }, select: { azmBalance: true } });
    check('voucher AZM untouched during grace (still 400)',
      new Prisma.Decimal(u1AzmAfterGrace.azmBalance).equals(400));

    // Force grace expiry into the past.
    await prisma.susuCycle.update({
      where: { id: cycle.id },
      data: { graceUntil: new Date(Date.now() - 1000) },
    });

    const r = await cycleSvc.processCycle(cycle.id);
    check('cycle finalized after grace expiry', r && (r.cycleStatus === 'PAID_OUT' || r.cycleStatus === 'DEFAULTED'));

    const u2Member = await prisma.susuMember.findFirst({ where: { susuGroupId: susu.id, userId: u2.id } });
    check('u2 hard-DEFAULTED at grace expiry', u2Member.status === 'DEFAULTED');

    const u2After = await prisma.user.findUnique({ where: { id: u2.id } });
    check('u2 availableBalance seized to 0', new Prisma.Decimal(u2After.availableBalance).equals(0));

    const seizedContrib = await prisma.susuContribution.findFirst({
      where: { cycleId: cycle.id, userId: u2.id },
    });
    check('u2 contribution row SEIZED', seizedContrib && seizedContrib.status === 'SEIZED');
    check('seizedFromAvailable = 8', seizedContrib && new Prisma.Decimal(seizedContrib.seizedFromAvailable).equals(8));

    // Voucher slash: 25% of u1's 400 AZM = 100 deducted → 300.
    const u1After = await prisma.user.findUnique({ where: { id: u1.id } });
    check('voucher (u1) AZM slashed 25% (400 → 300)', new Prisma.Decimal(u1After.azmBalance).equals(300));
    check('voucher (u1) trustRating −1 (100 → 99)', u1After.trustRating === 99);

    const slashLog = await prisma.voucherSlashLog.findFirst({ where: { cycleId: cycle.id, voucherId: u1.id } });
    check('VoucherSlashLog written for hard default', !!slashLog);

    await prisma.vouchRecord.deleteMany({ where: { groupId: group.id } });
    await cleanup(susu.id, group.id, [u1.id, u2.id]);
  }

  // ────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: auto-retain — recipient keeps next contribution tagged.
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[4] auto-retain — recipient retains next contribution from payout');
  {
    // 2 cycles total. Cycle 1 pays u1 (who has autoRetain on and a future
    // cycle 2). Both funded → payout, autoRetained = contribution (20).
    const u1 = await mkUser('s4_recip', { available: '20', azm: '0' });
    const u2 = await mkUser('s4_other', { available: '20', azm: '0' });
    const { susu, group, cycle } = await buildActiveSusu({
      contribution: '20', members: [u1, u2], payoutUserId: u1.id, cycleNumber: 1, totalCycles: 2,
    });
    // Create a future PENDING cycle 2 (payout to u2) so "has future cycle" is true.
    await prisma.susuCycle.create({
      data: {
        susuGroupId: susu.id,
        cycleNumber: 2,
        collectionDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        payoutAmount: new Prisma.Decimal('40'),
        payoutUserId: u2.id,
        status: 'PENDING',
      },
    });
    // u1 opts into auto-retain.
    await prisma.susuMember.updateMany({
      where: { susuGroupId: susu.id, userId: u1.id },
      data: { autoRetainNextCycle: true },
    });

    const r = await cycleSvc.processCycle(cycle.id);
    check('cycle 1 paid out', r && r.cycleStatus === 'PAID_OUT');
    check('autoRetained = contribution (20)', r && new Prisma.Decimal(r.autoRetained).equals(20));

    // Payout still credits the full pool to availableBalance (shared ledger);
    // retention is a tag so the next cycle self-funds. u1 had 0 left after
    // contributing 20, then receives 40 pool → 40 available, enough to cover
    // the next $20 contribution.
    const u1After = await prisma.user.findUnique({ where: { id: u1.id } });
    check('recipient received pool, next contribution covered',
      new Prisma.Decimal(u1After.availableBalance).gte(20));

    await prisma.transactionHistory.deleteMany({ where: { userId: { in: [u1.id, u2.id] } } });
    await cleanup(susu.id, group.id, [u1.id, u2.id]);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
