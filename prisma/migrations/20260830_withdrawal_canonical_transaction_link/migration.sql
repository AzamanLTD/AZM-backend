-- Durable identity bridge for legacy Withdrawal -> canonical TransactionHistory.
-- TransactionHistory remains the financial source of truth. The nullable link
-- lets old rows be migrated safely while allowing the reconciliation worker to
-- refuse unsafe correlation.

ALTER TABLE "Withdrawal"
    ADD COLUMN "transactionHistoryId" UUID;

CREATE UNIQUE INDEX "Withdrawal_transactionHistoryId_key"
    ON "Withdrawal"("transactionHistoryId")
    WHERE "transactionHistoryId" IS NOT NULL;

ALTER TABLE "Withdrawal"
    ADD CONSTRAINT "Withdrawal_transactionHistoryId_fkey"
    FOREIGN KEY ("transactionHistoryId")
    REFERENCES "TransactionHistory"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- Backfill only when there is exactly one plausible canonical transaction.
-- Ambiguous/missing rows intentionally remain NULL for the reconciliation
-- exception queue; this migration never guesses.
WITH candidates AS (
    SELECT
        w.id AS withdrawal_id,
        MIN(t.id) AS transaction_id
    FROM "Withdrawal" w
    JOIN "TransactionHistory" t
      ON t."userId" = w."userId"
     AND t."type" = 'WITHDRAWAL_FIAT'
     AND t."amountUsdc" = w."amount"
     AND t."createdAt" BETWEEN w."createdAt" - INTERVAL '5 seconds'
                           AND w."createdAt" + INTERVAL '5 seconds'
    WHERE w."transactionHistoryId" IS NULL
    GROUP BY w.id
    HAVING COUNT(*) = 1
)
UPDATE "Withdrawal" w
SET "transactionHistoryId" = c.transaction_id
FROM candidates c
WHERE w.id = c.withdrawal_id;

-- New Withdrawal mirror rows are normally inserted immediately after the
-- canonical TransactionHistory reservation. Link them automatically only
-- when the same strict uniqueness rule identifies exactly one candidate.
CREATE OR REPLACE FUNCTION link_withdrawal_to_transaction_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_id UUID;
BEGIN
    IF NEW."transactionHistoryId" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT MIN(t.id)
      INTO candidate_id
      FROM "TransactionHistory" t
     WHERE t."userId" = NEW."userId"
       AND t."type" = 'WITHDRAWAL_FIAT'
       AND t."amountUsdc" = NEW."amount"
       AND t."createdAt" BETWEEN NEW."createdAt" - INTERVAL '5 seconds'
                             AND NEW."createdAt" + INTERVAL '5 seconds'
     HAVING COUNT(*) = 1;

    IF candidate_id IS NOT NULL THEN
        NEW."transactionHistoryId" := candidate_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "Withdrawal_link_transaction_history"
BEFORE INSERT ON "Withdrawal"
FOR EACH ROW
EXECUTE FUNCTION link_withdrawal_to_transaction_history();
