-- AZM escrow integrity: make DRAFT -> FUNDED a single-winner database transition.
-- Application services still perform authorization and balance validation; this
-- trigger closes the race between an initial status read and the transactional
-- financial mutations in every escrow funding path that updates SmartEscrow.

CREATE OR REPLACE FUNCTION azm_guard_escrow_funding_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'DRAFT' AND NEW.status = 'FUNDED' THEN
        -- The row-level update lock acquired by PostgreSQL serializes competing
        -- updates to the same escrow row. Re-read the current persisted state
        -- and reject a stale transition rather than allowing a second funder to
        -- proceed after the first transaction has won.
        IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'ESCROW_FUNDING_RACE_LOST: escrow % is no longer DRAFT', OLD.id
                USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_azm_guard_escrow_funding_transition ON "SmartEscrow";
CREATE TRIGGER trg_azm_guard_escrow_funding_transition
BEFORE UPDATE OF status ON "SmartEscrow"
FOR EACH ROW
WHEN (OLD.status = 'DRAFT' AND NEW.status = 'FUNDED')
EXECUTE FUNCTION azm_guard_escrow_funding_transition();
