// test_phase6_join_requests.js
// =============================================================================
// Phase 6 / Phase 3 — Group Membership & Vouching verification.
//
// Exercises GroupJoinRequestService directly against the local DB:
//   1. propose → one PENDING row per target + notifies BOTH sides
//   2. approve → adds GroupMember with vouchedById=proposer, status APPROVED
//   3. reject  → status REJECTED, no member, notifies proposer
//   4. admin-only guard → non-admin approve/reject → JOIN_REQUEST_FORBIDDEN (403)
//   5. idempotent re-resolve → second approve/reject is a no-op (no double
//      add / notify)
//   6. quota engine → resolveAddQuota tiers; 4th direct add at tier-3 rejected
//      (ADD_QUOTA_EXCEEDED) and vouchedById=admin on direct adds
//   7. one-PENDING-per-pair → second propose for the same (group,target)
//      throws JOIN_REQUEST_DUPLICATE
//
// A fake NotificationService captures sends so we can assert the bidirectional
// copy without a live socket/FCM. Fixtures are TAG-prefixed and fully cleaned
// up. Run: node test_phase6_join_requests.js   (against local DB)
// =============================================================================

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { GroupJoinRequestService } = require('./services/groups/groupJoinRequest.service');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const TAG = `gjr6_${Date.now()}`;

// Fake notification sink — captures every sendNotification call. The service
// fires via setImmediate, so tests await a microtask flush before asserting.
class FakeNotifier {
  constructor() { this.sent = []; }
  async sendNotification(payload) { this.sent.push(payload); return { id: 'fake' }; }
  forUser(userId) { return this.sent.filter((n) => n.userId === userId); }
  withAction(action) { return this.sent.filter((n) => n.actionPayload && n.actionPayload.action === action); }
  reset() { this.sent = []; }
}

const flush = () => new Promise((r) => setImmediate(r));

async function mkUser(suffix, extra = {}) {
  return prisma.user.create({
    data: {
      username: `${TAG}_${suffix}`,
      email: `${TAG}_${suffix}@test.local`,
      password: 'x',
      ...extra,
    },
  });
}

async function mkGroup(name, adminId, memberIds = []) {
  return prisma.groupChat.create({
    data: {
      name: `${TAG}_${name}`,
      createdById: adminId,
      members: {
        create: [
          { userId: adminId, role: 'ADMIN' },
          ...memberIds.map((uid) => ({ userId: uid, role: 'MEMBER' })),
        ],
      },
    },
  });
}

const createdGroupIds = [];
const createdUserIds = [];

