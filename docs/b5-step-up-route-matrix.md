# B5 — action-bound step-up and KYC route coverage (current state)

**Generated from source** by `node scripts/step-up-route-inventory.js --write-doc`
(`scripts/step-up-route-inventory.js` is the single source of truth; the static
guard `__tests__/b5-step-up-route-coverage.test.js` imports the same module).
Do not hand-edit this file — regenerate it.

**This document describes the state as it IS, not as it should be.** Scope is
every mutation route (POST/PUT/PATCH/DELETE) in `routes/*.js` whose path
matches a money term, plus an explicit list of value-moving routes whose paths
carry no money term (`/ghs`, `/fiat`, `/initiate`, `/satisfy`, `/pay`…).

**Measured population: 135 in-scope routes.**

| class | count | meaning |
|---|---|---|
| GATED | 7 | carries `whenStepUpEnforced(requireActionStepUp(...))` |
| CUSTOMER_GAP | 30 | moves customer value, no gate — recorded gap, may only shrink |
| CUSTOMER_EXEMPT | 3 | moves value; step-up not required, economic reason recorded |
| BUSINESS | 11 | KYB-scoped business operator on their own business |
| OPERATOR | 20 | admin/operator action — separate operator authorisation, never customer step-up |
| NON_VALUE | 60 | matches a money term, moves no value |
| WEBHOOK | 4 | provider callback; never customer-gated |

`whenStepUpEnforced(...)` is a no-op unless `STEP_UP_ENFORCEMENT=on`.
**`STEP_UP_ENFORCEMENT` is OFF**, so every gate below is dormant in production
today. This document does not change that flag and must not.

## 1. Gated today (7)

| route | action |
|---|---|
| `escrow POST /fund` | ESCROW_FUND |
| `escrow POST /satisfy` | ESCROW_RELEASE |
| `p2p POST /complete` | P2P_TRADE_COMPLETE |
| `trade POST /accept` | TRADE_ACCEPT |
| `trade POST /initiate` | TRADE_INITIATE |
| `wallet POST /internal-transfer` | INTERNAL_TRANSFER |
| `wallet POST /withdraw` | FIAT_WITHDRAWAL — the proven end-to-end path |

Only the withdrawal path has a real end-to-end route proof (challenge → proof →
grant → exact retry → transaction consumption). The other gates are wired and
covered by the static guard and unit-level action binding; they are NOT proven
end-to-end by that withdrawal test, and this document does not claim they are.

## 2. Recorded customer coverage gaps (30)

Genuinely value-moving customer routes with no action-bound step-up. This list
is frozen by the guard: it may only shrink, and every entry carries the
economic reason it is still open.

| route | why it is a gap |
|---|---|
| `azmConversion POST /` | AZM→USDC conversion; idempotent, no action-bound step-up |
| `azmGift POST /send` | AZM gift to another user; idempotent, no action-bound step-up |
| `businessOS POST /ewa/withdraw` | EWA payout to an employee; no action-bound step-up |
| `businessOS POST /finance/payout` | business payout; no action-bound step-up |
| `businessOS POST /orders/:id/refund` | order refund moves funds back; no action-bound step-up |
| `business POST /invoices/:invoiceId/pay` | customer pays a business invoice; KYC(pay) gated, no action-bound step-up |
| `conversation POST /:conversationId/messages/:messageId/fund-escrow` | funds escrow from a conversation; no action-bound step-up |
| `conversation POST /:conversationId/messages/:messageId/release-escrow` | releases escrow from a conversation; no action-bound step-up |
| `crossBorderSusu POST /contribute` | cross-border susu contribution; KYC + idempotent, no action-bound step-up |
| `crossBorderSusu POST /payout` | cross-border susu payout; KYC + idempotent, no action-bound step-up |
| `deposit POST /fiat/initiate` | initiates a fiat deposit; KYC + idempotent, no action-bound step-up |
| `deposit POST /fiat/initiate/moolre` | initiates a Moolre deposit; KYC + idempotent, no action-bound step-up |
| `dineIn POST /tabs/:tabId/pay` | customer pays a dine-in tab; KYC(pay) + 2FA, no action-bound step-up |
| `finance POST /withdraw/fiat` | legacy finance fiat withdrawal; KYC + 2FA + idempotent, no action-bound step-up |
| `friend PUT /transfer/:id/fulfill` | fulfils a peer transfer request and moves funds; KYC gated, no step-up |
| `friend POST /transfer/send` | peer transfer of funds; KYC + 2FA + idempotent, no action-bound step-up |
| `multiCurrency POST /convert` | currency conversion; idempotent, no action-bound step-up |
| `orderBook POST /orders` | places an order and reserves balance; idempotent, no action-bound step-up |
| `savings POST /goals/:id/deposit` | savings deposit; fresh-rate + idempotent, no action-bound step-up |
| `savings POST /goals/:id/withdraw` | savings withdrawal; 2FA + fresh-rate + idempotent, no action-bound step-up |
| `sharedVault POST /:id/deposit` | shared-vault deposit; idempotent, no action-bound step-up |
| `storefrontCheckoutIntegrity POST /:businessProfileId/order` | storefront checkout (integrity variant); no action-bound step-up |
| `storefront POST /:businessProfileId/order` | storefront checkout; no action-bound step-up |
| `vault POST /:id/break` | early vault break; 2FA + idempotent, no action-bound step-up |
| `vault POST /:id/deposit` | vault deposit; idempotent, no action-bound step-up |
| `wallet POST /deposit/initialize` | initiates a deposit; KYC + idempotent, no action-bound step-up |
| `withdrawal POST /bank` | bank payout; KYC + 2FA + idempotent, no action-bound step-up |
| `withdrawal POST /crypto` | crypto withdrawal; KYC + 2FA + idempotent, no action-bound step-up |
| `withdrawal POST /fiat` | legacy fiat withdrawal; KYC + 2FA + idempotent, no action-bound step-up |
| `withdrawal POST /ghs` | native-GHS withdrawal; KYC + 2FA + idempotent, no action-bound step-up |

