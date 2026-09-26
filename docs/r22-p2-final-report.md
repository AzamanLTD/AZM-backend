# r22 — Custody Execution Recovery + Terminal Convergence (P0) — Final Report

**Date:** 2026-09-21 · **Branch:** `r22/custody-execution-recovery` · **Scope:** §P.2 custody execution (audit + fix)

## 1. Executive summary

Audited the entire custody execution lifecycle for crash-window and
terminal-convergence defects. Confirmed every defect in the brief and repaired
them with a dedicated recovery service, evidence-verified settlement guards,
and a dedicated 60s recovery cadence. All customer-money transitions are now
conditional single-winner CAS operations whose outcomes converge exactly once,
with every non-actionable outcome honestly quarantined for a human instead of
guessed.

- **Regression suite:** `__tests__/r22-custody-execution-recovery.test.js` — 41 proofs (unit + real PostgreSQL)
- **Existing custody suite:** 72/72 (2 tests updated to the stricter contract, see §6)
- **Full suite:** verification gate run on the branch — see §8
- **Docs:** `docs/custody-execution.md` — recovery-ownership model, honest limits, ops tunables

## 2. Defects confirmed and repaired

| ID | Defect | Repair |
|---|---|---|
| A1 | Reconcile worker scanned only `SIGNING`/`BROADCAST`; `SUBMITTED`, stale `RESERVING`, and `RECONCILIATION_REQUIRED` were permanently unrecoverable | New `services/custodyRecoveryService.js` + `workers/custodyRecoveryWorker.js` (60s cadence through the existing BullMQ scheduler abstraction) own every non-terminal state; the state machine is now exported and enforceable (`STATE_MACHINE` with `recoveryOwner` per status) |
| A2 | Stale `RESERVING` rows stranded forever | Stale PENDING/DENIED withdrawals → definitive FAILED + exactly-once refund (ledger idempotency key family `ledger:withdrawal:crypto:refund:<id>`; obligation `CANCELLED`; `TransactionHistory` FAILED). Stale APPROVED rows re-enter the canonical `submitExecution()` boundary on the durable identity — the single-winner CAS guarantees exactly one submission |
| A3/A4 | Crash after the `RESERVED→SUBMITTED` CAS could double-send (retry) or strand (no-op) | `recoverSubmittedExecutions` resolves via Tatum's documented pending-KMS contract (`GET /v3/kms/pending/MATIC` → `PendingTransaction {id, chain, hashes[], serializedTransaction, index?, txId?}`). Binding requires exact chain + KMS signature identity + decoded ERC-20 transfer semantics (contract, recipient, base-unit amount). Never a blind retry: a match binds (SIGNING or BROADCAST via `txId`); no match quarantines with evidence; provider unavailability leaves the row untouched |
| A5 | Quarantined rows had no recurring convergence | `convergeReconciliationRequired`: `UNKNOWN_OUTCOME` re-scans pendings every pass and binds the moment evidence appears; `CHAIN_REVERTED` converges definitively to FAILED + exactly-once refund (revert txHash preserved); `CHAIN_MISMATCH`/contradictions stay human-owned — validator refuses (409), no retry, no refund |
| A6 | Unchecked `TransactionHistory` completion CAS permitted COMPLETED execution with linked record not completing | `settleExecution` guards: missing linked record → refusal + quarantine (atomically, inside the settle transaction); FAILED linked record + success evidence → contradiction quarantine. Normal settlement converges the REAL chain tx hash into the customer record in the same transaction (no divergence window) |
| A7 | Deny race: cancel could be recorded while signing proceeded | `denyKmsRequest` now converges per durable outcome: proven cancel → definitive FAILED + exactly-once refund; unprovable cancel → quarantine (no refund — broadcast cannot be excluded); post-broadcast denial recorded but cannot un-broadcast. `approveKmsRequest` refuses executions already carrying broadcast evidence |
| A8 | Hourly-only recovery cadence (customer withdrawals left hanging up to 1h+) | Dedicated 60s `custody-recovery` job registered in `src/workers/index.js`; safe in distributed mode and the Redis-off fallback because every transition is a conditional CAS |

## 3. Honest limits (documented, not guessed)

- Absence from the KMS pending list does NOT prove no broadcast (completed pendings leave the list). A crash-after-claim with no admissible match is quarantined — never auto-refunded.
- A pending whose serialized payload does not decode is UNUSABLE evidence — never a match nor a mismatch.
- `realizedNetworkCostBaseUnits` is never fabricated from the estimate. The reverted-receipt gas (MATIC, paid by the hot-wallet operator) is an operating cost — recorded as a P1 follow-up, not a customer charge.
- An in-flight KMS signing fetch is an unavoidable external race: a denial whose cancel cannot be proven quarantines instead of failing/refunding.

