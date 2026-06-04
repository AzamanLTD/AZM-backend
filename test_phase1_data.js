#!/usr/bin/env node
/**
 * Phase 1 Verification Gate — private-susu-ecosystem
 *
 * Asserts that the additive Phase 1 schema/seed/repository foundation has
 * landed correctly. This script does NOT mutate any data — it only reads.
 *
 * Usage:
 *   node test_phase1_data.js                       # local backend (DATABASE_URL)
 *   node test_phase1_data.js https://...           # any HTTPS endpoint (no DB asserts)
 *
 * Exits 0 on green; non-zero on any failure with the failing assertion logged.
 */

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REMOTE_BASE = process.argv[2];

let pass = 0;
let fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) {
  console.log(`  ✗ ${label}`);
  if (err) console.log(`    → ${err.message || err}`);
  fail++;
}

async function assertEnumExists(prisma, enumName, expectedValues) {
  // Postgres-introspection: pg_type holds enum metadata.
  const rows = await prisma.$queryRawUnsafe(`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = '${enumName}'
    ORDER BY e.enumsortorder
  `);
  const values = rows.map(r => r.enumlabel);
  const missing = expectedValues.filter(v => !values.includes(v));
  if (missing.length === 0) {
    ok(`enum ${enumName} has values [${expectedValues.join(', ')}]`);
  } else {
    bad(`enum ${enumName} missing values: ${missing.join(', ')}`,
        new Error(`Found: ${values.join(', ')}`));
  }
}

async function assertTableExists(prisma, tableName) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = '${tableName}' AND table_schema = 'public'
    LIMIT 1
  `);
  if (rows.length === 1) ok(`table ${tableName} exists`);
  else bad(`table ${tableName} does not exist`);
}

async function assertColumnsExist(prisma, tableName, expectedCols) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = '${tableName}' AND table_schema = 'public'
  `);
  const cols = rows.map(r => r.column_name);
  const missing = expectedCols.filter(c => !cols.includes(c));
  if (missing.length === 0) {
    ok(`${tableName} has columns [${expectedCols.join(', ')}]`);
  } else {
    bad(`${tableName} missing columns: ${missing.join(', ')}`);
  }
}

async function assertTreasurySeed(prisma) {
  const t = await prisma.user.findUnique({
    where: { username: 'azaman-treasury' },
  });
  if (!t) return bad('treasury wallet seeded', new Error('User row not found'));
  if (t.role !== 'ADMIN') return bad('treasury wallet has role=ADMIN', new Error(`role=${t.role}`));
  if (Number(t.availableBalance) !== 0)
    return bad('treasury wallet starts at availableBalance=0', new Error(`balance=${t.availableBalance}`));
  if (t.kycStatus !== 'VERIFIED')
    return bad('treasury wallet has kycStatus=VERIFIED', new Error(`kyc=${t.kycStatus}`));
  ok(`treasury wallet seeded (id=${t.id}, role=ADMIN, balance=0)`);
  return t;
}

async function assertContractSeed(prisma) {
  const v1 = await prisma.liabilityContractVersion.findUnique({
    where: { version: 'v1.0' },
  });
  if (!v1) return bad('liability contract v1.0 seeded', new Error('row not found'));
  if (!v1.contractHash || v1.contractHash.length !== 64)
    return bad('contract hash is a 64-char SHA-256 hex',
               new Error(`got ${v1.contractHash?.length} chars`));
  if (!v1.body || v1.body.length < 500)
    return bad('contract body is non-trivial', new Error(`body length=${v1.body?.length}`));
  // Recompute the hash from disk and assert it matches the row.
  const bodyPath = path.join(__dirname, 'infra', 'liability-contract-v1.0.md');
  if (fs.existsSync(bodyPath)) {
    const expected = crypto.createHash('sha256')
      .update(fs.readFileSync(bodyPath, 'utf8')).digest('hex');
    if (expected !== v1.contractHash) {
      return bad('contract hash matches disk body',
                 new Error(`db=${v1.contractHash} disk=${expected}`));
    }
  }
  ok(`liability contract v1.0 seeded (hash=${v1.contractHash.slice(0, 12)}...)`);
}

