# r23 — Custody Denial/Approval Races + Submission Under Concurrency (P0) — Final Report

**Date:** 2026-09-21 · **Scope:** §P.2 custody execution, race axis (audit + fix)

## 1. Executive summary

Audited every concurrent interleaving of the four-eye denial/approval path
against the submission boundary, the refund closure, and the recovery scan.
Confirmed the P0 double-spend window (a denial and a submission racing on the
same execution could both win: the customer refunded AND the provider called)
and repaired it by restructuring the money paths around durable identity
rather than request data. Added linked-record identity/economics guards to
settlement and refund, REQUESTED-state recovery ownership, and due-time
scheduling so a large unresolvable backlog can never starve fresh rows.

- **Regression suite:** `__tests__/r23-custody-denial-approval-races.test.js` — 29 proofs against real PostgreSQL (the commit message's "37" was a miscount; 29 is the verified jest number)
- **r22 suite updated:** 44 lines (stricter contract alignment), all 41 r22 proofs still green
- **Full gate:** 268 suites / 2250 tests, 2249 green (r18 S4 is a known flake — passes 2x in isolation; no custody or money suite touched)

## 2. Defects confirmed and repaired

| ID | Defect | Repair |
|---|---|---|
| D1-P0 | Denial and submission could both win the same execution: refund executed while the submitter was already past the provider boundary | Pre-flight restructure: the exactly-once refund closure runs ONLY before any submission claim is taken; once a row has claimed the submission CAS, no refund path can execute against it. Both interleavings proven (denial-first and submitter-first) — exactly one winner, never both refund and provider call |
| D1 | Repeated denial re-executed the refund closure | Denial is idempotent by construction: a repeated denial records the fact only, never a second refund |
| D1 | A SUBMITTED denial (no pendingId, provider unresponsive) was refunded on absence of evidence | Absence from the KMS contract is not proof of no broadcast — such denials quarantine; the money stays untouched |
| D2 | Approval could restore APPROVED on a denied/failed row, or land on quarantined rows | Conditional write: approval after denial refused; after FAILED refused as stale; on quarantine refused; racing approval/denial (Promise.all) yields exactly one durable outcome — APPROVED-after-DENIED is unreachable |
| D3 | Settlement/refund trusted the linked TransactionHistory row by id alone | Linked-record identity guards: wrong owner, wrong type, economics disagreement (exact-decimal net; fee compared only when the execution carries feeChargeBaseUnits authority), and conflicting-txHash-on-COMPLETED all refuse + quarantine with the victim row untouched. A control proof confirms correctly-linked settlement still completes (guards do not overreach) |
| D3 | A refund or a verified chain REVERT could pay against a misbound linked row | Misbound linked rows withhold the refund and re-classify the execution for a human; the victim's record stays PENDING and their balance is byte-identical |
| D4 | Recovery re-scanned unusable evidence shapes; a pending decode without an explicit token contract could bind a recipient/amount collision | Fail-closed decoder contract enforced in the race axis too: JSON without an explicit token contract is UNUSABLE evidence — never a match, never a mismatch |
| D5 | A 30-row unresolvable backlog starved fresh rows from the bounded recovery scan | Due-time scheduling: nextRecoveryAttemptAt (NULL = due immediately) + recoveryAttemptCount backoff 60s -> 300s -> 900s cap; the scan picks due rows first, so a fresh row is always examined. Pendings claimed by another execution are excluded from binding |
| D5 | Human-owned quarantine classes (CHAIN_MISMATCH etc.) were re-scanned forever | The automatic reconciliation scan excludes human-owned classes; only evidence-responsive classes (UNKNOWN_OUTCOME, late pendings) re-scan |
| D6 | REQUESTED rows had no recovery owner (stranded forever) | REQUESTED added to the state machine with a real recovery owner: stale PENDING/DENIED -> definitive FAILED + exactly-once refund; stale APPROVED re-enters the canonical submitExecution() boundary |

## 3. Honest limits (documented, not guessed)

- A denial racing an in-flight KMS signing fetch remains an external race; the
  system converges to exactly one winner by durable identity, but cannot
  prevent the fetch itself — an unprovable cancel quarantines rather than
  refunds (carried from r22, now proven under true concurrency).
- The fee-economics guard deliberately does NOT compare the linked record's
  fee when the execution carries no feeChargeBaseUnits authority: the
  column is nullable and legacy executions legitimately keep the fee on the
  history side alone. The NET payout (customer-decisive) is always compared.
- Backlogged unresolvable rows remain quarantined for a human indefinitely —
  fairness ensures they never consume the scan budget, not that they resolve.
- r18 S4 (orphan-adoption concurrent claim) flaked once under full-suite load;
  it passed twice in isolation and involves none of the custody modules. It
  is recorded as a CI-retry-class flake, not repaired here.

## 4. Verified evidence (29 proofs)

- **D4 unit (4):** unusable-evidence decoder contract; no-contract decode
  never binds; backoff schedule 60s -> 300s -> 900s cap; REQUESTED has a real
  recovery owner in the exported state machine.
- **D1 denial (9):** RESERVING denial definitive (FAILED + exactly-once
  refund + DENIED, zero provider calls); SUBMITTED denial quarantines; repeat
  denial idempotent; sweep denial fails the sweep without customer money; the
  P0 race both interleavings (exactly one winner); DENIED quarantine invisible
  to the automatic scan.
- **D2 approval (5):** after-denial refused; after-FAILED refused as stale;
  approve-vs-deny Promise.all exactly one durable outcome; repeat approval
  idempotent; quarantine rows never approved.
- **D3 linked-record identity (8):** wrong owner / wrong type / economics
  disagreement / conflicting txHash all refuse + quarantine with victim
  untouched; the control proof completes; misbound refund withheld +
  quarantined; verified REVERT with misbound row withholds the refund and
  re-classifies for a human.
- **D5 fairness (3):** 30-row backlog cannot starve a fresh row; backoff
  stamps grow per attempt to the 5-minute step; human-owned classes excluded
  from the automatic scan.
- **D6 REQUESTED (3):** stale PENDING and stale DENIED rows fail with
  exactly-once refund; stale APPROVED re-enters the canonical submission
  boundary.

## 5. Files changed

- `services/tatumCustodyExecutionService.js` — pre-flight restructure of the
  refund closure (durable-identity-only derivation); approval conditional
  writes; deny race convergence; scoped fee-economics guard
- `services/custodyRecoveryService.js` — due-time scheduling + backoff
  stamping; claimed-pending exclusion; REQUESTED recovery ownership;
  human-owned class exclusion; misbound-linked-row refund withholding
- `prisma/schema.prisma`, `prisma/migrations/20260917170000_custody_execution/migration.sql`,
  `infra/install-custody-execution-overlay.js` — additive, idempotent
  `lastRecoveryAttemptAt`, `nextRecoveryAttemptAt`, `recoveryAttemptCount`
  columns + composite ("status", "nextRecoveryAttemptAt") index
- `__tests__/r23-custody-denial-approval-races.test.js` (new, 29 proofs)
- `__tests__/r22-custody-execution-recovery.test.js` — contract alignment (41 proofs still green)
- `docs/custody-execution.md` — r23 section (this release's model + limits)

## 6. Verification environment note

The full gate is meaningful: the local test database was rebuilt exactly per
the CI recipe (`prisma db push` + the nine overlay installers in
`.github/workflows/test.yml` order) after drift (a half-applied migration
chain) had produced 24 spurious suite failures. Final verified state: fresh
DB from the CI recipe -> 268 suites / 2250 tests.
