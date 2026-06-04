#!/usr/bin/env node
/**
 * Phase 3 Verification Gate — private-susu-ecosystem
 *
 * Drives SusuCycleService.processCycle directly (not through the cron
 * worker) against fresh fixture state. The eight scenarios cover:
 *
 *   1. Happy-path cycle              — all PAID, recipient credited (Property 1)
 *   2. One default with active recipient — SEIZED + DEFAULTED + Voucher_Slash
 *   3. Self-default → treasury        — defaulter is recipient, seizure routes to treasury (Property 2)
 *   4. Escrow diversion               — payout recipient defaulted earlier; pool diverted to treasury (Req 10.8)
 *   5. Circuit Breaker — mass default — 2+ defaults in same cycle → FROZEN_DISPUTE (Req 11.9)
 *   6. Circuit Breaker — admin default— Susu admin defaults → FROZEN_DISPUTE (Req 11.9)
 *   7. Idempotent replay              — processCycle twice → no double-payout (Property 10)
 *   8. T-24h reminder exactly-once    — Reminder_Cron x3 → exactly one notification (Property 11)
 *
 * Usage: node test_phase3_engine.js
 *
 * Note: This test runs WITHOUT the HTTP server. It instantiates the
 * services directly and bypasses cron timing.
 */

const { Prisma, PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const SusuVouchService     = require('./services/susu/susuVouch.service');
const SusuMemberService    = require('./services/susu/susuMember.service');
const AdminWarRoomService  = require('./services/susu/adminWarRoom.service');
const SusuCycleService     = require('./services/susu/susuCycle.service');
const SusuReminderCron     = require('./workers/susuReminderCron');

const PASSWORD = 'TestPass123!';

let pass = 0, fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) {
  console.log(`  ✗ ${label}`);
  if (err) console.log(`    → ${err.message || err}`);
  fail++;
}

const prisma = new PrismaClient();
let TREASURY_USER_ID;

// Stubbed notification service (no FCM at test time)
const notifLog = [];
const notificationService = {
  async sendNotification(payload) { notifLog.push(payload); return { ok: true }; },
};

const susuVouchService    = new SusuVouchService(prisma,    { notificationService });
const susuMemberService   = new SusuMemberService(prisma);
const adminWarRoomService = new AdminWarRoomService(prisma, { notificationService });
let susuCycleService;     // built after we have treasuryUserId

// --- Fixture utilities ---------------------------------------------------

