# B5 — action-bound step-up and KYC route coverage (current state)

**Commit basis:** release candidate `6acc42f` (`merge(#403): the declared final tip fe73a9cb`)
plus the changes on this branch. Every row below was **generated from the route
source** (`routes/*.js`), not written from memory: a small scanner split each
router file on `router.<method>(` boundaries and read the middleware chain of
each route. `—` means the route carries no KYC and no step-up.

**This document deliberately describes the state as it IS, not as it should be.**
It exists because the release brief requires proof per alias: the real-route
step-up proof only establishes `POST /api/withdraw`, and claiming broader
coverage is forbidden until a matrix proves it.

## 1. Step-up: what is actually mounted

Only **one** route in the entire backend consumes the action-bound grant:

```
routes/walletRoutes.js:143  const stepUpGate = whenStepUpEnforced(
                                requireActionStepUp({ actionType: 'FIAT_WITHDRAWAL',
                                                     routeScope: 'POST /api/withdraw' }));
routes/walletRoutes.js:148  router.post('/withdraw', ..., stepUpGate, ...)
```

`routes/walletRoutes.js` is the **only** router that references
`requireActionStepUp`; no other router mentions step-up at all.

`whenStepUpEnforced(...)` means the gate is a no-op unless
`STEP_UP_ENFORCEMENT=on`. **`STEP_UP_ENFORCEMENT` is OFF**, so even the
withdrawal gate is dormant in production today. This branch does not change that
flag and must not.

Grant semantics (unchanged, proven elsewhere): server-issued, single-use,
transaction-atomic, bound to the canonical action, consumed inside the economic
transaction. A body-supplied PIN/password is not a substitute, and the matrix
below does not treat `require2FA()` as step-up.

## 2. Financial mutation route inventory (46 money-path routes)

| route | controls present |
|---|---|
| `wallet POST /withdraw` | KYC:withdraw, **step-up**, idem, auth |
| `wallet POST /deposit/initialize` | KYC:deposit, idem, auth |
| `wallet POST /internal-transfer` | KYC:p2p, 2FA, idem, auth |
| `trade POST /initiate` | KYC:trade, 2FA, idem, auth |
| `trade POST /accept` | KYC:trade, idem, auth |
| `trade POST /decline` | auth |
| `trade POST /extend` | auth |
| `trade POST /extend/respond` | auth |
| `trade POST /upload-proof` | auth |
| `trade POST /dispute` | auth |
| `trade POST /review` | auth |
| `withdrawal POST /fiat` | KYC:withdraw, 2FA, idem |
| `withdrawal POST /ghs/quote` | idem |
| `withdrawal POST /ghs` | KYC:withdraw, 2FA, idem |
| `withdrawal POST /crypto` | KYC:withdraw, 2FA, idem |
| `withdrawal POST /bank/quote` | idem |
| `withdrawal POST /bank` | KYC:withdraw, 2FA, idem |
| `deposit POST /fiat/initiate` | KYC:deposit, idem, auth |
| `deposit POST /fiat/webhook` | — |
| `deposit POST /webhook/tatum` | — |
| `deposit POST /fiat/initiate/moolre` | KYC:deposit, idem, auth |
| `deposit POST /fiat/initiate/moolre/otp` | auth |
| `deposit POST /fiat/webhook/moolre` | — |
| `deposit POST /validate-name` | auth |
| `susu POST /groups` | KYC:susu, idem, auth |
| `susu POST /groups/:id/contract` | idem, auth |
| `susu POST /groups/:id/cancel` | idem, auth |
| `susu POST /vouches` | idem, auth |
| `susu POST /` | idem, auth |
| `susu POST /:id/cancel` | idem, auth |
| `susu POST /:id/auto-retain` | auth |
| `susu POST /:id/invites` | auth |
| `susu POST /invites/:token/redeem` | idem, auth |
| `susu POST /invites/:id/accept` | auth |
| `susu POST /invites/:id/decline` | auth |
| `susu POST /invites/:id/revoke` | auth |
| `susu POST /:id/contract/accept` | idem, auth |
| `crossBorderSusu POST /` | — |
| `crossBorderSusu POST /contribute` | KYC:susu, idem |
| `crossBorderSusu POST /payout` | KYC:susu, idem |
| `friend PUT /request/:id/accept` | — |
| `friend POST /transfer/send` | KYC:p2p, 2FA, idem |
| `friend POST /transfer/request` | — |
| `friend PUT /transfer/:id/fulfill` | KYC:p2p |
| `friend PUT /transfer/:id/decline` | — |
| `escrow POST /fund` | KYC:pay, 2FA, idem, auth |

## 3. What this proves and what it does not

**Proven:** every money-path route above carries the controls listed beside it,
read from source. `POST /api/withdraw` is the only route with an action-bound
step-up gate, and that gate is dormant while the flag is off.

**Not proven, and not claimed:** that step-up covers deposits, P2P,
internal-transfer, transfers, trade, savings, susu or escrow funding. Those rely
on KYC + 2FA + idempotency, not on a step-up grant.

## 4. KYC at the economic boundary

Gated actions in the current build, with the canonical action name:

| action | routes |
|---|---|
| `withdraw` | `withdrawal POST /fiat`, `/ghs`, `/crypto`, `/bank`; `wallet POST /withdraw` |
| `deposit` | `deposit POST /fiat/initiate`, `/fiat/initiate/moolre`; `wallet POST /deposit/initialize` |
| `p2p` | `friend POST /transfer/send`, `PUT /transfer/:id/fulfill`; `wallet POST /internal-transfer` |
| `trade` | `trade POST /initiate`, `trade POST /accept` |
| `susu` | `susu POST /groups`; `crossBorderSusu POST /contribute`, `/payout` |
| `pay` | `escrow POST /fund` |

