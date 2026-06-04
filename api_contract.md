# Azaman V2 — API Contract

> **This document is the canonical contract.** It supersedes every prior
> version. If any code in this repo disagrees with what is written here, the
> code is wrong. Open a PR.
>
> See `AZAMAN_MASTER_SOUL.md` for the architectural rules that this contract
> implements.

## Conventions

- **Base URL**: `http://localhost:3000/api`
- **Auth**: `Authorization: Bearer <jwt>` on protected routes.
- **Content-Type**: `application/json` (multipart where noted).
- **Envelope**:
  - Success: `{ "success": true, "message": "...", "data": { ... } }`
  - Error:   `{ "success": false, "code": "...", "message": "..." }`
- **Currencies**: Internal balances are USDC. GHS values displayed to users
  are computed as `availableBalance × GlobalSettings.liveUsdToGhs` ("the
  Hologram"). The backend never persists GHS as a balance.
- **Idempotency**: All financial mutations are wrapped in
  `prisma.$transaction`. Webhook endpoints are idempotent by `txHash` /
  `reference`.

## Phase A reconciliation — what changed

| Change | Status | Replacement |
| --- | --- | --- |
| `POST /trades/release` | **REMOVED** | `POST /p2p/complete` |
| `POST /deposit/transfer` | **REMOVED** | `POST /chat/transfer` |
| Socket event `vendor_release_crypto` | **REMOVED** | `POST /p2p/complete` |
| `POST /deposit/fiat` (auto-credit) | **REMOVED** | `POST /deposit/fiat/initiate` + `POST /deposit/fiat/webhook` |
| `User.lockedBalance` mutated on initiate / release | **REMOVED** | `User.escrowLockedBalance` (V2 ledger split) |
| `User.lockedBalance` column itself | **DROPPED** (Phase J, 2026-05-25) | Field deleted from schema. Active V2 escrow lives in `escrowLockedBalance`. |
| `User.ghsBalance` column | **DROPPED** (Phase J, 2026-05-25) | Hologram model derives GHS = `availableBalance × yellowCardRate` on read. No persistent fiat bucket. |
| Inline `setInterval` auto-cancel in `server.js` | **REMOVED** | `workers/tradeWorker.js` (canonical owner) |
| `warRoomController.systemLedger` references | **REMOVED** | `SystemMasterCrypto`, `SystemHotWallet`, `SystemFiatPool`, `SystemProfitFees` (V2 singletons) |
| `markAsPaid` writing legacy `Message.text` / `imagePath` fields | **REMOVED** | V2 `Conversation` + `Message.{conversationId, messageType: IMAGE_PROOF, content}` |

Banned-user enforcement: every protected write route is now wrapped in the
**ban guard** (`middleware/banGuardMiddleware.js`). Banned users retain
read-only access (`GET` requests pass through). Any non-`GET` request from a
non-`ACTIVE` user returns `403 ACCOUNT_RESTRICTED` with `banStatus`,
`banUntil`, and `appealEmail` in the body.

---

## Coverage gaps — closed in Phase L (2026-05-25)

This contract was bootstrapped during Phase A and intentionally narrow.
Phase B flagged 9 route trees as "implementation precedes spec" — they
existed in `routes/` and were reachable, but were not yet documented here.
**Phase L closes that gap.** The full set is now documented below:
`/api/friends/*`, `/api/savings/*`, `/api/security/*`, `/api/users/*`,
`/api/auth/sso`, `/api/ai/*`, `/api/kyc/*`, `/api/vendor/*`,
`/api/oracle/*`.

**Going-forward convention.** When you change a route signature in any
PR, write the change into this file in the **same** PR. The contract
is the source of truth — code that disagrees with it is by definition
wrong.

Phase B audit (2026-05) verified the live behaviour matched the contract
for every section that was already written; Phase L was a pure documentation
catch-up against live code (no behaviour change). The original "Coverage
gaps" table is preserved in PR #34's history.

---

## Authentication — `/auth`

### `POST /auth/register`
Body: `{ username, email, password }`. Returns `201` with the new user's
public profile.

### `POST /auth/login`
Body: `{ email, password }`. Returns `{ token, user }`.

### `GET /auth/settings/rates` (public)
Returns the live oracle rates: `{ liveUsdToGhs, bankMargin, thirdPartyMargin }`.

### `GET /auth/me/:id` (auth)
Returns the authenticated user's full balance shape: `availableBalance`,
`vendorUnallocatedBalance`, `escrowLockedBalance`, `disputeEscrowBalance`,
`azmBalance`, plus profile fields.

> **Phase J (2026-05-25):** `lockedBalance` and `ghsBalance` were dropped
> from the User schema. They are no longer present on this response.
> Pre-Phase-J clients that read those keys will get `undefined` and should
> either upgrade or fall back to `availableBalance` for spendable USDC and
> the live yellow-card rate × `availableBalance` for the GHS hologram.

### `PUT /auth/fcm-token` (auth)
Body: `{ fcmToken }`. Persists the FCM token used by `pushIfOffline`.

### `POST /auth/sso` (public) — Federated sign-in (Google / Apple)
Body: `{ idToken, provider, referredByCode? }` where
`provider ∈ {'google', 'apple'}` and `idToken` is a Firebase ID token
obtained client-side via the Firebase Auth SDK.

**Flow.** Backend verifies the Firebase ID token (via
`firebase-admin.auth().verifyIdToken`), extracts `email`, `name`,
`picture`. If the user exists (matched by `googleId` / `appleId`,
falling back to email), updates `lastLoginAt`, links the provider ID
if not already linked, and increments the login streak. If not found,
auto-registers a new user with a generated username
(`<FirstName>_<4-hex>`) and applies the optional referral code.
Returns the standard `{ token, user }` envelope plus an `isNewUser`
boolean. Status `201` for new accounts, `200` for existing.

**Refusals.**
- `400` if `idToken` or `provider` missing / invalid.
- `400` if `email` is not present in the verified token claims.
- `401` if the Firebase token is invalid or expired.
- `409 P2002` on a race-condition double-tap (the second call sees
  the unique-constraint conflict and is told to use email login).
- `503` if `firebase-admin` is not initialised on the server.

**Dev fallback.** When `process.env.NODE_ENV !== 'production'` and
`firebase-admin` is not initialised, the controller decodes the token
**without** signature verification (UNSAFE — dev only) so local
end-to-end tests can run without service-account credentials.

---

## Marketplace ads — `/ads`

### `GET /ads/active` (public)
Query params: `type`, `crypto`, `amount`, `preferredPayment`. Returns the
marketplace feed with vendor reputation summary.

### `GET /ads/mine` (auth, read-only)
Vendor's own ads. Available to banned users.

### `POST /ads/create` (auth + ban guard)
Body: `{ type, crypto, pricePerUSD, margin, minLimit, maxLimit, paymentMethod, terms?, maxConcurrentTrades?, activeHoursStart?, activeHoursEnd? }`.

### `PUT /ads/:id/toggle` (auth + ban guard)
Flip ad status `ACTIVE` ↔ `OFFLINE`.

### `PUT /ads/:id/deactivate` (auth + ban guard)
Hard-deactivate an ad.

---

## P2P — `/p2p`  *(canonical V2 path)*

### `POST /p2p/ping` (auth + ban guard)
Body: `{ tradeId }`. Buyer pings vendor when
`vendorUnallocatedBalance < trade.amountCrypto`. Creates a 5-minute
`VENDOR_PRIORITY` notification with `actionPayload.action = 'PING_TOPUP'`.

### `POST /p2p/ping/accept` (auth + ban guard)
Body: `{ tradeId, topUpAmount }`. Atomically moves `topUpAmount` from
`availableBalance` → `vendorUnallocatedBalance`.

### `POST /p2p/underpayment` (auth + ban guard, vendor or admin)
Body: `{ tradeId, paidAmountFiat, intentional? }`. Releases the paid
fraction to the buyer, refunds the unpaid fraction to the vendor's
`availableBalance`. If `intentional === true`, applies a strike to the
buyer; the third strike triggers `BANNED_INDEF`.

### `POST /p2p/overpayment` (auth + ban guard, buyer)
Body: `{ tradeId, overpaidAmountUsdc }`. Drains the disputed amount from
the vendor (`vendorUnallocatedBalance` first, then `availableBalance`) into
`disputeEscrowBalance`. Trade transitions to `DISPUTED`.

### `POST /p2p/complete` (auth + ban guard) — **single source of truth**
Body: `{ tradeId }`. Releases assets with the V2 tiered margin split:

- `< $1,000 USDC` → 60% admin / 40% vendor
- `≥ $1,000 USDC` → 50% admin / 50% vendor

Admin cut is credited to `SystemProfitFees` and recorded in
`AdminProfitLog (source = 'P2P_MARGIN')`. Returns the buyer credit, vendor
cut, admin cut, and split breakdown.

---

## Trades — `/trades`

### `GET /trades/history` (auth, read-only)
The caller's trade history.

### `GET /trades/:id` (auth, read-only)
Returns full trade details including the V2 conversation messages.

### `POST /trades/initiate` (auth + ban guard)
Body: `{ adId, amountCrypto, amountFiat, paymentMethod }`. Smart-Queue
gated: if the ad is at `maxConcurrentTrades`, the request returns `202`
with a `TradeQueue` entry instead of creating the trade. On a normal
trade, vendor liquidity moves `availableBalance` →
`escrowLockedBalance` (V2 ledger).

### `POST /trades/upload-proof` (auth + ban guard, multipart)
Form: `tradeId`, `proof` (image). Buyer uploads payment proof. Trade →
`PAID`. Writes two messages in the V2 conversation:
`IMAGE_PROOF` (content = proof URL) and `SYSTEM_URGENCY` (content =
verification notice).

### `POST /trades/dispute` (auth + ban guard)
Body: `{ tradeId, reason }`. Trade → `DISPUTED`, broadcasts to all admins.

### `POST /trades/review` (auth + ban guard)
Body: `{ tradeId, isPositive, comment? }`. One review per (trade, reviewer).

> **Removed:** `POST /trades/release`. Use `POST /p2p/complete`.

---

## Finance — `/finance`

### `POST /finance/withdraw/fiat` (auth + ban guard)
Body: `{ amount, recipientPhone, network, accountName? }` where
`network ∈ {MTN, VODAFONE, AIRTELTIGO}` (advisory; the MTN MoMo
Disbursement API is the dispatch channel for all networks). Runs the
**Double-Check** ledger audit (`Sum(In) - Sum(Out) === availableBalance`).
On success, atomically:

- Debits `availableBalance` by `amount + 2 % exit fee`.
- Splits the 2 % exit fee: 1 % to the influencer (when `referredByCode`
  matches an `influencerCode`) + 1 % to `SystemProfitFees`; full 2 % to
  `SystemProfitFees` otherwise.
- **ARBITRAGE CAPTURE** — credits `amount` (the 98 % net principal) to
  `SystemMasterCrypto`. Azaman now permanently retains this USDC and
  liquidates it later at the OTC premium (§1 / §4 of
  `AZAMAN_MASTER_SOUL.md`). An `AdminProfitLog (source =
  'ARBITRAGE_SPREAD')` row records the capture.
- Debits `SystemFiatPool` by `amount` (the GHS being paid out to the user).
- Writes `TransactionHistory(WITHDRAWAL_FIAT, COMPLETED, txHash =
  X-Reference-Id)`.

Outside the DB transaction the controller dispatches the GHS to the
user's MoMo wallet via the MTN MoMo Disbursement API
(`mtnDisbursementService.initiateTransfer`) using a UUID v4 as the
`X-Reference-Id` idempotency key. If MTN rejects the call (sync error or
async webhook = `FAILED`), the controller invokes
`reverseFiatWithdrawal`, which unwinds **all** of the above — including
the SystemMasterCrypto capture — and returns `502
MTN_DISBURSEMENT_REJECTED` with the reversal details. Returns
`data.fiatPoolLow = true` when the pool falls below the alert threshold.

Response (success) shape:

```
{
  "success": true,
  "message": "Fiat withdrawal of 100 USDC accepted. Exit fee: 2 USDC. 100 USDC captured to SystemMasterCrypto. MTN MoMo status: PENDING.",
  "data": {
    "reference":          "<uuid-v4>",
    "withdrawalAmount":   100,
    "exitFee":            2,
    "totalDeducted":      102,
    "retailRate":         12.45,
    "payoutGhs":          1245.00,
    "feeSplit":           { "referrerId": 17, "referrerShare": 1, "systemShare": 1 },
    "newBalance":         898.00,
    "systemFiatPool":     ...,
    "systemProfitFees":   ...,
    "systemMasterCrypto": ...,
    "arbitrageCapture":   100,
    "fiatPoolLow":        false,
    "fiatPoolBalance":    ...,
    "transaction":        { "id": ..., "status": "COMPLETED", "txHash": "<uuid-v4>" },
    "disbursement": {
      "provider":       "MTN_MOMO_DISBURSEMENT",
      "referenceId":    "<uuid-v4>",
      "externalId":     "AZAMAN_<userId>_<ts>",
      "status":         "PENDING",
      "amountGhs":      1245.00,
      "recipientPhone": "233XXXXXXXXX",
      "network":        "MTN",
      "source":         "MOCK"
    }
  }
}
```

### `POST /finance/admin/liquidate-profits` (auth + ban guard + admin)
Body: `{ amountUsdc }`. Atomically moves USDC from `SystemProfitFees` →
`SystemFiatPool`. Writes an `AdminProfitLog` entry with
`source = 'ARBITRAGE_SPREAD'`.

### `POST /finance/webhook/deposit` (no auth, idempotent)
Body: `{ amount, txHash, address?, userId }`. Crypto deposit listener
(Tatum / Alchemy). Idempotent on `txHash`. Credits user, debits master
crypto and hot wallet, writes `TransactionHistory(DEPOSIT_CRYPTO)`.

### `POST /finance/webhook/mtn-disbursement` (no auth, **shared-secret guarded**) — *Phase B v2*
Header: `X-Mtn-Webhook-Secret: <MTN_WEBHOOK_SECRET>`.
Body (accepts either MTN's native shape or our normalized shape):
`{ reference | referenceId, status: 'SUCCESSFUL'|'FAILED'|'PENDING', providerTxId? | financialTransactionId?, message? | reason? }`.

Settlement webhook for the MTN MoMo Disbursement API. Idempotent —
`SUCCESSFUL` (or legacy `SUCCESS`) on a `COMPLETED` row is a no-op (the
GHS just landed in the user's MoMo wallet); `PENDING` is acknowledged
with `200` and no ledger mutation; `FAILED` triggers an atomic reversal
via `finance.service.reverseFiatWithdrawal` which:

1. Re-credits the user (`amount + exitFee`).
2. Unwinds the influencer split.
3. **Decrements `SystemMasterCrypto`** by `amount` (the captured USDC
   never actually became Azaman's because the user is being refunded).
4. Re-credits `SystemFiatPool` by `amount`.
5. Marks the `TransactionHistory` row `FAILED`.
6. Writes negative-amount `AdminProfitLog` rows (one `EXIT_FEE`, one
   `ARBITRAGE_SPREAD`, both with `isSubsidized = true`).

Refuses to mutate if `MTN_WEBHOOK_SECRET` is unset (503).

### `GET /finance/fiat-pool-status` (public, read-only) — *Phase B*
Returns the live `SystemFiatPool` balance with a tier classification
(`HEALTHY` ≥ threshold, `LIMITED` ≥ ½ × threshold, `CRITICAL` below).
The frontend uses this to render the "limited fiat" tag in the withdraw
sheet before the user submits.

```
{
  "success": true,
  "data": {
    "balance":    4520.30,
    "threshold":  5000,
    "status":     "LIMITED",
    "lastUpdate": "2026-..."
  }
}
```

### `POST /finance/withdraw/fiat` (Phase B body extension)
The fiat withdrawal endpoint now requires Kotani Pay V3 dispatch metadata
in addition to the amount:

```
{ "amount": 100, "recipientPhone": "0541234567", "network": "MTN", "accountName": "..." }
```

`network ∈ {MTN, VODAFONE, AIRTELTIGO}`. The 2 % exit fee + 1 %/1 %
influencer split semantics are unchanged. On a successful debit, the
controller dispatches the payout to Kotani; if the gateway rejects the
call, the controller invokes `reverseFiatWithdrawal` and returns
`502 GATEWAY_REJECTED` with the reversal details.

---

## Deposits — `/deposit`

### `POST /deposit/fiat/initiate` (auth + ban guard) — *new*
Body: `{ amountGhs, provider }` where `provider ∈ {MTN_MOMO,
VODAFONE_CASH, AIRTELTIGO, BANK_TRANSFER}`. Creates a `PENDING`
`TransactionHistory` row using a unique `reference` as the idempotency
key. Returns the reference and human-readable instructions for the user.

### `POST /deposit/fiat/webhook` (no auth, **shared-secret guarded**) — *new*
Header: `X-Azaman-Webhook-Secret: <FIAT_WEBHOOK_SECRET>`.
Body: `{ reference, amountGhs, providerTxId?, status? }`. Idempotent — a
duplicate `reference` is a no-op. On the first call: re-quotes at the
**live** `liveUsdToGhs`, credits `availableBalance`, transitions
`TransactionHistory.status` → `COMPLETED`, emits `deposit_success`. If
`status !== 'SUCCESS'`, the row is marked `FAILED`. **Refuses to credit if
`FIAT_WEBHOOK_SECRET` is not set on the server.**

### `POST /deposit/webhook/tatum` (no auth, **HMAC-guarded**) — *Phase C*
Header: `x-payload-hash: <HMAC-SHA512 of body using TATUM_WEBHOOK_SECRET>`.
Body (Tatum ADDRESS_TRANSACTION shape):
`{ address, txId, amount, asset, chain, blockNumber?, ... }`.
Also accepts legacy shape: `{ address, txHash, amount, userId }`.

Polygon (MATIC) crypto deposit webhook listener. When USDC lands on a
user's derived HD wallet address:

1. Verifies the HMAC-SHA512 signature against `TATUM_WEBHOOK_SECRET`.
2. Looks up the user by `address` → `User.tatumPolygonAddress`.
3. Inside `prisma.$transaction`:
   - Credits `user.availableBalance` by `amount`.
   - Credits `SystemMasterCrypto` (swept funds land in treasury).
   - Credits `SystemHotWallet` (on-chain hot wallet balance).
   - Writes `TransactionHistory(DEPOSIT_CRYPTO, COMPLETED, txHash)`.
   - Writes a notification.
4. Emits `deposit_success` via Socket.io.

Idempotent on `txId`/`txHash`. Non-USDC assets are silently acknowledged
(200) with `ignored: true`. Unmatched addresses return 200 (treasury sweep
acknowledgement). Refuses to credit if `TATUM_WEBHOOK_SECRET` is unset (503).

```json
{
  "success": true,
  "data": {
    "userId": 42,
    "amountUsdc": 100.0,
    "txHash": "0xabc...",
    "address": "0x...",
    "network": "Polygon",
    "newBalance": 1100.0
  }
}
```

> **Removed:** `POST /deposit/transfer`. Use `POST /chat/transfer`.

---

## Wallet — `/wallet`

### `POST /wallet/withdraw` (auth + ban guard)
Body: `{ amount, destination, networkPref }`. External crypto withdrawal
flow. Runs Double-Check before debiting.

### `GET /wallet/history` (auth, read-only)
Withdrawal history.

### `POST /wallet/saved` (auth + ban guard)
Add a saved external wallet (whitelist).

### `GET /wallet/saved` (auth, read-only)
List saved wallets.

### `DELETE /wallet/saved/:id` (auth + ban guard)
Remove a saved wallet.

### `POST /wallet/deposit/initialize` (auth + ban guard)
Initialize a fiat-deposit session (Phase 16 gateway).

### `GET /wallet/deposit-address/polygon` (auth, read-only) — *Phase C*
Returns the user's unique Polygon USDC deposit address. On first call,
derives the address from the platform's HD wallet xpub using
`userId` as the derivation index (via Tatum API or mock fallback),
persists it to `User.tatumPolygonAddress`, and subscribes the address
to Tatum's webhook notification system.

Subsequent calls return the cached address from the DB (no API call).

```json
{
  "success": true,
  "data": {
    "address": "0x...",
    "derivationIndex": 42,
    "source": "MOCK",
    "isNew": false,
    "network": "Polygon (MATIC)",
    "token": "USDC",
    "warning": "Only send USDC on the Polygon network to this address..."
  }
}
```

---

## External Crypto Withdrawal — `/withdraw`

### `POST /withdraw/crypto` (auth + ban guard) — *Phase C update*
Body: `{ amount, destination, network? }`. `destination` must be a valid
Polygon address (`0x` + 40 hex chars).

**V2 Blueprint Gas Fee Policy:** The user bears **100%** of the MATIC/POL
network gas fee. The fee is deducted FROM the withdrawal amount:
- User requests `amount` USDC withdrawal.
- Backend fetches live MATIC/USD rate from CoinGecko.
- `gasFeeUsdc = POLYGON_GAS_FEE_MATIC (0.05) × maticUsdcRate`.
- `netPayout = amount - gasFeeUsdc` (what actually arrives on-chain).
- `amount` is debited from `availableBalance`.
- `netPayout` is debited from `SystemHotWallet`.
- `gasFeeUsdc` is credited to `SystemProfitFees` as operational revenue
  and recorded in `AdminProfitLog (source = 'GAS_FEE_REVENUE')`.
- Transaction is broadcast to Polygon via Tatum (best-effort).

Returns `502` if the oracle is unreachable (uses 0.55 fallback).
Returns `400` if `amount` is too low to cover gas.

```json
{
  "success": true,
  "data": {
    "withdrawalAmount": 50.0,
    "gasFeeMatic": 0.05,
    "maticUsdcRate": 0.55,
    "gasFeeUsdc": 0.0275,
    "netPayout": 49.9725,
    "gasFeePolicy": "USER_BEARS_100_PERCENT",
    "destination": "0x...",
    "network": "Polygon",
    "txHash": "0x...",
    "newBalance": 950.0
  }
}
```

---

## Chat — `/chat`

### `GET /chat/:tradeId` (auth, read-only)
Trade conversation history.

### `POST /chat/send` (auth + ban guard)
Body: `{ tradeId, message }`.

### `POST /chat/upload` (auth + ban guard, multipart)
Form: `tradeId`, `screenshot`. Writes an `IMAGE_PROOF` message.

### `POST /chat/transfer` (auth + ban guard) — *V2 canonical*
Body: `{ recipientId | username | influencerCode, amountUsdc, note? }`.
Atomic in-chat USDC transfer. Lazy-creates a `PERSONAL` conversation,
upserts mutual `Contact` rows, writes a `PAYMENT_TRANSFER` message,
fires FCM if the recipient is offline.

### `POST /chat/upload-media` (auth, multipart)
Lightweight media upload. Returns `{ mediaUrl }`; the message persistence
is handled separately by the socket `send_message` event.

---

## Notifications — `/notifications`

### `GET /notifications/` (auth, read-only)
The caller's notifications. Supports `?category=GENERAL|SECURITY_ACCOUNT|VENDOR_PRIORITY|ADMIN_SYSTEM`.

### `GET /notifications/unread-count` (auth, read-only)
Returns `{ unreadCount }`.

### `PATCH /notifications/:id/read` (auth + ban guard)
### `PATCH /notifications/read-all` (auth + ban guard)

---

## Friends — `/friends`  *(social CRUD + 1:1 DM + peer transfer)*

> **Path note:** the 1:1 direct-message routes live under `/api/friends/chat/*`,
> NOT `/api/messages/*`. Any reference to `/messages/*` is stale.

### Discovery

#### `GET /friends/search?q=<query>` (auth, read-only)
Returns up to 20 matching users. Searches by username (case-insensitive
contains) and by numeric Azaman UID. Each result is enriched with the
caller's existing `friendshipStatus` (`PENDING|ACCEPTED|REJECTED|BLOCKED|null`)
and `isFriendRequestSender` so the FE can render the correct CTA. Excludes
self and `isDeleted = true` accounts. Returns `400` if `q` is shorter than
2 chars.

#### `GET /friends/profile/:userId` (auth, read-only)
Public profile preview for the friend-request review screen. Returns
`{ id, username, profilePictureUrl, tradesCompleted, completionRate,
positiveReviews, negativeReviews, isVerified, loyaltyTier, memberSince }`.

### Requests

#### `POST /friends/request` (auth)
Body: `{ addresseeId, message? }`. Refuses self-add (`400`), already-accepted
duplicate (`409`), already-pending (`409`), `BLOCKED` relationship (`403`).
Auto-revives `REJECTED` rows by re-`PENDING`-ing them. Sends a `GENERAL`
notification + emits `friend_request_received` to `user_<addresseeId>`.

#### `GET /friends/requests` (auth, read-only)
Incoming `PENDING` friend requests. Pagination: `?page=1&limit=20`. Returns
`{ requests, total, page, limit }`. Each request is enriched with
`requester.isVerified`.

#### `GET /friends/requests/sent` (auth, read-only)
Outgoing `PENDING` friend requests.

#### `PUT /friends/request/:id/accept` (auth)
`PENDING → ACCEPTED`. Caller must be the `addresseeId`. Sends a notification
+ emits `friend_request_accepted` to the original requester. `409` if the
request is no longer pending.

#### `PUT /friends/request/:id/reject` (auth)
`PENDING → REJECTED`. Caller must be the `addresseeId`. `409` if no longer
pending.

### Friends list

#### `GET /friends?cursor=<friendshipId>&limit=20` (auth, read-only) — *Phase I*
Cursor pagination by `Friendship.id`, ordered `[updatedAt DESC, id DESC]`.
Each row contains: `friendshipId`, `friend` (id, username, profilePictureUrl,
tradesCompleted, completionRate, kycStatus, isVerified), `latestMessage`
(content/createdAt/isFromMe — content shows `[TYPE]` for non-text messages),
`unreadCount`, `friendSince`. Wire envelope: `{ success, friends, count,
nextCursor, hasMore, limit, page?, total? }`.

**Phase I performance note.** Two-query enrichment (was 2N+1 before):
one `findMany distinct: ['friendshipId']` for latest messages (Postgres
`DISTINCT ON`, served by `DirectMessage(friendshipId, createdAt DESC)`
index) plus one `groupBy` for unread counts. Friend-list cursor caveat:
`Friendship.updatedAt` is mutated by every DM and peer transfer, so a
friend whose `updatedAt` bumps mid-pagination can skip or duplicate
across pages. Friend-list scale (rarely > 1 page) makes this a
non-issue in practice.

#### `DELETE /friends/:id` (auth)
Hard-deletes the `Friendship` row. Either participant may delete.

### Direct messaging — `/friends/chat/*`

> Mounted under `/api/friends/chat/*`. Permanent personal conversations
> (V2 §5 dual-chat system: trade chats live under `/chat/*` and are
> ephemeral; these are permanent and tied to `friendshipId`).

#### `GET /friends/chat/unread-count` (auth, read-only)
Returns `{ unreadCount }` aggregated across all of the caller's
friendships.

#### `GET /friends/chat/:friendshipId/messages?cursor=<id>&limit=20` (auth, read-only) — *Phase I*
Cursor pagination, ordered `[createdAt DESC, id DESC]`. Each message:
`{ id, senderId, receiverId, content, messageType, mediaUrl?,
transferAmount?, transferStatus?, isRead, createdAt }`.

#### `POST /friends/chat/:friendshipId/messages` (auth + ban guard)
Body: `{ content, messageType?, mediaUrl?, transferAmount?, transferType? }`.
`messageType` defaults to `TEXT`. Sends a `new_personal_message` socket event
to the receiver's `user_<id>` room and bumps `Friendship.updatedAt`. Refuses
if the friendship is not `ACCEPTED` (`403`).

#### `PUT /friends/chat/:friendshipId/read` (auth)
Marks every unread message in the conversation (where the caller is the
receiver) as `isRead = true`. Returns `{ markedCount }`.

#### `GET /friends/chat/:friendshipId/info` (auth, read-only)
Conversation metadata: friend profile, friendship dates, total message
count, unread count.

### Peer transfers — `/friends/transfer/*`

> In-friendship USDC send/request flow. Idempotent on
> `clientRequestId` / `X-Idempotency-Key`. Both sender and receiver get
> `TransactionHistory` rows. See `peerTransferController.js` for the
> three-layer idempotency proof (Phase A2).

#### `POST /friends/transfer/send` (auth + ban guard)
Body: `{ friendshipId, amountUsdc, note?, clientRequestId? }`. Atomic
debit/credit inside `prisma.$transaction` with the Double-Check audit.
Returns `200` with the existing transfer row if `clientRequestId` (or
the `X-Idempotency-Key` header) matches a prior call. Sends a
`TRANSFER_SENT` direct message. Refuses on insufficient funds (`400
INSUFFICIENT_FUNDS`).

#### `POST /friends/transfer/request` (auth + ban guard)
Body: `{ friendshipId, amountUsdc, note?, clientRequestId? }`. Creates a
`PENDING` `PeerTransfer` row + writes a `TRANSFER_REQUEST` direct message.
The receiver fulfils via `PUT /friends/transfer/:id/fulfill` or declines
via `/decline`. No funds move until fulfilment.

#### `GET /friends/transfer/pending` (auth, read-only)
Outstanding requests sent to the caller (request type, status `PENDING`).

#### `GET /friends/transfer/history/:friendshipId` (auth, read-only)
Full per-friendship transfer ledger.

#### `GET /friends/transfer/:id` (auth, read-only)
Single transfer detail.

#### `PUT /friends/transfer/:id/fulfill` (auth + ban guard)
Body: optional `clientRequestId`. Atomic debit (caller) / credit (requester),
moves the row to `COMPLETED`, emits `peer_transfer_completed` socket events
to both rooms. Idempotent on `txHash = PEER_FULFILL_*_<transferId>` — a P2002
unique conflict returns `200` with the existing row.

#### `PUT /friends/transfer/:id/decline` (auth)
Moves a `PENDING` request to `DECLINED`. No ledger movement.

---

## Personal P2P chat — Socket.io

The `/friends/chat/*` REST routes have a real-time companion via the
existing Socket.io infrastructure. See the **Real-time events** section
below — `friend_request_received`, `friend_request_accepted`,
`new_personal_message`, `peer_transfer_received`, `peer_transfer_completed`,
`peer_transfer_declined` are all emitted to `user_<id>` rooms.

---

## Savings — `/savings`

> Goal-based locked / unlocked savings. All amounts on the wire are GHS;
> the controller converts to USDC at `liveUsdToGhs` for the actual ledger
> mutation. `availableBalance` is the source/sink (deposit drains,
> withdraw refills). Each mutation writes a matching
> `TransactionHistory(INTERNAL_TRANSFER)` row so the Double-Check audit
> stays consistent.

### `GET /savings/overview` (auth, read-only)
Dashboard summary across all goals: total saved (GHS + USDC),
target sum, overall progress %, active/completed/total goal counts,
best ever streak, current best active streak, total deposits all-time,
upcoming dues (next 7 days), and the full goals list.

### `GET /savings/goals` (auth, read-only)
List all of the caller's goals with `_count.deposits` aggregate.

### `GET /savings/goals/:id` (auth, read-only)
Single goal with `deposits` (last 50) + derived `progressPercent`,
`daysRemaining`, `isMatured`, `canWithdrawFree`.

### `POST /savings/goals` (auth + ban guard)
Body: `{ name?, targetAmountGhs, frequencyAmount, frequency?, endDate?, isLocked? }`.
`frequency ∈ {DAILY, WEEKLY, BIWEEKLY, MONTHLY}` (default `WEEKLY`).
`isLocked` defaults `true` (penalty applies on early withdrawal).
Refuses if the user already has 5 active goals (`400`), if
`frequencyAmount > targetAmountGhs`, or if either amount is non-positive.

### `POST /savings/goals/:id/deposit` (auth + ban guard)
Body: `{ amountGhs, type? }`. Inside one transaction: debits
`availableBalance` by the USDC equivalent, credits the goal,
recomputes streak (+1 if on-time vs `nextDueDate`, else reset to 0;
`missedCount` increments on late), advances `nextDueDate`,
auto-completes the goal when the target is hit, writes the matching
`TransactionHistory(INTERNAL_TRANSFER, -amountUsdc, txHash =
SAVINGS_DEP_<depositId>)`, and on every 4th-streak milestone fires a
celebratory notification. Refuses if `availableBalance` is insufficient
(`400`). On success emits `balance_update` to the caller.

### `POST /savings/goals/:id/withdraw` (auth + ban guard)
Body: `{ amountGhs? }` (defaults to the full goal balance).

**Penalty model.** If `goal.isLocked === true` AND the goal is not yet
matured (`endDate` in the future or null), the controller applies
`goal.earlyWithdrawalPenalty` (default `0.02` = 2 %) on the withdrawn
amount. The penalty is routed to `SystemProfitFees` and recorded in
`AdminProfitLog (source = 'SAVINGS_FEE')`. The user receives the
**net** (post-penalty) USDC into `availableBalance` and a
`TransactionHistory(INTERNAL_TRANSFER, +netUsdc, txHash =
SAVINGS_WD_<goalId>_<ts>)`. Mature or unlocked goals: zero penalty.

Refuses if `withdrawAmount > currentAmountGhs` (`400`) or the goal is
`CANCELLED` (`400`).

### `PUT /savings/goals/:id/pause` (auth + ban guard)
`ACTIVE → PAUSED`. Stops reminder fires.

### `PUT /savings/goals/:id/resume` (auth + ban guard)
`PAUSED → ACTIVE`. Re-computes `nextDueDate` from "now + frequency".

---

## Users — `/users`

> Mounted at `/api/users`. Profile, balance REST fallback, dashboard
> aggregator, onboarding state, preferences, milestones, security log,
> account deletion.

### Profile

#### `GET /users/profile` (auth, read-only)
Full profile envelope including all V2 balance buckets, vendor stats,
loyalty tier, onboarding state, theme + shortcuts, KYC status, ban
status, and `_count` of (ads, tradesAsBuyer, tradesAsVendor,
sentFriendRequests, receivedFriendRequests, savingsGoals, unread
notifications). Derives `rating` (positive/(positive+negative) × 5),
`totalReviews`, `totalBalance` (`availableBalance + vendorUnallocatedBalance`),
`unreadNotifications`, `totalFriends`, `memberSince`.

#### `PUT /users/profile` (auth)
Body: `{ displayName?, bio?, phoneNumber?, country?, profilePictureUrl?, fcmToken? }`.
**Whitelist enforced** — only these six fields are mutable. Length caps:
`displayName ≤ 50`, `bio ≤ 200`, `phoneNumber ≤ 20`, `country ≤ 5`.
Returns the updated subset. Refuses with `400` if no valid fields are
provided.

### Balance & dashboard

#### `GET /users/balance` (auth, read-only)
REST fallback for the WebSocket `balance_update` event. Returns the
full V2 balance buckets plus `totalBalance`, `currency: 'USDC'`,
`lastUpdated`. Used when the socket is unavailable.

#### `GET /users/dashboard` (auth, read-only)
**Single-call home-screen aggregator.** One round-trip returns:
- `user` summary (id, username, displayName, role, vendorLevel/Xp,
  loyaltyTier, loginStreak, kycStatus, onboardingCompleted, theme).
- `balances` envelope for the Hologram widget.
- `stats` (tradesCompleted, activeTrades count, currentStreak,
  unreadNotifications).
- `rates` from `GlobalSettings` (with safe fallback).
- `recentTransactions` (last 5).
- `activeSavings` (top 3 ACTIVE goals).

The frontend's `home_summary_service.dart` calls this in parallel with
`/oracle/rates`, `/trades/history`, `/wallet/history`,
`/friends/requests`, `/notifications/unread-count` for the full home
view.

### Onboarding

#### `GET /users/onboarding` (auth, read-only)
Returns `{ completed, currentStep, totalSteps: 3, steps: [...],
accountAge }`. The 3 fixed steps are: Welcome / Secure Account /
First Trade.

#### `PUT /users/onboarding` (auth)
Body: `{ step }` (number 0–3). Updates `onboardingStep`. When `step >= 3`
also sets `onboardingCompleted = true`.

#### `POST /users/onboarding/complete` (auth)
Forces `onboardingCompleted = true, onboardingStep = 3`.

### Preferences

#### `GET /users/preferences` (auth, read-only)
Returns `{ theme, shortcuts, preferences, availableThemes,
availableShortcuts }`. `availableThemes` is the canonical valid set
(`light, dark, cyberBlue, midnightPurple, mars, saturn, snow,
neonTokyo, deepOcean, volcanic, aurora`). `availableShortcuts` is the
16-id list (`deposit, withdraw, history, stats, p2p, savings, support,
ads, settings, security, kyc, friends, notifications, vendorPortal,
warRoom, wallet`).

#### `PUT /users/preferences/theme` (auth)
Body: `{ theme }`. Refuses if not in the canonical theme list (`400`).

#### `PUT /users/preferences/shortcuts` (auth)
Body: `{ shortcuts: [{ id, enabled, order }, ...] }`. Each `id` must be
in the canonical shortcut list. Sanitises with sensible defaults
(`enabled` defaults to `true`, `order` defaults to array index).

#### `PUT /users/preferences` (auth)
Body: `{ theme?, shortcuts?, preferences? }`. Batch update — only the
provided keys are touched. `preferences` is freeform JSON (e.g.
`{ hapticFeedback, soundEffects, animationIntensity, currencyDisplay,
language, biometricLock, showBalances, compactMode }`).

### Milestones & security log

#### `GET /users/me/milestones` (auth, read-only)
Tier progress envelope: `{ currentVolume, targetVolume: 100000,
tierName, tradesCompleted, completionRate, nextTier, tradesNeeded }`.
Tier ladder: `STANDARD → GOLD (50 trades) → PLATINUM (200 trades)`.
`currentVolume` is sourced from the latest `LeaderboardRecord` row.

#### `GET /users/me/security-logs?page=1&limit=20` (auth, read-only)
Paginated `SECURITY_ACCOUNT`-category notifications (login events,
password changes, 2FA toggles, etc.). Returns `{ logs, total, page,
limit }`.

### Account management

#### `POST /users/delete` (auth)
Body: `{ textReason, audioFileUrl? }`. Soft-delete: writes an
`AccountFeedback` row, then sets `isDeleted = true`, blanks the user's
PII (email, googleId, appleId, profilePictureUrl), and renames the
username to `DeletedUser_<8-hex>`. The row is retained for ledger /
trade-history integrity.

---

## Security — `/security`

> 2FA (TOTP), 6-digit PIN, change-password. Mounted at `/api/security`.

### `POST /security/2fa/setup` (auth)
Generates a fresh TOTP secret via `speakeasy` and returns
`{ secret, qrCodeDataURL }` (a `data:image/png;base64,...` data URL of
the QR for Google Authenticator / Authy). The secret is persisted to
`User.twoFactorSecret` but **not yet activated** — the user must
verify the first code via `/2fa/verify` to flip
`isTwoFactorEnabled = true`. Refuses if 2FA is already enabled (`400`).

### `POST /security/2fa/verify` (auth)
Body: `{ token }` (6-digit TOTP code). Verifies with `speakeasy.totp.verify`
(`window: 1`, ±30 s). On success sets `isTwoFactorEnabled = true`.
`400` on missing token or invalid code, `400` if no secret is set.

### `POST /security/2fa/disable` (auth)
Body: `{ token }`. Requires a valid current TOTP code to disable —
prevents a passive attacker with a session cookie from silently
turning 2FA off. Clears `twoFactorSecret` and sets
`isTwoFactorEnabled = false`.

### `POST /security/pin/set` (auth)
Body: `{ pin }`. PIN must match `/^\d{4,6}$/`. Stored as a
`bcrypt(pin, 10)` hash in `User.pinHash`. Used by the FE biometric-gate
fallback and quick-confirm flows.

### `POST /security/pin/verify` (auth)
Body: `{ pin }`. Returns `{ verified: boolean }` based on
`bcrypt.compare`. `400` if no PIN has been set.

### `POST /security/change-password` (auth)
Body: `{ currentPassword, newPassword }`. Verifies current via
`bcrypt.compare` then writes `bcrypt.hash(newPassword, 12)`.

**Refusals.**
- `400` if either field missing or not a string.
- `400` if `newPassword.length < 8`.
- `400` if `newPassword === currentPassword`.
- `400` for SSO-only accounts (`password === ''`) — directs the user to
  set a password first.
- `401` if `currentPassword` does not match.
- `404` for stale tokens.

On success writes a best-effort
`Notification(category = SECURITY_ACCOUNT, title = 'Password changed')`
audit row (failure is logged but does not fail the password change).
The audit row surfaces in **Account Activity** via
`GET /users/me/security-logs`.

---

## KYC — `/kyc`

> Mounted at `/api/kyc`. Image-based legal-identity submission +
> status check. Admin approval lives at `POST /admin/kyc/approve` (see
> the Admin section).

### `GET /kyc/status` (auth, read-only)
Returns `{ kyc: { kycStatus, legalName } }`. `kycStatus ∈ {UNVERIFIED,
PENDING, VERIFIED, REJECTED}`.

### `POST /kyc/submit` (auth, multipart)
Form: `legalName`, `idType`, `idNumber`, plus up to 2 image files
under the `idImages` key (front + optional back). Files pass through
the shared `uploadMiddleware` (`jpeg/jpg/png` ≤ 5 MB, count cap = 2).

Persists the legal info + image paths to `User.{legalName, idType,
idNumber, idImageFront, idImageBack}` and locks `kycStatus = 'PENDING'`.
The admin approval queue picks it up via `GET /admin/kyc/pending`.
Returns `400` on missing files or upload-middleware failure.

---

## Vendor — `/vendor`

> Vendor stats, gamification, achievements, leaderboard. Mounted at
> `/api/vendor`. Soft vendor check — non-vendor callers see their data
> too (mostly zeros), so the floating "For Vendor" tab can show a
> teaser without forcing a role flip.

### `GET /vendor/stats` (auth, read-only)
Full gamified vendor profile:

- `profile`: id, username, role, kycStatus, memberSince, daysSinceCreation.
- `gamification`: xp, level, levelProgress (`{ currentLevelXp,
  nextLevel, xpToNext, progress }`), streak (`current, longest,
  lastTradeDate, isActiveToday`).
- `achievements`: earned count, total, completionPercent.
- `trading`: tradesCompleted, completionRate, totalVolumeUsdc,
  totalProfitUsdc, avgTradeSize.
- `reputation`: score (0–100, default 100 for zero reviews),
  positive/negative/total reviews.
- `ads`: total, active, recentInteractions (views / tradeClicks /
  closeAways over the last 30 days, served by `AdInteraction` index).

### `GET /vendor/stats/quick` (auth, read-only)
Lightweight teaser — used by the floating pull-tab. Returns level, xp,
levelProgress, nextLevel, xpToNext, current streak, isActiveToday,
tradesCompleted, totalProfit, activeTrades count, isVendor boolean,
and the most recently unlocked `lastAchievement` (name, tier, icon,
unlockedAt).

### `GET /vendor/achievements` (auth, read-only)
Every achievement definition with status:

- `summary`: total, unlocked, locked, totalXpFromAchievements.
- `achievements[]`: each row has `{ id, name, description, iconName,
  tier, xpReward, unlocked, unlockedAt, progressHint }`.
  `progressHint` is a human string for locked rows
  (e.g., `"$420.00/$1,000 volume"`, `"3/5 day streak"`).
- `categorized`: pre-bucketed by `tradeMilestones / volumeMilestones /
  reputation / streaks / special` for FE rendering.
- `recentlyUnlocked`: last 5 unlocks.

### `GET /vendor/leaderboard?metric=xp&limit=20` (auth, read-only)
`metric ∈ {xp, volume, trades, profit, streak}` (default `xp`).
`limit` capped at 50. Returns the top vendors with `{ rank, id,
username, level, xp, tradesCompleted, totalVolume, totalProfit, streak,
longestStreak, completionRate, kycVerified, isYou }` and the caller's
own `myRank` even if outside the top N (computed via a count-above
query).

### `POST /vendor/xp/review` (auth)
Body: `{ vendorId, isPositive }`. **Internal helper** — called from
`POST /trades/review` after a review is committed. Awards
`XP_REWARDS.POSITIVE_REVIEW` or `XP_REWARDS.NEGATIVE_REVIEW`,
re-checks every achievement against the post-review snapshot, and
returns `{ xpChange, ...xpResult, newAchievements }`.

---

## AI & Smart Queue — `/ai`

> Mounted at `/api/ai`. Houses the AI feature catalogue, the CFO
> trigger (admin-only), and the **Smart Queue** — the FIFO that
> activates when an ad hits its `maxConcurrentTrades` ceiling.

### `GET /ai/capabilities` (admin)
Returns the catalogue of available AI features (`operational-cfo`,
`dispute-assistant`, `smart-matchmaking`, `smart-queue`). Each entry
has `{ id, name, description, status, icon, endpoint }`. The FE admin
panel renders this directly.

### `POST /ai/cfo/analyze` (admin)
Triggers the **Operational CFO** background worker on demand
(`workers/cfoWorker.js → analyzeExpenses`). Returns the analysis JSON.
Used to refresh the AI dashboard outside the worker's normal cadence.

### `POST /ai/queue/initiate` (auth)
Body: `{ adId, amountCrypto, amountFiat, paymentMethod }`. **Wraps**
`POST /trades/initiate`. If the target ad already has
`activeTrades >= ad.maxConcurrentTrades`, the request is *not* converted
to a trade — instead a `TradeQueue(WAITING)` row is created, the
`queue_joined` socket event is emitted to `user_<id>`, and a
`200 { queued: true, queuePosition, queueId }` is returned. If the
caller already has a `WAITING` entry on this ad, that row is returned
verbatim (idempotent). If the ad has capacity, the request is
forwarded transparently to `tradeController.initiateTrade` and the
normal `Trade` flow runs.

### `GET /ai/queue/status?adId=<id>` (auth, read-only)
Lists the caller's `WAITING` queue entries (optionally filtered to one
ad). Each entry is enriched with the live `position` (computed by
counting earlier-`joinedAt` waiters on the same ad).

### `PUT /ai/queue/:queueId/leave` (auth)
Cancels a `WAITING` queue entry (`status = CANCELLED`). Refuses on
non-WAITING entries (`400`) and on entries the caller doesn't own
(`403`).

### `POST /ai/queue/process/:adId` (admin)
Manual trigger of `processNextInQueue(adId)`. Promotes the head of
the FIFO from `WAITING → PROCESSED`, emits `queue_update` with the
locked-in `liveUsdToGhs` rate, and writes a `GENERAL` notification
inviting the buyer to open the ad. Normally the worker calls this
automatically when a trade slot opens up; this admin endpoint is for
manual recovery.

---

## Oracle — `/oracle`  *(public)*

> Live USD/GHS exchange-rate feed. **No authentication required** —
> rates are public information. The frontend's `home_summary_service`
> and `TradeProvider.fetchYellowCardRate` consume these.

### `GET /oracle/yellowcard-rate` (public)
Returns the current USD→GHS rate from `GlobalSettings` (id=1).
Response shape:

```
{
  "success":      true,
  "rate":         15.20,
  "retailRate":   15.50,
  "corporateRate": 14.85,
  "source":       "KOTANI_PAY",
  "lastSync":     "2026-05-25T..."
}
```

`source ∈ {KOTANI_PAY, MANUAL_OVERRIDE, MOCK, UNAVAILABLE, UNKNOWN}`.
When `GlobalSettings` is missing the controller responds with `{ rate: 0,
source: 'UNAVAILABLE', lastSync: null }` (still `200` so the FE can
gracefully degrade rather than retry-loop).

### `GET /oracle/rates` (public)
Convenience endpoint — every rate field in one call:

```
{
  "success": true,
  "data": {
    "liveUsdToGhs":      15.20,
    "liveRetailRate":    15.50,
    "liveCorporateRate": 14.85,
    "bankMargin":         3.0,
    "thirdPartyMargin":   2.0,
    "rateSource":        "KOTANI_PAY",
    "lastSync":          "2026-05-25T..."
  }
}
```

The FE home dashboard's sparkline reads `liveUsdToGhs` from this
endpoint and appends each observation to a 24-sample in-memory rolling
window.

---

## Trade accounts & payout destinations — `/trade-accounts`, `/payout-destinations`

### `POST /trade-accounts/` (auth + ban guard, multipart)
Form: `methodType`, `accountDetails` (JSON), `verificationScreenshot`
(image). Persists with `adminVerificationStatus = PENDING`.

### `GET /trade-accounts/approved` (auth, read-only)
Approved accounts only.

### `POST /payout-destinations/` (auth + ban guard)
Body: `{ nickname, destinationType, destinationAddress, isExternalCrypto? }`.

### `GET /payout-destinations/` (auth, read-only)

---

## Admin — `/admin`, `/admin/chat`, `/war-room`

### `GET /admin/stats` (admin)
Platform-wide stats summary.

### `GET /admin/disputes` (admin)
### `GET /admin/trades/live` (admin)

### `POST /admin/disputes/force-release` (admin)
### `POST /admin/disputes/force-cancel` (admin)
### `POST /admin/chat/inject` (admin)

### `GET /admin/kyc/pending` (admin)
### `POST /admin/kyc/approve` (admin)
### `POST /admin/kyc/reject` (admin)

### `POST /war-room/corporate-purchase` (admin)
Body: `{ usdcAmount, fiatSentTotal, discountRate, actualMarketRate, screenshotUrl?, purchaseMethod? }`.
Atomic: writes `CorporatePurchaseLog`, credits `SystemMasterCrypto`.

### `POST /war-room/corporate-purchase/api` (admin) — *Phase B*
Body: `{ fiatGhs, recipientPhone?, recipientNetwork?, screenshotUrl?, gatewayReference? }`.
Atomically pulls the **live corporate (OTC) rate** from the Kotani Pay
gateway, computes `usdcAmount = fiatGhs / corporateRate`, writes a
`CorporatePurchaseLog` with `purchaseMethod = 'API'` and the gateway
provenance fields populated, and credits `SystemMasterCrypto`. The
`gatewayReference` column is `UNIQUE` — replays return `409 CORPORATE_REFERENCE_REPLAY`.

### `POST /war-room/liquidate-profits` (admin)
Body: `{ amountUsdc }`. Delegates to `finance.service.liquidateProfits`.

### `POST /war-room/cold-storage` (admin)
Body: `{ amountUsdc, direction (TO_COLD|TO_HOT), notes? }`. Audit-trail
record only — the on-chain movement is performed out-of-band on the
hardware wallet.

---

## Real-time events (Socket.io)

### Rooms
- `user_<id>`              — personal stream (notifications, balance pushes)
- `balance_room_<id>`      — granular balance updates (drives the Hologram)
- `trade_<id>`             — escrow chat + trade lifecycle
- `personal_<sha256>`      — V2 personal P2P chat hash
- `admin_spy_room`         — admin spy-glass mirror

### Server → client events
- `balance_update`         — `{ availableBalance, escrowLockedBalance, vendorUnallocatedBalance, disputeEscrowBalance, azmBalance }`
- `new_message`            — `{ id, sender, content, messageType, createdAt }` (V2 schema)
- `message_saved` / `message_delivered` — sender confirmations
- `trade_update`           — `{ status, ... }`
- `new_trade_request`      — vendor inbox
- `vendor_ping` / `ping_accepted`
- `queued`                 — Smart-Queue placement
- `new_notification`       — generic banner ping
- `deposit_success`        — `{ type, amount, txHash | reference, newBalance, timestamp }`
- `admin_alert`            — `{ type, ... }` (DISPUTE, OVERPAYMENT_DISPUTE, LIQUIDITY_LOW, PROFIT_LIQUIDATION, ...)
- `account_restricted`     — fired when the strike threshold trips a ban

### Client → server events
- `join_user_room` / `join_balance_room` / `join_trade`
- `send_message`           — uses V2 `Conversation` lazily; persists to `Message`
- `mark_messages_read`
- `typing`
- `vendor_accept`          — vendor accepts a new trade request

> **Removed:** `vendor_release_crypto` socket event. All releases now go
> through `POST /p2p/complete`.

---

## Error codes (non-exhaustive)

| HTTP | `code`                  | When |
| --- | --- | --- |
| 401 | `USER_NOT_FOUND`        | JWT references a deleted user |
| 403 | `ACCOUNT_RESTRICTED`    | Ban guard blocked a write |
| 403 | `ACCOUNT_DELETED`       | User has `isDeleted = true` |
| 403 | (Double-Check failure)  | Withdrawal frozen, `data.status = 'FROZEN_DISPUTE'` |
| 409 | (deposit conflict)      | Webhook attempted to confirm a non-PENDING deposit |
| 503 | (oracle / webhook)      | Live rate unavailable / webhook secret unset |

---

## Compliance footnotes

1. All monetary fields are USDC unless explicitly suffixed `Ghs` or `Fiat`.
2. Timestamps are ISO-8601 (RFC 3339).
3. File uploads are `multipart/form-data`; image-only routes accept
   `jpeg / jpg / png` ≤ 5 MB.
4. The `V2 ledger split` is enforced at the schema level. The legacy
   `lockedBalance` column was dropped in **Phase J (2026-05-25)** along
   with `ghsBalance` — both were write-dead V1 buckets. Active escrow
   now lives in `escrowLockedBalance`; the GHS hologram is computed
   `availableBalance × yellowCardRate` on read.
5. Banned users keep `GET` access. They cannot mutate state; the
   ban guard returns `403 ACCOUNT_RESTRICTED` with `appealEmail`.

*Update this contract whenever a route signature changes. The contract
is the source of truth.*
