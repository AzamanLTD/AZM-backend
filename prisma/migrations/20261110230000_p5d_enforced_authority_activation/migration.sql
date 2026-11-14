-- §WP-E — DATABASE-ENFORCED, APPEND-ONLY AUTHORITY ACTIVATION RECORD.
--
-- WHY THIS EXISTS
-- `FiatLiquidityState.authorityActivatedAt` is a nullable column on a table the
-- application runtime role owns and can UPDATE. That makes the "one-way latch"
-- a code convention, not a boundary: the same role that reads the regime can
-- write it, rewrite it back to NULL, or delete the row. This migration adds a
-- separate record that a correctly provisioned runtime role cannot mutate.
--
-- WHAT THIS MIGRATION DOES **NOT** DO
-- It does not create roles and it does not transfer ownership, because a
-- migration cannot know the deployment's runtime role name and must not guess
-- it. Applied alone, the table therefore belongs to whichever role ran the
-- migration and the authority gate stays CLOSED: the runtime self-check in
-- src/services/authorityActivationEnforcement.js independently refuses to
-- report the authority as enforced unless ownership separation, the absence of
-- write privileges and the immutability triggers are all observed at runtime.
--
-- ESTABLISHING THE BOUNDARY IS A SEPARATE, CONTROLLED STEP:
--   node infra/install-authority-activation-roles.js --owner <role> --runtime <role> --operator <role>
-- run as a role that may create roles and re-parent the table. See
-- docs/authority-activation-enforcement.md.

CREATE TABLE IF NOT EXISTS "FiatLiquidityAuthorityActivation" (
  "id"                INTEGER      NOT NULL,
  "activatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedBy"       TEXT         NOT NULL,
  "approvedBy"        TEXT         NOT NULL,
  "evidenceReference" TEXT         NOT NULL,
  "evidenceDigest"    TEXT         NOT NULL,
  CONSTRAINT "FiatLiquidityAuthorityActivation_pkey" PRIMARY KEY ("id")
);

-- SINGLETON, ENFORCED BY THE DATABASE. id = 1 only, so a second activation can
-- never silently replace the first: the PRIMARY KEY rejects it, and the CHECK
-- rejects any other id, which also defeats "insert id=2 as a newer truth".
ALTER TABLE "FiatLiquidityAuthorityActivation"
  DROP CONSTRAINT IF EXISTS "FiatLiquidityAuthorityActivation_singleton";
ALTER TABLE "FiatLiquidityAuthorityActivation"
  ADD CONSTRAINT "FiatLiquidityAuthorityActivation_singleton" CHECK ("id" = 1);

-- An activation row is a CONTROL DECISION. The evidence columns are required
-- and non-blank so the row can never be an anonymous flag flip.
ALTER TABLE "FiatLiquidityAuthorityActivation"
  DROP CONSTRAINT IF EXISTS "FiatLiquidityAuthorityActivation_evidence_nonblank";
ALTER TABLE "FiatLiquidityAuthorityActivation"
  ADD CONSTRAINT "FiatLiquidityAuthorityActivation_evidence_nonblank" CHECK (
    btrim("activatedBy") <> ''
    AND btrim("approvedBy") <> ''
    AND btrim("evidenceReference") <> ''
    AND btrim("evidenceDigest") <> ''
  );

-- APPEND-ONLY, DEFENCE IN DEPTH. Privilege separation is the boundary; these
-- triggers are the second line, and they also protect against a deployment
-- that accidentally leaves the runtime role with DML rights.
CREATE OR REPLACE FUNCTION azm_authority_activation_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FiatLiquidityAuthorityActivation is append-only: % is refused', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Activation is a one-time control decision recorded under a separate database authority.';
END;
$$;

DROP TRIGGER IF EXISTS "FiatLiquidityAuthorityActivation_no_update" ON "FiatLiquidityAuthorityActivation";
CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_update"
  BEFORE UPDATE ON "FiatLiquidityAuthorityActivation"
  FOR EACH ROW EXECUTE FUNCTION azm_authority_activation_immutable();

DROP TRIGGER IF EXISTS "FiatLiquidityAuthorityActivation_no_delete" ON "FiatLiquidityAuthorityActivation";
CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_delete"
  BEFORE DELETE ON "FiatLiquidityAuthorityActivation"
  FOR EACH ROW EXECUTE FUNCTION azm_authority_activation_immutable();

DROP TRIGGER IF EXISTS "FiatLiquidityAuthorityActivation_no_truncate" ON "FiatLiquidityAuthorityActivation";
CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_truncate"
  BEFORE TRUNCATE ON "FiatLiquidityAuthorityActivation"
  FOR EACH STATEMENT EXECUTE FUNCTION azm_authority_activation_immutable();

-- No implicit access for anyone, including roles created later.
REVOKE ALL ON TABLE "FiatLiquidityAuthorityActivation" FROM PUBLIC;
