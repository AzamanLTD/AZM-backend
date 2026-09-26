-- Retail inventory integrity: reserve tracked stock atomically when an order line
-- is created and release the reservation exactly once on cancellation/refund.
-- The reservation trigger only acts for order lines belonging to an
-- AWAITING_PAYMENT order, which is the canonical retail checkout state.

ALTER TABLE "BusinessOrderItem"
  ADD COLUMN IF NOT EXISTS "stockReserved" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tracked_stock INTEGER;
  parent_status TEXT;
BEGIN
  SELECT "status" INTO parent_status
  FROM "BusinessOrder"
  WHERE id = NEW."orderId";

  IF parent_status IS DISTINCT FROM 'AWAITING_PAYMENT' THEN
    NEW."stockReserved" := FALSE;
    RETURN NEW;
  END IF;

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
    WITH release_totals AS (
      SELECT "productId", SUM(quantity) AS quantity
      FROM "BusinessOrderItem"
      WHERE "orderId" = NEW.id
        AND "stockReserved" = TRUE
      GROUP BY "productId"
    )
    UPDATE "BusinessProduct" p
    SET "stockQty" = p."stockQty" + release_totals.quantity
    FROM release_totals
    WHERE p.id = release_totals."productId";

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
