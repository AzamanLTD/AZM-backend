# Supported production baseline for the release chain

This records what the release chain (`npm run release`) actually requires, measured
rather than assumed. It exists because two different questions get conflated:

1. "Does the release chain install this feature?" — yes, for every overlay it
   ships, on a database already carrying the base schema.
2. "Can the release chain build a database from nothing?" — **no**, and it never
   could.

## The baseline

The chain runs against a database whose **base schema is already provisioned at
the release commit** — i.e. every table Prisma declares in `prisma/schema.prisma`.
Operationally that is one of:

- an existing production database whose schema was applied by the historical
  `prisma db push` path; or
- a freshly provisioned database where `prisma db push` is run once as a
  bootstrap step, after which the release chain is the only thing that applies
  DDL.

`prisma db push` is a **bootstrap and test path, not the production DDL authority**.
It creates tables, columns and indexes, and it creates **no CHECK constraints and
no triggers**. That gap is exactly what the overlay installers exist to close, and
it is why "the Prisma model exists" is not an implementation of a money invariant.

## Measured evidence

On a clean disposable database created empty and provisioned to the baseline with a
single `prisma db push`, the complete `npm run release` chain was run twice:

| Run | Exit | Result |
|---|---|---|
| 1 | 0 | all installers applied |
| 2 | 0 | `added: 0, already present: 74, dropped obsolete: 0, failed: 0` |

No `does not exist` error appears in either run's output, so the chain has no
hidden dependency on a table an earlier installer forgot to create **at this
baseline**.

After both runs, the objects this branch owns are present and singular:

- `BusinessOrder`: `ck_businessorder_currency_shape`, `ck_businessorder_currency_allowed`,
  `ck_businessorder_amount_present`
- `AdminMoneySettingRevision`: `admin_money_setting_revision_no_update`,
  `admin_money_setting_revision_no_delete`, `admin_money_setting_revision_no_truncate`

This is enforced by `__tests__/release-chain-baseline.pg.test.js`.

## Known limitation: the chain cannot bootstrap from empty

Standing up the chain against a genuinely empty database fails, and it fails
honestly:

```
node infra/install-business-os-overlay.js
  -> relation "BusinessProfile" does not exist
```

`BusinessProfile` has no installer; it arrives with the base schema. So the chain
is **additive on top of the base schema**, not a from-scratch provisioner. Anyone
reading "the release chain installs production DDL" should read it with that
qualifier. Making the chain self-bootstrapping would mean installers for the base
domain tables, which is a larger change than a money-contract PR and is not claimed
here.

## What this does not prove

- The chain is not proven against the **actual production database**; that needs an
  operator run.
- `infra/verify-authority-boundary.js` runs last in the chain and reports
  `TRIGGER_MISSING` / `ACTIVATION_FUNCTION_MISSING` for the activation boundary on a
  database where activation was never provisioned. It does not fail the chain
  (exit 0), so a green `npm run release` is **not** evidence that activation is
  provisioned.
