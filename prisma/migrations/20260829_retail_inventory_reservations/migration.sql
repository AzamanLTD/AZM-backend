-- Retail inventory integrity: reserve tracked stock atomically when an order line
-- is created and release the reservation exactly once on cancellation/refund.
-- The boot-time installer mirrors these statements because production currently
-- converges with `prisma db push` rather than `prisma migrate deploy`.

ALTER TABLE "BusinessOrderItem"
  ADD COLUMN IF NOT EXISTS "stockReserved" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock()
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
EXECUTE FUNCTION azaman_retail_reserve_stock();

CREATE OR REPLACE FUNCTION azaman_retail_release_stock()
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
EXECUTE FUNCTION azaman_retail_release_stock();
