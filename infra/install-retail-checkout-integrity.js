'use strict';

// Runtime schema convergence for the retail checkout integrity overlay.
//
// Production currently uses `prisma db push` rather than `prisma migrate deploy`.
// That means the Prisma schema remains an active source of database shape at
// boot and can otherwise recreate the legacy global idempotency uniqueness
// constraint after the additive migration has installed customer+business
// scoping. This installer is deliberately idempotent and runs after db-push
// convergence so the financial boundary is restored before normal traffic.
//
// Keep every statement static: this module must never interpolate request data
// into DDL. The migration remains the canonical historical change; this is the
// boot-time convergence guard for the deployed environment.

async function installRetailCheckoutIntegrity(prisma) {
  const steps = [];

  const run = async (label, query) => {
    await prisma.$executeRawUnsafe(query);
    steps.push(label);
  };

  await run(
    'drop legacy global idempotency uniqueness',
    'ALTER TABLE "BusinessOrder" DROP CONSTRAINT IF EXISTS "BusinessOrder_idempotencyKey_key"',
  );

  await run(
    'add idempotency request fingerprint',
    'ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "idempotencyRequestHash" VARCHAR(64)',
  );

  await run(
    'add scoped idempotency uniqueness',
    'CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyKey_key" ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyKey")',
  );

  await run(
    'add scoped fingerprint lookup index',
    'CREATE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyRequestHash_idx" ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyRequestHash")',
  );

  await run(
    'add immutable variant snapshot column',
    'ALTER TABLE "BusinessOrderItem" ADD COLUMN IF NOT EXISTS "variants" JSONB',
  );

  return { ok: true, steps };
}

module.exports = { installRetailCheckoutIntegrity };
