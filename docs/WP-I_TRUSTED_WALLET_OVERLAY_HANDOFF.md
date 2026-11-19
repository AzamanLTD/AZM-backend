# WP-I trusted-wallet overlay — hand-off to Agent 1 (release-chain integration)

**Status: superseded by the UPDATE below — the overlay now exists and is registered.** Nothing in this document has
been added to `package.json`, and no release-chain edit was made by Agent 4. Agent 1 owns
release-command integration; this is the request, with the exact command and the ordering
constraints that make it safe.

Branch: `wp-i/observation-closure` (based on #405 head `a1741ee3`).
Related commit: `6d7c6411` — wallet-scoped observation identity (v2), not yet cut over.

## UPDATE 2026-11-19 — this document is now history, not a request

**The overlay exists and is registered.** `f19c2c7b` built `infra/install-wp-i-observation-wallet-overlay.js`
(applying `prisma/sql/2026-11-18-fiat-provider-event-wallet-account.sql`), and Agent 1's
integration candidate `993a6a14` registered it as chain segment 15, exactly the slot requested
in §4. `DEPLOY_RUNBOOK.md` and `release-execution-path.test.js` were updated to pin the position.
Nothing below needs doing by Agent 1.

**§3 was wrong, and Agent 1 proved it by measurement.** I asked for the Prisma field to land with
the overlay. Agent 1 added it, measured, and removed it: declaring a scalar makes Prisma select
`walletAccount` on every `FiatProviderEvent` read, and `install-fiat-liquidity-overlay.js`
**recreates that table without the column**, so on any database provisioned through the chain
(`db push`, then the installers) those reads fail. Measured: the p5d authority suite went to 500s
with the field declared and passed 63/63 without it. The correct rule is therefore the reverse of
what §3 says:

- the SQL column is safe to add now, because nothing selects it;
- the Prisma field may only be declared once **every** provisioning path creates the column,
  including any installer that drops and recreates `FiatProviderEvent`;
- until then the column is evidence in the database, not a field any writer can read or set.

**Consequence for the cut-over (§6): the overlay does not survive re-provisioning by itself.**
A database rebuilt by the fiat-liquidity installer loses `walletAccount` until segment 15 runs
again. The chain does run it after, so a chain-provisioned database is correct; a database
rebuilt by a single installer is not. Any wallet-scoped reader must therefore treat a missing
column as "unknown wallet" and refuse, never as "no wallet needed".

**What is still true from §6:** the cut-over remains all-or-nothing. The overlay adds the evidence
and nothing else — no writer supplies a wallet and no reader consumes one.

---

## 1. The gap this closes (verified in source, not assumed)

| Fact | Evidence |
| --- | --- |
| `FiatProviderEvent` has no wallet/account column | `prisma/schema.prisma` model `FiatProviderEvent` (fields end at `raw`, `receivedAt`) |
| `recordProviderEvent()` cannot persist a wallet | no `accountNumber` parameter |
| the settlement path passes a field that never exists | `src/services/moolreDepositSettlement.js` passes `providerEvent.accountNumber`, which is always `undefined`, so every claim row is written with `accountKey = NULL` |
| the v1 claim key omits the wallet entirely | `src/services/providerObservationIdentity.js` builds `moolre\|collection\|<ref>` |

Consequence: two different Moolre wallets that reuse the same `externalref` collide into one
claim identity, while the trusted wallet that actually received the money is not recorded
anywhere in our database. Moolre's Quickstart states `externalref` is unique **per wallet**,
so a global uniqueness assumption is unsupported.

## 2. The overlay

**Proposed file:** `infra/install-wp-i-observation-wallet-overlay.js`

**Exact command (this is the string to register, unchanged):**

```
node infra/install-wp-i-observation-wallet-overlay.js
```

**Required SQL (idempotent, additive, no data backfill):**

```sql
ALTER TABLE "FiatProviderEvent" ADD COLUMN IF NOT EXISTS "walletAccount" VARCHAR(32);
CREATE INDEX IF NOT EXISTS "FiatProviderEvent_walletAccount_idx"
  ON "FiatProviderEvent"("walletAccount");
```

**Semantics of the column.** It stores the **trusted server-side wallet** that received the
payment, taken from our configured Moolre client identity at initiation or from the trusted
initiation record — never from a caller-controlled or provider-supplied `accountnumber`
field on its own. `NULL` means **unknown**, and unknown must stay unknown: the identity
layer refuses (`OBSERVATION_WALLET_MISSING`) rather than defaulting to today's configured
wallet. The overlay must **not** backfill historical rows from current configuration.

**Non-goals:** no `NOT NULL`, no unique constraint, no rewrite of existing rows, no change to
`TransactionHistory`, no change to any ledger or liquidity table.

## 3. Prisma model diff (shared schema — coordinate before editing)

```prisma
model FiatProviderEvent {
  // ...
  walletAccount    String?   // trusted server-side wallet that received the payment; NULL = unknown
  // ...
  @@index([walletAccount])
}
```

This is a Prisma-client-affecting change, so it is called out separately from the SQL overlay:
the column must exist in **both** the model and the raw-SQL chain, or `prisma generate` and
the release chain disagree.

## 4. Release-chain insertion point

Current chain is 32 steps. The relevant anchors, as they exist today:

| # | Installer | Why it matters here |
| --- | --- | --- |
| 12 | `install-payout-reconciliation-infra.js` | creates `ReconciliationException` (the Case B case table) |
| 13 | `install-wp-i-settlement-witness.js` | witness table |
| 14 | `install-fiat-liquidity-overlay.js` | **creates `FiatProviderEvent`** |
| 30 | `install-provider-observation-claim.js` | backfill reads the claim columns; will read `walletAccount` |
| 32 | `verify-authority-boundary.js` | terminal verification |

**Requested position: immediately after step 14, i.e. step 15.**

Hard constraints, in order of severity:

1. **After step 14** — the `ALTER TABLE` fails if `FiatProviderEvent` does not exist yet.
2. **Before step 30** — the claim backfill is the first consumer of `walletAccount`; a
   backfill that runs against a database without the column must not be possible.
3. **Before any runtime writer supplies a wallet** — the settlement path will start writing
   `walletAccount`; if the column is absent the write fails and deposits stop settling.

Inserting it at the end of the chain (near step 30) also satisfies 1 and 2, but leaves the
column unavailable for the whole window between step 14 and step 30. Placing it at 15 keeps
the schema and the table that owns it adjacent.

## 5. Idempotency and proof requirements

The overlay must be proven, not asserted:

- clean disposable database → creates column + index;
- already-provisioned database → second run is a no-op (no error, no duplicate index);
- database where `FiatProviderEvent` is absent → **fails closed with a clear message**, it
  must not silently succeed;
- partial failure → no misleading half-state (no index without column, no column without the
  model);
- the release chain's terminal `verify-authority-boundary` still reaches its expected
  NOT-READY state on a disposable target (it exits non-zero by design when authority is not
  activated; that is not a regression).

`prisma db push` is **not** acceptable evidence for production release.

## 6. Cut-over sequencing — the part that must not be split

The v2 identity (`6d7c6411`) is merged in code but **not wired into the claim service**. That
was deliberate: a partial cut-over opens a double-claim window.

Why: the deposit path currently writes a **v1** claim (`moolre|collection|<ref>`) because the
persisted event has no wallet. The witness path would write **v2**
(`moolre|collection|v2|<wallet>|<ref>`) as soon as an opening supplies a wallet. Different
keys do not collide, so one payment could be claimed once under each format — two economic
uses of one observation — and the legitimate witness path would be refused by a legacy-block
check that only closes one direction of the race.

Therefore, in **one release**, all of the following must switch together:

1. the column exists (this overlay);
2. the settlement path persists the trusted wallet at initiation and at callback;
3. the deposit claim, the witness claim, the cross-path guard, the quarantine writer and the
   backfill all use the same identity function;
4. the claim service refuses when an attempt uses v2 while a v1 claim exists for the same
   reference (**and** refuses the reverse), until every v1 row is provably accounted for.

Until 1–4 are all true, every writer stays on v1 and the wallet dimension exists only in the
identity module. Do not enable v2 in one path ahead of the others.

## 7. What Agent 1 must not do

- Do not register this command before the file exists and its idempotency proof is attached.
- Do not edit the release ordering in `package.json` on Agent 4's behalf; Agent 4 will supply
  the file and the proof, Agent 1 places it.
- Do not run the overlay against production, and do not treat a successful `db push` as
  release proof.
- Do not backfill `walletAccount` for historical rows from current configuration.

## 8. Acceptance checklist for the hand-off

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Overlay file written with the SQL in §2 | NOT DONE |
| 2 | Prisma model field added | NOT DONE |
| 3 | Idempotency proven on clean + upgraded + absent-table databases | NOT DONE |
| 4 | Release position agreed (after 14, before 30) | PENDING AGENT 1 |
| 5 | All writers switched in one release | NOT DONE |
| 6 | v1/v2 cross-format race closed and proven | NOT DONE |

## Appendix A — provider questions (owner, not Agent 1)

To be answered by Moolre before the wallet scope is stated any more broadly than "one
configured wallet per collection API Service":

1. Is `externalref` unique per wallet, per API Service/credential, or globally?
2. Is a client-supplied `externalref` returned verbatim in the type-1 status response?
3. May a reference be reused after a failed or timed-out attempt?
4. How are reversals/chargebacks surfaced, and can they be identified by reference?

Until answered, the supported scope is: **type-1 collection status for a single configured
wallet**, with the wallet carried explicitly and unknown wallets refused.
