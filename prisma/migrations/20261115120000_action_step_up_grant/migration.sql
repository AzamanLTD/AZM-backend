-- §WP-H G — action-bound step-up grants.
--
-- A high-impact economic mutation must be authorised by a proof bound to THAT
-- action: one user, one canonical action digest, one idempotency identity, one
-- short expiry, consumed exactly once. Consumption is a conditional UPDATE so
-- PostgreSQL decides the single winner, and it runs inside the same transaction
-- as the economic write so a rolled-back action does not spend the grant.
CREATE TABLE IF NOT EXISTS "ActionStepUpGrant" (
    "id"             TEXT PRIMARY KEY,
    "tokenHash"      TEXT NOT NULL UNIQUE,
    "userId"         TEXT NOT NULL,
    "actionType"     TEXT NOT NULL,
    "actionDigest"   TEXT NOT NULL,
    "routeScope"     TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "consumedAt"     TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "ActionStepUpGrant_userId_idx" ON "ActionStepUpGrant"("userId");
CREATE INDEX IF NOT EXISTS "ActionStepUpGrant_expiresAt_idx" ON "ActionStepUpGrant"("expiresAt");

-- §H — a grant is single-use at the storage layer too: once consumed it can
-- never be un-consumed, and its binding columns can never be rewritten.
CREATE OR REPLACE FUNCTION azm_step_up_grant_guard() RETURNS trigger AS $$
BEGIN
    IF OLD."consumedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'ActionStepUpGrant is single-use: % was already consumed', OLD."id";
    END IF;
    IF NEW."tokenHash" <> OLD."tokenHash"
       OR NEW."userId" <> OLD."userId"
       OR NEW."actionDigest" <> OLD."actionDigest"
       OR NEW."actionType" <> OLD."actionType"
       OR NEW."routeScope" <> OLD."routeScope" THEN
        RAISE EXCEPTION 'ActionStepUpGrant binding is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ActionStepUpGrant_no_reuse" ON "ActionStepUpGrant";
CREATE TRIGGER "ActionStepUpGrant_no_reuse"
    BEFORE UPDATE ON "ActionStepUpGrant"
    FOR EACH ROW EXECUTE FUNCTION azm_step_up_grant_guard();
