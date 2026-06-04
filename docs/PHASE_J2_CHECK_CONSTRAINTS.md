# Phase J2 — Operator runbook for the CHECK-constraint migration

> **What this migration does.** Adds ~50 `CHECK` constraints to the
> backend database — non-negativity on every balance / amount / fee /
> volume column, positivity on prices / rates / limits, and bounded
> ranges on ratios and percentages. Pure defense-in-depth; no
> application code change required.
>
> **Why it might fail on existing data.** If any row in the live database
> currently violates one of the new constraints (e.g. a negative
> balance from an unrepaired ledger drift, or a `pricePerUSD = 0` ad
> that snuck through some old code path), Postgres will reject the
> migration with a `check_violation` error and roll back. Surfacing
> the corruption is the desired outcome — Phase J3 (the Float→Decimal
> column-type rewrite) needs clean data to migrate cleanly.

---

## Pre-deploy checklist

Before running `prisma migrate deploy` against a long-lived environment,
audit each constrained column for existing violations. The shape of the
audit query is the same as the constraint, with the comparison flipped:

```sql
-- Find any negative balances on User
SELECT id, email,
       "availableBalance", "vendorUnallocatedBalance", "escrowLockedBalance",
       "disputeEscrowBalance", "azmBalance", "activeDiscountCredit",
       "totalVolumeUsdc", "totalProfitUsdc"
  FROM "User"
 WHERE "availableBalance"         < 0
    OR "vendorUnallocatedBalance" < 0
    OR "escrowLockedBalance"      < 0
    OR "disputeEscrowBalance"     < 0
    OR "azmBalance"               < 0
    OR "activeDiscountCredit"     < 0
    OR "totalVolumeUsdc"          < 0
    OR "totalProfitUsdc"          < 0
    OR "completionRate"           < 0
    OR "completionRate"           > 100;

-- Same shape for every other table. The full set:
SELECT * FROM "SystemMasterCrypto" WHERE "balance" < 0;
SELECT * FROM "SystemHotWallet"    WHERE "balance" < 0;
SELECT * FROM "SystemFiatPool"     WHERE "balance" < 0;
SELECT * FROM "SystemProfitFees"   WHERE "balance" < 0;

SELECT id FROM "Ad"
 WHERE "pricePerUSD" <= 0
    OR "minLimit"    <= 0
    OR "maxLimit"    <= 0
    OR "minLimit"    >  "maxLimit"
    OR "baseMargin"  <  0
    OR "vendorMargin" < 0;

SELECT id FROM "Trade"
 WHERE "amountCrypto"     < 0
    OR "amountFiat"       < 0
    OR "rate"             < 0
    OR "adminBonusAmount" < 0
    OR "vendorProfitCut"  < 0;

SELECT id FROM "Withdrawal"
 WHERE "amount"         < 0
    OR "totalGasFee"    < 0
    OR "vendorGasShare" < 0
    OR "adminGasShare"  < 0;

SELECT id FROM "TransactionHistory"
 WHERE "amountUsdc" < 0 OR "feeUsdc" < 0;

-- ... and so on for the remaining tables (see migration.sql for the full list)
```

Expected result on a healthy database: zero rows from every audit query.
If any query returns rows, see "Recovery from a failed migration" below.

---

## Deploy

For a typical environment:

```sh
# 1. Run the audit queries above; confirm zero violations
# 2. Apply the migration
npx prisma migrate deploy

# 3. Verify all constraints landed
psql $DATABASE_URL -c "
  SELECT conrelid::regclass AS table, conname AS constraint
    FROM pg_constraint
   WHERE contype = 'c'
     AND conname LIKE ANY (ARRAY[
       'User\_%', 'System%\_balance\_nonneg', 'Ad\_%',
       'Trade\_%', 'Withdrawal\_%', 'GS\_%',
       'TH\_%', 'APL\_%', 'CSL\_%', 'PWL\_%', 'OE\_%',
       'CPL\_%', 'Badge\_%', 'LR\_%', 'DS\_%',
       'PT\_%', 'SG\_%', 'SD\_%'
     ])
   ORDER BY conrelid::regclass::text, conname;
"
```

Expected: ~50 rows, one per ADD CONSTRAINT line in `migration.sql`.

---

## Recovery from a failed migration

If `prisma migrate deploy` fails with a `check_violation` error like:

```
ERROR: check constraint "User_availableBalance_nonneg" of relation "User" is violated by some row
```

The migration is **rolled back** as a single transaction — no constraints
are added if any one fails. The database is in the same state it was
before. Recovery flow:

1. **Identify the offending rows** with the audit query above for that
   specific column.
2. **Decide repair-or-zero** for each row. For balance corruption, the
   typical answer is "zero it out and write a `TransactionHistory` row
   noting the manual adjustment for audit completeness." For a ledger
   row that has the wrong sign in a one-off direction-flip bug, repair
   with the correct value.
3. **Apply the repairs** in a single transaction so the audit row and
   the balance fix commit together.
4. **Re-run the audit query**; expect zero rows.
5. **Re-run** `npx prisma migrate deploy`. The constraint should land
   cleanly this time.

---

## Soft-deploy alternative (defer validation to a maintenance window)

If you would rather deploy first and audit second — for example because
the audit queries are slow on a very large database — replace each
`ADD CONSTRAINT` line in `migration.sql` with the `NOT VALID` form:

```sql
ALTER TABLE "User"
  ADD CONSTRAINT "User_availableBalance_nonneg" CHECK ("availableBalance" >= 0) NOT VALID;
```

`NOT VALID` skips the existing-row scan. New writes are checked from
the moment the constraint lands; old rows are ignored until validation
runs. After deploy, validate in a separate maintenance window:

```sql
ALTER TABLE "User" VALIDATE CONSTRAINT "User_availableBalance_nonneg";
```

`VALIDATE CONSTRAINT` does the seq-scan but takes only a `SHARE UPDATE
EXCLUSIVE` lock, which does not block reads or normal writes (only
schema changes and other validations on the same table).

This pattern is the standard Postgres approach for adding constraints
to large tables in production. It is NOT applied by default in the
shipped `migration.sql` because the codebase's row counts (per the
audit's §13 mobile-payload findings — list endpoints return all rows
unbounded, suggesting tables in the thousands of rows, not millions)
don't warrant the operational cost of a two-step deploy.

---

## What Phase J2 does NOT do

- **Float → Decimal column-type rewrite.** Filed as Phase J3. Adding
  `CHECK` constraints to `Float` columns works fine — the constraint
  predicate evaluates against whatever the column's stored type is.
  Phase J3 ships separately because the type rewrite changes the
  JSON wire format (Decimal serializes as a string by default in
  Prisma, not a number) and requires coordinated frontend updates.

- **`NOT NULL` enforcement.** Most money columns are already
  `@default(0.0)` and effectively non-null. The exceptions are
  `Trade.amountCrypto` / `Trade.amountFiat` (required at create time
  but no server-side default) — leaving these as-is because adding
  a NOT NULL retroactively requires a backfill plan.

- **Compound invariants.** `Ad.minLimit <= Ad.maxLimit` IS encoded
  (column-level check). But cross-table invariants like
  `User.availableBalance + User.escrowLockedBalance <= treasury_total`
  cannot be enforced by a single-table CHECK — those need
  `runDoubleCheck` (already implemented in `services/ledger.service.js`
  for double-entry validation) or a database trigger. Out of scope.
