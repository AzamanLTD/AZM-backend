# Payout provider ownership contract (r15 hardening, audit P0)

> Status: implemented and proven by `__tests__/r15j-payout-provider-ownership.test.js`
> (unit proofs), `__tests__/r15k-reconciliation-provider-ownership.test.js`
> (healthy-failover / owner-down / legacy-search / all-rails-absent, real
> PostgreSQL) and `__tests__/r15l-dispatch-bookkeeping-failure-paths.test.js`
> (bookkeeping-failure matrix A–I incl. the controller path, real PostgreSQL).

## The problem

The disbursement chain runs through `PaymentFailoverService` (Moolre primary →
MTN secondary), so the ACTUAL provider that accepted a payout is only known at
runtime. Before r15 hardening, that identity was never durably recorded and the
reconciliation status contract answered "reference not found on this rail" as
`PENDING`. A payout that failed over to MTN could therefore NEVER resolve:
Moolre's "not found" kept the row parked while MTN (the real owner) was never
asked. Cross-rail guessing to compensate risks settling through the wrong
provider. The fix makes ownership a first-class durable fact with fail-closed
semantics at every step.

## The five ownership sources, in authority order

`services/payoutProviderOwnership.js` → `resolvePayoutOwner(prisma, txRow)`:

1. **Canonical ownership metadata** — `TransactionHistory.metadata.payoutProvider`
   (`'moolre' | 'mtn'`, the failover tag) plus `payoutProviderName` (canonical
   name, e.g. `MOOLRE_DISBURSEMENT`) and `intendedProvider`. Authoritative
   when present. `persistPayoutOwnership` is fail-closed: the first writer
   wins, a contradictory overwrite raises `PAYOUT_OWNERSHIP_CONFLICT` and
   records a `ReconciliationException`.
2. **Durable dispatch evidence** — the `event:payout-dispatch:<provider>:<reference>`
   `FiatProviderEvent` row is written BEFORE the ownership write at dispatch
   time, so it survives an ownership-bookkeeping failure. Exactly one
   distinct provider → `RECOVERED`. Two distinct providers → `CONFLICT`
   (never a coin flip; parked).
3. Both fail-closed identity derivations (controller + workers): the
   accepting provider's identity comes from the failover chain's provider
   tag and the result's canonical self-identification. Absent or
   contradictory → `DISPATCH_IDENTITY_UNKNOWN` / `DISPATCH_IDENTITY_CONTRADICTION`
   park — a rail is never invented (the old `|| 'MTN_MOMO'` fallback is gone).
4. **Legacy rows** (no ownership, no evidence): reconciliation MAY search
   rail-by-rail; a rail's authoritative absence (`PROVIDER_REFERENCE_NOT_FOUND`)
   continues the search instead of parking.
5. **Nothing durable anywhere**: parked with a durable exception — never a
   terminal guess.

## The write order (all dispatch paths: controller, payoutBatchWorker)

After the provider ACCEPTS the dispatch, in order:

1. dispatch evidence (`event:payout-dispatch:...`) — failure parks the
   payout (`NEEDS_MANUAL_REVIEW` + `POST_DISPATCH_BOOKKEEPING_FAILED`
   exception) because the owner would be undiscoverable;
2. canonical ownership write — failure is SOFT (the payout stays tracked;
   `POST_DISPATCH_OWNERSHIP_WRITE_FAILED` exception; reconciliation
   recovers the owner from evidence);
3. `IN_TRANSIT` transition — failure parks with the same
   `POST_DISPATCH_BOOKKEEPING_FAILED` reason.

The user is NEVER refunded after acceptance: the money is with the provider.

## The reconciliation guard (workers/withdrawalReconciliationWorker)

Before any provider I/O, when ownership resolves UNKNOWN, the worker checks
the durable exception queue for reasons
`POST_DISPATCH_BOOKKEEPING_FAILED`, `POST_DISPATCH_OWNERSHIP_WRITE_FAILED`,
`DISPATCH_IDENTITY_UNKNOWN`, `DISPATCH_IDENTITY_CONTRADICTION` on the
reference. If present, the payout was dispatched but its owner is not
durably recoverable: it records `DISPATCHED_OWNERSHIP_NOT_DURABLE` and parks
— it never falls through to cross-rail guessing (even after an operator
status reset).

## The controller reservation contract

`finance.service.processFiatWithdrawal` creates the `Withdrawal`
reconciliation record INSIDE the authoritative reservation transaction, via
the `createWithdrawalRecordInTransaction` callback (raw-SQL bridge —
`Withdrawal.transactionHistoryId`, provisioned by
`infra/install-payout-reconciliation-infra.js`, not in the prisma migrate
chain). Consequences:

- the record cannot be orphaned from the canonical row;
- if the record cannot be established, the ENTIRE reservation rolls back
  (no debit, no canonical row, no provider I/O) and the client gets a
  fail-closed `503 WITHDRAWAL_RECORD_CREATION_FAILED`, never a
  retry-inviting 400.

## Change-response parking matrix (reconciliation outcomes)

| Observation (owner's rail) | Result |
|---|---|
| `SUCCESSFUL`/`COMPLETED` | settles via `financeService.completeFiatWithdrawal`, exactly once (terminal claim on `Withdrawal`, `ProviderSettlementAttempt` dedup) |
| `FAILED`/`REJECTED` | reverses via `financeService.reverseFiatWithdrawal`, exactly once (idempotent re-reconcile) |
| `UNRESOLVED` (transport/app uncertainty) | park + `PROVIDER_STATUS_UNRESOLVED`; other rail never asked |
| `NOT_FOUND` on a KNOWN owner | park + `PROVIDER_REFERENCE_NOT_FOUND`; other rail never asked |
| `NOT_FOUND` on every rail (legacy, no owner) | park + `PROVIDER_REFERENCE_NOT_FOUND` |
| contradictory evidence / identity | park (`PAYOUT_OWNERSHIP_CONFLICT` / self-ID contradiction); zero provider calls |
| ownership not durably recoverable | park (`DISPATCHED_OWNERSHIP_NOT_DURABLE`); zero provider calls |
