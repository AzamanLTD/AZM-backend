// test_phase5_admin_portal.js
// =============================================================================
// Phase 5 / Workstream E — Admin Portal backend surface verification.
//
// Exercises AdminSusuMonitorService directly against the local DB:
//   1. listSusus            — the seeded Susu appears with correct counts.
//   2. getSusuDetail        — members + cycles + frozen alert projected.
//   3. getMemberDetail      — idNumber DECRYPTED (round-trips the cipher),
//                             default/seizure/slash history surfaced.
//   4. resolveFrozenSusu RESUME           — FROZEN_DISPUTE → ACTIVE, freeze cleared.
//   5. resolveFrozenSusu REFUND_AND_CLOSE — PAID contribution refunded to
//                             member, Susu → CANCELLED, open cycles DEFAULTED,
//                             alert marked resolved.
//
// Requires ENCRYPTION_KEY in .env for the decryption assertion.
// Run:  node test_phase5_admin_portal.js
// =============================================================================

require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();

const AdminSusuMonitorService = require('./services/susu/adminSusuMonitor.service');
const SusuVouchService = require('./services/susu/susuVouch.service');
const fieldCipher = require('./services/crypto/fieldCipher');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const TAG = `adm_${Date.now()}`;

async function mkUser(suffix, extra = {}) {
  return prisma.user.create({
    data: {
      username: `${TAG}_${suffix}`,
      email: `${TAG}_${suffix}@test.local`,
      password: 'x',
      kycStatus: 'VERIFIED',
      proofOfResidencyStatus: 'VERIFIED',
      proofOfResidencyVerifiedAt: new Date(),
      ...extra,
    },
  });
}

async function buildSusu({ members, status = 'ACTIVE', contribution = '20', frozen = false }) {
  const group = await prisma.groupChat.create({
    data: {
      name: `${TAG} susu`,
      createdById: members[0].id,
      members: { create: members.map((u, i) => ({ userId: u.id, role: i === 0 ? 'ADMIN' : 'MEMBER' })) },
    },
  });
  const susu = await prisma.susuGroup.create({
    data: {
      status: frozen ? 'FROZEN_DISPUTE' : status,
      contributionUsdc: new Prisma.Decimal(contribution),
      frequency: 'WEEKLY',
      totalCycles: members.length,
      startDate: new Date(),
      contractRequiredCount: members.length,
      contractAcceptedCount: members.length,
      rotationSnapshot: [],
      activatedAt: new Date(),
      frozenAt: frozen ? new Date() : null,
      frozenReason: frozen ? 'MASS_DEFAULT_THRESHOLD' : null,
      groupChat: { connect: { id: group.id } },
      members: {
        create: members.map((u, i) => ({
          userId: u.id, cycleSlot: i + 1, trustScore: new Prisma.Decimal(0),
          status: 'ACTIVE', contractAcceptedAt: new Date(),
        })),
      },
    },
  });
  return { susu, group };
}

