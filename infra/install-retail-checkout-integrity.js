'use strict';

// Runtime schema convergence for the retail checkout integrity overlay.
// Production uses `prisma db push`, so safety-critical overlay objects must be
// converged at boot rather than relying on migration history alone.
//
// This installer owns the retail idempotency/inventory boundary and the shared
// SmartEscrow funding/state guard. The latter protects every escrow funding
// path and prevents stale terminal-state writes from resurrecting an escrow.

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

  await run('install atomic inventory reservation trigger', `CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE tracked_stock INTEGER;
BEGIN
  SELECT "stockQty" INTO tracked_stock FROM "BusinessProduct" WHERE id = NEW."productId" FOR UPDATE;
  IF tracked_stock IS NULL THEN NEW."stockReserved" := FALSE; RETURN NEW; END IF;
  IF tracked_stock < NEW.quantity THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%', NEW."productId", tracked_stock USING ERRCODE = 'P0001'; END IF;
  UPDATE "BusinessProduct" SET "stockQty" = "stockQty" - NEW.quantity WHERE id = NEW."productId";
  NEW."stockReserved" := TRUE; RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS azaman_retail_reserve_stock ON "BusinessOrderItem";
CREATE TRIGGER azaman_retail_reserve_stock BEFORE INSERT ON "BusinessOrderItem" FOR EACH ROW EXECUTE FUNCTION azaman_retail_reserve_stock()`,);

  await run('install inventory release trigger', `CREATE OR REPLACE FUNCTION azaman_retail_release_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('CANCELLED', 'REFUNDED') AND OLD.status NOT IN ('CANCELLED', 'REFUNDED') THEN
    UPDATE "BusinessProduct" p SET "stockQty" = p."stockQty" + i.quantity FROM "BusinessOrderItem" i WHERE i."orderId" = NEW.id AND i."stockReserved" = TRUE AND i."productId" = p.id;
    UPDATE "BusinessOrderItem" SET "stockReserved" = FALSE WHERE "orderId" = NEW.id AND "stockReserved" = TRUE;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS azaman_retail_release_stock ON "BusinessOrder";
CREATE TRIGGER azaman_retail_release_stock AFTER UPDATE OF status ON "BusinessOrder" FOR EACH ROW EXECUTE FUNCTION azaman_retail_release_stock()`,);

  await run('install SmartEscrow funding/state guard', `CREATE OR REPLACE FUNCTION azm_guard_smart_escrow_funding_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'FUNDED' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'ESCROW_FUNDING_TRANSITION_INVALID: escrow % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'PENDING_SETTLEMENT' AND OLD.status IN ('SETTLED', 'RELEASED', 'REFUNDED', 'EXPIRED') THEN
    RAISE EXCEPTION 'ESCROW_STATE_REGRESSION_INVALID: escrow % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS azm_guard_smart_escrow_funding_transition ON "SmartEscrow";
CREATE TRIGGER azm_guard_smart_escrow_funding_transition BEFORE UPDATE OF status ON "SmartEscrow" FOR EACH ROW WHEN (NEW.status = 'FUNDED' OR NEW.status = 'PENDING_SETTLEMENT') EXECUTE FUNCTION azm_guard_smart_escrow_funding_transition()`,);

  return { ok: true, steps };
}

module.exports = { installRetailCheckoutIntegrity };
