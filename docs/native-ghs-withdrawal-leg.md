# Native-GHS withdrawal leg — proposed contract (DESIGN ONLY, not implemented)

Status: open design for owner decision (#381 follow-up). Nothing here is
implemented, and nothing activates until the owner rules. The collections
leg (#381, flag OFF) settles GHS in; this document specifies how GHS gets
OUT to a MoMo destination without a USDC round-trip.

## Option A — GHS-native MoMo withdrawal (recommended)

The customer's GHS never converts. Symmetric with the collections leg:
real GHS in, real GHS out, one currency, one ledger chart.

### Authority
- Separate flag `GlobalSettings.nativeGhsWithdrawalEnabled`, default OFF
  (same overlay-installer family as the collections flag). Legs activate
  independently — collections-first rollout stays possible.
- Gate: the route refuses (fail-closed, no mutation) when the flag is ON
  but the payout float governance is unresolved (open question 2 below).

### Request contract
- `amountGhs`: exact 2-dp decimal, strictly positive. `0.00` is refused
  outright (dust guard analog of #380 — a zero payout can never be
  dispatched).
- `destination`: numeric MoMo destination with EXPLICIT
  `destinationType: 'MOMO'` — the #379 policy (no inferred types) applies
  unchanged; the missing-type refusal happens before any economics.
- HTTP `Idempotency-Key` supported exactly as the USDC leg supports it.

### Economic leg (single transaction)
- Atomic balance claim (r25 pattern): conditional decrement
  `nativeGhsBalance >= amountGhs`, losing the claim rolls back the whole
  transaction — no Withdrawal row, no ledger posting.
- Withdrawal row: additive `amountGhs` column (Decimal(20,2)) +
  `metadata.settlementCurrency: 'GHS_NATIVE'`. `amount` stays the honest
  USDC projection (amountGhs / rate at request) so legacy read surfaces
  keep a single denomination — recorded, never used for dispatch.
- Ledger posting (request): D `ghs:user:{id}:liability`,
  C `fiat:momo:ghs`. Idempotency namespace
  `ledger:wallet:withdrawal-ghs:{id}` — DISTINCT from the USDC leg's
  `ledger:wallet:withdrawal:{id}` so the two currencies can never
  collide on a hash (the exact defect class found in test on 2026-10-27).

### Dispatch
- No TransactionQuote, no FX conversion, no fresh-rate gate for the
  customer leg. The worker dispatches the EXACT `amountGhs` (the §P.5-D
  "exact reserved amount" discipline, extended to the native leg).
- If the fiat liquidity authority is ON, the payout reserves from the
  evidence-backed GHS float at request time — dispatch pays exactly the
  reserved amount, never a live-rate recomputation.

### Failure / reversal / reconciliation
- Provider-definitive failure: re-credit `nativeGhsBalance` exactly once
  via a reversal-marker CAS (mirror of the collections
  `reverseNativeGhsSettlement`); compensating ledger posting; the USDC
  wallet is never touched.
- UNKNOWN_OUTCOME stays unresolved — reconciliation ladder only, never an
  automatic local failure (same honesty contract as existing payouts).
- Sweep mirrors the collections leg: GHS_NATIVE rows whose ledger entry
  is missing are flagged as ReconciliationExceptions idempotently; money
  is never auto-corrected.

## Option B — quoted conversion (NOT recommended)
Keep the existing quote path (GHS → USDC value → GHS at dispatch). The
customer bears rate risk twice on a pure-GHS movement and needs a fresh
canonical rate for what is not an FX transaction. Rejected.

## Test plan (when implemented; real PostgreSQL)
- flag OFF: byte-identical legacy path; native wallet untouched.
- flag ON: exact-pesewa debit; USDC untouched; distinct ledger namespace.
- concurrent double-debit: exactly one winner.
- reversal once-only; UNKNOWN never auto-credited; dust 0.00 refused;
  missing destinationType refused before economics.
- reconciliation sweep idempotent, no balance mutation.

## Open questions for the owner
1. `Withdrawal.amount` for GHS-native rows — additive `amountGhs` column
   (recommended) or projection-only in metadata?
2. Float governance — require `fiatLiquidityAuthorityEnabled` for the
   GHS-native payout leg (recommended), or accept legacy-pool-less
   dispatch with manual float accounting?
3. Separate activation flag per leg (recommended) or one flag for both?
4. Fees — MOMO gas fee is 0 today; confirm no GHS fee model for v1.
