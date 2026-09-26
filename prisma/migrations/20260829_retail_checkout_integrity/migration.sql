-- Retail checkout integrity: persist selected variants and scope idempotency.
ALTER TABLE "BusinessOrder"
  DROP CONSTRAINT IF EXISTS "BusinessOrder_idempotencyKey_key";

ALTER TABLE "BusinessOrder"
  ADD COLUMN IF NOT EXISTS "idempotencyRequestHash" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyKey_key"
  ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyRequestHash_idx"
  ON "BusinessOrder" ("businessProfileId", "customerId", "idempotencyRequestHash");

ALTER TABLE "BusinessOrderItem"
  ADD COLUMN IF NOT EXISTS "variants" JSONB;
