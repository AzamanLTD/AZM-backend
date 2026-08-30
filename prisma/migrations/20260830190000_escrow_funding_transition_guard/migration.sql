-- AZM Smart Escrow integrity guards
--
-- The service layer remains responsible for authorization and business rules.
-- These guards make critical state transitions safe against stale concurrent
-- writes at the database boundary.

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

    -- markSatisfied() can race: one participant can settle the escrow while
    -- another stale request is still trying to mark the row pending. Terminal
    -- financial states must never be resurrected by that stale write.
    IF NEW.status = 'PENDING_SETTLEMENT'
       AND OLD.status IN ('SETTLED', 'RELEASED', 'REFUNDED', 'EXPIRED') THEN
        RAISE EXCEPTION 'ESCROW_STATE_REGRESSION_INVALID: escrow % is already %',
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
WHEN (NEW.status = 'FUNDED' OR NEW.status = 'PENDING_SETTLEMENT')
EXECUTE FUNCTION azm_guard_smart_escrow_funding_transition();

COMMENT ON FUNCTION azm_guard_smart_escrow_funding_transition() IS
    'Prevents duplicate SmartEscrow funding and stale terminal-state regression into PENDING_SETTLEMENT.';
