# r42 — Shared Financial Idempotency Authority (audit artifact)

**Branch:** `fix/r42-shared-idempotency-authority` (from main `7a123eb`)
**Scope:** every route using the generic `idempotency()` middleware, its controller/service transaction, its durable request identity, and the resulting fix or explicit safe disposition.

---

## 1. The finding (confirmed P0 on main)

`middleware/idempotency.js` on r41-main had the fundamental race:

```
IdempotencyKey.findUnique({ key })   →  no row  →  next()  →  financial handler
executes  →  only afterwards does res.json() fire a fire-and-forget
idempotencyKey.create()
```

Two concurrent identical requests both passed the lookup and both executed the
economic operation before any row existed. Additionally:

- **Global key scope** — `key @unique` alone; `userId`/`endpoint` were stored
  but never part of the uniqueness or the replay check. User B sending the same
  key as user A received **user A's cached response** (cross-user replay),
  and the same key on a different endpoint replayed the wrong endpoint's
  response.
- **Fail-open** — any DB error or missing model silently proceeded into
  unprotected execution of a financial endpoint.
- **24-hour expiry** — after expiry the row was **deleted** and the settled
  economic request became executable again.
- **Fire-and-forget cache write** — a crash between handler completion and
  the cache write left no durable fact of the operation at all.

## 2. The r42 design

`FinancialOperation` (new Prisma model, `@@unique([userId, endpoint, key])`)
is the **durable economic operation identity** — not a response cache:

1. **Claim before execute.** The middleware INSERTs the claim *before* the
   handler runs. PostgreSQL's unique constraint is the single arbiter under
   concurrency: exactly one racing request can insert. The loser reads the
   existing claim and gets a deterministic `409 IDEMPOTENCY_IN_PROGRESS`
   (with `operationId`) — it never enters the economic path.
2. **Scoped identity.** (user, logical endpoint, key) are the unique tuple.
   Same key across users or endpoints is fully independent (proved P5/P6).
3. **Request fingerprint.** sha256 of a canonical (sorted-key) request
   serialization including route params. Money is never routed through float
   arithmetic; `10`, `"10.00"` and `10.5` are *distinct* fingerprints — same
   key + materially different payload = deterministic `409
   IDEMPOTENCY_PAYLOAD_CONFLICT`, never a replay of the wrong transaction
   (proved P4/P4b).
4. **Permanent COMMITTED rows.** There is no TTL on the economic identity.
   The stored `responseBody` is only the derived HTTP replay convenience.
   A backdated committed claim replays forever; pruning/expiry can never
   re-arm a settled request (proved P13).
5. **Failure policies, per route.**
   - 2xx → claim COMMITTED atomically with the delivered response.
   - 4xx → claim released (validation failures do not poison the key; proved P8).
   - 5xx + `RETAIN` (default) → claim stays IN_PROGRESS: a 500 may have
     followed a committed mutation; the same key deterministically refuses
     forever (proved P9). The client must use a new key.
   - 5xx + `RELEASE` → for routes whose economic transaction provably rolls
     back together with its in-transaction claim commit (the wired
     multi-currency conversion); the claim is released and the same key may
     retry (proved P10/MC3).
6. **Fail-closed.** Missing model, DB error, or an unauthenticated mount →
   `503 IDEMPOTENCY_UNAVAILABLE` and the handler is never invoked (proved P11).
7. **Crash windows.**
   - *Wired endpoints* (multi-currency convert): the claim flips to COMMITTED
     **inside the economic `$transaction`** (claim + debit + credit + log
     commit or roll back together). A crash after commit, before response →
     the retry replays the committed result (proved MC1).
   - *Unwired endpoints*: the claim row itself is the durable fact — a crash
     leaves IN_PROGRESS, which deterministically refuses re-execution. No
     retry can ever produce a second mutation; the client converges via a new
     key or by checking their history.

## 3. Route inventory and classification

Legend — **A** middleware is convenience; a durable exactly-once identity already
protects the economics. **B** middleware was the primary protection; the mutation
has no adequate durable identity. **C** both layers exist but represent different
logical operations/scopes. **D** no adequate authority at the mutation boundary.

