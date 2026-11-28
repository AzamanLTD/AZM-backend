# Proposal: make every provisioning path preserve `FiatProviderEvent.walletAccount`

> **LANDED 2026-11-19 — applied as written, not paraphrased.** Agent 1 took the patch
> unmodified: `9a54a586` on `feat/wp-h-payout-authority-closure`, cherry-picked with `-x`
> as `f8f3f846` onto `wp-i/step-up-closure`. Verified here from the pushed trees: the commit
> touches exactly one file, `"walletAccount" TEXT` is inside the `CREATE TABLE` body,
> `statementsFromSqlFile()` strips comments before splitting, and the loop applies
> `[...STATEMENTS, ...statementsFromSqlFile(WALLET_COLUMN_SQL)]`.
>
> **Numbering note.** The overlay is segment 14 of 28 on #403's chain and 15 of 33 on #405's.
> #405 carries three installers #403 does not, so the step number differs while the relative
> position does not: immediately after the installer that creates the table, and ahead of
> everything that reads or grants it. Quote the relative position, not the number, when
> discussing this across branches.
>
> The guarantee is now structural: the creator owns the column, so a recreated table is born
> with it and the overlay has nothing left to add.


**Ownership: `infra/install-fiat-liquidity-overlay.js` belongs to Agent 1. This proposal
is NOT applied.** The patch is `docs/proposals/2026-11-19-fiat-liquidity-wallet-column.patch`
and it applies cleanly (`git apply --check`) to the file as it exists on Agent 1's
candidate `993a6a14`.

## The defect this closes

`install-fiat-liquidity-overlay.js` creates `FiatProviderEvent` with `CREATE TABLE IF NOT
EXISTS` and no `walletAccount` column. Segment 15 (`install-wp-i-observation-wallet-overlay.js`)
adds the column afterwards, so the normal chain converges. But the guarantee is positional,
not structural: **any path that recreates the table produces a database without the column.**
That is not hypothetical — the p5d authority suite drops and re-provisions this table, which is
exactly why declaring the Prisma field broke it (500s with the field, 63/63 without).

A recreated database then reports itself as provisioned while a wallet-scoped reader finds no
column, and the safe behaviour (refuse as "unknown wallet") silently becomes the permanent
behaviour for every payment.

## The patch, in three parts

1. `"walletAccount" TEXT,` in the `CREATE TABLE` body — a fresh database is born correct.
2. The shared DDL file `prisma/sql/2026-11-18-fiat-provider-event-wallet-account.sql` is applied
   after the `CREATE TABLE` statements — an existing table gains the column, its comment and its
   index, idempotently.
3. `fs`/`path` requires and a `statementsFromSqlFile()` helper, which strips comment lines
   *before* splitting on `;` (a comment may contain a semicolon).

No SQL is restated: the two installers apply the same file, so they cannot drift. That is
requirement 6 of the owner's brief, and it is why the patch does not inline an `ALTER TABLE`.

## Provisioning paths that must all converge

| Path | Recreates the table? | After this patch |
| --- | --- | --- |
| `install-fiat-liquidity-overlay.js` (segment 14) | yes, when absent | column + index |
| `install-wp-i-observation-wallet-overlay.js` (segment 15) | no, adds | no-op, already present |
| p5d authority suite re-provisioning | yes (drops) | column + index |
| test harnesses that apply the overlay | depends | column + index |

## Proofs to run once the patch lands

1. Fresh database → fiat-liquidity installer → column and index exist.
2. Existing database without the column → installer → column added safely.
3. Existing database with the column and populated rows → installer → rows preserved.
4. Both installers consecutively, twice → identical schema, no error.
5. p5d authority test provisioning path → column still present afterwards.
6. Full release chain → segment 15 still immediately after segment 14.
7. Real Prisma reads and writes after provisioning, then p5d 63/63, WP-I suites, full Test Suite.

## Sequencing the owner set

The Prisma model field stays **deferred** until those proofs pass. The v2 identity and every
writer stay on v1 until the field exists and all writers can switch atomically in one release.
`NULL` wallet stays "unknown" and refuses; it is never backfilled from today's configuration.