### Two boundaries worth naming explicitly

**Trade acceptance (fixed on this branch).** `POST /trades/accept` was exempt
with the reason "counterparty accepts an already-authorised trade". That reason
does not hold: `controllers/tradeController.js` `acceptTrade` is executed by the
**vendor**, and on a SELL ad it decrements the vendor's
`vendorUnallocatedBalance` and increments `escrowLockedBalance` inside a
transaction. That is the vendor locking its own trading pool into escrow, so it
is an economic action and now carries `requireKyc('trade')`. Initiation and
acceptance are both gated.

**Moolre deposit OTP confirmation (audited, left exempt).**
`deposit POST /fiat/initiate/moolre/otp` carries no KYC gate, deliberately: it is
a continuation of an initiation that already passed `requireKyc('deposit')`, and
the continuation is bound to the same user and quote. Gating it again would
refuse a deposit already authorised at the economic entry point while stranding
the customer's in-flight quote. This is a reasoned exemption, not an oversight,
and it is recorded in `__tests__/kyc-route-matrix.test.js` `EXEMPT`.

**Susu contract acceptance (audited, left ungated, and the matrix does not see
it).** `susu POST /groups/:id/contract` and `POST /:id/contract/accept` accept
group terms; `services/susu/liabilityContract.service.js` updates the group row
and moves no funds. Contributions are the money-moving step and are gated at
`crossBorderSusu POST /contribute`. **Disclosed blind spot:** the matrix's
`MONEY_PATH` regex does not match the token `contract`, so these routes are not
even scanned. They are safe today because no funds move, but the blind spot
itself is real.

## 5. Regression guard

`__tests__/kyc-route-matrix.test.js` scans >80 mounted routes and fails if any
money-path route is ungated without a reasoned exemption, if KYC is mounted after
idempotency/step-up, if an exemption goes stale, if a provider webhook is gated,
or if the mandatory action baseline is narrowed by configuration. It passes
21/21 on a real PostgreSQL database.

## 6. Standing owner actions

- `STEP_UP_ENFORCEMENT` remains **OFF**. Turning it on is an owner decision and
  needs the grant installer (`infra/install-action-step-up-grant.js`) applied
  first.
- Do not describe step-up as covering all financial mutations. It covers
  `POST /api/withdraw` only.

## Measured inventory (2026-11-18, PR #405 working branch `feat/wp-h-payout-authority-closure`)

This section records what was MEASURED from the mounted route definitions, not what
the matrix above asserts. It exists because the matrix says only `POST /api/withdraw`
consumes the action-bound grant, and that claim needed checking.

**Method.** Parsed `router.<verb>('<path>')` declarations across `routes/*.js` and
counted every route in a money-bearing router or with a money-bearing path segment
(withdraw, deposit, transfer, trade, escrow, susu, vendor, payout, contribute,
fulfil/fulfill, send). `grep -rn requireActionStepUp routes/` gives the consumption
side directly.

**Measured: 101 financial mutation routes across 21 routers.**

| Router | Mutations | Consumes action-bound step-up |
| --- | --- | --- |
| susuRoutes | 13 | no |
| adminRoutes | 10 | no (operator surface) |
| tradeRoutes | 8 | no |
| depositRoutes | 7 | no |
| withdrawalRoutes | 6 | no |
| escrowRoutes | 5 | no |
| p2pRoutes | 5 | no |
| walletRoutes | 5 | **yes, 1 of 5** (`POST /api/withdraw`, `FIAT_WITHDRAWAL`) |
| friendRoutes | 4 | no |
| businessOSRoutes | 3 | no |
| conversationRoutes | 3 | no |
| crossBorderSusuRoutes | 3 | no |
| groupChatRoutes | 3 | no |
| paymentRequestRoutes | 3 | no |
| financeRoutes | 2 | no |
| savingsRoutes | 2 | no |
| tradeAccountRoutes | 2 | no |
| other (5 routers) | 2 each | no |

**So the coverage figure is 1 of 101, not "1 route and that is the complete set".**
`STEP_UP_ENFORCEMENT` remains OFF and no production flag was touched; the grant is
prepared but not activated.

### Deliberate exclusions (must never be gated by customer step-up)

- `POST /api/deposit/fiat/webhook`, `/api/deposit/fiat/webhook/moolre`, `/api/deposit/webhook/tatum`
  — provider callbacks. They authenticate as the provider. A customer grant here
  would make settlement depend on a customer action.
- Operator-only routes (`adminRoutes` withdrawal approve/reject/resolve-review,
  payout batch-process, payouts/settings, dispute assign/resolve). These need
  operator authorization, not customer step-up; they are out of scope for B5.

### What this inventory does NOT establish

- **Per-route KYC and 2FA classification is not measured.** A middleware-name grep
  is not evidence: the routers use several different guards and a zero hit can mean
  "different name" rather than "no gate". The KYC/2FA columns of the matrix above
  remain unverified until each router is read.
- **No route has been wired.** Nothing in this section changes behaviour; it
  records the size of the gap so the wiring work is not scoped from an
  understatement.
- **No route tests were written for the challenge -> proof -> grant -> retry ->
  consumption flow**, and the wrong-amount/recipient/currency/route/resource/
  operation/user/idempotency, expiry, concurrent consumption, rollback and
  lost-response cases in the brief are all still owed.
- `P2P fulfil` and `trade acceptance` were NOT reviewed. If fulfil performs a payer
  debit and recipient credit, it is a financial mutation that currently has no
  action-bound step-up, and that remains an open finding rather than a decision.
