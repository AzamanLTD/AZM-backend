'use strict';

// infra/install-native-ghs-withdrawal-overlay.js — native-GHS withdrawal leg.
//
// Idempotent structural overlay for the native-GHS WITHDRAWAL authority
// (issue #389, Agent A). Mirrors the established overlay family: safe on an
// empty database, safe on a populated production database, safe to re-run any
// number of times, and it NEVER rewrites existing rows.
//
// Structures installed:
//   • GlobalSettings."nativeGhsWithdrawalEnabled" BOOLEAN NOT NULL DEFAULT
//     false — the payout-leg rollout authority. Independent of the
//     collections flag (nativeGhsSettlementEnabled).
//   • Withdrawal."amountGhs" DECIMAL(20,2) + "settlementCurrency" TEXT —
//     the authoritative exact-pesewa payout amount and its explicit asset
//     for the GHS leg; NULL on legacy rows means the old USDC semantics.
//   • TransactionHistory."amountGhs" + "settlementCurrency" — the same
//     disclosure on the canonical operation row.
//   • SavedBankBeneficiary — encrypted bank beneficiaries (versioned
//     AES-256-GCM envelope + separate-key HMAC fingerprint; see
//     services/crypto/fieldCipher.js).
//
// Release-chain contract (mirrors every other overlay): wired into
// `npm run release`, the CI test workflow and the financial-durability
// workflow — see docs/native-ghs-withdrawal.md.

const { PrismaClient } = require('@prisma/client');

const STATEMENTS = [
  `ALTER TABLE "GlobalSettings"
     ADD COLUMN IF NOT EXISTS "nativeGhsWithdrawalEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Withdrawal"
     ADD COLUMN IF NOT EXISTS "amountGhs" DECIMAL(20, 2)`,
  `ALTER TABLE "Withdrawal"
     ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT`,
  `ALTER TABLE "TransactionHistory"
     ADD COLUMN IF NOT EXISTS "amountGhs" DECIMAL(20, 2)`,
  `ALTER TABLE "TransactionHistory"
     ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT`,
  `CREATE TABLE IF NOT EXISTS "SavedBankBeneficiary" (
     "id" TEXT NOT NULL,
     "userId" INTEGER NOT NULL,
     "bankCode" VARCHAR(16) NOT NULL,
     "bankName" VARCHAR(80) NOT NULL,
     "accountName" VARCHAR(120),
     "accountNumberEnc" TEXT NOT NULL,
     "accountNumberMasked" VARCHAR(32) NOT NULL,
     "accountNumberHmac" VARCHAR(64) NOT NULL,
     "nickname" VARCHAR(40),
     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
     "validatedAt" TIMESTAMP(3),
     "keyId" VARCHAR(32),
     "envelopeVersion" INTEGER NOT NULL DEFAULT 2,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "SavedBankBeneficiary_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SavedBankBeneficiary_userId_accountNumberHmac_key"
     ON "SavedBankBeneficiary" ("userId", "accountNumberHmac")`,
  `CREATE INDEX IF NOT EXISTS "SavedBankBeneficiary_userId_status_idx"
     ON "SavedBankBeneficiary" ("userId", "status")`,
];

async function installNativeGhsWithdrawalOverlay(prisma) {
  for (const sql of STATEMENTS) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(sql);
  }
  return { statements: STATEMENTS.length };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const res = await installNativeGhsWithdrawalOverlay(prisma);
    // eslint-disable-next-line no-console
    console.log(`[native-ghs-withdrawal-overlay] installed ${res.statements} structures (idempotent)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[native-ghs-withdrawal-overlay] FAILED — nothing partially applied beyond additive DDL:', err.message);
    process.exit(1);
  });
}

module.exports = { installNativeGhsWithdrawalOverlay };
