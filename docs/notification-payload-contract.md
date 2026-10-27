# Notification Category & actionPayload Contract (Priority E audit, 2026-10-25)

Single source of truth for the notification payload ecosystem. There is exactly
one taxonomy: the Prisma `NotificationCategory` enum. Producers must emit only
these categories; unknown values fail safe to `GENERAL` at the persistence
boundary (`services/notificationService.js` `_normalizeCategory`).

The single payload authority is `notificationService.sendNotification`
(and, for worker paths, `prisma.notification.create` with the same shape).
The canonical payload shape is a deep-link envelope:

```json
{ "route": "/trade/<id>", "action": "OPEN_TRADE", "<targetId>": "..." }
```

- `action` — the semantic deep-link verb. The client dispatches on `action`
  (NOT on `route`); unknown actions no-op safely in every shipped client.
- `route` — server-derived documentation of the destination. It is NOT trusted
  client navigation input: the Flutter client maps `action` → screen through its
  own router (`handleNotificationTap`), and cold-start fallbacks are a fixed
  switch, not a `route` string evaluation.
- extra keys — the target identifiers specific to the action.

## 1. Category semantics

| Category | Intended meaning | Representative emitters |
| --- | --- | --- |
| `GENERAL` | catch-all / user-facing lifecycle events without a dedicated category | reservation counter-proposal, business order events, transit reminders, withdrawal review notice, trade chat/accept updates |
| `SECURITY_ACCOUNT` | account-security and account-state events: logins, password changes, 2FA, KYC, dispute resolution | `securityController`, `adminController` (KYC_STATUS/ACCOUNT_STATUS), `notificationService.formatDisputeUpdated`, `disputeResolutionService` |
| `VENDOR_PRIORITY` | vendor-facing alerts requiring attention | trade-request notifications to vendors (`tradeRoutes`), vendor application results |
| `ADMIN_SYSTEM` | admin operations console events (war room, queue) | `queueController`, `adminController` war-room emits |
| `MONEY` | deposits, withdrawals, transfers, invoices, escrow events | `walletController`, invoice/payment services, escrow lifecycle |
| `SOCIAL` | friend requests, follows, story reactions, referrals | `friendController`, `storyController`, referral service |
| `CHAT` | direct conversation messages | conversation/socket message paths (`OPEN_CHAT`) |
| `SYSTEM` | platform-wide announcements | `adminController` broadcasts |
| `VAULT` | vault deposits / receipts | `vaultController` (`VIEW_VAULT`, `VIEW_VAULT_RECEIPT`) |
| `SUSU` | susu cycle events | susu services (`OPEN_SUSU`, `OPEN_SUSU_INVITE`, `OPEN_DEPOSIT_FOR_SUSU`, `OPEN_SUSU_CONTRACT`) |
| `SMART_ROUTE` | smart-route execution events | r19 smart-route execution snapshot |
| `AUCTION` | auction lifecycle | `auctionController` (`OPEN_AUCTION`) |
| `STOREFRONT` | storefront / retail checkout events | retail checkout integrity paths |

Frontend mapping (verified in `AZM-frontend lib/models/notification_model.dart`):
the shipped client enum knows the 8 original categories; `VAULT`, `SUSU`,
`SMART_ROUTE`, `AUCTION`, `STOREFRONT` parse to the `general` bucket today — a
display grouping only, not a downgrade of the stored value.

## 2. Canonical action → payload matrix

