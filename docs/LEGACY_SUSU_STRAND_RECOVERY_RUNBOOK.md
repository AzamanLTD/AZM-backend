# Legacy Susu stranded-cycle recovery runbook (read-only)

Operational check for the `fix/legacy-susu-economic-atomicity` merge (#264).
All queries are pure `SELECT`s against the production database — no mutation
of any kind. Run them before the merge to know what will recover, and again
after the merge to verify it did.

## How to run

Production runs on Render; the connection string lives in the Render
environment (`DATABASE_URL`). From a Render Shell:

```bash
psql "$DATABASE_URL"
```

Every table and column name below matches `prisma/schema.prisma` exactly
(Prisma maps to quoted PascalCase tables — keep the double quotes).

## Q1 — Legacy inventory (contractVersion IS NULL groups and their cycle states)

```sql
SELECT sg.id                          AS group_id,
       sg.status                      AS group_status,
       sg."contributionUsdc",
       sg."totalCycles",
       COUNT(sc.id)                                          AS cycles_total,
       COUNT(sc.id) FILTER (WHERE sc.status = 'PENDING')     AS cycles_pending,
       COUNT(sc.id) FILTER (WHERE sc.status = 'COLLECTING')  AS cycles_collecting,
       COUNT(sc.id) FILTER (WHERE sc.status = 'PAID_OUT')    AS cycles_paid_out,
       COUNT(sc.id) FILTER (WHERE sc.status = 'DEFAULTED')   AS cycles_defaulted
FROM "SusuGroup" sg
LEFT JOIN "SusuCycle" sc ON sc."susuGroupId" = sg.id
WHERE sg."contractVersion" IS NULL
GROUP BY sg.id, sg.status, sg."contributionUsdc", sg."totalCycles"
ORDER BY sg."startDate";
```

**Interpretation.** Zero rows → there is no legacy population at all and this
entire runbook is moot. `cycles_collecting > 0` on any group is the smoking
gun of the pre-fix strand (see Q2). `cycles_paid_out` / `cycles_defaulted`
rows can only predate the era in which the payout batch acquired the
`userId: null` + `metadata` validation defects — the current pre-#264 code
cannot finalize any legacy cycle, so those are historical/informational.

## Q2 — Stranded COLLECTING cycles: age, stamp signature, recoverability

```sql
SELECT sc.id                AS cycle_id,
       sc."susuGroupId",
       sc."cycleNumber",
       sc."payoutUserId",
       sc."collectionDate",
       sc."startedCollectingAt",
       CASE WHEN sc."startedCollectingAt" IS NULL
                 THEN 'HISTORICAL_LEGACY_STRAND'
            WHEN sc."startedCollectingAt" <= now() - interval '5 minutes'
                 THEN 'STALE_STAMPED'
            ELSE 'ACTIVE_NEW_CODE_TICK' END AS strand_kind,
       ROUND(EXTRACT(EPOCH FROM (now() - sc."collectionDate")) / 86400.0, 1)
                                          AS days_since_due
FROM "SusuCycle" sc
JOIN "SusuGroup" sg ON sg.id = sc."susuGroupId"
WHERE sg."contractVersion" IS NULL
  AND sc.status = 'COLLECTING'
ORDER BY sc."collectionDate";
```

**Interpretation.** The pre-#264 legacy code flipped `COLLECTING` without
ever stamping `startedCollectingAt`, so `HISTORICAL_LEGACY_STRAND`
(NULL stamp) is the expected production signature. After #264 deploys, its
claim CAS re-claims exactly these rows on the **first worker tick** (no
5-minute wait) — the worker sweeps every 5 minutes, so every row listed here
self-recovers within ~5 minutes of deploy. `STALE_STAMPED` can only appear
under post-#264 code after a genuine mid-tick crash (recovered within 5
minutes of the crash). `ACTIVE_NEW_CODE_TICK` should never be observed by
this query (live ticks are younger than the 5-minute window).

## Q3 — Committed contributions and the recoverable pool per stranded cycle