async function main() {
  const notifier = new FakeNotifier();
  const svc = new GroupJoinRequestService(prisma, { notificationService: notifier });

  // ── 0. Quota tiers (pure function) ─────────────────────────────────────
  console.log('\n[0] resolveAddQuota tiers');
  check('0 AZM → 3', svc.resolveAddQuota(0) === 3);
  check('499 → 3', svc.resolveAddQuota(499) === 3);
  check('500 → 5', svc.resolveAddQuota(500) === 5);
  check('2000 → 8', svc.resolveAddQuota(2000) === 8);
  check('10000 → 12', svc.resolveAddQuota(10000) === 12);

  // Shared cast of users.
  const admin = await mkUser('admin');
  const proposer = await mkUser('proposer');
  const target1 = await mkUser('target1', { displayName: 'Kofi' });
  const target2 = await mkUser('target2', { displayName: 'Ama' });
  createdUserIds.push(admin.id, proposer.id, target1.id, target2.id);

  const group = await mkGroup('vouchgroup', admin.id, [proposer.id]);
  createdGroupIds.push(group.id);

  // ── 1. propose → PENDING rows + notifies both sides ────────────────────
  console.log('\n[1] propose');
  notifier.reset();
  const { requests } = await svc.propose({
    groupId: group.id,
    proposerId: proposer.id,
    targetUserIds: [target1.id, target2.id],
    note: 'susu',
  });
  await flush();
  check('2 PENDING rows created', requests.length === 2 && requests.every((r) => r.status === 'PENDING'));
  const dbPending = await prisma.groupJoinRequest.count({ where: { groupId: group.id, status: 'PENDING' } });
  check('2 PENDING in DB', dbPending === 2);

  // admin notified with the exact copy + note + OPEN_JOIN_REQUESTS action
  const adminNotes = notifier.forUser(admin.id);
  check('admin notified', adminNotes.length === 2);
  check('admin copy + reason note',
    adminNotes[0].body.includes(`wants to add user '`) &&
    adminNotes[0].body.includes(`to your group '${group.name}'`) &&
    adminNotes[0].body.includes('— reason: susu'));
  check('admin action OPEN_JOIN_REQUESTS', adminNotes.every((n) => n.actionPayload.action === 'OPEN_JOIN_REQUESTS'));

  // each target notified with the join-request copy + reference note
  const t1Notes = notifier.forUser(target1.id);
  check('target1 notified', t1Notes.length === 1);
  check('target copy + reference note',
    t1Notes[0].body.includes(`has sent you a request to join '${group.name} group'`) &&
    t1Notes[0].body.includes(`with reference 'susu'`));
  check('target action OPEN_GROUP_INVITE', t1Notes[0].actionPayload.action === 'OPEN_GROUP_INVITE');

  // ── 2. one-PENDING-per-pair guard ──────────────────────────────────────
  console.log('\n[2] one-PENDING-per-pair');
  let dupThrew = false;
  try {
    await svc.propose({ groupId: group.id, proposerId: proposer.id, targetUserIds: [target1.id] });
  } catch (e) { dupThrew = e.code === 'JOIN_REQUEST_DUPLICATE'; }
  check('second PENDING for same pair → JOIN_REQUEST_DUPLICATE', dupThrew);

  // ── 3. admin-only guard on approve/reject ──────────────────────────────
  console.log('\n[3] admin-only guard');
  const req1 = requests.find((r) => r.targetUserId === target1.id);
  const req2 = requests.find((r) => r.targetUserId === target2.id);
  let forbiddenThrew = false;
  try { await svc.approve(req1.id, proposer.id); } catch (e) { forbiddenThrew = e.code === 'JOIN_REQUEST_FORBIDDEN' && e.httpStatus === 403; }
  check('non-admin approve → JOIN_REQUEST_FORBIDDEN 403', forbiddenThrew);

  // ── 4. approve → adds member + vouchedById=proposer ────────────────────
  console.log('\n[4] approve');
  notifier.reset();
  const appr = await svc.approve(req1.id, admin.id);
  await flush();
  check('approve not flagged alreadyResolved', appr.alreadyResolved === false);
  const m1 = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: target1.id } },
  });
  check('target1 is now a member', !!m1 && m1.removedAt == null);
  check('vouchedById = proposer', m1.vouchedById === proposer.id);
  check('addedById = proposer', m1.addedById === proposer.id);
  const req1After = await prisma.groupJoinRequest.findUnique({ where: { id: req1.id } });
  check('request status APPROVED', req1After.status === 'APPROVED');
  check('decidedById = admin', req1After.decidedById === admin.id);
  check('target notified of add', notifier.forUser(target1.id).some((n) => n.actionPayload.action === 'OPEN_GROUP_PROFILE'));

  // ── 5. idempotent re-approve ───────────────────────────────────────────
  console.log('\n[5] idempotent re-resolve');
  notifier.reset();
  const reAppr = await svc.approve(req1.id, admin.id);
  await flush();
  check('re-approve flagged alreadyResolved', reAppr.alreadyResolved === true);
  check('no duplicate notification on re-approve', notifier.sent.length === 0);
  const memberCount = await prisma.groupMember.count({ where: { groupId: group.id, userId: target1.id } });
  check('still exactly one member row for target1', memberCount === 1);

  // ── 6. reject → no member + notifies proposer ──────────────────────────
  console.log('\n[6] reject');
  notifier.reset();
  const rej = await svc.reject(req2.id, admin.id);
  await flush();
  check('reject not flagged alreadyResolved', rej.alreadyResolved === false);
  const m2 = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: target2.id } },
  });
  check('target2 NOT added', !m2);
  const req2After = await prisma.groupJoinRequest.findUnique({ where: { id: req2.id } });
  check('request status REJECTED', req2After.status === 'REJECTED');
  check('proposer notified of rejection', notifier.forUser(proposer.id).length === 1);

  // idempotent re-reject
  notifier.reset();
  const reRej = await svc.reject(req2.id, admin.id);
  await flush();
  check('re-reject flagged alreadyResolved', reRej.alreadyResolved === true);
  check('no notification on re-reject', notifier.sent.length === 0);

  // ── 7. quota ceiling: 4th direct add at tier-3 rejected ────────────────
  console.log('\n[7] quota ceiling (tier-3 admin, 0 AZM)');
  const qAdmin = await mkUser('qadmin', { azmBalance: 0 });
  createdUserIds.push(qAdmin.id);
  const qGroup = await mkGroup('quotagroup', qAdmin.id);
  createdGroupIds.push(qGroup.id);

  const quotaTargets = [];
  for (let i = 0; i < 4; i += 1) {
    const u = await mkUser(`qt${i}`);
    createdUserIds.push(u.id);
    quotaTargets.push(u);
  }

  const q0 = await svc.getAddQuota(qGroup.id, qAdmin.id);
  check('quota=3, used=0 initially', q0.quota === 3 && q0.used === 0);

  // 3 direct adds succeed
  let directOk = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = await svc.adminDirectAdd({ groupId: qGroup.id, adminId: qAdmin.id, targetUserId: quotaTargets[i].id });
    if (r.member) directOk += 1;
  }
  check('3 direct adds succeeded', directOk === 3);
  const directMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: qGroup.id, userId: quotaTargets[0].id } },
  });
  check('direct-add vouchedById = admin', directMember.vouchedById === qAdmin.id);

  // 4th direct add rejected with ADD_QUOTA_EXCEEDED
  let quotaThrew = false;
  try {
    await svc.adminDirectAdd({ groupId: qGroup.id, adminId: qAdmin.id, targetUserId: quotaTargets[3].id });
  } catch (e) { quotaThrew = e.code === 'ADD_QUOTA_EXCEEDED' && e.httpStatus === 409; }
  check('4th direct add → ADD_QUOTA_EXCEEDED 409', quotaThrew);
  const q1 = await svc.getAddQuota(qGroup.id, qAdmin.id);
  check('used=3, remaining=0 after ceiling', q1.used === 3 && q1.remaining === 0);

  // ── cleanup ────────────────────────────────────────────────────────────
  console.log('\n[cleanup]');
  await prisma.groupJoinRequest.deleteMany({ where: { groupId: { in: createdGroupIds } } });
  await prisma.groupMessage.deleteMany({ where: { groupId: { in: createdGroupIds } } });
  await prisma.groupMember.deleteMany({ where: { groupId: { in: createdGroupIds } } });
  await prisma.groupChat.deleteMany({ where: { id: { in: createdGroupIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  // best-effort cleanup
  try {
    await prisma.groupJoinRequest.deleteMany({ where: { groupId: { in: createdGroupIds } } });
    await prisma.groupMessage.deleteMany({ where: { groupId: { in: createdGroupIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: { in: createdGroupIds } } });
    await prisma.groupChat.deleteMany({ where: { id: { in: createdGroupIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch (_) { /* ignore */ }
  await prisma.$disconnect();
  process.exit(1);
});