## 4. Verified evidence (41 proofs)

- **Unit:** calldata decode (exact recipient/amount, malformed rejection, JSON + hex forms); matching (bind on exact identity + semantics; non-match on wrong chain/signature/index/recipient/amount; unusable on unparseable); state-machine completeness (every status has a recovery owner; COMPLETED/FAILED not resumable; RECONCILIATION_REQUIRED resumable by design).
- **RESERVING:** exactly-once refund with full money proofs (balance, ledger reversal count 1, obligation CANCELLED, history FAILED); no double refund on repeat pass; approved re-entry submits exactly once on the same execution; fresh rows untouched; denied rows failed+refunded; sweep rows failed without customer refund and address freed for re-claim.
- **SUBMITTED:** pendingId + signed tx → BROADCAST; crash-after-CAS bind to SIGNING with zero second submissions; `txId`-carrying pending binds to BROADCAST; malformed txId quarantines; multiple matches quarantined (no probabilistic binding); no match quarantines with money untouched and customer record honestly PENDING; already-bound pendings never stolen; provider unavailability leaves rows untouched; bound execution settles end-to-end (COMPLETED + real txHash in the customer record + obligation RELEASED).
- **Quarantine convergence:** late-arriving pending binds on a later pass; CHAIN_REVERTED → FAILED + exactly-once refund with evidence preserved; no double refund; CHAIN_MISMATCH stays human-owned with validator refusal (409); reverted sweep frees the address.
- **Settlement guards:** missing linked record refuses + quarantines; FAILED-record contradiction refuses + quarantines; normal settle converges the real txHash atomically and re-settle is idempotent; audit-only sweep settlement never blocks on a missing audit row.
- **Races:** proven-cancel deny → FAILED + exactly-once refund; failed-cancel deny → quarantined DENIED with no refund; post-broadcast denial recorded while chain evidence settles; post-broadcast approval refused.
- **Cadence/gates:** worker pass bounded and re-entry safe; 60s cadence registered through the existing scheduler abstraction; recovery fails closed when the LIVE+KMS+execution gate is off.

## 5. Files changed

- `services/custodyRecoveryService.js` (new) — recovery ownership for RESERVING/SUBMITTED/RECONCILIATION_REQUIRED; ERC-20 evidence decoding; pending matching
- `workers/custodyRecoveryWorker.js` (new) — bounded 60s recovery pass
- `services/tatumCustodyExecutionService.js` — settle convergence guards, deny/approve race hardening, exported `STATE_MACHINE`
- `src/workers/index.js` — `custody-recovery` cadence registration
- `__tests__/r22-custody-execution-recovery.test.js` (new, 41 proofs)
- `__tests__/custody-execution.test.js` — 2 tests updated to the stricter settlement contract
- `docs/custody-execution.md` — r22 recovery model + honest limits + tunables (`TATUM_CUSTODY_RESERVING_STALE_MINUTES`, `TATUM_CUSTODY_SUBMITTED_GRACE_MINUTES`)

## 6. Deliberate test updates (with reasoning)

Two existing proofs relied on the lax contract repaired here (the brief's point F): they settled executions whose linked `TransactionHistory` row did not exist. The tests' INTENT (reconcile idempotency; deterministic lifecycle) is preserved against REAL linked records; the missing-record divergence now has its own dedicated proofs (refusal + quarantine). The sweep-claim failure was environmental (fresh sandbox DB lacked the partial-unique overlay indexes); fixed by running `infra/install-custody-execution-overlay.js` + `install-custody-accounting-overlay.js` against the test database, not by changing production code.

## 7. Follow-ups

- P1: record the reverted-receipt gas as an explicit operator operating-cost line (realized network cost), sourced from the receipt `gasUsed × gasPrice`, distinct from the customer-facing fee.
- P2: operations runbook for `RECONCILIATION_REQUIRED` triage (evidence fields, resolution actions, safe manual transitions).

## 8. Verification gate

Full suite (`npx jest --testEnvironment=node --runInBand --forceExit`, real PostgreSQL): **267 suites / 2220 tests passed, 0 failures** on the branch (342s). Baseline was 266/2179 — the delta is exactly the new `r22-custody-execution-recovery` suite (41 proofs).

Two operational notes from the gate run, neither a code defect:
- An earlier full-suite attempt was killed mid-`prisma db push`-style schema churn and left `azm_test` half-provisioned (missing tables → 14 suites failing on `42P01`). Fixed by rebuilding the test DB from the Prisma schema + all 13 `infra/install-*` overlay scripts; the 14 suites then passed standalone and in the full gate.
- The suite has a pre-existing open handle after completion (the repo's canonical `npm test` script already uses `--forceExit` for this reason).
