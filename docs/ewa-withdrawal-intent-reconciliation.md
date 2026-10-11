# EWA Withdrawal Intent — Server-Owned Reconciliation Contract

Issue [#330](https://github.com/AzamanLTD/AZM-backend/issues/330). Companion to
AZM-businessPortal PR #115, which keeps an unresolved withdrawal's identity in
browser localStorage. That record cannot survive a device change, so the server
now owns a durable intent lifecycle: an authorized session on ANY device can
discover an unresolved attempt and recover the ORIGINAL identity instead of
minting a new one (and risking a duplicate payout).

## State machine

```
                 claim (durable, BEFORE any economics)
  (nothing) ─────────────────────────────────────────▶ PENDING
                                                        │
            ┌───────────────────────────────────────────┤
            │                                           │
   in-transaction guarded update              outer catch, marked
   (same $transaction as the money)          pre-commit refusal only
            │                                           │
            ▼                                           ▼
        COMMITTED                                    REFUSED
                                                        │
                            guarded reopen (review Finding 4,
                            arbitrated by the partial unique index)
                                                        │
                                                        ▼
                                                     PENDING
```

| Status | Meaning | Durability | Concurrent retry behavior |
|---|---|---|---|
| `PENDING` | Registered durably BEFORE any economics. The attempt is in-flight, crashed, or its outcome is otherwise not yet provable. **Nothing is claimed about the money.** | Written in its own transaction, before the withdrawal transaction runs. Survives restart. | Retry proceeds into the Serializable transaction; the in-tx claim guard is the single arbiter (below). |
| `COMMITTED` | The withdrawal atomically committed with its authoritative ledger/history records. `committedTxHash` anchors the `TransactionHistory` row. | Transitioned INSIDE the same Serializable `$transaction` as the treasury debit / employee credit / fee / ledger writes: committed-intent ⟺ committed money. | Exact retry replays the committed outcome (server-truth amounts). No second movement. |
| `REFUSED` | An authoritative pre-commit refusal (documented catalog only), recorded after rollback. | Written outside the rolled-back transaction. | Same-key retry first REOPENS the row `REFUSED → PENDING` (guarded, index-arbitrated — review Finding 4), then re-evaluates fresh — the existing "never replay a failure" contract is preserved. A refusal is authoritative for THAT attempt, not forever. |

### Edge behavior

- **Concurrent same-key attempts** (duplicate tabs, two devices): the
  `(employeeId, idempotencyKey)` unique constraint arbitrates the initial
  claim; inside the transaction a guarded
  `UPDATE ... WHERE status IN ('PENDING','REFUSED')` is the single commit
  arbiter, atomic with the money. The loser either hits a Serializable write
  conflict (→ retry → the existing txHash replay path returns the committed
  truth) or observes `COMMITTED` and returns it without moving money.
- **Different-key attempt against an UNRESOLVED intent** (review
  Finding 3): at most one `PENDING` intent may exist per employee, enforced
  by the database — the partial unique index
  `EwaWithdrawalIntent_unresolved_employee_key` (employeeId WHERE status =
  'PENDING', installed by the business-OS overlay; Prisma cannot declare
  partial indexes, so the installer is the authoritative source for both
  production and the CI/test db-push path). A new idempotency key whose
  claim would bypass an existing unresolved `PENDING` intent fails closed
  at the insert with typed `EWA_UNRESOLVED_INTENT_CONFLICT` — no
  application-level pre-check is trusted to arbitrate the race; the index
  is the arbiter, so concurrent different-key attempts cannot both pass.
  Same-key retries are exempt (they reuse the existing row, never insert a
  second one). Once the intent is authoritatively resolved (`COMMITTED` /
  `REFUSED`), the partial index vacates and a legitimately new withdrawal
  proceeds normally. A loser of this race leaves NO intent row and moves NO
  money; the client must recover the original key via the recovery
  endpoints and retry that identity.
- **Same-key retry of a REFUSED intent** (review Finding 4): the retry
  REOPENS its intent `REFUSED → PENDING` before the financial transaction,
  via a guarded `updateMany` that only transitions while the row is still
  `REFUSED` — and the transition itself is arbitrated by the same partial
  unique index (an existing different-key `PENDING` intent rejects the
  reopen with `EWA_UNRESOLVED_INTENT_CONFLICT`; both intents and all money
  unchanged). The retry therefore durably holds the unresolved slot for
  its whole attempt: no different-key `PENDING` can be claimed in the
  pre-transaction gap, a crash after reopening leaves a discoverable
  `PENDING` intent, and a concurrent same-key twin that loses the guarded
  race re-reads the row it already shares (the in-transaction guard remains
  the single economic arbiter).
- **Changed parameters on the same key** (`amount` or `destination` differ):
  typed `EWA_IDEMPOTENCY_CONFLICT`, fail closed. The original intent is
  untouched and remains recoverable. (Portal clients hold this conflict as
  an unresolved/reconciliation state.)
- **Process crash between claim and transaction / DB timeout / lost
  connection / serialization retries exhausted**: the intent stays `PENDING`
  — discoverable, reconcilable, never misclassified as a refusal or a
  committed payout.
- **Lost HTTP response after commit**: the intent is `COMMITTED` in the same
  transaction as the money, so the recovery list shows the committed truth
  immediately; an exact retry replays it.
- **Keyless (legacy) withdrawals**: no intent row is created — unchanged
  behavior. The worker route continues to REQUIRE `clientRequestId`.
- A `COMMITTED` intent whose anchor `TransactionHistory` row cannot be loaded
  fails closed with `EWA_INTENT_RECONCILIATION_REQUIRED` — never a second
  movement, never a fresh refusal claim.

## API contract

### Typed conflict envelope (review Finding 5)

`EWA_UNRESOLVED_INTENT_CONFLICT` and `EWA_IDEMPOTENCY_CONFLICT` (and the
`EWA_INTENT_RECONCILIATION_REQUIRED` reconciliation state) are surfaced by
the routes as **HTTP 409** with a stable JSON envelope:

```json
{ "success": false, "code": "EWA_UNRESOLVED_INTENT_CONFLICT", "message": "..." }
```

The exact `code` is the contract; `message` is human guidance. Clients should
key reconciliation logic off `code`, not message strings. Unrelated error
semantics (the reservation-availability 409, kiosk statusCodes and the
conservative 400 default for pre-commit refusals) are unchanged.

### `POST /api/business-os/ewa/withdraw` (unchanged surface, new backing)

Body: `{ employeeId, amount, destination?, idempotencyKey? }`.
Requires `ewa.manage` within the employee's business scope.

- With `idempotencyKey`: the attempt is durably claimed before the economics
  (see state machine). Response unchanged: committed outcome, or
  `{ success: true, replayed: true, ... }` on exact retry, or typed refusals.
- Without a key: legacy behavior (no intent, no recovery row for that attempt).

### `GET /api/business-os/ewa/intents/:employeeId` — operator recovery

Requires `ewa.manage`. Strictly scoped to the caller's resolved business
context: a foreign or absent context returns an empty list — never a
disclosure, never a hint that the employee exists.

Response:

```json
{
  "success": true,
  "intents": [
    {
      "id": "…",
      "status": "PENDING",            // PENDING first, then REFUSED, then COMMITTED
      "idempotencyKey": "…",          // the ORIGINAL key — the point of the endpoint
      "amount": "20.00000000",        // exact normalized decimal (8dp) of the requested gross
      "destination": "AZAMAN_BALANCE",
      "committedTxHash": "EWA_<employeeId>_<key>",  // COMMITTED only
      "refusalMessage": "…",                          // REFUSED only
      "createdAt": "…",
      "resolvedAt": "…"               // COMMITTED/REFUSED only
    }
  ]
}
```

Latest 20 intents for the employee, unresolved first.

### `GET /api/business-os/employees/my-ewa-intents` — worker self-service

Authenticated employee only; returns exactly their own intents (same shape
as above). The worker route also carries a mandatory `clientRequestId`, so
this endpoint is how a worker who lost their device recovers the same
identity instead of minting a new key.

## Claim ordering and authorization (review Finding 1)

Business scope, employee ownership and actor authorization are resolved
BEFORE the durable claim: the pre-claim lookup mirrors the in-transaction
read (scoped `findFirst` when a business scope is resolved — a
foreign-tenant employee is simply not found), and the same authorization
rule (`_assertWithdrawalAuthorization`) runs against the pre-claim read.
An unauthorized or foreign-tenant request therefore leaves the intent table
completely unchanged. The Serializable financial transaction re-asserts
both ownership (scoped employee read) and authorization inside its own
boundary; the preflight only stops durable writes by requests that could
never pass the transaction — it is not the arbiter of record.

## Recovery list ordering (review Finding 2)

`GET /ewa/intents/:employeeId` and `GET /employees/my-ewa-intents` return a
deterministic status priority — `PENDING` (unresolved) first, then
`REFUSED`, then `COMMITTED`, newest first within each tier. Tiers are
fetched independently under the caller's bounded limit, so a flood of
refusals or committed rows can never push an unresolved `PENDING` intent
out of the visible window.

## Client recovery sequence (second device)

1. Open the employee's EWA panel; call the intents list.
2. If the newest intent is `PENDING`: the attempt is unresolved. Retry
   `POST /ewa/withdraw` with the LISTED key, amount, and destination — never
   a new key.
   - The retry either commits the withdrawal once (the crash case), or
     replays the committed outcome (the lost-response case), or replays the
     authoritative refusal (same-key refusal re-evaluation).
3. If the newest intent is `COMMITTED`: the withdrawal is complete — verify
   against EWA history via `committedTxHash`. Do not submit anything new
   for that intent.
4. If the newest intent is `REFUSED`: the attempt was authoritatively
   refused; the message names the cause. A retry re-evaluates fresh.
5. No client-side action can silently retire an unresolved intent: only a
   committed transaction, a marked pre-commit refusal, or (in future work)
   an explicit server-side reconciliation process changes its status.

## Accounting invariants preserved

Exact `Prisma.Decimal` arithmetic (8dp authority, never floats on the
settlement path); atomic treasury debit + employee credit + 1% fee +
`TransactionHistory`/`BusinessLedgerEntry`/`AdminProfitLog` writes in one
Serializable transaction; `azmBalance` untouched; unsupported external
destinations fail closed; same-key replay stays byte-comparable with the
pre-change behavior (the txHash anchor and response envelope are unchanged).

## Schema / deployment

- Prisma model `EwaWithdrawalIntent` (additive; unique
  `(employeeId, idempotencyKey)`, cascade deletes with employee/business).
- The single-unresolved-intent rule is a PARTIAL unique index
  (`EwaWithdrawalIntent_unresolved_employee_key`: one `PENDING` row per
  employee), created by the overlay installer below — Prisma schema cannot
  express partial indexes, so the installer is its authoritative source.
- Production DDL: `infra/install-business-os-overlay.js` (idempotent
  `CREATE TABLE IF NOT EXISTS` + indexes + FKs), which runs in the Render
  build via `npm run release` — the production path (production Neon has no
  `_prisma_migrations`; never `db push` against production).
- CI/test: `prisma db push --accept-data-loss` on the disposable Postgres,
  then the overlay installer — both produce the same shape.

## Limits (honest)

- Keyless legacy attempts have no intent row and therefore no cross-device
  recovery record.
- Intent history is retention-bounded to 20 per list call; older rows remain
  queryable by the database but are not paginated in this API yet.
- The unique-claim guard makes same-intent retries exactly-once **for that
  intent**. The single-unresolved-intent index additionally prevents a new
  key from bypassing an unresolved `PENDING` intent; once that intent is
  resolved, deliberately NEW intents are again allowed and are bounded by
  the existing economic-cap guard, unchanged.
- "Exactly once" is claimed only for the same-key lifecycle: claim + guarded
  in-transaction transition + txHash uniqueness + replay. No claim is made
  about distinct-key attempts or external providers (EWA settles internally
  to AZAMAN_BALANCE only).
