# Native-GHS Settlement (collections leg)

Owner intent (#369, 2026-10-27): Moolre collections are paid in GHS by the
customer, but the settled GHS is CONVERTED at the transaction quote and
credited as USDC to `user.availableBalance`. The native-GHS wallet
(`user.nativeGhsBalance`) is never touched by these flows. This workstream
adds the INTENDED native-GHS settlement integration — flag-gated, OFF by
default, no change to live behaviour.

## The flag

`GlobalSettings.nativeGhsSettlementEnabled` (Boolean, default FALSE).
Installed idempotently by `infra/install-native-ghs-settlement-overlay.js`,
wired into `npm run release`, the CI test workflow, the financial-durability
workflow, and the converge prod-branch chain.

- **OFF (shipped default):** the settlement path is byte-identical to the
  legacy USDC conversion credit. Pinned by the existing r15/p5e/r271d
  suites plus a dedicated flag-OFF regression in
  `__tests__/native-ghs-settlement.test.js` (native wallet NEVER touched).
- **ON:** a settled Moolre collection credits the customer's native-GHS
  wallet in EXACT pesewas. `availableBalance` is NEVER touched. GHS stays
  GHS — no conversion, no quote repricing.
- **Mutual exclusion with Model B:** `nativeGhsSettlementEnabled` +
  `modelBSettlementEnabled` together is an ambiguous configuration. The
  settlement fails CLOSED before any mutation: the deposit stays PENDING and
  retryable. Zero economic effect.

## Settlement path (flag ON)

Inside the ONE settlement transaction (`src/services/moolreDepositSettlement.js`):

1. Quote consumption, route gate, exact-pesewa match, and the
   PENDING→COMPLETED CAS claim are unchanged (the ONCE guarantee).
2. The settled row's metadata records the honest destination markers:
   `settlementCurrency: 'GHS_NATIVE'` and `settlementExternalRef` (the
   exact identity the ledger key was built from).
3. The customer credit goes to `nativeGhsBalance` (+exact pesewas) via
   `nativeGhsSettlementService.settleCollectionToNativeGhs` — same
   atomicity envelope as the legacy credit it replaces.
4. §P.4 accounting: `D fiat:momo:ghs` / `C ghs:user:{id}:liability`
   (both GHS units), idempotency key `ledger:deposit:fiat-ghs:{ref}`.
   Model B and the `clearing:conversion` bridge are NOT used — there is no
   USDC conversion to settle or clear.
5. The §P.5-D liquidity receipt still records (the collected GHS float is
   real regardless of destination).

`availableBalance` and existing USDC balances are NEVER reinterpreted.

## Durability primitives

- **Idempotency:** the deposit-level ONCE guarantee stays with the
  PENDING→COMPLETED CAS; the ledger posting carries its unique key; a
  webhook replay returns "Already processed" and credits nothing.
- **Failure/reversal:** `reverseNativeGhsSettlement(tx, ...)` is a
  compensating entry returning the exact credited GHS. Once-only by a raw
  jsonb CAS stamp on `metadata.nativeGhsReversal` (covers both a missing
  key and an explicit JSON null — Prisma's `equals: null` JSON filter
  misses absent keys). A second reversal is refused
  (`NATIVE_GHS_ALREADY_REVERSED`); a row that did not settle as GHS-native
  is refused (`NATIVE_GHS_NOT_GHS_NATIVE`); USDC is never touched.
- **Reconciliation:** `reconcileNativeGhsSettlements(prisma)` detects
  COMPLETED GHS-native rows whose ledger entry is missing (a torn
  transaction that must not exist — the honest detector), records a
  ReconciliationException (`NATIVE_GHS_SETTLEMENT_LEDGER_MISSING`,
  idempotent per row), and NEVER mutates a balance. A human resolves;
  money is never auto-corrected.

## Honest non-goals / unresolved decisions

- The WITHDRAWAL leg (GHS-native MoMo payouts debiting `nativeGhsBalance`
  directly, no USDC conversion) is NOT implemented in this PR. The
  semantics need an owner decision: does a GHS-native withdrawal skip the
  quote/FX path entirely, and what rate governs the pool settlement?
  Recorded for review on #369.
- No migration or reinterpretation of any existing balance. No provider
  behaviour change. Nothing is activated: the flag ships OFF.