async function nukeFixtures() {
  const users = await prisma.user.findMany({
    where: { username: { startsWith: 'p3test_' } },
    select: { id: true },
  });
  const ids = users.map(u => u.id);
  if (ids.length === 0) return;
  await prisma.susuReminderSent.deleteMany({ where: { member: { userId: { in: ids } } } });
  await prisma.voucherSlashLog.deleteMany({ where: { OR: [{ vouchedUserId: { in: ids } }, { voucherId: { in: ids } }] } });
  await prisma.adminWarRoomAlert.deleteMany({ where: { susu: { members: { some: { userId: { in: ids } } } } } });
  await prisma.liabilityAcceptance.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuInvite.deleteMany({ where: { OR: [{ inviterId: { in: ids } }, { inviteeUserId: { in: ids } }] } });
  await prisma.susuContribution.deleteMany({ where: { userId: { in: ids } } });
  await prisma.transactionHistory.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuCycle.deleteMany({ where: { susu: { members: { some: { userId: { in: ids } } } } } });
  await prisma.susuMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuGroup.deleteMany({ where: { groupChat: { createdById: { in: ids } } } });
  await prisma.vouchRecord.deleteMany({ where: { OR: [{ voucherId: { in: ids } }, { inviteeId: { in: ids } }] } });
  await prisma.groupMessage.deleteMany({ where: { senderId: { in: ids } } });
  await prisma.groupMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.groupChat.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(handle, opts = {}) {
  const username = `p3test_${handle}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const email = `${username}@phase3.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  return prisma.user.create({
    data: {
      username,
      email,
      password: hash,
      kycStatus: 'VERIFIED',
      proofOfResidencyStatus: 'VERIFIED',
      proofOfResidencyVerifiedAt: new Date(),
      availableBalance: opts.balance != null ? new Prisma.Decimal(opts.balance) : new Prisma.Decimal(100),
      azmBalance: opts.azm != null ? new Prisma.Decimal(opts.azm) : new Prisma.Decimal(1000),
      trustRating: opts.trustRating ?? 100,
    },
  });
}

/**
 * Seed an ACTIVE Susu with N members + N PENDING cycles. Members are
 * created with cycleSlot 1..N and recipient assigned in order.
 *
 * @param {Array<{ user, balance?, role? }>} memberSpecs  initiator first; role 'ADMIN' for the initiator's GroupMember row
 * @param {string|number} contributionUsdc
 * @returns { susu, members, cycles }
 */
async function seedActiveSusu(memberSpecs, contributionUsdc = '10') {
  const initiator = memberSpecs[0].user;
  return prisma.$transaction(async (tx) => {
    const groupChat = await tx.groupChat.create({
      data: {
        name: `p3-susu-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        description: 'Phase 3 fixture',
        createdById: initiator.id,
        status: 'ACTIVE',
      },
    });
    for (const { user, role } of memberSpecs) {
      await tx.groupMember.create({
        data: { groupId: groupChat.id, userId: user.id, role: role || (user.id === initiator.id ? 'ADMIN' : 'MEMBER') },
      });
    }
    const susu = await tx.susuGroup.create({
      data: {
        contributionUsdc: new Prisma.Decimal(contributionUsdc),
        frequency: 'WEEKLY',
        totalCycles: memberSpecs.length,
        startDate: new Date(),
        contractAcceptedCount: memberSpecs.length,
        contractRequiredCount: memberSpecs.length,
        rotationSnapshot: { computed: true },
        contractVersion: 'v1.0',
        contractHash: 'a'.repeat(64),
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await tx.groupChat.update({ where: { id: groupChat.id }, data: { susuGroupId: susu.id } });

    const members = [];
    const cycles = [];
    for (let i = 0; i < memberSpecs.length; i++) {
      const { user } = memberSpecs[i];
      const slot = i + 1;
      const member = await tx.susuMember.create({
        data: {
          susuGroupId: susu.id,
          userId: user.id,
          cycleSlot: slot,
          trustScore: new Prisma.Decimal(100),
          status: 'ACTIVE',
          contractAcceptedAt: new Date(),
        },
      });
      members.push(member);

      // Each member also gets a VouchRecord vouching for them by the
      // initiator (so Voucher_Slash has a target). Skip the initiator
      // themselves.
      if (user.id !== initiator.id) {
        await tx.vouchRecord.create({
          data: {
            groupId: groupChat.id,
            voucherId: initiator.id,
            inviteeId: user.id,
            isInviter: true,
            relationship: 'Susu invitee',
            durationKnown: 'fixture',
            reasonForTrust: 'fixture',
            acknowledgesPenalty: true,
            status: 'COMPLETED',
          },
        });
      }

      // PENDING SusuCycle row whose collectionDate is "now" so the
      // service treats it as due immediately.
      const cycle = await tx.susuCycle.create({
        data: {
          susuGroupId: susu.id,
          cycleNumber: slot,
          collectionDate: new Date(),
          payoutAmount: new Prisma.Decimal(contributionUsdc).mul(memberSpecs.length),
          payoutUserId: user.id,
          status: 'PENDING',
        },
      });
      cycles.push(cycle);
    }
    return { susu, members, cycles, groupChat };
  });
}

async function readUserBalance(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true, azmBalance: true, trustRating: true } });
  return {
    availableBalance: new Prisma.Decimal(u.availableBalance),
    azmBalance: new Prisma.Decimal(u.azmBalance),
    trustRating: u.trustRating,
  };
}

// =============================================================================
// SCENARIOS
// =============================================================================

async function scenarioHappyPath() {
  console.log('\n1️⃣  Happy-path cycle');
  const u1 = await makeUser('hp_init', { balance: 100 });
  const u2 = await makeUser('hp_m2',   { balance: 100 });
  const u3 = await makeUser('hp_m3',   { balance: 100 });
  const { susu, cycles } = await seedActiveSusu([
    { user: u1 }, { user: u2 }, { user: u3 },
  ], '10');

  // Process cycle 1 (recipient = u1)
  const result = await susuCycleService.processCycle(cycles[0].id);
  if (result.cycleStatus !== 'PAID_OUT') return bad(`expected PAID_OUT, got ${result.cycleStatus}`);
  ok('cycle status = PAID_OUT');

  const b1 = await readUserBalance(u1.id);
  const b2 = await readUserBalance(u2.id);
  const b3 = await readUserBalance(u3.id);
  // u1 paid 10 (debit) + received 30 (credit) = +20 net. u2/u3 each -10.
  if (b1.availableBalance.toNumber() !== 120) return bad(`u1 expected 120, got ${b1.availableBalance}`);
  if (b2.availableBalance.toNumber() !== 90)  return bad(`u2 expected 90, got ${b2.availableBalance}`);
  if (b3.availableBalance.toNumber() !== 90)  return bad(`u3 expected 90, got ${b3.availableBalance}`);
  ok('balance ledger conservation: u1=+20, u2=-10, u3=-10');

  const dbCycle = await prisma.susuCycle.findUnique({ where: { id: cycles[0].id } });
  // pooled = sum of PAID contributions = 3 × $10 = $30 (recipient pays
  // their share too per Req 10.4). Net to recipient is +$20 = -$10 paid
  // + $30 received, which the balance assertion above already verified.
  if (Number(dbCycle.payoutAmount) !== 30)
    return bad(`payoutAmount expected 30 (sum of 3 PAID), got ${dbCycle.payoutAmount}`);
  ok('cycle.payoutAmount captured');
}

async function scenarioOneDefaultActiveRecipient() {
  console.log('\n2️⃣  One default with active recipient + Voucher_Slash');
  const u1 = await makeUser('d1_init', { balance: 100, azm: 1000 });
  const u2 = await makeUser('d1_m2',   { balance: 0,   azm: 0 });    // will default
  const u3 = await makeUser('d1_m3',   { balance: 100, azm: 0 });
  const { cycles } = await seedActiveSusu([{ user: u1 }, { user: u2 }, { user: u3 }], '10');

  const result = await susuCycleService.processCycle(cycles[0].id);
  if (result.cycleStatus !== 'PAID_OUT') return bad(`expected PAID_OUT, got ${result.cycleStatus}`);

  // u2 should be DEFAULTED
  const u2Member = await prisma.susuMember.findFirst({ where: { userId: u2.id } });
  if (u2Member.status !== 'DEFAULTED') return bad(`u2 status expected DEFAULTED, got ${u2Member.status}`);
  ok('u2 status = DEFAULTED');

  // SusuContribution row for u2 should be FAILED_INSUFFICIENT (zero seized)
  const u2Contribution = await prisma.susuContribution.findFirst({ where: { userId: u2.id } });
  if (u2Contribution.status !== 'FAILED_INSUFFICIENT')
    return bad(`u2 contribution expected FAILED_INSUFFICIENT, got ${u2Contribution.status}`);
  ok('u2 contribution = FAILED_INSUFFICIENT (zero balance to seize)');

  // VoucherSlashLog: voucher = u1, vouched = u2
  const slashLog = await prisma.voucherSlashLog.findFirst({ where: { vouchedUserId: u2.id } });
  if (!slashLog) return bad('VoucherSlashLog row missing');
  // 25% of 1000 = 250 AZM, trustRating 100 → 99
  if (Number(slashLog.azmDeducted) !== 250)
    return bad(`azmDeducted expected 250, got ${slashLog.azmDeducted}`);
  if (slashLog.trustRatingBefore !== 100 || slashLog.trustRatingAfter !== 99)
    return bad(`trustRating before/after expected 100/99, got ${slashLog.trustRatingBefore}/${slashLog.trustRatingAfter}`);
  ok('VoucherSlashLog: 250 AZM deducted, trustRating 100→99');

  const u1After = await readUserBalance(u1.id);
  if (Number(u1After.azmBalance) !== 750) return bad(`u1 azm expected 750, got ${u1After.azmBalance}`);
  if (u1After.trustRating !== 99) return bad(`u1 trustRating expected 99, got ${u1After.trustRating}`);
  ok('u1 (voucher) AZM=750, trustRating=99');
}

async function scenarioSelfDefaultToTreasury() {
  console.log('\n3️⃣  Self-default routes seizure to treasury');
  const u1 = await makeUser('s_init', { balance: 100 });
  const u2 = await makeUser('s_m2',   { balance: 5 }); // partial seize, will default
  const u3 = await makeUser('s_m3',   { balance: 100 });

  // Order matters: cycleSlot 1 is u1, slot 2 is u2 (the defaulter who will
  // also be the recipient on this cycle).
  const { cycles } = await seedActiveSusu([{ user: u1 }, { user: u2 }, { user: u3 }], '10');

  const treasuryBefore = (await readUserBalance(TREASURY_USER_ID)).availableBalance;

  // Process cycle 2 — recipient is u2 themselves
  const result = await susuCycleService.processCycle(cycles[1].id);
  if (result.cycleStatus !== 'PAID_OUT') return bad(`expected PAID_OUT, got ${result.cycleStatus}`);

  const treasuryAfter = (await readUserBalance(TREASURY_USER_ID)).availableBalance;
  // u2 had 5, seized 5 (routed to treasury, not to u2). u1 and u3 each
  // pay $10 PAID — those flow to the recipient (u2), but u2 is itself the
  // defaulter on this cycle (the recipient). With escrow diversion in
  // play, the pooled $20 also routes to treasury (Req 10.8). Total
  // treasury delta = 5 (seize) + 20 (pool) = 25.
  const delta = treasuryAfter.minus(treasuryBefore);
  if (Number(delta) !== 25) return bad(`treasury delta expected 25 (5 seize + 20 escrow divert), got ${delta}`);
  ok('treasury credited $25 (self-seize $5 + escrow-divert $20)');

  const u2After = await readUserBalance(u2.id);
  if (Number(u2After.availableBalance) !== 0) return bad(`u2 availableBalance expected 0, got ${u2After.availableBalance}`);
  ok('u2 availableBalance = 0 (self-payment forbidden)');
}

async function scenarioEscrowDiversion() {
  console.log('\n4️⃣  Escrow diversion when recipient defaulted earlier');
  const u1 = await makeUser('e_init', { balance: 100 });
  const u2 = await makeUser('e_m2',   { balance: 100 });
  const u3 = await makeUser('e_m3',   { balance: 100 });
  const { susu, members, cycles } = await seedActiveSusu([
    { user: u1 }, { user: u2 }, { user: u3 },
  ], '10');

  // Manually mark u2 as DEFAULTED (simulating an earlier-cycle default)
  const u2Member = members.find(m => m.userId === u2.id);
  await prisma.susuMember.update({ where: { id: u2Member.id }, data: { status: 'DEFAULTED' } });

  const treasuryBefore = (await readUserBalance(TREASURY_USER_ID)).availableBalance;
  // Process cycle 2 — recipient is u2 (now DEFAULTED) → divert to treasury
  const result = await susuCycleService.processCycle(cycles[1].id);
  if (!result.escrowDiverted) return bad('expected escrowDiverted=true');
  ok('escrowDiverted flag set');

  const dbCycle = await prisma.susuCycle.findUnique({ where: { id: cycles[1].id } });
  if (!dbCycle.escrowDivertedAt) return bad('cycle.escrowDivertedAt should be non-null');
  ok('cycle.escrowDivertedAt is non-null');

  const treasuryAfter = (await readUserBalance(TREASURY_USER_ID)).availableBalance;
  const delta = treasuryAfter.minus(treasuryBefore);
  // u1 + u3 each contribute 10 → pool 20 → diverted to treasury
  if (Number(delta) !== 20) return bad(`treasury delta expected 20, got ${delta}`);
  ok(`treasury credited $${delta} (the pooled contributions)`);

  const alert = await prisma.adminWarRoomAlert.findFirst({
    where: { susuGroupId: susu.id, alertType: 'ESCROW_DIVERSION' },
  });
  if (!alert) return bad('AdminWarRoomAlert ESCROW_DIVERSION not created');
  ok('AdminWarRoomAlert ESCROW_DIVERSION row created');
}

async function scenarioCircuitBreakerMassDefault() {
  console.log('\n5️⃣  Circuit Breaker — mass default (≥2 in same cycle)');
  const u1 = await makeUser('cbm_init', { balance: 100, azm: 1000 });
  const u2 = await makeUser('cbm_m2',   { balance: 0 });
  const u3 = await makeUser('cbm_m3',   { balance: 0 });
  const u4 = await makeUser('cbm_m4',   { balance: 100 });
  const { susu, cycles } = await seedActiveSusu([
    { user: u1 }, { user: u2 }, { user: u3 }, { user: u4 },
  ], '10');

  await susuCycleService.processCycle(cycles[0].id);

  const susuAfter = await prisma.susuGroup.findUnique({ where: { id: susu.id } });
  if (susuAfter.status !== 'FROZEN_DISPUTE') return bad(`expected FROZEN_DISPUTE, got ${susuAfter.status}`);
  ok('Susu.status = FROZEN_DISPUTE');
  if (susuAfter.frozenReason !== 'MASS_DEFAULT_THRESHOLD')
    return bad(`expected MASS_DEFAULT_THRESHOLD, got ${susuAfter.frozenReason}`);
  ok('frozenReason = MASS_DEFAULT_THRESHOLD');

  const alert = await prisma.adminWarRoomAlert.findFirst({
    where: { susuGroupId: susu.id, alertType: 'MASS_DEFAULT_THRESHOLD' },
  });
  if (!alert) return bad('MASS_DEFAULT_THRESHOLD alert not fired');
  ok('AdminWarRoomAlert MASS_DEFAULT_THRESHOLD created');
}

async function scenarioCircuitBreakerAdminDefault() {
  console.log('\n6️⃣  Circuit Breaker — admin default');
  const u1 = await makeUser('cba_init', { balance: 0, azm: 1000 }); // admin, will default
  const u2 = await makeUser('cba_m2',   { balance: 100 });
  const u3 = await makeUser('cba_m3',   { balance: 100 });
  const { susu, cycles } = await seedActiveSusu([
    { user: u1, role: 'ADMIN' }, { user: u2 }, { user: u3 },
  ], '10');

  await susuCycleService.processCycle(cycles[0].id);

  const susuAfter = await prisma.susuGroup.findUnique({ where: { id: susu.id } });
  if (susuAfter.status !== 'FROZEN_DISPUTE') return bad(`expected FROZEN_DISPUTE, got ${susuAfter.status}`);
  ok('Susu.status = FROZEN_DISPUTE');
  if (susuAfter.frozenReason !== 'ADMIN_DEFAULT')
    return bad(`expected ADMIN_DEFAULT, got ${susuAfter.frozenReason}`);
  ok('frozenReason = ADMIN_DEFAULT');

  const alert = await prisma.adminWarRoomAlert.findFirst({
    where: { susuGroupId: susu.id, alertType: 'ADMIN_DEFAULT' },
  });
  if (!alert) return bad('ADMIN_DEFAULT alert not fired');
  ok('AdminWarRoomAlert ADMIN_DEFAULT created');
}

async function scenarioIdempotencyReplay() {
  console.log('\n7️⃣  Idempotency replay — processCycle twice');
  const u1 = await makeUser('idem_init', { balance: 100 });
  const u2 = await makeUser('idem_m2',   { balance: 100 });
  const u3 = await makeUser('idem_m3',   { balance: 100 });
  const { cycles } = await seedActiveSusu([{ user: u1 }, { user: u2 }, { user: u3 }], '10');

  const r1 = await susuCycleService.processCycle(cycles[0].id);
  if (r1.cycleStatus !== 'PAID_OUT') return bad(`first call expected PAID_OUT, got ${r1.cycleStatus}`);

  const r2 = await susuCycleService.processCycle(cycles[0].id);
  if (!r2.skipped) return bad(`second call expected skipped, got ${JSON.stringify(r2)}`);
  ok('second processCycle returned skipped');

  const u1After = await readUserBalance(u1.id);
  if (Number(u1After.availableBalance) !== 120)
    return bad(`u1 availableBalance expected 120 (paid -10, recv +30), got ${u1After.availableBalance}`);
  ok('balance unchanged on second call (no double-payout)');

  const payouts = await prisma.transactionHistory.count({
    where: { type: 'SUSU_PAYOUT', metadata: { path: ['cycleId'], equals: cycles[0].id } },
  }).catch(() => 0); // metadata column may not exist
  // Fall back to: count rows where userId=u1 AND type=SUSU_PAYOUT in this run
  const payoutsByUser = await prisma.transactionHistory.count({
    where: { userId: u1.id, type: 'SUSU_PAYOUT' },
  });
  if (payoutsByUser > 1) return bad(`expected ≤1 SUSU_PAYOUT row for u1, got ${payoutsByUser}`);
  ok(`${payoutsByUser} SUSU_PAYOUT TransactionHistory row(s) for u1 — no duplicate`);
}

async function scenarioReminderExactlyOnce() {
  console.log('\n8️⃣  T-24h reminder exactly-once');
  // Create a Susu where one cycle's collectionDate is 24h ± 0min from now
  // and a member has insufficient balance.
  const u1 = await makeUser('rem_init', { balance: 100 });
  const u2 = await makeUser('rem_m2',   { balance: 1 }); // shortfall = 9
  const u3 = await makeUser('rem_m3',   { balance: 100 });
  const { susu, cycles } = await seedActiveSusu([{ user: u1 }, { user: u2 }, { user: u3 }], '10');

  // Move cycle 2's collectionDate to exactly +24h
  const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.susuCycle.update({ where: { id: cycles[1].id }, data: { collectionDate: target } });

  notifLog.length = 0;
  const cron = new SusuReminderCron(prisma, notificationService);
  // Invoke private tick directly 3x (no setInterval)
  await cron._tick();
  await cron._tick();
  await cron._tick();

  const reminders = notifLog.filter(n =>
    n.actionPayload?.action === 'OPEN_DEPOSIT_FOR_SUSU' &&
    n.actionPayload?.susuId === susu.id,
  );
  // Only u2 has a shortfall; u1 + u3 have full balance
  if (reminders.length !== 1) return bad(`expected exactly 1 reminder, got ${reminders.length}`);
  ok('exactly 1 OPEN_DEPOSIT_FOR_SUSU notification across 3 cron ticks (Property 11)');

  const r = reminders[0];
  if (r.actionPayload.amount !== '9.00') return bad(`expected shortfall amount 9.00, got ${r.actionPayload.amount}`);
  ok('shortfall amount correct ($9.00)');

  const sentRows = await prisma.susuReminderSent.count({ where: { susuCycleId: cycles[1].id } });
  if (sentRows !== 1) return bad(`expected 1 SusuReminderSent row, got ${sentRows}`);
  ok('SusuReminderSent has exactly 1 row');
}

// =============================================================================
// DRIVER
// =============================================================================

async function main() {
  console.log('═════════════════════════════════════════════════════════════');
  console.log('Phase 3 Verification Gate — private-susu-ecosystem');
  console.log('═════════════════════════════════════════════════════════════');

  // Resolve the cached treasury user id
  const treasury = await prisma.user.findUnique({ where: { username: 'azaman-treasury' }, select: { id: true } });
  if (!treasury) throw new Error('treasury user missing — run seed-susu-foundation.js first');
  TREASURY_USER_ID = treasury.id;
  susuCycleService = new SusuCycleService(prisma, {
    susuVouchService,
    susuMemberService,
    adminWarRoomService,
    notificationService,
    treasuryUserId: TREASURY_USER_ID,
  });
  console.log(`Treasury userId = ${TREASURY_USER_ID}\n`);

  try {
    await nukeFixtures();
    await scenarioHappyPath();
    await scenarioOneDefaultActiveRecipient();
    await scenarioSelfDefaultToTreasury();
    await scenarioEscrowDiversion();
    await scenarioCircuitBreakerMassDefault();
    await scenarioCircuitBreakerAdminDefault();
    await scenarioIdempotencyReplay();
    await scenarioReminderExactlyOnce();
  } catch (err) {
    console.error('\n💥 Verification crashed:', err);
    fail++;
  } finally {
    await nukeFixtures().catch(() => {});
    await prisma.$disconnect();
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log('═════════════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
}

main();