## 3. Customer-exempt (3)

| route | economic reason step-up is not required |
|---|---|
| `azm POST /spend/ad-boost` | spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists |
| `azm POST /spend/card-skin/purchase` | spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists |
| `azm POST /spend/fee-discount` | spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists, so the economic loss is bounded to the reward balance |

## 4. Business-operator routes (11)

KYB-scoped business operators acting on their own business; membership and KYB
are the boundary, not customer step-up.

| route | reason |
|---|---|
| `businessOSInventory POST /restaurant/inventory/:id/restock` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOSInventory POST /restaurant/inventory/restock-intents` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOSInventory POST /restaurant/inventory/restock-intents/:id/ack` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOSInventory POST /restaurant/inventory/restock-intents/:id/cancel` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOSPos POST /pos/order` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOS POST /payroll/disburse` | disburses the operator's own business payroll (payroll.disburse permission) |
| `businessOS POST /payroll/process` | runs a payroll batch for the operator's own business (payroll.process permission) |
| `businessOS POST /pos/cash-close-tab` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOS POST /pos/cash-sale` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOS POST /retail/purchase-orders` | KYB-scoped business operator acting on their own business; membership + KYB gated |
| `businessOS PATCH /retail/purchase-orders/:id` | KYB-scoped business operator acting on their own business; membership + KYB gated |

## 5. Operator routes (20)

Admin/operator actions. The brief forbids customer step-up here; these need
separate operator authorisation.

| route | reason |
|---|---|
| `adminChat POST /intervene/:tradeId` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `adminControlPlane POST /staff/:id/suspend` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `adminControlPlaneSummary POST /disputes/:escrowId/assign` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `adminControlPlaneSummary POST /disputes/:escrowId/resolve` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin DELETE /ad-posts/:id` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /businesses/:bizId/suspend` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /businesses/:bizId/unsuspend` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /disputes/:tradeId/resolve` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /escrow-disputes/:id/assign` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /escrow-disputes/:id/resolve` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /fee-profiles` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin PUT /fee-profiles/:id` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin DELETE /fee-profiles/:id` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /payouts/batch-process` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin PUT /payouts/settings` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /trade-accounts/:id/approve` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /trade-accounts/:id/reject` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /withdrawals/:id/approve` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /withdrawals/:id/reject` | operator/admin action — needs separate operator authorisation, never customer step-up |
| `admin POST /withdrawals/:id/resolve-review` | operator/admin action — needs separate operator authorisation, never customer step-up |

## 6. Non-value matches (60)