| Action (canonical key fields) | Target identifier & origin | Route authority | Producer(s) |
| --- | --- | --- | --- |
| `OPEN_TRADE` { tradeId } | `Trade.id` (Int, trade initiator) | `/trade/:id` | trade lifecycle, dispute resolution, socket connection handler |
| `PING_TOPUP` { tradeId } | `Trade.id` | `/trade/:id` | trade reminder paths |
| `OPEN_DISPUTE` { disputeId } | `Dispute.id` | `/dispute/:id` | dispute lifecycle |
| `OPEN_FRIEND_REQUEST` / `OPEN_FRIEND_CHAT` { friendshipId } | `Friendship.id` | `/friends` | friend service |
| `VIEW_SAVINGS` { goalId } | `SavingsGoal.id` | `/savings` | savings worker |
| `OPEN_AD` { adId } | `Ad.id` | `/marketplace` | queue/ads |
| `OPEN_SUSU` { susuId } | `Susu.id` | `/susu/:id` | susu services |
| `OPEN_SUSU_INVITE` { token \| susuId } | invite token (LINK channel) or `SusuInvite.id` | `/susu/invite/:token` | susu invite paths |
| `OPEN_DEPOSIT_FOR_SUSU` { amount, susuId } | `Susu.id` | `/deposit` | susu shortfall reminders |
| `OPEN_CHAT` { conversationId, friendId, friendName } | `Friendship.id` + `User.id` | messages hub | chat paths |
| `OPEN_ORDER` { orderId, orderRef } | `BusinessOrder.id` | order tracking | business order lifecycle |
| `OPEN_PROOF_OF_RESIDENCY` {} | — (profile-scoped) | `/proof-of-residency` | KYC requirements |
| `OPEN_WALLET` { ratePair? } | — (owner wallet) | `/wallet` | rate alerts, wallet events |
| `WITHDRAWAL_STATUS` { withdrawalId, status } | `Withdrawal.id` (Int) | wallet/withdrawals | `adminController` review decisions, `payoutBatchWorker` manual-review flag (fixed here) |
| `KYC_STATUS` { kycStatus } | — (owner KYC state) | `/kyc` | KYC resolution |
| `ACCOUNT_STATUS` { status } | — (owner account state) | settings | admin account actions |
| `VIEW_TICKET` { ticketId } | `Ticket.id` | `/tickets/:id` | `businessOrderController` delivered-order notice |
| `VIEW_BUSINESS_ORDER` { orderId } | `BusinessOrder.id` | `/business/orders` | `ticketController` new-order notice |
| `OPEN_INVOICE` { invoiceId } | `BusinessInvoice.id` | invoices | invoice payment paths |
| `OPEN_QUEUE` { queueId } | queue session id | `/queue` | queue joins |
| `VIEW_VAULT` / `VIEW_VAULT_RECEIPT` { vaultId? , receiptId? } | vault session / receipt ids | vault | `vaultController` |
| `OPEN_AUCTION` { auctionId } | auction id | auctions | `auctionController` |
| `OPEN_SMART_ROUTE` { routeId } | smart-route execution id | smart route | r19 execution snapshot |
| `OPEN_SUSU_CONTRACT` { susuId } | `Susu.id` | `/susu/:id` | susu contract events |
| `VIEW_BADGE` / `VIEW_ACHIEVEMENT` { badgeId \| achievementId } | badge/achievement ids | profile | gamification |
| `APPROVE_DISCOUNT` { requestId } | discount request id | business portal | discount approval flows |
| `OPEN_GROUP` / `OPEN_GROUP_INVITE` / `OPEN_GROUP_PROFILE` / `OPEN_JOIN_REQUESTS` { groupId, ... } | group ids | groups | group/social services |
| `OPEN_KYC` / `SECURITY_ALERT` {} | — (owner-scoped) | settings/security | admin/security |
| `VENDOR_APPLICATION_RESULT` {} | — (vendor applicant) | business | vendor onboarding |
| `OPEN_PAYMENT_REQUESTS` { requestId? } | payment request id | payment requests | payment request service |
| `OPEN_FRIEND_TRANSFER_REQUEST` { requestId } | friend transfer request id | friends | friend transfer service |
| `OPEN_TRADE_ACCOUNTS` {} | — (owner trade accounts) | trade accounts | trade account events |
| `TRANSIT_REMINDER` { bookingId, tripId, routeName } | `TransitBooking.id`, `TransitTrip.id` | transit | `transitReminderWorker` (#270 remediation) |
| `COUNTER_PROPOSAL` { reservationId, proposedStartDatetime, proposedEndDatetime } | `Reservation.id` (uuid) | marketplace reservations | `reservationController.counterProposeReservation` (fixed here) |
| `COUNTER_PROPOSAL_ACCEPTED` { reservationId } | `Reservation.id` | marketplace reservations | `reservationController.acceptCounterProposal` (fixed here) |
| `REVIEW_RECEIVED` { reviewId, businessProfileId, rating } | `BusinessReview.id`, `BusinessProfile.id` | business profile | `businessReviewService.createReview` (fixed here) |
| `OPEN_HOME` {} | — | `/` | `_ensureDeepLink` default for payloads without an action |

Client dispatch (verified `AZM-frontend lib/router/app_router.dart`,
`handleNotificationTap` + `_fallbackToRouter`): actions handled by the shipped
client are `OPEN_TRADE`, `PING_TOPUP`, `OPEN_DISPUTE`, `OPEN_FRIEND_REQUEST`,
`OPEN_FRIEND_CHAT`, `VIEW_SAVINGS`, `OPEN_AD`, `OPEN_SUSU`,
`OPEN_SUSU_INVITE`, `OPEN_DEPOSIT_FOR_SUSU`, `OPEN_CHAT`, `OPEN_ORDER`,
`OPEN_PROOF_OF_RESIDENCY`. All other actions (server-emitted, forward-compat)
display in the hub and no-op on tap — by design, so a backend rollout never
crashes an older client.

## 3. Ownership / privacy / permission requirements

- Every notification is created server-side; the recipient `userId` is always
  derived from the OWNER of the target resource (order customer, reservation
  customer, business profile owner, withdrawal owner, dispute parties) — never
  from client input.
- `actionPayload` is generated exclusively by trusted server code. No route
  accepts a client-supplied `actionPayload`, `route`, or `action` value; the
  notification trigger endpoints under `/api/notifications/trigger/*` are
  `protect` + `adminOnly` and go through the same service normalization.
- Target identifiers are opaque ids (Int for `Trade`/`Withdrawal`/`Friendship`,
  uuid for `Reservation`/`BusinessOrder`/`BusinessReview`). Landing screens
  re-check authorization server-side when they fetch the referenced resource;
  a stale/forged id degrades to a 404 for its owner, not a data leak.

## 4. Missing / malformed / legacy / stale payload behaviour

- Missing `actionPayload` → stored as `{ route: '/', action: 'OPEN_HOME' }`
  (`_ensureDeepLink`): the notification lists normally and taps to home.
- Unknown `category` string → fails safe to `GENERAL`, never rejected (legacy
  rows emitted before this audit — e.g. historical `TRADE`/`MARKET` literals —
  all persisted as `GENERAL` and are indistinguishable from new emissions).
- Missing required fields (`userId`, `title`, `body`) → the create fails loudly
  in dev/CI; producers that must not fail their request wrap in
  `.catch()` with a structured log (never a silent swallow — see the
  payoutBatchWorker fix rationale).
- Stale payload (target later deleted) → navigation no-ops or 404s at the
  destination screen; the notification row is unaffected (soft-dismissal #374
  can hide it per user).
- Historical payloads: rows created before this contract with different key
  spellings (e.g. `metadata` blobs from pre-#270 writers) are tolerated by the
  client (`actionPayload?.['key']` null-safe reads); no backfill is required.
  The static-invariant test added with this PR (`__tests__/notification-payload-contract.pg.test.js`)
  prevents any new producer from re-introducing nonexistent columns
  (`type`/`metadata` at column level), non-enum category literals, or
  `message:` instead of `body:` in `sendNotification` calls.

## 5. The four contract breaks fixed by this PR

1. `reservationController.counterProposeReservation` — created a notification
   with nonexistent `type`/`metadata` columns and invalid `MARKETPLACE`
   category AFTER the reservation update committed → PrismaClientValidationError
   → HTTP 500 for a request that actually succeeded, no notification persisted,
   no socket emit. Fixed: schema-valid create with `COUNTER_PROPOSAL` payload.
2. `reservationController.acceptCounterProposal` — same invalid create after
   the accept committed. Fixed: `COUNTER_PROPOSAL_ACCEPTED` payload.
3. `businessReviewService.createReview` — same invalid create swallowed by a
   silent `catch`: businesses NEVER received review notifications. Fixed:
   `REVIEW_RECEIVED` payload.
4. `payoutBatchWorker._claimForManualReview` — passed `message` where
   `sendNotification` expects `body`, so the required `body` column was
   undefined and every create failed into `.catch(() => {})`: users were never
   told their withdrawal went to manual review. Fixed: `body` +
   canonical `WITHDRAWAL_STATUS` payload.

Plus the normalization repair: `STOREFRONT` was missing from the
`_normalizeCategory` allow-list, so a legitimate enum category was silently
downgraded to `GENERAL` at the persistence boundary — now pinned by test, along
with the category-literal alignment (`TRADE` → `SECURITY_ACCOUNT`/`GENERAL`,
`MARKET` → `GENERAL`) that makes emitted labels match what actually persists.
