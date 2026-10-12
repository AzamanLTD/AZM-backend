// infra/install-payment-requests-overlay.js
// =============================================================================
// STANDALONE PAYMENT REQUESTS — production-convergence overlay.
//
// Creates the PaymentRequest table (the server-owned request resource behind
// POST /api/payment-requests) and its indexes. This is the idempotent DDL
// twin of prisma/migrations/20261010120000_payment_requests — the release
// chain (npm run release) and both CI lanes run this installer so the
// disposable/production databases converge on the exact reviewed DDL.
//
// Idempotent: safe to re-run on every deploy. Mirrors install-r42-idempotency
// -overlay.js (PrismaClient + raw statements, fail-closed exit code).
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "PaymentRequest" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "requesterId" INTEGER NOT NULL,
    "recipientId" INTEGER,
    "mode"        TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'PENDING',
    "amountExact" TEXT NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'GHS',
    "tokenHash"   TEXT,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
  );`,
  // Converge tables first created by Prisma db-push: @default(uuid()) is
  // applied client-side by Prisma and does not create a database default.
  `ALTER TABLE "PaymentRequest" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text`,
  // FKs are added idempotently via DO blocks: a plain ADD CONSTRAINT would
  // fail the whole installer on re-run once the constraint already exists.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'PaymentRequest_requesterId_fkey'
     ) THEN
       ALTER TABLE "PaymentRequest"
         ADD CONSTRAINT "PaymentRequest_requesterId_fkey"
         FOREIGN KEY ("requesterId") REFERENCES "User"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'PaymentRequest_recipientId_fkey'
     ) THEN
       ALTER TABLE "PaymentRequest"
         ADD CONSTRAINT "PaymentRequest_recipientId_fkey"
         FOREIGN KEY ("recipientId") REFERENCES "User"("id")
         ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$;`,
  // Cursor-query indexes: the list query filters requesterId/recipientId and
  // orders createdAt DESC, id DESC with the (createdAt, id) cursor predicate.
  // Convergence: drop the pre-review (status, createdAt) variants if an
  // environment already ran the earlier DDL (status is never list-filtered).
  `DROP INDEX IF EXISTS "PaymentRequest_requesterId_status_createdAt_idx";`,
  `DROP INDEX IF EXISTS "PaymentRequest_recipientId_status_createdAt_idx";`,
  `CREATE INDEX IF NOT EXISTS "PaymentRequest_requesterId_createdAt_id_idx"
     ON "PaymentRequest"("requesterId", "createdAt", "id");`,
  `CREATE INDEX IF NOT EXISTS "PaymentRequest_recipientId_createdAt_id_idx"
     ON "PaymentRequest"("recipientId", "createdAt", "id");`,
  `CREATE INDEX IF NOT EXISTS "PaymentRequest_expiresAt_idx"
     ON "PaymentRequest"("expiresAt");`,
  // The ONLY durable token material on this row is the sha256 hash of the
  // RAW link token; unique lookup key. The raw token is never stored in
  // plaintext anywhere (the share URL carries its AES-256-GCM envelope —
  // see services/crypto/shareToken.js).
  `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRequest_tokenHash_key"
     ON "PaymentRequest"("tokenHash");`,
];

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[payment-requests] statement failed');
      process.exitCode = 1;
      return;
    }
  }
  logger.info('[payment-requests] standalone request resource overlay verified (idempotent).');
}

main()
  .catch((err) => {
    logger.error({ err }, '[payment-requests] fatal');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