| route | reason |
|---|---|
| `azm POST /spend/card-skin/equip` | equips an owned cosmetic; no balance change |
| `bills POST /saved-accounts` | saves a bill account record; no funds move |
| `businessDirectMessage POST /send` | does not move value |
| `businessOS POST /employees/my-ewa-request` | creates an EWA request record; the payout is POST /ewa/withdraw |
| `businessOS POST /employees/shifts/:shiftId/request-swap` | does not move value |
| `businessOS POST /feedback` | does not move value |
| `businessOS POST /messages/:conversationId/send` | does not move value |
| `businessOS POST /orders/bulk-status` | does not move value |
| `businessOS POST /reservations/:id/propose-reschedule` | does not move value |
| `businessOS POST /restaurant/inventory` | does not move value |
| `businessOS PATCH /restaurant/inventory/:id` | does not move value |
| `businessOS POST /restaurant/inventory/deduct/:orderId` | does not move value |
| `businessOS PATCH /restaurant/sections/reorder` | does not move value |
| `businessOS PATCH /restaurant/tables/:id/metadata` | does not move value |
| `businessOS PATCH /retail/products/:id/barcode` | does not move value |
| `businessOS POST /retail/stock-counts` | does not move value |
| `businessOS PATCH /retail/stock-counts/:id/items/:itemId` | does not move value |
| `businessOS POST /retail/stock-counts/:id/reconcile` | does not move value |
| `businessOS POST /retail/suppliers` | does not move value |
| `businessOS PATCH /retail/suppliers/:id` | does not move value |
| `businessOS DELETE /retail/suppliers/:id` | does not move value |
| `business POST /invoices/:invoiceId/send` | does not move value |
| `business PATCH /orders/:orderId/delivered` | does not move value |
| `chat POST /send` | does not move value |
| `chatUploadRoutesExtended.js POST /vendor-docs` | file upload |
| `conversation POST /:conversationId/messages/:messageId/dispute-escrow` | flags a dispute; no balance change |
| `deposit POST /fiat/initiate/moolre/otp` | OTP confirmation for the initiate above |
| `deposit POST /validate-name` | name validation |
| `friend POST /request` | does not move value |
| `friend PUT /request/:id/accept` | does not move value |
| `friend PUT /request/:id/reject` | does not move value |
| `friend PUT /transfer/:id/decline` | does not move value |
| `friend POST /transfer/request` | creates a request record; funds move only at fulfil |
| `groupChat POST /:id/join-requests` | does not move value |
| `groupChat POST /:id/join-requests/:reqId/approve` | does not move value |
| `groupChat POST /:id/join-requests/:reqId/reject` | does not move value |
| `groupChat POST /:id/susu/cancel` | does not move value |
| `groupChat POST /:id/susu/initiate` | starts a susu cycle; contributions are scheduler-driven |
| `groupChat POST /:id/susu/vouch` | does not move value |
| `notification POST /trigger/deposit-success` | notification trigger |
| `notification POST /trigger/trade-started` | notification trigger |
| `orderBook DELETE /orders/:id` | cancels an order and releases its own reservation |
| `orderTracking PUT /:orderId/tracking/eta` | does not move value |
| `orderTracking PUT /:orderId/tracking/location` | does not move value |
| `orderTracking POST /:orderId/tracking/status` | does not move value |
| `p2p POST /overpayment` | dispute marking |
| `p2p POST /underpayment` | dispute marking |
| `paymentRequest POST /` | creates a request record; no funds move until the payer pays |
| `reservation POST /:id/counter-propose` | does not move value |
| `savedMomo POST /` | saves a payout destination record; no funds move |
| `security POST /app-unlock/sms/send` | sends an app-unlock OTP challenge; no value moves |
| `security POST /phone/send-otp` | sends an OTP challenge; no value moves |
| `showcase POST /reorder` | does not move value |
| `susu POST /:id/contract/accept` | accepts a contract |
| `susu POST /groups` | creates a susu group record |
| `susu POST /groups/:id/cancel` | does not move value |
| `susu POST /groups/:id/contract` | accepts a contract; contributions are scheduler-driven |
| `walletPass POST /vault/:vaultId` | generates a pass; no balance change |
| `withdrawal POST /bank/quote` | returns an indicative quote; no value moves |
| `withdrawal POST /ghs/quote` | returns an indicative quote; no value moves |

## 7. Provider webhooks (4)

Settlement must never depend on a customer action.

| route | reason |
|---|---|
| `deposit POST /fiat/webhook` | provider deposit callback |
| `deposit POST /fiat/webhook/moolre` | provider deposit callback |
| `deposit POST /webhook/tatum` | provider crypto callback |
| `finance POST /webhook/deposit` | provider deposit callback; settlement must not depend on a customer action |

## 8. What the guard enforces

1. Every in-scope route has exactly one classification; a NEW money route fails
   the build until it is gated or explicitly exempted with a reason.
2. Every recorded gate is still present, and every gate sits behind
   `whenStepUpEnforced(...)` so wiring cannot activate enforcement by accident.
3. The CUSTOMER_GAP population matches the frozen list exactly — it cannot grow.
4. Provider webhooks are never gated.
