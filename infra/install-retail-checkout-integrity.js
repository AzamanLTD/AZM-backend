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
// The same boundary reserves tracked inventory atomically with BusinessOrderItem
// creation and returns it exactly once when an order is cancelled/refunded.
// Untracked inventory (stockQty IS NULL) remains unaffected.

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

  await run(
    'add stock reservation marker',
    'ALTER TABLE "BusinessOrderItem" ADD COLUMN IF NOT EXISTS "stockReserved" BOOLEAN NOT NULL DEFAULT FALSE',
  );

  await run(
    'install atomic inventory reservation trigger',
    `CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tracked_stock INTEGER;
BEGIN
  SELECT "stockQty" INTO tracked_stock
  FROM "BusinessProduct"
  WHERE id = NEW."productId"
  FOR UPDATE;

  IF tracked_stock IS NULL THEN
    NEW."stockReserved" := FALSE;
    RETURN NEW;
  END IF;

  IF tracked_stock < NEW.quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%', NEW."productId", tracked_stock
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "BusinessProduct"
  SET "stockQty" = "stockQty" - NEW.quantity
  WHERE id = NEW."productId";

  NEW."stockReserved" := TRUE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS azaman_retail_reserve_stock ON "BusinessOrderItem";
CREATE TRIGGER azaman_retail_reserve_stock
BEFORE INSERT ON "BusinessOrderItem"
FOR EACH ROW
EXECUTE FUNCTION azaman_retail_reserve_stock()` ,
  );

  await run(
    'install inventory release trigger',
    `CREATE OR REPLACE FUNCTION azaman_retail_release_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('CANCELLED', 'REFUNDED')
     AND OLD.status NOT IN ('CANCELLED', 'REFUNDED') THEN
    UPDATE "BusinessProduct" p
    SET "stockQty" = p."stockQty" + i.quantity
    FROM "BusinessOrderItem" i
    WHERE i."orderId" = NEW.id
      AND i."stockReserved" = TRUE
      AND i."productId" = p.id;

    UPDATE "BusinessOrderItem"
    SET "stockReserved" = FALSE
    WHERE "orderId" = NEW.id
      AND "stockReserved" = TRUE;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS azaman_retail_release_stock ON "BusinessOrder";
CREATE TRIGGER azaman_retail_release_stock
AFTER UPDATE OF status ON "BusinessOrder"
FOR EACH ROW
EXECUTE FUNCTION azaman_retail_release_stock()` ,
  );

  return { ok: true, steps };
}

module.exports = { installRetailCheckoutIntegrity };
