'use strict';

// Runtime schema convergence for the retail checkout integrity overlay.
// Production uses `prisma db push`, so safety-critical overlay objects must be
// converged at boot rather than relying on migration history alone.

async function installRetailCheckoutIntegrity(prisma) {
  const steps = [];
  const run = async (label, query) => {
    await prisma.$executeRawUnsafe(query);
    steps.push(label);
  };

  await run('drop legacy global idempotency uniqueness', 'ALTER TABLE "BusinessOrder" DROP CONSTRAINT IF EXISTS "BusinessOrder_idempotencyKey_key"');
  await run('add idempotency request fingerprint', 'ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "idempotencyRequestHash" VARCHAR(64)');
  await run('add scoped idempotency uniqueness', 'CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyKey_key" ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyKey")');
  await run('add scoped fingerprint lookup index', 'CREATE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyRequestHash_idx" ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyRequestHash")');
  await run('add immutable variant snapshot column', 'ALTER TABLE "BusinessOrderItem" ADD COLUMN IF NOT EXISTS "variants" JSONB');
  await run('add stock reservation marker', 'ALTER TABLE "BusinessOrderItem" ADD COLUMN IF NOT EXISTS "stockReserved" BOOLEAN NOT NULL DEFAULT FALSE');

  await run('install atomic inventory reservation function', `CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE tracked_stock INTEGER; parent_status TEXT;
BEGIN
  SELECT "status" INTO parent_status FROM "BusinessOrder" WHERE id = NEW."orderId";
  IF parent_status IS DISTINCT FROM 'AWAITING_PAYMENT' THEN NEW."stockReserved" := FALSE; RETURN NEW; END IF;
  SELECT "stockQty" INTO tracked_stock FROM "BusinessProduct" WHERE id = NEW."productId" FOR UPDATE;
  IF tracked_stock IS NULL THEN NEW."stockReserved" := FALSE; RETURN NEW; END IF;
  IF tracked_stock < NEW.quantity THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%', NEW."productId", tracked_stock USING ERRCODE = 'P0001'; END IF;
  UPDATE "BusinessProduct" SET "stockQty" = "stockQty" - NEW.quantity WHERE id = NEW."productId";
  NEW."stockReserved" := TRUE; RETURN NEW;
END;
$$`);

  await run('install atomic inventory reservation trigger', `CREATE OR REPLACE TRIGGER azaman_retail_reserve_stock BEFORE INSERT ON "BusinessOrderItem" FOR EACH ROW EXECUTE FUNCTION azaman_retail_reserve_stock()`,);

  await run('install inventory release function', `CREATE OR REPLACE FUNCTION azaman_retail_release_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('CANCELLED', 'REFUNDED') AND OLD.status NOT IN ('CANCELLED', 'REFUNDED') THEN
    WITH release_totals AS (
      SELECT "productId", SUM(quantity) AS quantity
      FROM "BusinessOrderItem"
      WHERE "orderId" = NEW.id AND "stockReserved" = TRUE
      GROUP BY "productId"
    )
    UPDATE "BusinessProduct" p SET "stockQty" = p."stockQty" + release_totals.quantity
    FROM release_totals WHERE p.id = release_totals."productId";
    UPDATE "BusinessOrderItem" SET "stockReserved" = FALSE WHERE "orderId" = NEW.id AND "stockReserved" = TRUE;
  END IF;
  RETURN NEW;
END;
$$`);

  await run('install inventory release trigger', `CREATE OR REPLACE TRIGGER azaman_retail_release_stock AFTER UPDATE OF status ON "BusinessOrder" FOR EACH ROW EXECUTE FUNCTION azaman_retail_release_stock()`,);

  await run('install SmartEscrow funding/state guard function', `CREATE OR REPLACE FUNCTION azm_guard_smart_escrow_funding_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'FUNDED' AND OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ESCROW_FUNDING_TRANSITION_INVALID: escrow % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001'; END IF;
  IF NEW.status = 'PENDING_SETTLEMENT' AND OLD.status IN ('SETTLED', 'RELEASED', 'REFUNDED', 'EXPIRED') THEN RAISE EXCEPTION 'ESCROW_STATE_REGRESSION_INVALID: escrow % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END;
$$`);

  await run('install SmartEscrow funding/state guard trigger', `CREATE OR REPLACE TRIGGER azm_guard_smart_escrow_funding_transition BEFORE UPDATE OF status ON "SmartEscrow" FOR EACH ROW WHEN (NEW.status = 'FUNDED' OR NEW.status = 'PENDING_SETTLEMENT') EXECUTE FUNCTION azm_guard_smart_escrow_funding_transition()`,);

  return { ok: true, steps };
}

module.exports = { installRetailCheckoutIntegrity };

// CLI entry — mirrors every other infra/install-*.js overlay. REQUIRED so the
// r39/P0 battery-hermetic restore (r38-overlay-upgrade-path runAllOverlays)
// and `npm run release` can run this installer the same way as the rest of
// the set: it spawns `node infra/install-*.js`. Without this entry the file
// defines and exports the function but installs NOTHING when spawned, so any
// `prisma db push` restore silently loses the retail integrity column while
// the retail trigger functions survive — leaving every later order-item
// insert against a trigger referencing a dropped column (r39/P0 poisoning).
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  installRetailCheckoutIntegrity(prisma)
    .then((result) => {
      console.log(`[install-retail-checkout-integrity] ${result.steps.length} steps ok`);
    })
    .catch((err) => {
      console.error('[install-retail-checkout-integrity] fatal:', err && err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}