async function assertReposLoad() {
  // Smoke-test that every new repo file loads cleanly with a stub Prisma.
  const stubPrisma = {};
  const files = [
    'susuRepo', 'susuMemberRepo', 'susuInviteRepo', 'vouchRepo',
    'liabilityContractRepo', 'proofOfResidencyRepo', 'adminWarRoomRepo',
  ];
  for (const f of files) {
    try {
      const Repo = require(path.join(__dirname, 'repositories', f + '.js'));
      const inst = new Repo(stubPrisma);
      if (typeof inst !== 'object') throw new Error('Repo does not instantiate');
      ok(`${f}.js loads + instantiates`);
    } catch (err) {
      bad(`${f}.js failed to load`, err);
    }
  }
}

async function assertHttpHealthcheck(base) {
  // Lightweight HTTPS ping when invoked with a remote URL.
  const https = require('https');
  return new Promise((resolve) => {
    const url = base.replace(/\/$/, '') + '/health';
    https.get(url, (res) => {
      if (res.statusCode === 200) ok(`remote /health = 200 (${url})`);
      else bad(`remote /health = ${res.statusCode}`, new Error(url));
      res.resume();
      resolve();
    }).on('error', (err) => {
      bad(`remote /health unreachable`, err);
      resolve();
    });
  });
}

async function main() {
  console.log('═════════════════════════════════════════════════════════════');
  console.log('Phase 1 Verification Gate — private-susu-ecosystem');
  console.log(`Target: ${REMOTE_BASE || 'local DATABASE_URL'}`);
  console.log('═════════════════════════════════════════════════════════════\n');

  if (REMOTE_BASE) {
    console.log('Remote-mode checks (HTTPS only):');
    await assertHttpHealthcheck(REMOTE_BASE);
    console.log('\n(local DB asserts skipped in remote mode — schema parity ' +
                'must be verified by reapplying the migration on Render.)\n');
  } else {
    const prisma = new PrismaClient();
    try {
      console.log('Enums:');
      await assertEnumExists(prisma, 'ProofOfResidencyStatus',
        ['NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']);
      await assertEnumExists(prisma, 'SusuInviteChannel',
        ['FRIEND', 'PHONE', 'LINK']);
      await assertEnumExists(prisma, 'SusuInviteStatus',
        ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED']);
      await assertEnumExists(prisma, 'AdminWarRoomAlertType',
        ['ADMIN_DEFAULT', 'MASS_DEFAULT_THRESHOLD', 'ESCROW_DIVERSION', 'VOUCH_SLASH_TX_FAILURE']);
      await assertEnumExists(prisma, 'VouchStatus',
        ['PENDING', 'COMPLETED', 'REJECTED', 'VOIDED']);

      console.log('\nNew tables:');
      for (const t of [
        'SusuInvite', 'LiabilityContractVersion', 'LiabilityAcceptance',
        'VoucherSlashLog', 'SusuReminderSent', 'AdminWarRoomAlert',
      ]) {
        await assertTableExists(prisma, t);
      }

      console.log('\nUser table additions:');
      await assertColumnsExist(prisma, 'User', [
        'proofOfResidencyUrl', 'proofOfResidencyStatus',
        'proofOfResidencySubmittedAt', 'proofOfResidencyVerifiedAt',
        'proofOfResidencyRejectionReason', 'trustRating',
      ]);

      console.log('\nSusuGroup additions:');
      await assertColumnsExist(prisma, 'SusuGroup', [
        'contractVersion', 'contractHash', 'activatedAt',
        'frozenAt', 'frozenReason',
      ]);

      console.log('\nSusuCycle additions:');
      await assertColumnsExist(prisma, 'SusuCycle', [
        'startedCollectingAt', 'escrowDivertedAt',
      ]);

      console.log('\nSeed rows:');
      await assertTreasurySeed(prisma);
      await assertContractSeed(prisma);

      console.log('\nRepository smoke load:');
      await assertReposLoad();
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  console.log('═════════════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  process.exit(2);
});