async function cleanup(susuId, groupId, userIds) {
  await prisma.adminWarRoomAlert.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.voucherSlashLog.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.susuContribution.deleteMany({ where: { cycle: { susuGroupId: susuId } } });
  await prisma.susuCycle.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.susuMember.deleteMany({ where: { susuGroupId: susuId } });
  await prisma.groupMember.deleteMany({ where: { groupId } });
  await prisma.groupChat.update({ where: { id: groupId }, data: { susuGroupId: null } }).catch(() => {});
  await prisma.susuGroup.delete({ where: { id: susuId } }).catch(() => {});
  await prisma.groupChat.delete({ where: { id: groupId } }).catch(() => {});
  await prisma.transactionHistory.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  const vouchSvc = new SusuVouchService(prisma, {});
  const svc = new AdminSusuMonitorService(prisma, { susuVouchService: vouchSvc });

  // ── 1/2/3: list + detail + member decryption ──────────────────────────
  console.log('\n[1] listSusus + getSusuDetail + getMemberDetail');
  {
    const realId = 'GHA-123456789-0';
    const encId = fieldCipher.encrypt(realId);
    check('cipher actually encrypted the id', fieldCipher.isEncrypted ? fieldCipher.isEncrypted(encId) : encId.startsWith('enc:v1:'));

    const u1 = await mkUser('m1', { idNumber: encId, legalName: 'Ama Mensah', idType: 'national_id', strikeCount: 1 });
    const u2 = await mkUser('m2');
    const { susu, group } = await buildSusu({ members: [u1, u2] });

    // one cycle + a default footprint on u1
    const cycle = await prisma.susuCycle.create({
      data: {
        susuGroupId: susu.id, cycleNumber: 1, collectionDate: new Date(),
        payoutAmount: new Prisma.Decimal('40'), payoutUserId: u2.id, status: 'PENDING',
      },
    });
    await prisma.susuContribution.create({
      data: { cycleId: cycle.id, memberId: (await firstMemberId(susu.id, u1.id)), userId: u1.id, amountUsdc: new Prisma.Decimal('5'), status: 'SEIZED', seizedFromAvailable: new Prisma.Decimal('5'), shortfall: new Prisma.Decimal('15') },
    });
    await prisma.voucherSlashLog.create({
      data: { voucherId: u2.id, vouchedUserId: u1.id, susuGroupId: susu.id, cycleId: cycle.id, azmDeducted: new Prisma.Decimal('10'), trustRatingBefore: 100, trustRatingAfter: 99 },
    });

    const list = await svc.listSusus({});
    const listed = list.find((s) => s.id === susu.id);
    check('listSusus includes the Susu', !!listed);
    check('memberCount = 2', listed && listed.memberCount === 2);
    check('activeMembers = 2', listed && listed.activeMembers === 2);
    check('nextCycle present', listed && listed.nextCycle && listed.nextCycle.cycleNumber === 1);

    const detail = await svc.getSusuDetail(susu.id);
    check('detail has 2 members', detail.members.length === 2);
    check('detail has 1 cycle', detail.cycles.length === 1);
    check('projectedPool = 40', detail.projectedPool === '40');

    const member = await svc.getMemberDetail(u1.id);
    check('idNumber DECRYPTED to plaintext', member.user.idNumber === realId);
    check('idNumberOnFile true', member.user.idNumberOnFile === true);
    check('legalName surfaced', member.user.legalName === 'Ama Mensah');
    check('strikeCount surfaced', member.user.strikeCount === 1);
    check('history.seizures has 1', member.history.seizures.length === 1);
    check('history.slashesReceived has 1', member.history.slashesReceived.length === 1);
    check('seizure amount = 5', member.history.seizures[0].seizedFromAvailable === '5');

    await cleanup(susu.id, group.id, [u1.id, u2.id]);
  }

  // ── 4: RESUME ─────────────────────────────────────────────────────────
  console.log('\n[2] resolveFrozenSusu RESUME');
  {
    const u1 = await mkUser('r1');
    const u2 = await mkUser('r2');
    const { susu, group } = await buildSusu({ members: [u1, u2], frozen: true });
    await prisma.adminWarRoomAlert.create({
      data: { alertType: 'MASS_DEFAULT_THRESHOLD', susuGroupId: susu.id, payload: { summary: 'x' } },
    });

    const admin = await mkUser('admin1', { role: 'ADMIN' });
    const r = await svc.resolveFrozenSusu({ adminUserId: admin.id, susuGroupId: susu.id, action: 'RESUME', notes: 'reviewed, false alarm' });
    check('RESUME returns ACTIVE', r.susu.status === 'ACTIVE');
    const after = await prisma.susuGroup.findUnique({ where: { id: susu.id } });
    check('Susu ACTIVE, freeze cleared', after.status === 'ACTIVE' && after.frozenAt === null && after.frozenReason === null);
    const alert = await prisma.adminWarRoomAlert.findFirst({ where: { susuGroupId: susu.id } });
    check('alert marked resolved RESUME', alert.resolution === 'RESUME' && alert.resolvedAt != null);

    await cleanup(susu.id, group.id, [u1.id, u2.id, admin.id]);
  }

  // ── 5: REFUND_AND_CLOSE ───────────────────────────────────────────────
  console.log('\n[3] resolveFrozenSusu REFUND_AND_CLOSE');
  {
    const u1 = await mkUser('f1', { availableBalance: new Prisma.Decimal('0') });
    const u2 = await mkUser('f2', { availableBalance: new Prisma.Decimal('100') });
    const { susu, group } = await buildSusu({ members: [u1, u2], frozen: true });
    const cycle = await prisma.susuCycle.create({
      data: { susuGroupId: susu.id, cycleNumber: 1, collectionDate: new Date(), payoutAmount: new Prisma.Decimal('40'), payoutUserId: u1.id, status: 'COLLECTING' },
    });
    // u2 has a PAID contribution sitting in the frozen pool → must be refunded.
    await prisma.susuContribution.create({
      data: { cycleId: cycle.id, memberId: (await firstMemberId(susu.id, u2.id)), userId: u2.id, amountUsdc: new Prisma.Decimal('20'), status: 'PAID' },
    });
    await prisma.adminWarRoomAlert.create({
      data: { alertType: 'ADMIN_DEFAULT', susuGroupId: susu.id, payload: { summary: 'x' } },
    });

    const admin = await mkUser('admin2', { role: 'ADMIN' });
    const u2Before = await prisma.user.findUnique({ where: { id: u2.id } });

    const r = await svc.resolveFrozenSusu({ adminUserId: admin.id, susuGroupId: susu.id, action: 'REFUND_AND_CLOSE', notes: 'unrecoverable, refunding' });
    check('REFUND returns CANCELLED', r.susu.status === 'CANCELLED');
    check('refundedMembers = 1', r.refundedMembers === 1);
    check('refundedTotal = 20', r.refundedTotal === '20');

    const u2After = await prisma.user.findUnique({ where: { id: u2.id } });
    check('u2 refunded +20 (100 → 120)', new Prisma.Decimal(u2After.availableBalance).equals(new Prisma.Decimal(u2Before.availableBalance).plus(20)));

    const after = await prisma.susuGroup.findUnique({ where: { id: susu.id } });
    check('Susu CANCELLED', after.status === 'CANCELLED');
    const cyc = await prisma.susuCycle.findUnique({ where: { id: cycle.id } });
    check('open cycle DEFAULTED', cyc.status === 'DEFAULTED');
    const refundTx = await prisma.transactionHistory.findFirst({ where: { userId: u2.id, type: 'SUSU_REFUND' } });
    check('SUSU_REFUND tx written', !!refundTx);
    const alert = await prisma.adminWarRoomAlert.findFirst({ where: { susuGroupId: susu.id } });
    check('alert marked resolved REFUND_AND_CLOSE', alert.resolution === 'REFUND_AND_CLOSE' && alert.resolvedAt != null);

    // Guard: resolving a non-frozen Susu must fail.
    let threw = false;
    try { await svc.resolveFrozenSusu({ adminUserId: admin.id, susuGroupId: susu.id, action: 'RESUME', notes: 'again' }); }
    catch (e) { threw = true; }
    check('re-resolve on non-frozen Susu rejected', threw);

    await cleanup(susu.id, group.id, [u1.id, u2.id, admin.id]);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

async function firstMemberId(susuId, userId) {
  const m = await prisma.susuMember.findFirst({ where: { susuGroupId: susuId, userId } });
  return m.id;
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
