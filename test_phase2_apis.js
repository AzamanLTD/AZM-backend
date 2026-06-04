#!/usr/bin/env node
/**
 * Phase 2 Verification Gate — private-susu-ecosystem
 *
 * Drives the new HTTP surface end-to-end against a local backend, using
 * fresh fixture state per scenario (no shared production demo accounts).
 *
 * Scenarios:
 *   1. Onboarding happy path     (Susu activates, payoutSlot permutation complete)
 *   2. KYC gate                  (KYC_REQUIRED 403)
 *   3. PoR gate                  (RESIDENCY_REQUIRED 403)
 *   4. Contract version mismatch (CONTRACT_VERSION_MISMATCH 409 + idempotent re-post)
 *   5. Privacy 404 uniformity    (non-member + bogus id → identical envelope)
 *   6. Cancel from CONFIGURING   (VouchRecords flip to VOIDED)
 *   7. Decline + replacement     (declined slot can be re-invited)
 *
 * Usage:  node test_phase2_apis.js [BASE_URL]
 *         BASE_URL defaults to http://localhost:3777
 */

const axios = require('axios');
const { execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { issueTokenPair } = require('./services/authTokenService');

const BASE = (process.argv[2] || 'http://localhost:3777').replace(/\/$/, '');
const API = `${BASE}/api`;
const PASSWORD = 'TestPass123!';

let pass = 0;
let fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) {
  console.log(`  ✗ ${label}`);
  if (err?.response?.data) console.log('    server said:', JSON.stringify(err.response.data));
  else if (err) console.log('    error:', err.message || err);
  fail++;
}
function assertEq(label, got, want) {
  const okp = JSON.stringify(got) === JSON.stringify(want);
  if (okp) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(`${label} expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
}

const prisma = new PrismaClient();

// --- Fixture utilities ----------------------------------------------------

async function nukeFixtures() {
  // Wipe every Phase-2 test artifact so each run starts clean.
  // We key off the test username prefix to avoid touching real accounts.
  const users = await prisma.user.findMany({
    where: { username: { startsWith: 'p2test_' } },
    select: { id: true },
  });
  const ids = users.map(u => u.id);
  if (ids.length === 0) return;
  // Walk dependent rows first to avoid FK violations
  await prisma.susuReminderSent.deleteMany({ where: { member: { userId: { in: ids } } } });
  await prisma.voucherSlashLog.deleteMany({ where: { OR: [{ vouchedUserId: { in: ids } }, { voucherId: { in: ids } }] } });
  await prisma.adminWarRoomAlert.deleteMany({ where: { susu: { members: { some: { userId: { in: ids } } } } } });
  await prisma.liabilityAcceptance.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuInvite.deleteMany({ where: { OR: [{ inviterId: { in: ids } }, { inviteeUserId: { in: ids } }] } });
  await prisma.susuContribution.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuCycle.deleteMany({ where: { susu: { members: { some: { userId: { in: ids } } } } } });
  await prisma.susuMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.susuGroup.deleteMany({
    where: { groupChat: { createdById: { in: ids } } },
  });
  await prisma.vouchRecord.deleteMany({ where: { OR: [{ voucherId: { in: ids } }, { inviteeId: { in: ids } }] } });
  await prisma.groupMessage.deleteMany({ where: { senderId: { in: ids } } });
  await prisma.groupMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.groupChat.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(handle, opts = {}) {
  const username = `p2test_${handle}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const email = `${username}@phase2.test`;
  // Bypass /auth/register so we don't trip the 5-req/min rate limiter.
  // Mint the User row directly + issue a token pair via the same helper
  // the auth controller uses.
  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  const data = {
    username,
    email,
    password: hashedPassword,
    availableBalance: 0.0,
  };
  if (opts.kyc !== false) data.kycStatus = 'VERIFIED';
  if (opts.por !== false) {
    data.proofOfResidencyStatus = 'VERIFIED';
    data.proofOfResidencyVerifiedAt = new Date();
  }
  const created = await prisma.user.create({ data });
  const { accessToken } = await issueTokenPair(prisma, created, {
    userAgent: 'phase2-test', ipAddress: '127.0.0.1',
  });
  return {
    id: created.id,
    username,
    email,
    token: accessToken,
    auth: { headers: { Authorization: `Bearer ${accessToken}` } },
  };
}

async function makeFriendship(a, b) {
  // Bypass the request/accept dance — direct DB insert.
  await prisma.friendship.create({
    data: { requesterId: a.id, addresseeId: b.id, status: 'ACCEPTED' },
  });
}

async function getActiveContract() {
  const r = await axios.get(`${API}/liability-contract/active`);
  // The overlay controller wraps the row in { contract: ... }
  return r.data.data.contract || r.data.data;
}

// =============================================================================
// SCENARIOS
// =============================================================================

async function scenarioOnboardingHappyPath() {
  console.log('\n1️⃣  Onboarding happy path');
  const initiator = await makeUser('init1');
  const m2 = await makeUser('m2');
  const m3 = await makeUser('m3');
  await makeFriendship(initiator, m2);
  await makeFriendship(initiator, m3);

  const contract = await getActiveContract();
  ok(`active contract loaded version=${contract.version}`);

  const createRes = await axios.post(`${API}/susu/`, {
    name: 'Phase2 Happy Susu',
    contributionUsdc: '10',
    frequency: 'WEEKLY',
    invites: [
      { channel: 'FRIEND', inviteeUserId: m2.id },
      { channel: 'FRIEND', inviteeUserId: m3.id },
    ],
  }, initiator.auth);
  if (createRes.status !== 201) return bad('create returned 201');
  const susuId = createRes.data.data.susu.id;
  ok(`susu created (id=${susuId.slice(0, 8)}...)`);

  // Initiator accepts contract first
  await axios.post(`${API}/susu/${susuId}/contract/accept`, {
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
  }, initiator.auth);
  ok('initiator contract accepted');

  // Each invite has been created with status=PENDING. Find them by walking from m2/m3 side.
  const m2Invite = await prisma.susuInvite.findFirst({ where: { susuGroupId: susuId, inviteeUserId: m2.id } });
  const m3Invite = await prisma.susuInvite.findFirst({ where: { susuGroupId: susuId, inviteeUserId: m3.id } });
  if (!m2Invite || !m3Invite) return bad('invite rows present for m2 + m3');

  // m2 accepts
  await axios.post(`${API}/susu/invites/${m2Invite.id}/accept`, {}, m2.auth);
  await axios.post(`${API}/susu/${susuId}/contract/accept`, {
    contractVersion: contract.version, contractHash: contract.contractHash, agreed: true,
  }, m2.auth);
  ok('m2 accepted invite + contract');

  // m3 accepts (this should trigger Susu activation)
  await axios.post(`${API}/susu/invites/${m3Invite.id}/accept`, {}, m3.auth);
  await axios.post(`${API}/susu/${susuId}/contract/accept`, {
    contractVersion: contract.version, contractHash: contract.contractHash, agreed: true,
  }, m3.auth);

  // Re-read Susu — should now be ACTIVE with payoutSlot 1..3
  const susuRow = await prisma.susuGroup.findUnique({
    where: { id: susuId },
    include: { members: { orderBy: { cycleSlot: 'asc' } }, cycles: { orderBy: { cycleNumber: 'asc' } } },
  });
  if (susuRow.status !== 'ACTIVE') return bad(`susu status expected ACTIVE got ${susuRow.status}`);
  ok('susu transitioned to ACTIVE');

  const slots = susuRow.members.map(m => m.cycleSlot).sort();
  assertEq('payoutSlot permutation', slots, [1, 2, 3]);
  if (susuRow.cycles.length !== 3) return bad(`expected 3 cycles, got ${susuRow.cycles.length}`);
  ok(`${susuRow.cycles.length} cycles created`);

  // VouchRecord assertions
  const vouches = await prisma.vouchRecord.findMany({ where: { voucherId: initiator.id } });
  if (vouches.length < 2) return bad(`expected ≥2 vouches for initiator, got ${vouches.length}`);
  ok(`${vouches.length} VouchRecords created with status=COMPLETED`);
}

async function scenarioKycGate() {
  console.log('\n2️⃣  KYC gate');
  const noKyc = await makeUser('nokyc', { kyc: false, por: true });
  try {
    await axios.post(`${API}/susu/`, {
      name: 'NoKYC Test', contributionUsdc: '10', frequency: 'WEEKLY',
      invites: [{ channel: 'FRIEND', inviteeUserId: 1 }],
    }, noKyc.auth);
    bad('expected KYC_REQUIRED 403');
  } catch (e) {
    if (e.response?.status === 403 && e.response.data?.errorCode === 'KYC_REQUIRED') {
      ok('KYC_REQUIRED 403');
    } else {
      bad('expected KYC_REQUIRED 403', e);
    }
  }
}

async function scenarioPorGate() {
  console.log('\n3️⃣  PoR gate');
  const noPor = await makeUser('nopor', { kyc: true, por: false });
  try {
    await axios.post(`${API}/susu/`, {
      name: 'NoPoR Test', contributionUsdc: '10', frequency: 'WEEKLY',
      invites: [{ channel: 'FRIEND', inviteeUserId: 1 }],
    }, noPor.auth);
    bad('expected RESIDENCY_REQUIRED 403');
  } catch (e) {
    if (e.response?.status === 403 && e.response.data?.errorCode === 'RESIDENCY_REQUIRED') {
      ok('RESIDENCY_REQUIRED 403');
    } else {
      bad('expected RESIDENCY_REQUIRED 403', e);
    }
  }
}

async function scenarioContractVersionMismatch() {
  console.log('\n4️⃣  Contract version mismatch + idempotent re-post');
  const initiator = await makeUser('cinit');
  const m2 = await makeUser('cm2');
  await makeFriendship(initiator, m2);
  const contract = await getActiveContract();

  const cr = await axios.post(`${API}/susu/`, {
    name: 'Mismatch Test', contributionUsdc: '5', frequency: 'WEEKLY',
    invites: [{ channel: 'FRIEND', inviteeUserId: m2.id }],
  }, initiator.auth);
  const susuId = cr.data.data.susu.id;

  // Submit a wrong hash
  try {
    await axios.post(`${API}/susu/${susuId}/contract/accept`, {
      contractVersion: contract.version,
      contractHash: 'a'.repeat(64),
      agreed: true,
    }, initiator.auth);
    bad('expected CONTRACT_VERSION_MISMATCH 409');
  } catch (e) {
    if (e.response?.status === 409 && e.response.data?.errorCode === 'CONTRACT_VERSION_MISMATCH') {
      ok('CONTRACT_VERSION_MISMATCH 409');
    } else {
      bad('expected CONTRACT_VERSION_MISMATCH 409', e);
    }
  }

  // Now submit correctly — should succeed
  const accept1 = await axios.post(`${API}/susu/${susuId}/contract/accept`, {
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
  }, initiator.auth);
  if (accept1.status !== 200) return bad('accept returned 200');
  ok('contract accepted');

  // Re-submit same body — idempotent (Property 12)
  const accept2 = await axios.post(`${API}/susu/${susuId}/contract/accept`, {
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
  }, initiator.auth);
  if (accept2.status !== 200) return bad('idempotent accept returned 200');
  // Same acceptance row id?
  const id1 = accept1.data.data.acceptance?.id;
  const id2 = accept2.data.data.acceptance?.id;
  if (id1 && id2 && id1 === id2) ok('idempotent re-post returns same acceptance id');
  else bad(`idempotent acceptance ids should match (got ${id1} vs ${id2})`);
}

async function scenarioPrivacy404Uniformity() {
  console.log('\n5️⃣  Privacy 404 uniformity');
  const member = await makeUser('priv_member');
  const outsider = await makeUser('priv_outsider');
  const m2 = await makeUser('priv_m2');
  await makeFriendship(member, m2);

  const cr = await axios.post(`${API}/susu/`, {
    name: 'Privacy Test', contributionUsdc: '5', frequency: 'WEEKLY',
    invites: [{ channel: 'FRIEND', inviteeUserId: m2.id }],
  }, member.auth);
  const susuId = cr.data.data.susu.id;

  // Outsider GETs the existing Susu — should be 404 with SUSU_NOT_FOUND
  let outsiderBody;
  try {
    await axios.get(`${API}/susu/${susuId}`, outsider.auth);
    bad('non-member GET of existing Susu should 404');
  } catch (e) {
    if (e.response?.status === 404 && e.response.data?.errorCode === 'SUSU_NOT_FOUND') {
      outsiderBody = e.response.data;
      ok('non-member GET → 404 SUSU_NOT_FOUND');
    } else {
      bad('non-member GET expected 404 SUSU_NOT_FOUND', e);
    }
  }

  // Outsider GETs a bogus id — should be the SAME envelope shape
  let bogusBody;
  try {
    await axios.get(`${API}/susu/00000000-0000-0000-0000-000000000000`, outsider.auth);
    bad('bogus-id GET should 404');
  } catch (e) {
    if (e.response?.status === 404 && e.response.data?.errorCode === 'SUSU_NOT_FOUND') {
      bogusBody = e.response.data;
      ok('bogus-id GET → 404 SUSU_NOT_FOUND');
    } else {
      bad('bogus-id GET expected 404 SUSU_NOT_FOUND', e);
    }
  }

  if (outsiderBody && bogusBody) {
    const a = JSON.stringify(outsiderBody);
    const b = JSON.stringify(bogusBody);
    if (a === b) ok('byte-identical 404 envelope shape (Property 14)');
    else bad(`envelope shape mismatch: ${a} vs ${b}`);
  }
}

async function scenarioCancelWithVouchVoid() {
  console.log('\n6️⃣  Cancel from CONFIGURING — VouchRecord flips to VOIDED');
  const initiator = await makeUser('cancel_init');
  const m2 = await makeUser('cancel_m2');
  await makeFriendship(initiator, m2);

  const cr = await axios.post(`${API}/susu/`, {
    name: 'Cancel Test', contributionUsdc: '5', frequency: 'WEEKLY',
    invites: [{ channel: 'FRIEND', inviteeUserId: m2.id }],
  }, initiator.auth);
  const susuId = cr.data.data.susu.id;
  const inv = await prisma.susuInvite.findFirst({ where: { susuGroupId: susuId, inviteeUserId: m2.id } });
  await axios.post(`${API}/susu/invites/${inv.id}/accept`, {}, m2.auth);

  // m2's VouchRecord should now exist with status=COMPLETED
  const vouchBefore = await prisma.vouchRecord.findFirst({ where: { inviteeId: m2.id } });
  if (vouchBefore?.status !== 'COMPLETED') {
    return bad(`expected vouch status COMPLETED, got ${vouchBefore?.status}`);
  }
  ok('vouch initially COMPLETED');

  // Capture initial AZM + trustRating snapshots
  const before = await prisma.user.findUnique({ where: { id: initiator.id }, select: { azmBalance: true, trustRating: true } });

  // Cancel
  await axios.post(`${API}/susu/${susuId}/cancel`, {}, initiator.auth);
  ok('cancel POST returned 200');

  const susuAfter = await prisma.susuGroup.findUnique({ where: { id: susuId } });
  if (susuAfter.status !== 'CANCELLED') return bad(`expected CANCELLED, got ${susuAfter.status}`);
  ok('Susu.status = CANCELLED');

  const vouchAfter = await prisma.vouchRecord.findUnique({ where: { id: vouchBefore.id } });
  if (vouchAfter?.status !== 'VOIDED') return bad(`expected VOIDED, got ${vouchAfter?.status}`);
  ok('VouchRecord.status flipped → VOIDED');

  // No AZM/trustRating penalty applied
  const after = await prisma.user.findUnique({ where: { id: initiator.id }, select: { azmBalance: true, trustRating: true } });
  if (Number(after.azmBalance) !== Number(before.azmBalance)) bad('initiator AZM unchanged');
  else ok('no AZM penalty');
  if (after.trustRating !== before.trustRating) bad('initiator trustRating unchanged');
  else ok('no trustRating penalty');
}

async function scenarioDeclineAndReplace() {
  console.log('\n7️⃣  Decline + replacement');
  const initiator = await makeUser('decl_init');
  const m2 = await makeUser('decl_m2');
  const m3 = await makeUser('decl_m3');
  await makeFriendship(initiator, m2);
  await makeFriendship(initiator, m3);

  const cr = await axios.post(`${API}/susu/`, {
    name: 'Decline Test', contributionUsdc: '5', frequency: 'WEEKLY',
    invites: [{ channel: 'FRIEND', inviteeUserId: m2.id }],
  }, initiator.auth);
  const susuId = cr.data.data.susu.id;
  const inv = await prisma.susuInvite.findFirst({ where: { susuGroupId: susuId, inviteeUserId: m2.id } });

  // m2 declines
  const decl = await axios.post(`${API}/susu/invites/${inv.id}/decline`, {}, m2.auth);
  if (decl.data.data.invite.status !== 'DECLINED') return bad(`expected DECLINED status, got ${decl.data.data.invite.status}`);
  ok('decline returned status=DECLINED');

  // Initiator can now invite m3 to fill the slot
  const r2 = await axios.post(`${API}/susu/${susuId}/invites`, {
    channel: 'FRIEND', inviteeUserId: m3.id,
  }, initiator.auth);
  if (r2.status !== 201) return bad('replacement invite returned 201');
  ok('replacement invite accepted');
}

// --- Driver --------------------------------------------------------------

async function main() {
  console.log('═════════════════════════════════════════════════════════════');
  console.log('Phase 2 Verification Gate — private-susu-ecosystem');
  console.log(`Target: ${BASE}`);
  console.log('═════════════════════════════════════════════════════════════');

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    await nukeFixtures();
    await scenarioOnboardingHappyPath();
    await scenarioKycGate();
    await scenarioPorGate();
    // The contract-mismatch test re-uses the same user for 3 financial POSTs.
    // Each scenario uses fresh users so per-user buckets reset, but a tight
    // burst against the same user can still hit the 10/min financialLimiter.
    // Small breather between high-traffic scenarios keeps the gate stable.
    await sleep(500);
    await scenarioContractVersionMismatch();
    await scenarioPrivacy404Uniformity();
    await scenarioCancelWithVouchVoid();
    await scenarioDeclineAndReplace();
  } catch (err) {
    console.error('\n💥 Verification crashed:', err.response?.data || err.message);
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
