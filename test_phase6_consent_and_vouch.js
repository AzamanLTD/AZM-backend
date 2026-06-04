#!/usr/bin/env node
// test_phase6_consent_and_vouch.js
// =============================================================================
// PHASE 6 / Phase 4 — Consent & Vouch Test Suite
//
// Validates:
//   • acceptContract stores acknowledgedClauses + voucherUserId (Req 11)
//   • vouched/unvouched projection in getInitiationStatus (Req 12)
//   • vouchMember endpoint sets GroupMember.vouchedById (Req 12)
//   • auto-kick removes still-unvouched members at deadline (Req 12)
//
// Fixtures are cleaned up after each scenario.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LiabilityContractService = require('./services/susu/liabilityContract.service');
const SusuInitiationService = require('./services/susu/susuInitiation.service');
const GroupJoinRequestService = require('./services/groups/groupJoinRequest.service');

let testCount = 0;
let passCount = 0;

function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function cleanup() {
  // Clean up test data in reverse dependency order
  await prisma.groupJoinRequest.deleteMany({ where: { groupId: { startsWith: 'test-' } } });
  await prisma.liabilityAcceptance.deleteMany({ where: { susuGroupId: { startsWith: 'test-' } } });
  await prisma.susuMember.deleteMany({ where: { susuGroupId: { startsWith: 'test-' } } });
  await prisma.susuGroup.deleteMany({ where: { id: { startsWith: 'test-' } } });
  await prisma.groupMessage.deleteMany({ where: { groupId: { startsWith: 'test-' } } });
  await prisma.groupMember.deleteMany({ where: { groupId: { startsWith: 'test-' } } });
  await prisma.groupChat.deleteMany({ where: { id: { startsWith: 'test-' } } });
  await prisma.liabilityContractVersion.deleteMany({ where: { version: { startsWith: 'test-' } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: 'test-consent-' } } });
}

async function createTestUser(username, verified = true) {
  return prisma.user.create({
    data: {
      username,
      email: `${username}@test.local`,
      password: 'hashed',
      kycStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
      proofOfResidencyStatus: verified ? 'VERIFIED' : 'NOT_SUBMITTED',
      azmBalance: 1000,
    },
  });
}