| Route | Underlying mutation | Service-level identity | Class | r42 disposition |
|---|---|---|---|---|
| `POST /api/multi-currency/convert` | source debit + dest credit + `CurrencyConversion` in one `$transaction` | **none** — generic middleware was the only request-level protection | **D** | **Fixed + wired.** Claim commits inside the transaction; route set `failurePolicy: RELEASE` (rollbacks are provable). Full conversion convergence (MC1–MC3). |
| `POST /api/trades/initiate` | escrow/trade creation + balances | HIGH-12 heuristic: `findFirst(userId, same amounts, ≤60s)` — check-then-act with no stored key; protects nothing under concurrency and rejects legitimate same-amount trades | **D** | **Fixed.** HIGH-12 block removed; the durable claim is the authority. |
| `POST /api/trades/accept` | escrow release / trade state CAS | trade status state machine (convergent) | B→A | Claim layering on top; state machine converges duplicates. RETAIN default. |
| `POST /api/p2p/ping/accept`, `/underpayment`, `/overpayment`, `/complete` | trade/ping status CAS + txHash-uniqued money legs (`OVERPAYMENT_FREEZE_<id>`) | state machine + txHash uniques (convergent) | B→A | Claim layering; duplicate execution converges by state. |
| `POST /api/wallet/withdraw` | withdrawal request + r16 durable DISPATCH_INTENT evidence | per-request internal evidence keys — **not client-key keyed** | **B** | Claim now provides the client-key identity the service lacked. RETAIN default. |
| `POST /api/withdrawal/fiat`, `/crypto` | as above (r15/r16 machinery) | as above | **B** | Same. RETAIN default. |
| `POST /api/savings/goals/:id/deposit` | user debit + goal credit + `TransactionHistory` | `txHash = SAVINGS_DEP_<clientRequestId \| x-idempotency-key \| random>` with `@unique` — **C mismatch**: the service reads `clientRequestId`/`x-idempotency-key`, the middleware reads `Idempotency-Key`; a caller sending only the middleware header gets a *random* service key (no service protection) | **C** | Middleware claim closes the mismatch gap at the HTTP boundary. Service identity untouched. Documented: clients should send matching keys. |
| `POST /api/savings/goals/:id/withdraw` | goal debit + user credit | same H12 txHash pattern | **C** | Same. |
| `POST /api/friends/transfer/send` | dual-leg transfer + `TransactionHistory` | `txHash = PEER_SEND_<clientRequestId \| x-idempotency-key \| …>` `@unique` | **C** | Same as savings. |
| `POST /api/wallet/internal-transfer` | pool ⇄ available balance move + history row | none (fresh history row per call) | **B** | Claim provides the identity. RETAIN default. |
| `POST /api/vault/:id/deposit` | guarded user claim + vault credit + `VaultDeposit` | `VaultDeposit.idempotencyKey @unique` **exists but is not wired from the HTTP key** (internal smart-route identity only) | **C** | Claim provides the HTTP identity; the internal identity remains authoritative for smart-route recovery. |
| `POST /api/vault/:id/break` | vault claim + ledger `ledger:vault:break-early:<vaultId>` | ledger idempotency keys derived from the vault (not the client request) | **B** | Claim layering. RETAIN default. |
| `POST /api/shared-vault`, `/:id/deposit` | vault deposit legs | none found | **B** | Claim layering. RETAIN default. |
| `POST /api/azm-conversion/` (AZM→USDC) | spend legs + ledger | `AzmSpendLog` dedup keyed `azm_conversion_<log.id>` — per-execution, **not** client-request keyed | **B** | Claim provides the client-request identity; spend-log dedup remains authoritative per execution. |
| `POST /api/azm-gifts/send` | gift + spend/reward legs | **A**: `gift_<senderId>_<idempotency-key>` with composite uniques on `AzmSpendLog` + `AzmGift.dedupKey` | **A** | Preserved. The claim is now the HTTP first line; the service identity remains the economic authority (the two use the same header value). |
| `POST /api/orders` (order book) | order create + ledger reserve | ledger keys derived from `order.id` (per-execution) | **B** | Claim layering; the reserve ledger is per-order. RETAIN default. |
| `POST /api/deposits/fiat/initiate` (+ `/moolre`) | deposit intent + reference | callback/evidence dedup keyed by provider reference (per-initiation) | **B** (low severity: money moves only at the provider callback the user pays) | Claim layering prevents duplicate intents. |
| `POST /api/escrow/fund`, `/satisfy`, `/dispute`, `/cancel` | escrow status CAS + custody legs | escrow terminal-state machine (r41 authority) — convergent | B→A | Claim layering; state machine refuses duplicate fund/satisfy. |
| Susu `POST /groups`, `/contract`, `/cancel`, `/vouches`, overlay routes | susu group/member state + contribution claims | contribution cycle claims (r41), member status machines | B→A | Claim layering; state machines converge. |
| `POST /api/cross-border-susu/contribute`, `/payout` | contribution/payout legs + evidence dedup | event-dedup by reference (per-initiation) | **B** | Claim layering. RETAIN default. |
| `POST /api/wallet/saved` | non-financial (saved address) | n/a | A | Convenience only; fail-closed acceptable. |

