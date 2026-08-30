-- AZM Smart Escrow integrity guard
--
-- fundEscrow performs balance mutations and the escrow status transition in one
-- database transaction. The service-level pre-read is intentionally not the
-- concurrency authority: two callers can both observe DRAFT before either
-- transaction commits. This trigger makes the state transition itself the
-- database-enforced single-winner boundary.
--
-- If a second concurrent transaction reaches the status update after the first
-- has committed DRAFT -> FUNDED, PostgreSQL presents the current row to the
-- trigger and the second transaction is rejected. Because the status update is
-- inside the same transaction as the balance mutations, that rejection rolls
-- back the second debit/lock/fee/history changes as one unit.

CREATE OR REPLACE FUNCTION azm_guard_smart_escrow_funding_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'FUNDED' AND OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'ESCROW_FUNDING_TRANSITION_INVALID: escrow % is already %',
            OLD.id, OLD.status
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS azm_guard_smart_escrow_funding_transition
    ON "SmartEscrow";

CREATE TRIGGER azm_guard_smart_escrow_funding_transition
BEFORE UPDATE OF status ON "SmartEscrow"
FOR EACH ROW
WHEN (NEW.status = 'FUNDED')
EXECUTE FUNCTION azm_guard_smart_escrow_funding_transition();

COMMENT ON FUNCTION azm_guard_smart_escrow_funding_transition() IS
    'Prevents a SmartEscrow from entering FUNDED more than once; protects the financial transaction from concurrent funding races.';
