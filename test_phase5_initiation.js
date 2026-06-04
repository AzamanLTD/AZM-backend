// test_phase5_initiation.js
// Local smoke test for Phase 5 / Workstream D group-chat-first Susu
// initiation. Exercises the service directly against the local DB:
//   1. create 3 users + a GroupChat with all 3 as members (admin = u1)
//   2. mark all 3 KYC+PoR VERIFIED
//   3. initiate a Susu (24h window) → assert SusuGroup CONFIGURING + 3
//      PENDING_VOUCH→PENDING_CONTRACT members + binding
//   4. getInitiationStatus → assert chips projection
//   5. accept contract for only 2 of 3 (simulate via direct ACTIVE flip)
//   6. force the deadline into the past, run sweep → assert laggard kicked,
//      Susu ACTIVATED with 2 members + cycles created
//
// Run: node test_phase5_initiation.js   (against local DB)

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SusuMemberService = require('./services/susu/susuMember.service');
const SusuVouchService = require('./services/susu/susuVouch.service');
const SusuOverlayService = require('./services/susu/susu.service');
const LiabilityContractService = require('./services/susu/liabilityContract.service');
const SusuInitiationService = require('./services/susu/susuInitiation.service');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

async function mkUser(suffix) {
  return prisma.user.create({
    data: {
      username: `p5_${suffix}_${Date.now()}`,
      email: `p5_${suffix}_${Date.now()}@test.local`,
      password: 'x',
      kycStatus: 'VERIFIED',
      proofOfResidencyStatus: 'VERIFIED',
      proofOfResidencyVerifiedAt: new Date(),
    },
  });
}

async function main() {
  const memberSvc = new SusuMemberService(prisma);
  const vouchSvc = new SusuVouchService(prisma, {});
  const liab = new LiabilityContractService(prisma);
  const overlay = new SusuOverlayService(prisma, {
    susuVouchService: vouchSvc,
    susuMemberService: memberSvc,
    liabilityContractService: liab,
  });
  const initSvc = new SusuInitiationService(prisma, {
    susuOverlayService: overlay,
    susuMemberService: memberSvc,
    liabilityContractService: liab,
  });

  const u1 = await mkUser('admin');
  const u2 = await mkUser('m2');
  const u3 = await mkUser('m3');

  const group = await prisma.groupChat.create({
    data: {
      name: `P5 Group ${Date.now()}`,
      createdById: u1.id,
      members: {
        create: [
          { userId: u1.id, role: 'ADMIN' },
          { userId: u2.id, role: 'MEMBER' },
          { userId: u3.id, role: 'MEMBER' },
        ],
      },
    },
  });

  console.log('\n[1] initiate');
  const susu = await initSvc.initiate({
    groupId: group.id,
    initiatorId: u1.id,
    contributionUsdc: '20',
    frequency: 'WEEKLY',
    windowHours: 24,
  });
  check('SusuGroup created CONFIGURING', susu.status === 'CONFIGURING');
  check('initiationDeadline set', !!susu.initiationDeadline);
  const boundGroup = await prisma.groupChat.findUnique({ where: { id: group.id } });
  check('GroupChat bound to SusuGroup', boundGroup.susuGroupId === susu.id);
  const members = await prisma.susuMember.findMany({ where: { susuGroupId: susu.id } });
  check('3 SusuMember rows created', members.length === 3);
  // KYC+PoR already VERIFIED → promoted to PENDING_CONTRACT
  check('members promoted to PENDING_CONTRACT',
    members.every((m) => m.status === 'PENDING_CONTRACT'));

  console.log('\n[2] status projection');
  const status = await initSvc.getInitiationStatus({ groupId: group.id, viewerId: u2.id });
  check('status CONFIGURING', status.status === 'CONFIGURING');
  check('memberCount 3', status.memberCount === 3);
  check('all chips green KYC+PoR', status.members.every((m) => m.kyc === 'VERIFIED' && m.por === 'VERIFIED'));
  check('readyCount 0 (no contract yet)', status.readyCount === 0);

  console.log('\n[3] two of three reach ACTIVE');
  // Simulate contract acceptance for u1 + u2 (ACTIVE); u3 lags.
  for (const uid of [u1.id, u2.id]) {
    const m = members.find((x) => x.userId === uid);
    await memberSvc.transitionToActive(m.id);
  }
  const active = await prisma.susuMember.count({ where: { susuGroupId: susu.id, status: 'ACTIVE' } });
  check('2 ACTIVE members', active === 2);

  console.log('\n[4] expire + sweep');
  await prisma.susuGroup.update({
    where: { id: susu.id },
    data: { initiationDeadline: new Date(Date.now() - 1000) },
  });
  const results = await initSvc.sweepExpiredInitiations();
  const r = results.find((x) => x.susuId === susu.id);
  check('sweep outcome ACTIVATED', r && r.outcome === 'ACTIVATED');
  check('1 laggard removed', r && r.removed === 1);

  const after = await prisma.susuGroup.findUnique({ where: { id: susu.id } });
  check('SusuGroup ACTIVE after sweep', after.status === 'ACTIVE');
  const cycles = await prisma.susuCycle.count({ where: { susuGroupId: susu.id } });
  check('2 cycles created (one per active member)', cycles === 2);
  const kicked = await prisma.groupMember.findFirst({
    where: { groupId: group.id, userId: u3.id },
  });
  check('laggard removed from group chat', kicked && kicked.removedAt != null);
  const survivingMembers = await prisma.susuMember.count({ where: { susuGroupId: susu.id } });
  check('only 2 SusuMember rows remain', survivingMembers === 2);

  // Cleanup
  console.log('\n[cleanup]');
  await prisma.susuCycle.deleteMany({ where: { susuGroupId: susu.id } });
  await prisma.susuMember.deleteMany({ where: { susuGroupId: susu.id } });
  await prisma.groupMessage.deleteMany({ where: { groupId: group.id } });
  await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
  await prisma.groupChat.update({ where: { id: group.id }, data: { susuGroupId: null } });
  await prisma.susuGroup.delete({ where: { id: susu.id } }).catch(() => {});
  await prisma.groupChat.delete({ where: { id: group.id } });
  await prisma.user.deleteMany({ where: { id: { in: [u1.id, u2.id, u3.id] } } });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