**Default policy**: every unwired route keeps `failurePolicy: RETAIN` — the
conservative choice: a 5xx leaves the key refused rather than re-executable.
Only the wired multi-currency conversion (whose rollback is provable because
the claim commit shares the economic transaction) uses `RELEASE`.

## 4. Preserved specialized authorities

Per the audit mandate, the following service-level identities were **not**
weakened or replaced: `AzmSpendLog`/`AzmRewardLog` dedup (including the
`gift_<senderId>_<key>` composite), `CustodyExecution`,
`InventoryRestockOperation`, business invoice/order/POS identities, EWA request
identities, reservation request identities, r16 `VaultDeposit.idempotencyKey`
(smart-route recovery), `TransactionHistory.txHash` uniques, and the r15/r16
withdrawal evidence machinery. The middleware claim is now the HTTP first
line; each documented service identity remains the economic authority at its
mutation boundary. On replay the handler is never invoked, so service
semantics are untouched (proved P3: handler invocation counter does not move
on replay).

## 5. Schema / migration

- `IdempotencyKey` (the retired response cache) — model removed; the r42
  overlay installer drops the table (it carried no money truth).
- `FinancialOperation` — created by `infra/install-r42-idempotency-overlay.js`
  (idempotent DDL, mirrors the release chain); added to `npm run release`,
  the main CI test lane, and the financial-durability lane install steps.
  `responseBody` is **TEXT**, not JSONB: JSONB reorders object keys on read,
  so a JSONB-stored replay body would be JSON-equivalent but not
  byte-identical to the original response. The column stores the exact
  serialized WIRE bytes (see Follow-up 3); the installer converges any
  earlier PR-era JSONB column idempotently with `ALTER ... TYPE TEXT`.

## 6. Proofs (real PostgreSQL)

`__tests__/r42-shared-idempotency-authority.pg.test.js` — 15 proofs, all
green, stable across repeated runs:

P1/P2 concurrency ×8 rounds (parked in-flight window, DB-observed), P3 replay
(no handler invocation), P4/P4b exact-decimal fingerprints, P5 cross-user,
P6 cross-endpoint, P7 in-flight 409 → committed replay, P8 4xx release,
P9 RETAIN poison semantics, P10 RELEASE rollback retry, P11 fail-closed,
P12 optional header, P13 permanence beyond any TTL, MC1 concurrent identical
conversions → one debit/credit/log + committed in-tx claim, MC2 changed-amount
conflict, MC3 injected mid-transaction failure → whole rollback + released
claim + single execution across the sequence.

**Standard**: a retry, duplicate request, lost response, process crash,
database race, or concurrent caller must never make AZM move money twice.

## 7. Unresolved findings / follow-ups

- Savings / friend-transfer services read `x-idempotency-key` /
  `clientRequestId` while the HTTP middleware reads `Idempotency-Key` (class C).
  The claim closes the protection gap, but clients should send a matching
  value; unifying the header contract is a recommended follow-up.
- The wired in-transaction claim pattern (MC1) is proven for multi-currency
  conversion; extending it to the remaining class-B arithmetic endpoints
  (internal transfer, vault deposit, AZM conversion) is a recommended
  follow-up wave. Until then, their crash window deterministically refuses
  (IN_PROGRESS) rather than double-moving money.

## 8. Follow-up 1 — independent review: HTTP-status/economic-commit boundary (2026-09-26)

An independent review of PR #311 (2d5661f) confirmed the green CI but
correctly rejected merge on two contract-level gaps, both now closed.

### P0-1 — a 4xx never implies economic rollback (FIXED)

The first implementation deleted the claim on any 4xx, assuming "nothing
committed". That assumption is unsound at a generic boundary: the reviewer's
concrete in-repo example — `withdrawalController.fiatWithdrawal` commits
`financeService.processFiatWithdrawal`, then post-commit work
(`emitBalanceUpdate`, emit helpers) can throw, and the outer catch converted
that into an HTTP 400 — would have had the authority asynchronously DELETE the
claim, re-arming a committed withdrawal for duplicate execution. A real
double-money path.

