// test_phase6_identity.js
// =============================================================================
// Phase 6 / Phase 1 — Identity Foundation verification.
//
// Exercises IdentityService + the backfill directly against the local DB:
//   1. generateUniqueAzamanId — format + uniqueness
//   2. lookupByAzamanId — projection (no PII), malformed reject, self reject,
//      not-found
//   3. discoverByPhones — hash-matched, verified+discoverable only, opt-out
//      excluded, unverified excluded, caller excluded, cap enforced
//   4. backfill idempotency — second run assigns 0
//
// Run:  node test_phase6_identity.js   (against local DB)
// =============================================================================

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { IdentityService, AZAMAN_ID_RE } = require('./services/identity/identity.service');
const { hashPhone } = require('./services/identity/phoneHash');
const { backfillAzamanIds } = require('./infra/backfill-azaman-ids');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const TAG = `id6_${Date.now()}`;

async function mkUser(suffix, extra = {}) {
  const svc = new IdentityService(prisma);
  const azamanId = await svc.generateUniqueAzamanId();
  return prisma.user.create({
    data: {
      username: `${TAG}_${suffix}`,
      email: `${TAG}_${suffix}@test.local`,
      password: 'x',
      azamanId,
      ...extra,
    },
  });
}

async function main() {
  const svc = new IdentityService(prisma);

  // ── 1. Generation: format + uniqueness ────────────────────────────────
  console.log('\n[1] generateUniqueAzamanId');
  {
    const ids = new Set();
    let formatOk = true;
    for (let i = 0; i < 50; i += 1) {
      const id = await svc.generateUniqueAzamanId();
      if (!AZAMAN_ID_RE.test(id)) formatOk = false;
      ids.add(id);
    }
    check('all 50 match ^AZM-\\d{9}$', formatOk);
    check('all 50 unique', ids.size === 50);
  }

  // ── 2. lookupByAzamanId ───────────────────────────────────────────────
  console.log('\n[2] lookupByAzamanId');
  {
    const u1 = await mkUser('look1', { displayName: 'Ama', profilePictureUrl: 'http://x/a.png', email: `${TAG}_look1pii@test.local` });
    const u2 = await mkUser('look2');

    const found = await svc.lookupByAzamanId(u2.id, u1.azamanId);
    check('returns the matching user', found.azamanId === u1.azamanId);
    check('projection has only azamanId/displayName/avatar',
      Object.keys(found).sort().join(',') === 'avatar,azamanId,displayName');
    check('no email/id/phone leaked', !('email' in found) && !('id' in found) && !('phoneNumber' in found));

    let malformedThrew = false;
    try { await svc.lookupByAzamanId(u2.id, 'AZM-123'); } catch (e) { malformedThrew = e.code === 'AZAMAN_ID_INVALID'; }
    check('malformed id rejected (no lookup)', malformedThrew);

    let selfThrew = false;
    try { await svc.lookupByAzamanId(u1.id, u1.azamanId); } catch (e) { selfThrew = e.code === 'AZAMAN_ID_SELF'; }
    check('self-lookup rejected', selfThrew);

    let nfThrew = false;
    try { await svc.lookupByAzamanId(u2.id, 'AZM-000000001'); } catch (e) { nfThrew = e.code === 'USER_NOT_FOUND'; }
    check('unknown id → USER_NOT_FOUND', nfThrew);

    await prisma.user.deleteMany({ where: { id: { in: [u1.id, u2.id] } } });
  }

  // ── 3. discoverByPhones ───────────────────────────────────────────────
  console.log('\n[3] discoverByPhones (hash-matched)');
  {
    const caller = await mkUser('disc_caller');
    const phoneVer = '+233241112233';
    const phoneOptOut = '+233241112244';
    const phoneUnver = '+233241112255';
    const phoneSelf = '+233241112266';

    // verified + discoverable → should match
    const verified = await mkUser('disc_verified', {
      phoneNumber: phoneVer, phoneVerified: true, phoneHash: hashPhone(phoneVer), discoverable: true,
    });
    // verified but opted out → excluded
    const optOut = await mkUser('disc_optout', {
      phoneNumber: phoneOptOut, phoneVerified: true, phoneHash: hashPhone(phoneOptOut), discoverable: false,
    });
    // has number but NOT verified (no hash) → excluded
    const unverified = await mkUser('disc_unver', {
      phoneNumber: phoneUnver, phoneVerified: false, phoneHash: null, discoverable: true,
    });
    // the caller themselves verified → excluded from their own results
    await prisma.user.update({
      where: { id: caller.id },
      data: { phoneNumber: phoneSelf, phoneVerified: true, phoneHash: hashPhone(phoneSelf), discoverable: true },
    });

    const matches = await svc.discoverByPhones(caller.id, [
      phoneVer, phoneOptOut, phoneUnver, phoneSelf, 'garbage', '+1',
    ]);
    const ids = matches.map((m) => m.azamanId);
    check('verified+discoverable matched', ids.includes(verified.azamanId));
    check('opted-out excluded', !ids.includes(optOut.azamanId));
    check('unverified excluded', !ids.includes(unverified.azamanId));
    check('caller excluded from own results', !ids.includes(caller.azamanId));
    check('exactly 1 match', matches.length === 1);
    check('match projection minimal',
      matches.length === 1 && Object.keys(matches[0]).sort().join(',') === 'avatar,azamanId,displayName');

    // raw-format tolerance: spaced/dashed variant of the verified number hashes the same
    const matchesFormatted = await svc.discoverByPhones(caller.id, ['+233 24 111 2233']);
    check('normalization: formatted variant still matches', matchesFormatted.length === 1);

    // cap enforced
    let capThrew = false;
    try { await svc.discoverByPhones(caller.id, new Array(1001).fill('+233241112233')); }
    catch (e) { capThrew = e.code === 'DISCOVERY_TOO_MANY'; }
    check('over-cap payload rejected', capThrew);

    await prisma.user.deleteMany({ where: { id: { in: [caller.id, verified.id, optOut.id, unverified.id] } } });
  }

  // ── 4. backfill idempotency ───────────────────────────────────────────
  console.log('\n[4] backfill idempotency');
  {
    // Insert a user with NO azamanId (simulate a pre-Phase-6 row).
    const legacy = await prisma.user.create({
      data: { username: `${TAG}_legacy`, email: `${TAG}_legacy@test.local`, password: 'x' },
    });
    check('legacy row has null azamanId', legacy.azamanId == null);

    const r1 = await backfillAzamanIds(prisma);
    check('first backfill assigned ≥ 1', r1.assigned >= 1);
    const after = await prisma.user.findUnique({ where: { id: legacy.id }, select: { azamanId: true } });
    check('legacy row now has valid azamanId', after.azamanId && AZAMAN_ID_RE.test(after.azamanId));

    const r2 = await backfillAzamanIds(prisma);
    check('second backfill assigns 0 (idempotent)', r2.assigned === 0);

    await prisma.user.delete({ where: { id: legacy.id } });
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