```sql
SELECT sc.id                     AS cycle_id,
       sc."payoutUserId",
       COUNT(scon.id) FILTER (WHERE scon.status = 'PAID')     AS paid_rows,
       COUNT(scon.id) FILTER (WHERE scon.status = 'SEIZED')  AS seized_rows,
       COALESCE(SUM(scon."amountUsdc")        FILTER (WHERE scon.status = 'PAID'), 0)       AS paid_total,
       COALESCE(SUM(scon."seizedFromAvailable") FILTER (WHERE scon.status = 'SEIZED'), 0) AS seized_total,
       COALESCE(SUM(scon."amountUsdc")        FILTER (WHERE scon.status = 'PAID'), 0)
         + COALESCE(SUM(scon."seizedFromAvailable") FILTER (WHERE scon.status = 'SEIZED'), 0)
                                                                AS recoverable_pool
FROM "SusuCycle" sc
JOIN "SusuGroup" sg ON sg.id = sc."susuGroupId"
LEFT JOIN "SusuContribution" scon ON scon."cycleId" = sc.id
WHERE sg."contractVersion" IS NULL
  AND sc.status = 'COLLECTING'
GROUP BY sc.id, sc."payoutUserId"
ORDER BY sc.id;
```

**Interpretation.** `recoverable_pool` is what #264's recovery tick will pay
out to `payoutUserId` — **plus** whatever the not-yet-collected members
still contribute (members without a contribution row are collected, or
seized to zero and defaulted, before the payout). The final payout is
`pool − fee` where fee = 3% (`susuProfitPct` global setting when present),
rounded down to 2 decimals, and the fee is attributed to the payout user on
their wallet ledger. Members already debited historically (their rows are
counted here) are **not** debited again.

## Q4 — Ledger / fee evidence on stranded cycles (ambiguity check)

```sql
SELECT sc.id AS cycle_id,
       (SELECT COUNT(*) FROM "TransactionHistory" th
         WHERE th."metadata"->>'cycleId' = sc.id
           AND th.type = 'SUSU_PAYOUT')                          AS payout_ledger_rows,
       (SELECT COUNT(*) FROM "TransactionHistory" th
         WHERE th."metadata"->>'cycleId' = sc.id
           AND th.type = 'SUSU_PROFIT')                          AS profit_ledger_rows,
       (SELECT COUNT(*) FROM "TransactionHistory" th
         WHERE th."metadata"->>'cycleId' = sc.id
           AND th.type IN ('SUSU_CONTRIBUTION', 'SUSU_SEIZURE')) AS debit_ledger_rows
FROM "SusuCycle" sc
JOIN "SusuGroup" sg ON sg.id = sc."susuGroupId"
WHERE sg."contractVersion" IS NULL
  AND sc.status = 'COLLECTING'
ORDER BY sc.id;
```

**Interpretation.** `payout_ledger_rows > 0` on a still-`COLLECTING` cycle
would mean a payout once committed but the cycle never finalized — an
ambiguous state the recovery tick would double-pay. Expected result for the
pre-#264 era is `payout_ledger_rows = 0` everywhere (the old payout batch
could never commit). If any row shows a nonzero payout ledger, **hold that
cycle for manual review before the recovery tick runs** — pause the susu
worker or deploy #264 with that cycle's group excluded until resolved.
`debit_ledger_rows = 0` is expected (the old code wrote no wallet ledger for
contributions/seizures); it is not a blocker.

## Q5 — Manufactured defaults (misclassification signature)

```sql
SELECT u.id        AS user_id,
       u.username,
       u."banStatus",
       u."strikeCount",
       sm."susuGroupId",
       sm.status   AS member_status,
       sm."trustScore"
FROM "SusuMember" sm
JOIN "SusuGroup" sg ON sg.id = sm."susuGroupId" AND sg."contractVersion" IS NULL
JOIN "User" u ON u.id = sm."userId"
WHERE u."banStatus" = 'BANNED_INDEF'
  AND sm.status = 'ACTIVE'
  AND NOT EXISTS (
      SELECT 1 FROM "SusuContribution" scon WHERE scon."userId" = u.id
  );
```

**Interpretation.** Banned indefinitely, still an ACTIVE susu member, with
**no contribution or seizure row ever recorded** — the exact signature of
the old code reclassifying a member-transaction failure (or a concurrent
tick's duplicate-key error) as a default. These bans and their voucher trust
penalties were applied to members whose money never moved. The recovery tick
will still collect them like any member (they hold funds again), but the
unjustified ban, strike and voucher penalties are a **manual business
decision** (unban / strike reversal / trust restoration) — the data cannot
reconstruct which voucher penalties came from manufactured defaults, so only
population-level review is possible.

## Post-deploy verification (after #264 is live)

Re-run Q1 and Q2 — every `COLLECTING` legacy cycle should be gone (absorbed
into `PAID_OUT` / `DEFAULTED` within ~5 minutes of deploy). Re-run Q3's
shape against the now-terminal cycles: each recovered cycle's
`payoutAmount` equals its committed pool minus the fee, and each
`payoutUserId`'s balance gained that net amount once, with a single
`SUSU_PAYOUT` wallet-ledger row per cycle.