The authority now NEVER infers rollback from HTTP status. Dispositions are
explicit and durable:

- **RELEASED** only when the handler itself marked the failure provably
  pre-economics (`res.locals.financialClaimRelease = true`) — the schema
  `validate()` middleware sets this on every rejection, and the seven
  withdrawal pre-tx guards (network/amount/phone/fraud/tier guards,
  AZM_SPEND_FAILED thrown inside the rolled-back reservation) set it on
  validation failures — or when the route declared `releaseOn4xx`, which is
  ONLY valid for wired endpoints whose claim commits inside the economic
  transaction: there, a post-response IN_PROGRESS claim is itself durable
  proof of rollback. Wired today: `/api/multi-currency/convert` (the
  `tx.financialOperation.updateMany` COMMITTED transition lives inside the
  same `$transaction` as the debit/credit; proven by R3).
- **Trade initiation correction (2d8ea9e follow-up review):** `POST /api/trades/initiate` is NOT wired: `initiateTrade()` has no
in-transaction claim transition, so it must not and no longer declares
`releaseOn4xx`. Its crash/post-commit protection is RETAIN-based, exactly
like every other unwired class-B/D route: a post-commit failure (e.g.
`emitBalanceUpdate`, socket emission, fee-profile resolution, or the
globalSettings lookup throwing after the `$transaction` commits) surfaces
through the outer catch as 4xx/500, the claim is retained, and same-key
retries deterministically refuse (409 IN_PROGRESS; never a second trade).
Its ten pre-economics guards (input validation, ad existence/status,
self-trade, min/max limits, buyer payment details) each set
`res.locals.financialClaimRelease = true` — provably before the economic
`$transaction` — so genuine request-data 4xx keeps the key reusable.
See the `r42-trade-initiation` regression proofs (T1–T3).

- **COMMITTED** only via the in-transaction claim commit (wired) or the
  guarded 2xx bookkeeping.
- Otherwise the claim is **RETAINED** — the key is poisoned; same-key retries
  get a deterministic 409 IN_PROGRESS refusal. Worst case is an unusable key,
  never duplicate money.

`withdrawalController`'s outer catch now classifies unknown failures as an
honest **500 WITHDRAWAL_INTERNAL_ERROR** — a post-commit failure can never
masquerade as a client error. The final `res.status(400)` fallback the review
quoted was the exact hole; it is gone. `cryptoWithdrawal` already 500s.

### P0-2 — the Idempotency-Key is now REQUIRED on authority routes (FIXED)

Previously a missing header simply called `next()` — the authority vanished
whenever a client omitted it, and a lost-response retry (no key) on a
withdrawal was a brand-new operation that could debit twice. The factory now
defaults `required: true`: an unkeyed request receives a deterministic
`400 IDEMPOTENCY_KEY_REQUIRED` BEFORE any economics execute, and no claim is
created. `required: false` remains an explicit, per-route opt-out for
endpoints with a proven independent durable exactly-once identity; no current
mount uses it.

### Required proofs — mapping (review items 1–8 → r42 suite)

1. committed economics + post-commit exception + HTTP 400 → claim NOT
   released → **R1** (money moved once; claim IN_PROGRESS).
2. same-key retry after that failure → no second mutation → **R2** (409
   IDEMPOTENCY_IN_PROGRESS, zero second debit).
3. unkeyed financial request → fail-closed/key-required → **P12**
   (IDEMPOTENCY_KEY_REQUIRED, handler never invoked, no claim; plus unit
   proof of the required:false opt-out).
4. validation 4xx before economics → explicitly releasable/reusable →
   **P8** (explicit pre-economics flag) + unit flag/releaseOn4xx proofs.
5. transaction failure before commit → reusable same key → **P10** (RELEASE
   on provable rollback).
6. commit succeeded but response bookkeeping lost → same-key deterministic
   recovery → **R3** (wired in-tx claim survives simulated bookkeeping
   crash; byte-identical replay, one mutation).
7. concurrent requests covering those failure states → **R4** (one owner
   executes, all duplicates 409, claim retained through the failure).
8. at least one real withdrawal path through the post-commit failure →
   **R5** (real `fiatWithdrawal` + real `financeService.processFiatWithdrawal`
   on PostgreSQL: economics commit, post-commit emit throws, honest 500,
   claim retained, same-key retry 409, user debited exactly once, exactly
   one canonical WITHDRAWAL_FIAT row and one Withdrawal row).

