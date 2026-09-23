# r15k CI-Order Isolation: Predecessor Wallet-Obligation Leftovers

Date: 2026-09-23
Scope: cross-suite test isolation for `__tests__/r15k-reconciliation-provider-ownership.test.js`; `RestrictedObligation` hygiene in producer suites; no production code changed.

## The CI failure (run 35812381059, PR #302 first attempt)

All five payout proofs in `r15k-reconciliation-provider-ownership.test.js`
failed on the CI first attempt with the same signature:

- `result.processed` = 0 (expected 1) in tests A and E;
- zero provider HTTP calls in tests B, C, D (expected 1–2 each).

The same battery passed on the automatic second attempt, and passed locally
against an identical PostgreSQL. The five failures are not a code defect in
the payout chain: the own-obligation guard in
`PayoutBatchWorker._findCanonicalTransaction` behaved exactly as designed.

## Root cause (proven, not inferred)

Jest's suite order is not alphabetical — it follows the haste-map crawl and
differs run to run. Two orderings matter:

- **CI attempt 1** ran `r25-financial-concurrency-authority` and
  `penalty-policy-integrity` shortly before r15k. Both leave an
  `ACTIVE` `RestrictedObligation` (`sourceEntity='withdrawal'`,
  `sourceEntityId='1'`, `reference='withdrawal:wallet:1'`) behind, because
  their `afterEach` truncates `User ... CASCADE` and
  `RestrictedObligation` has **no FK to `User`** — the cascade never reaches
  it. The obligation is their own withdrawal proof's wallet reservation,
  intentionally ACTIVE while the withdrawal stays PENDING.
- **CI attempt 2 / local runs** happened to interpose suites that truncate
  `RestrictedObligation` (e.g. `r18-orphan-adoption-claim`,
  `r21-settlement-binding-gap-proofs`), or ran r15k first in a fresh process.

r15k seeds the first `Withdrawal` of each test at serial id **1**: its own
`afterEach` truncates `Withdrawal RESTART IDENTITY`, and the predecessors'
User-cascade cleanup resets the identity too. The leftover obligation then
alias-claims every seeded withdrawal through
`restrictedObligations.findActiveForSource('withdrawal', '1')`:

1. `_findCanonicalTransaction` resolves the own-obligation guard first
   (r17 P0 identity guard: a withdrawal that owns a wallet obligation must
   never adopt — let alone dispatch — a fiat canonical reservation).
2. The guard returns `{ row: null }`; the seeded withdrawal is flagged
   `NEEDS_MANUAL_REVIEW`.
3. Every proof sees `processed: 0` and zero provider calls — exactly the
   CI signature.

Local reproduction (pre-fix, deterministic, single command):

```
npx jest --runInBand __tests__/r25-financial-concurrency-authority.test.js \
                   __tests__/r15k-reconciliation-provider-ownership.test.js
# r15k: 5 failed (processed 0 / zero provider calls)
```

`penalty-policy-integrity.test.js` pairing fails identically. All other
suites that create obligations were audited empirically (run alone, count
leftover ACTIVE withdrawal-sourced obligations): zero leftovers.

## Fix (three layers, defense in depth)

1. **Producer hygiene** — `r25-financial-concurrency-authority` and
   `penalty-policy-integrity` now truncate `RestrictedObligation` in
   `afterEach` alongside their existing User-cascade cleanup. A leftover
   obligation row can no longer outlive the suite that created it.
2. **Consumer ground truth** — `r15k-reconciliation-provider-ownership`
   now neutralizes `RestrictedObligation` leftovers in `beforeEach` (the
   first test inherits predecessor state; `afterEach` cleanup alone cannot
   protect it) and adds `RestrictedObligation` to its own truncation list.
   The suite's end-to-end payout contract no longer depends on every other
   suite's hygiene.
3. **Regression proof (test F)** — seeds the exact observed CI poison
   (ACTIVE wallet obligation bound to the seeded withdrawal's id) and proves:
   - (1) the own-obligation guard still refuses adoption — zero provider
     calls, `NEEDS_MANUAL_REVIEW` — the guard itself is correct;
   - (2) the suite's neutralization removes the poison;
   - (3) a fresh candidate then processes through the full chain with
     moolre ownership recorded — the CI failure is impossible to reproduce
     through this suite's boundary.

## Why the guard is NOT relaxed

`findActiveForSource` matching by `sourceEntityId` is the documented
durable-relation mechanism (see `services/restrictedObligationService.js`).
The guard refusing a withdrawal that owns an ACTIVE wallet obligation is a
production safety property, not test friction: it prevents dispatching one
withdrawal's fiat canonical under another withdrawal's mirror. The defect was
test isolation (leaked rows + serial-id aliasing across reseeds), not the
guard. No production code changed in this round.

## Verification gates

| Gate | Result |
|---|---|
| r15k focused, 3 consecutive runs | 6/6 tests each (incl. new proof F) |
| r15k immediately after r25 (same process) | 15/15 |
| r15k immediately after penalty-policy (same process) | 23/23 |
| Full battery, run 1 (post-fix) | 282/282 suites, 2458/2458 tests |
| Full battery, run 2 (post-fix) | 282/282 suites, 2458/2458 tests |
| financial-durability lane (synchronous_commit=on) | green (see below) |
| route-check | PASS |
| prisma validate | valid |
| npm production audit (critical) | 0 vulnerabilities |
| db recovery drill | green (see below) |

Both full-battery runs, the financial-durability rehearsal (production commit
mode), and the recovery drill were executed on the PR #302 branch before
push; CI re-proves both lanes and the drill on the branch.