async function createTestGroup(creatorId, memberIds, name = 'Test Group') {
  const groupId = `test-consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const group = await prisma.groupChat.create({
    data: {
      id: groupId,
      name,
      status: 'ACTIVE',
      createdBy: { connect: { id: creatorId } },
    },
  });
  for (const userId of memberIds) {
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId,
        role: userId === creatorId ? 'ADMIN' : 'MEMBER',
      },
    });
  }
  return group;
}

async function createTestContract(publishedBy) {
  const version = `test-v${Date.now()}`;
  const body = 'Test liability contract body with sufficient length to pass validation requirements for the contract service.';
  const contractService = new LiabilityContractService(prisma);
  return contractService.publishNewVersion({ adminUserId: publishedBy, version, body });
}

// ── Scenario 1: acceptContract stores acknowledgedClauses + voucherUserId ───
async function test1_acceptContractStoresConsentFields() {
  console.log('\n[Scenario 1] acceptContract stores acknowledgedClauses + voucherUserId');
  
  const admin = await createTestUser('test-consent-admin-1', true);
  const member = await createTestUser('test-consent-member-1', true);
  const voucher = await createTestUser('test-consent-voucher-1', true);
  
  const group = await createTestGroup(admin.id, [admin.id, member.id, voucher.id]);
  const contract = await createTestContract(admin.id);
  
  // Create a SusuGroup in CONFIGURING state
  const susu = await prisma.susuGroup.create({
    data: {
      id: `test-consent-susu-${Date.now()}`,
      status: 'CONFIGURING',
      contributionUsdc: 100,
      frequency: 'WEEKLY',
      totalCycles: 3,
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      contractRequiredCount: 3,
      contractAcceptedCount: 0,
      rotationSnapshot: { pending: true },
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      initiationDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      initiatedById: admin.id,
    },
  });
  
  await prisma.groupChat.update({
    where: { id: group.id },
    data: { susuGroupId: susu.id },
  });
  
  // Create SusuMember in PENDING_CONTRACT state
  await prisma.susuMember.create({
    data: {
      id: `test-consent-sm-${Date.now()}`,
      susuGroupId: susu.id,
      userId: member.id,
      cycleSlot: -member.id,
      trustScore: 100,
      status: 'PENDING_CONTRACT',
      inviterId: admin.id,
    },
  });
  
  const contractService = new LiabilityContractService(prisma);
  const acknowledgedClauses = ['seizure', 'tracing', 'named_voucher'];
  
  const acceptance = await contractService.acceptContract({
    userId: member.id,
    susuGroupId: susu.id,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    acknowledgedClauses,
    voucherUserId: voucher.id,
  });
  
  assert(acceptance.acknowledgedClauses !== null, 'acknowledgedClauses is persisted');
  assert(Array.isArray(acceptance.acknowledgedClauses), 'acknowledgedClauses is an array');
  assert(acceptance.acknowledgedClauses.length === 3, 'acknowledgedClauses has 3 items');
  assert(acceptance.acknowledgedClauses.includes('seizure'), 'acknowledgedClauses includes seizure');
  assert(acceptance.voucherUserId === voucher.id, 'voucherUserId is persisted');
  
  // Verify it's stored in the database
  const stored = await prisma.liabilityAcceptance.findUnique({
    where: { id: acceptance.id },
  });
  assert(stored.voucherUserId === voucher.id, 'voucherUserId persisted in DB');
  assert(Array.isArray(stored.acknowledgedClauses), 'acknowledgedClauses persisted as JSON array');
}

// ── Scenario 2: getInitiationStatus includes vouched flag ───────────────────
async function test2_initiationStatusIncludesVouchedFlag() {
  console.log('\n[Scenario 2] getInitiationStatus includes vouched flag');
  
  const admin = await createTestUser('test-consent-admin-2', true);
  const vouchedMember = await createTestUser('test-consent-vouched-2', true);
  const unvouchedMember = await createTestUser('test-consent-unvouched-2', true);
  
  const group = await createTestGroup(admin.id, [admin.id, vouchedMember.id, unvouchedMember.id]);
  
  // Set vouchedById for one member
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: group.id, userId: vouchedMember.id } },
    data: { vouchedById: admin.id },
  });
  
  const contract = await createTestContract(admin.id);
  
  const susu = await prisma.susuGroup.create({
    data: {
      id: `test-consent-susu-${Date.now()}`,
      status: 'CONFIGURING',
      contributionUsdc: 100,
      frequency: 'WEEKLY',
      totalCycles: 3,
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      contractRequiredCount: 3,
      contractAcceptedCount: 0,
      rotationSnapshot: { pending: true },
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      initiationDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      initiatedById: admin.id,
    },
  });
  
  await prisma.groupChat.update({
    where: { id: group.id },
    data: { susuGroupId: susu.id },
  });
  
  const initiationService = new SusuInitiationService(prisma);
  const status = await initiationService.getInitiationStatus({
    groupId: group.id,
    viewerId: admin.id,
  });
  
  assert(status.members.length === 3, 'Status includes all 3 members');
  
  const vouchedMemberStatus = status.members.find((m) => m.userId === vouchedMember.id);
  const unvouchedMemberStatus = status.members.find((m) => m.userId === unvouchedMember.id);
  
  assert(vouchedMemberStatus.vouched === true, 'Vouched member has vouched=true');
  assert(unvouchedMemberStatus.vouched === false, 'Unvouched member has vouched=false');
}

// ── Scenario 3: vouchMember endpoint sets GroupMember.vouchedById ───────────
async function test3_vouchMemberSetsVouchedById() {
  console.log('\n[Scenario 3] vouchMember endpoint sets GroupMember.vouchedById');
  
  const admin = await createTestUser('test-consent-admin-3', true);
  const voucher = await createTestUser('test-consent-voucher-3', true);
  const target = await createTestUser('test-consent-target-3', true);
  
  const group = await createTestGroup(admin.id, [admin.id, voucher.id, target.id]);
  
  const initiationService = new SusuInitiationService(prisma);
  
  const result = await initiationService.vouchMember({
    groupId: group.id,
    voucherId: voucher.id,
    targetUserId: target.id,
  });
  
  assert(result.vouched === true, 'vouchMember returns vouched=true');
  
  const groupMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: target.id } },
  });
  
  assert(groupMember.vouchedById === voucher.id, 'GroupMember.vouchedById is set to voucher');
}

// ── Scenario 4: vouchMember rejects already-vouched target ──────────────────
async function test4_vouchMemberRejectsAlreadyVouched() {
  console.log('\n[Scenario 4] vouchMember rejects already-vouched target');
  
  const admin = await createTestUser('test-consent-admin-4', true);
  const voucher1 = await createTestUser('test-consent-voucher1-4', true);
  const voucher2 = await createTestUser('test-consent-voucher2-4', true);
  const target = await createTestUser('test-consent-target-4', true);
  
  const group = await createTestGroup(admin.id, [admin.id, voucher1.id, voucher2.id, target.id]);
  
  // First vouch succeeds
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: group.id, userId: target.id } },
    data: { vouchedById: voucher1.id },
  });
  
  const initiationService = new SusuInitiationService(prisma);
  
  // Second vouch should fail
  let threw = false;
  try {
    await initiationService.vouchMember({
      groupId: group.id,
      voucherId: voucher2.id,
      targetUserId: target.id,
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes('already has a voucher'), 'Error message mentions already vouched');
  }
  
  assert(threw, 'vouchMember throws when target already vouched');
}

// ── Scenario 5: auto-kick removes unvouched members at deadline ─────────────
async function test5_autoKickRemovesUnvouchedMembers() {
  console.log('\n[Scenario 5] auto-kick removes unvouched members at deadline');
  
  const admin = await createTestUser('test-consent-admin-5', true);
  const vouchedMember = await createTestUser('test-consent-vouched-5', true);
  const unvouchedMember = await createTestUser('test-consent-unvouched-5', true);
  
  const group = await createTestGroup(admin.id, [admin.id, vouchedMember.id, unvouchedMember.id]);
  
  // Set vouchedById for admin and vouchedMember
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: group.id, userId: admin.id } },
    data: { vouchedById: admin.id }, // self-vouch for simplicity
  });
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: group.id, userId: vouchedMember.id } },
    data: { vouchedById: admin.id },
  });
  
  const contract = await createTestContract(admin.id);
  
  // Create SusuGroup with expired deadline
  const susu = await prisma.susuGroup.create({
    data: {
      id: `test-consent-susu-${Date.now()}`,
      status: 'CONFIGURING',
      contributionUsdc: 100,
      frequency: 'WEEKLY',
      totalCycles: 3,
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      contractRequiredCount: 3,
      contractAcceptedCount: 0,
      rotationSnapshot: { pending: true },
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      initiationDeadline: new Date(Date.now() - 1000), // expired
      initiatedById: admin.id,
    },
  });
  
  await prisma.groupChat.update({
    where: { id: group.id },
    data: { susuGroupId: susu.id },
  });
  
  // Create SusuMembers - all ACTIVE for this test
  for (const userId of [admin.id, vouchedMember.id, unvouchedMember.id]) {
    await prisma.susuMember.create({
      data: {
        id: `test-consent-sm-${userId}-${Date.now()}`,
        susuGroupId: susu.id,
        userId,
        cycleSlot: -userId,
        trustScore: 100,
        status: 'ACTIVE',
        inviterId: admin.id,
      },
    });
  }
  
  const initiationService = new SusuInitiationService(prisma);
  const results = await initiationService.sweepExpiredInitiations();
  
  assert(results.length === 1, 'Sweep processed 1 expired initiation');
  assert(results[0].removed === 1, 'Sweep removed 1 unvouched member');
  
  // Verify unvouched member was removed from GroupChat
  const unvouchedGroupMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: unvouchedMember.id } },
  });
  assert(unvouchedGroupMember.removedAt !== null, 'Unvouched member was removed from group');
  assert(unvouchedGroupMember.removedReason.includes('voucher'), 'Removal reason mentions voucher');
  
  // Verify vouched members remain
  const vouchedGroupMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: vouchedMember.id } },
  });
  assert(vouchedGroupMember.removedAt === null, 'Vouched member remains in group');
}

// ── Scenario 6: idempotent acceptance preserves original consent fields ──────
async function test6_idempotentAcceptancePreservesFields() {
  console.log('\n[Scenario 6] idempotent acceptance preserves original consent fields');
  
  const admin = await createTestUser('test-consent-admin-6', true);
  const member = await createTestUser('test-consent-member-6', true);
  const voucher = await createTestUser('test-consent-voucher-6', true);
  
  const group = await createTestGroup(admin.id, [admin.id, member.id, voucher.id]);
  const contract = await createTestContract(admin.id);
  
  const susu = await prisma.susuGroup.create({
    data: {
      id: `test-consent-susu-${Date.now()}`,
      status: 'CONFIGURING',
      contributionUsdc: 100,
      frequency: 'WEEKLY',
      totalCycles: 3,
      startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      contractRequiredCount: 3,
      contractAcceptedCount: 0,
      rotationSnapshot: { pending: true },
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      initiationDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      initiatedById: admin.id,
    },
  });
  
  await prisma.groupChat.update({
    where: { id: group.id },
    data: { susuGroupId: susu.id },
  });
  
  await prisma.susuMember.create({
    data: {
      id: `test-consent-sm-${Date.now()}`,
      susuGroupId: susu.id,
      userId: member.id,
      cycleSlot: -member.id,
      trustScore: 100,
      status: 'PENDING_CONTRACT',
      inviterId: admin.id,
    },
  });
  
  const contractService = new LiabilityContractService(prisma);
  const originalClauses = ['seizure', 'tracing'];
  
  // First acceptance
  const acceptance1 = await contractService.acceptContract({
    userId: member.id,
    susuGroupId: susu.id,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    acknowledgedClauses: originalClauses,
    voucherUserId: voucher.id,
  });
  
  // Second acceptance with different clauses (should return original)
  const acceptance2 = await contractService.acceptContract({
    userId: member.id,
    susuGroupId: susu.id,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    agreed: true,
    ipAddress: '127.0.0.2',
    userAgent: 'different-agent',
    acknowledgedClauses: ['different', 'clauses'],
    voucherUserId: admin.id, // different voucher
  });
  
  assert(acceptance1.id === acceptance2.id, 'Idempotent acceptance returns same row');
  assert(acceptance2.voucherUserId === voucher.id, 'Original voucherUserId preserved');
  assert(acceptance2.acknowledgedClauses.length === 2, 'Original acknowledgedClauses preserved');
  assert(acceptance2.acknowledgedClauses.includes('seizure'), 'Original clauses intact');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80));
  console.log('PHASE 6 / Phase 4 — Consent & Vouch Test Suite');
  console.log('='.repeat(80));
  
  try {
    await cleanup();
    
    await test1_acceptContractStoresConsentFields();
    await cleanup();
    
    await test2_initiationStatusIncludesVouchedFlag();
    await cleanup();
    
    await test3_vouchMemberSetsVouchedById();
    await cleanup();
    
    await test4_vouchMemberRejectsAlreadyVouched();
    await cleanup();
    
    await test5_autoKickRemovesUnvouchedMembers();
    await cleanup();
    
    await test6_idempotentAcceptancePreservesFields();
    await cleanup();
    
    console.log('\n' + '='.repeat(80));
    console.log(`RESULTS: ${passCount}/${testCount} tests passed`);
    console.log('='.repeat(80));
    
    if (passCount === testCount) {
      console.log('✓ All tests passed!');
      process.exit(0);
    } else {
      console.error(`✗ ${testCount - passCount} test(s) failed`);
      process.exit(1);
    }
  } catch (err) {
    console.error('\n✗ Test suite failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