### Route inventory re-verification (review P1)

All 39 `idempotency()` mounts were re-checked (independently re-counted by the reviewer). Standing disposition:
every mount now requires the key; `releaseOn4xx` only on the one
genuinely wired route (`/api/multi-currency/convert`, re-verified from
route → controller → in-tx claim transition); trade initiation's false
declaration was removed; no production route uses `required: false`;
schema-validation 4xx released explicitly via `validate()`;
controller-level 4xx without an explicit mark retains the claim. The prior
A/B/C/D class table stands, with this tightening: no route anywhere can
release a claim on status alone.

### Remaining boundary (documented, tracked)

Crash-after-commit **same-key recovery** is complete only for wired routes
(convert; trade initiation is unwired and RETAIN-protected). Unwired class-B/D routes still refuse same-key
retries after a crash (409 IN_PROGRESS; never a second mutation) — the client
must use a new key after confirming operation state. Extending the wired
in-transaction pattern to the remaining endpoints is the follow-up wave
(section 7), now with withdrawal as the highest-priority candidate.


## 9. Follow-up 3 — merge cleanliness + literal byte-level replay fidelity (2026-09-26)

Reviewer verdict: core P0 fixed and independently verified; two
merge-cleanliness items plus one proof-tightening item. All executed.

### 9.1 — probe-r40.js removed

The unrelated ad-hoc database probe committed alongside `2d8ea9e` has no
package.json/CI reference and no production purpose; it is deleted, not
replaced.

### 9.2 — replay fidelity is now LITERALLY byte-identical

Tightening the T2 regression to assert serialized-string equality (not
just parsed-JSON structural equality) exposed a second real defect: the
claim stored `responseBody` in a **JSONB** column, and PostgreSQL JSONB
does not preserve object key order. Replays were JSON-equivalent but the
final HTTP bytes differed from the original response (jsonb canonical key
order). Fixes, end to end:

- `FinancialOperation.responseBody` is `TEXT` (schema + overlay installer,
  with an idempotent converging `ALTER` for any earlier PR-era JSONB
  install).
- The middleware captures `JSON.stringify(body)` — the exact wire bytes
  `res.json` would have produced (Prisma Decimal's `toJSON` serialization
  included).
- The committed replay re-emits those bytes exactly: `res.json(JSON.parse(stored))`
  round-trips to the identical string (JSON parse preserves key order).
- The wired in-transaction claim commit in `multiCurrencyController` stores
  the same wire-text form, so wired and post-response captures are
  byte-consistent.
- T2 asserts `replay.wire === winner.wire` — literal serialized-bytes
  equality — on top of the Decimal/string structural regression.

### 9.3 — response-boundary audit (review item 4): no bypass paths

Every production `idempotency()` mount (39, enumerated from the route
files) was traced to its handler and the handler body scanned for response
paths that bypass the middleware's wrapped `res.json` (`res.send`,
`res.end`, `res.sendStatus`, `res.sendFile`, `res.download`, `res.redirect`,
`res.write`). Result: **39/39 handlers respond exclusively through
`res.json`** — the wrapped bookkeeping path — so a claim can never be left
IN_PROGRESS by a bypassing response writer on these routes. The only
`res.send` users in the codebase (CSV export in `adminRbacController`,
PDF receipts in `receiptController`) sit on routes with **no idempotency
mount**, so no claim can strand there either. Availability/replay-contract
risk: none found; nothing left to fix or document per-route.

### 9.4 — PR description corrected

The PR body previously stated trade initiation commits the claim
in-transaction and is a wired `releaseOn4xx` route. Both statements are
false. The final truth, consistent with this document:

- `/api/multi-currency/convert` is the ONLY currently wired
  in-transaction FinancialOperation route (its `releaseOn4xx` declaration
  is backed by the in-tx claim transition).
- `/api/trades/initiate` is UNWIRED and uses conservative RETAIN
  semantics; it clears `res.locals.financialClaimRelease` immediately
  before its economic transaction (proven pre-economics guards may release
  earlier), and post-transaction/post-commit failures retain the claim —
  same-key retries receive 409.
- The independent route sweep found exactly **39 `idempotency()` mounts**
  in `routes/`, **0** production `required: false` mounts, and **1**
  `releaseOn4xx` declaration.
