AZAMAN V2: THE MASTER SOUL
Identity: Enterprise Neo-Bank & P2P Crypto Exchange Hybrid.
Scale Target: Millions of Users.
This document is the immutable source of truth for the Azaman V2 architecture. It supersedes any legacy code, previous implementations, or generic AI assumptions.

CHANGELOG (most recent first)
- 2026-05-27 — Phase H12: 4-surface deep audit — KYC + savings + analytics + admin (BE PR, in review)
  - **CRITICAL — KYC webhook userId type-coercion bug.** `_extractUserIdFromReference` returned the userId as a STRING, then passed it to `prisma.user.findUnique({ where: { id: userId } })`. User.id is `Int @id @default(autoincrement())`, so a string match throws a P2009 type-coercion error. The entire Dojah webhook flow rejected every callback in production. The mock path didn't trigger this because mock tests POSTed userIds that were string-equal-checked elsewhere. Fix: parse to Int and validate.
  - **CRITICAL — KYC webhook signature verified against re-stringified body.** The previous version computed the expected HMAC against `JSON.stringify(payload)` — i.e. the RE-stringified parsed body. Real webhook providers sign the exact RAW request bytes that came over the wire; re-stringifying a parsed object produces a different byte sequence whenever key ordering, whitespace, or escape rules differ between the sender's JSON encoder and Node's `JSON.stringify`. Production Dojah webhooks would have failed verification consistently. Fix: thread `req.rawBody` (already captured by the `express.json` `verify` hook in `server.js`) through to `_verifyWebhookSignature` and use it for HMAC computation. Hex encoding fixed too — previously `Buffer.from(sig, 'utf8')` was used for both buffers; switched to proper `'hex'` encoding with case + length normalization.
  - **KYC notification key alignment.** `_sendKycResultNotification` was passing `{ message, type }` to `notificationService.sendNotification`, which expects `{ body, category }`. Result: every KYC result notification landed with an empty body and no FCM push body text. Fixed.
  - **KYC `adminOverride` and `getStatus` Int coercion.** Same userId type bug: admin override comes through `req.body.userId` and could be a JSON number or string depending on FE serialization. Both paths now coerce + validate.
  - **CRITICAL — `adminController.rejectWithdrawal` TOCTOU.** Two admins both clicking reject on the same withdrawal would BOTH refund the user. Real money loss. Fixed with the canonical `updateMany({ where: { id, status: 'PENDING' }, data })` pattern from H8 — second concurrent caller throws `WITHDRAWAL_ALREADY_FINALIZED` and the catch block returns 409 with the canonical state.
  - **`adminController.approveWithdrawal` TOCTOU.** Same race shape, but no money moves on approve (disbursement happens in the worker). Effect was double notifications and websocket emits. Same fix.
  - **`adminController.approveKyc` / `rejectKyc` TOCTOU.** Two admins approving simultaneously could both bump `tokenVersion`, double-revoke refresh tokens, fire two notifications. Same conditional-update fix; the `approve` path now does the conditional flip + refresh-token revocation inside one nested transaction.
  - **`savingsController.deposit` missing idempotency key.** Two concurrent deposit calls (network retry, FE double-tap) both passed the balance check, both decremented the user, both inserted goal increment + SavingsDeposit + TransactionHistory rows. Real double-debit. Previous `SAVINGS_DEP_<deposit.id>` txHash used a fresh uuid per call, so the unique constraint never tripped. Fix: accept `clientRequestId` (or `X-Idempotency-Key` header) and use it to derive the txHash. Same pattern as `peerTransferController.sendFunds`.
  - **`savingsWorker._breakStreak` hot-loop + TOCTOU.** The previous version didn't advance `nextDueDate` after breaking the streak — the goal stayed at the same due date forever, and every subsequent worker tick re-fired missed reminders + tried to break a 0-streak again. Two ticks crossing the 48-hour boundary simultaneously could also both pass the `streakCount === 0` early-return AND both increment `missedCount`. Fixed: conditional `updateMany` with `streakCount: { gt: 0 }` and the row's current `nextDueDate` as preconditions, plus the row advances to the next cycle's due date so the schedule moves forward.
  - **`vendorAnalyticsController` date-bucket off-by-one.** `startDate = today - days`, then loop `for i in 0..days` produced buckets for `today-days` through `today-1` — EXCLUDING today. A trade completed today fell outside every bucket and was silently dropped from the timeline (though still counted in the totals). Fix: anchor the window so the LAST bucket is today, with `setHours(0,0,0,0)` for clean day boundaries.
  - **`flagOverpayment`** is unchanged from H11. The H8 follow-up that closed it stays in place.
  - Files (5 + 2 docs): `services/kycService.js`, `controllers/kycController.js`, `controllers/savingsController.js`, `workers/savingsWorker.js`, `controllers/vendorAnalyticsController.js`, `controllers/adminController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase H11: closing the H8/H9 follow-ups — flagOverpayment idempotency + queue gate filter alignment (BE PR, in review)
  - **`flagOverpayment` idempotency.** Filed for follow-up at the end of H8 because flagOverpayment accepts calls from multiple statuses (`PAID, PENDING_PAYMENT, DISPUTED, COMPLETED`) by design and the simple "flip status if PENDING" precondition pattern from H8 didn't fit. The canonical alternative is the `TransactionHistory` `@unique txHash` constraint that the peer-fulfill flow already uses: writing a row keyed `OVERPAYMENT_FREEZE_<tradeId>` as the LAST write inside the `$transaction` means a duplicate flag attempt hits P2002 and the entire transaction (including the disputeEscrowBalance freeze) rolls back. Belt-and-braces: the txHash row also serves as a permanent admin-audit record of the flag, useful for dispute review. Catch block returns `200 idempotent: true` instead of a generic 500.
  - **`initiateTradeWithQueue` filter alignment.** The optimistic queue-gate count used `status: { in: ['PENDING', 'PENDING_PAYMENT', 'PAID'] }` while the canonical in-transaction check in `tradeController.initiateTrade` (CRITICAL-7) used `['PENDING_PAYMENT', 'PAID', 'DISPUTED']`. Two bugs: `PENDING` is never persisted (Trade.status defaults to PENDING_PAYMENT and no code path flips to PENDING), and `DISPUTED` was missing. Drift between the two filters would let a buyer pass the optimistic gate here only to bounce off the canonical check, producing an inconsistent answer and wasted round-trips. NOT a money-loss race — the canonical layer always recomputes inside the trade-creation transaction. Pure UX-consistency fix.
  - Files (3 + 2 docs): `services/p2p.service.js`, `controllers/p2p.controller.js`, `controllers/queueController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase H10: trade history pagination input hardening (BE PR, in review)
  - **`getTradeHistory` cursor coercion.** The previous code did `parseInt(cursor, 10)` on the cursor returned by `parsePagination`. If the FE sent a non-numeric cursor (junk payload, paste error), `parsePagination` passes the raw string through and `parseInt('abc', 10)` returns `NaN`, which Prisma rejects with an opaque P2009 type-coercion 500. Now we type-check + return a clean `400 Invalid cursor` instead.
  - Files (1 + 2 docs): `controllers/tradeController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase H9: Queue + admin + worker TOCTOU fixes (BE PR, in review)
  - **Continuation of Phase H8.** Same atomic-conditional-flip pattern applied to four more financial / coordination flows that had the same race shape.
  - **`queueController.processNextInQueue`** — `findFirst` outside the transaction picked one WAITING row, then `$transaction { update id → PROCESSED }`. Two concurrent calls (vendor completes two trades back-to-back) both saw the same WAITING row, both flipped it, both fired `queue_promoted` to the same buyer. Net result: slot count opened by 2 but only 1 buyer was promoted; a second waiter was never advanced. Fixed with `updateMany({ where: { id, status: 'WAITING' }, data })` and a `'QUEUE_RACE'` throw on count=0 (caught and logged as no-op so the outer trade-complete response stays clean).
  - **`queueController.leaveQueue`** — same TOCTOU shape. Effect mostly benign (idempotent flip to CANCELLED) but a leaveQueue + processNextInQueue race could promote a buyer who just left. Fixed with the conditional updateMany; second concurrent caller gets a 409.
  - **`adminController.forceCancel`** — refunds escrow then flips trade to CANCELLED. Two admins clicking force-cancel on the same disputed trade would both refund escrow before the second would get rejected by the pre-check (which ran outside the transaction). Fix: claim the row FIRST inside the transaction with `updateMany({ where: { id, status: 'DISPUTED' }, data })`. Catch block returns 409 instead of 500.
  - **`adminController.forceRelease`** — similar pattern. The status flip from DISPUTED → PAID happened OUTSIDE any transaction, then `p2pService.completeTrade` was invoked. The H8 fix on completeTrade catches the duplicate at the second layer, but a failed completeTrade would leave the trade stranded in PAID. With the conditional flip here, only one admin's call ever reaches completeTrade.
  - **`workers/tradeWorker._autoCancelTrade`** — the expired-trade scan happens outside the transaction. Two consecutive worker ticks (or worker tick racing with buyer's manual cancel) could both pick up the same trade and both refund the escrow. Fixed with the conditional updateMany; catch block treats `TRADE_ALREADY_FINALIZED` as a quiet skip log instead of an error.
  - **`server.js` `vendor_accept` socket handler** — vendor's network retry would double-emit `trade_update` and double-write notifications. Conditional updateMany on the PENDING / PENDING_PAYMENT precondition; second ack returns silent no-op.
  - **`initiateTradeWithQueue` count-based race left as a known follow-up** — the `activeTrades < maxConcurrentTrades` check could let two buyers slip through the gate. Worst-case effect: vendor temporarily exceeds their concurrent-trade cap by 1. Filed for a future fix that needs a SELECT FOR UPDATE on the vendor row or a DB-level constraint.
  - Files (4 + 2 docs): `controllers/queueController.js`, `controllers/adminController.js`, `workers/tradeWorker.js`, `server.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase H8: TOCTOU race fixes — atomic conditional status flips on financial flows (BE PR, in review)
  - **CRITICAL — `completeTrade` was vulnerable to DOUBLE PAYOUT.** The status check (`trade.status === 'PAID'`) happened OUTSIDE the `prisma.$transaction`. Two concurrent `completeTrade` calls (vendor double-tapping the release button under bad latency) both saw PAID, both passed the auth check, and both entered the transaction — escrow drained twice, counterparty credited twice, admin fees doubled. Unlike peer-transfer fulfill, there was NO unique constraint to catch the duplicate. Real money loss.
  - **Canonical Prisma pattern applied across five flows**: `p2pService.completeTrade`, `p2pService.markUnderpaid`, `peerTransferController.fulfillTransferRequest`, `peerTransferController.declineTransferRequest`, and `tradeController.markAsPaid`. Each transaction now opens with an `updateMany({ where: { id, status: <expected> }, data })` — Prisma's atomic conditional update — and aborts via `throw new Error('TRADE_ALREADY_FINALIZED')` (or `'ALREADY_FINALIZED'`) when `count === 0`. The second concurrent caller never moves any money / never writes any messages. The status field doubles as a per-row mutex.
  - **Why `updateMany` instead of `update`.** Prisma's `update` requires a `@unique` field in `where`; `status` is not unique. `updateMany` accepts any predicate and returns `{ count }` so we can detect "no row matched the precondition" (i.e. someone else already flipped it). The pattern is documented in Prisma docs as "atomic conditional update" and is the standard idiom for this race.
  - **Belt & braces.** The `txHash` `@unique` constraint on `TransactionHistory` (peer-fulfill flow) is preserved as the second line of defence. If a refactor accidentally drops the conditional update, the unique constraint still aborts the duplicate transaction.
  - **Idempotent error handling.** Each of the five callers catches `*_ALREADY_FINALIZED` (or queries the canonical row) and returns `200 idempotent: true` with the final state, so the FE doesn't surface a scary "Cannot mark as paid: trade status changed concurrently" error for what is essentially "you double-tapped".
  - **`markAsPaid`**: previous code path could write TWO `IMAGE_PROOF` chat messages for one buyer upload (Postgres last-writer-wins on the `update`, but both transactions committed). Conditional `updateMany` rejects the duplicate cleanly so we never write the second pair of messages.
  - **`flagOverpayment` left untouched** for now. It accepts calls from multiple statuses (`PAID, PENDING_PAYMENT, DISPUTED, COMPLETED`) by design and the simple status-precondition pattern doesn't fit cleanly. Filed for a follow-up that adds a unique `(tradeId, source='OVERPAYMENT_FREEZE')` row in TransactionHistory or AdminProfitLog so duplicate flags are rejected at the DB layer.
  - Files (4 + 2 docs): `services/p2p.service.js`, `controllers/p2p.controller.js`, `controllers/peerTransferController.js`, `controllers/tradeController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase UI-7-B: Trust signals on the FriendsHub list (BE — getFriends batched aggregation)
  - **No new schema migration.** Pure controller upgrade.
  - **`getFriends` extended** with the same trust signals already returned by `chatProfileController.getProfile`/`getTrustMetrics`: each friend row now carries `completedTransactions` (global), `rating` (5-star, null when no reviews), `isVerifiedVendor`, plus the existing `kycStatus` / `tradesCompleted` / `completionRate` / `isVerified`.
  - **Independent of N.** Computation adds 4 batched `prisma.groupBy` calls (sentTransfers, receivedTransfers, createdTickets, counterTickets) instead of 4×N — page size of 20 still costs 4 queries. Each wrapped in `.catch(() => [])` so a single index hiccup never blocks the chat list from rendering. Maps key by `friend.id` so the per-row enrichment is O(1).
  - **Same definition** as Phase UI-6: `completedTransactions = User.tradesCompleted + sum(PeerTransfer COMPLETED) + sum(Ticket CLOSED)`. The chat AppBar, the vault identity tier, and now the friends list all share one source of truth.
  - Files (1 + 2 docs): `controllers/friendController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase UI-7: Trust breakdown drilldown (BE — `getTrustMetrics` + `getProfile` enrichment)
  - **No new schema migration.** Pure controller addition — same three columns/relations the Phase UI-6 sum used (`User.tradesCompleted`, `PeerTransfer status=COMPLETED`, `Ticket status=CLOSED`), now also returned individually.
  - **`getTrustMetrics` extended** with a `breakdown` object: `{ tradesCompleted, completedTransfers, closedTickets }`. The total still ships in `completedTransactions` so existing FE code that only reads the rolled-up number keeps working unchanged.
  - **`getProfile` mirrors the change** — the friend object on the vault profile payload now carries `completedTransactionsBreakdown` so the Chat Profile vault identity tier card and the AppBar tap-popup share one source of truth and never re-aggregate.
  - **No new DB queries.** The two `count()` calls + one `User.findUnique()` were already fired in UI-6; the breakdown object simply exposes the per-source numbers we already had in scope.
  - Files (1 + 2 docs): `controllers/chatProfileController.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-27 — Phase UI-6: Social Trust Metrics in chat header (BE — new endpoint + getProfile enrichment)
  - **No new schema migration.** Pure controller work — every field consumed (`User.tradesCompleted`, `User.positiveReviews`, `User.negativeReviews`, `User.role`, `User.kycStatus`, `PeerTransfer.status`, `Ticket.status`) shipped in earlier phases.
  - **New `GET /api/friends/:friendshipId/trust-metrics`** in `controllers/chatProfileController.js` `getTrustMetrics`. Lightweight subset of `getProfile` — skips the mutual-trade aggregation and nickname JSON pluck because the chat AppBar opens far more often than the vault screen and shouldn't pay for them. Two parallel `prisma.peerTransfer.count` + `prisma.ticket.count` calls (each wrapped in `.catch(() => 0)` so a single index hiccup never breaks the AppBar) plus one User row. Participant-gated via the existing `_verifyParticipant` helper.
  - **Response shape:** `{ success: true, metrics: { completedTransactions, rating, positiveReviews, negativeReviews, isVerifiedVendor, kycStatus } }` where `rating` is the 5-star projection of `positiveReviews / (positiveReviews + negativeReviews) * 5` (one decimal place) or `null` when the friend has zero reviews.
  - **The metric is GLOBAL, not just P2P.** Per the product brief, trust applies to BOTH regular users and vendors because every successful transaction has two committed parties. `completedTransactions` aggregates three signals:
      - `User.tradesCompleted` (P2P escrow trades — the existing reputation column maintained by the trade settlement flow)
      - `count(PeerTransfer status=COMPLETED)` where user was sender OR receiver (off-ticket money transfers — the "send money with a tracking reason" PeerTransfer flow)
      - `count(Ticket status=CLOSED)` where user was creator OR counterparty (deal-tracking workspaces from Phase UI-4)
  - **`getProfile` also enriched** with the same `completedTransactions`, `rating`, and `isVerifiedVendor` fields on the friend object so the Chat Profile vault screen's identity tier card can surface them in a future polish pass without a second round-trip.
  - **Verified vendor flag** is computed as `role === 'VENDOR' && kycStatus === 'VERIFIED'`. Normal users with `kycStatus === 'VERIFIED'` are NOT flagged because the brief reserves the verified ✓ badge for approved vendors specifically.
  - Mounted in `routes/friendRoutes.js` under the existing `/api/friends/:friendshipId/...` block alongside the Phase UI-5 vault aggregators.
  - Files (2 + 2 docs): `controllers/chatProfileController.js`, `routes/friendRoutes.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-26 — Phase UI-5: Chat Profile + Transaction Vault (BE — aggregator endpoints + transfer receipt PDF)
  - **No new schema migration.** `Friendship.localNicknames` JSONB shipped with Phase UI-4. This phase is pure controller / service work consuming the existing column.
  - **New `controllers/chatProfileController.js`** with five endpoints, all `protect`-gated, all participant-only:
    - `GET   /api/friends/:friendshipId/profile` — identity tier (friend's username, avatar, KYC, completion stats, loyalty tier, account age) + caller's local nickname for the friend + mutual P2P trade count.
    - `PATCH /api/friends/:friendshipId/nickname` — body `{nickname: string|null}`. Stores the caller's nickname for the friend under the observer's userId in `Friendship.localNicknames`. Empty string or null clears. 40-char cap.
    - `GET   /api/friends/:friendshipId/media?type=IMAGE|VIDEO&limit=` — chronological union of DirectMessage + TicketMessage rows with `messageType IN (IMAGE, VIDEO)`. Each row carries a `source: 'DIRECT'|'TICKET'` discriminator.
    - `GET   /api/friends/:friendshipId/docs-links?limit=` — same pattern for DOCUMENT + LINK types.
    - `GET   /api/friends/:friendshipId/receipts?status=&cursor=&limit=` — paginated PeerTransfer history projected as receipt-shaped rows with direction relative to the caller. COMPLETED rows include a `downloadUrl` to the new transfer-receipt PDF endpoint.
  - **Receipts vault tab (vault tab 4) is built on PeerTransfer.** Receipts are immutable records of direct P2P off-ticket money transfers — the existing "send money with a tracking reason" flow. They cleanly differentiate casual balance transfers from structured ticket deals or formal P2P trade settlements.
  - **`receiptService.js` extended** with `generateTransferReceipt(transfer, observer)`. Returns a branded PDF Buffer with reference (TRF-{first 12 of uuid}), date, status badge, amount + currency, direction relative to observer, masked counterparty, optional memo, type (SEND/REQUEST), QR verification code, footer disclaimer.
  - **`receiptController.getTransferReceipt`** added and routed at `GET /api/receipts/transfer/:id`. Authorization: caller must be sender or receiver. Status must be COMPLETED. Returns `application/pdf` attachment.
  - **No vault tab 3 (Tickets) endpoint added** — the existing `GET /api/tickets?friendshipId=` from Phase UI-4 is reused by the FE.
  - **Mutual trade count.** The profile endpoint includes a non-blocking aggregate count of completed P2P trades where one party was the friend's vendor and the other was the friend (or vice versa). Falls back to 0 on query error.
  - Files (3 + 2 docs): `controllers/chatProfileController.js` (NEW), `controllers/receiptController.js` (+ getTransferReceipt), `services/receiptService.js` (+ generateTransferReceipt), `routes/friendRoutes.js` (+ 5 route entries), `routes/receiptRoutes.js` (+ 1 transfer route). Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-26 — Phase UI-4: Tickets Engine (BE — schema + endpoints + sockets)
  - **Schema migration `20260526_phase_ui4_tickets_engine`.** New `TicketType` (BUY | SELL | ESCROW | SERVICE_SWAP) and `TicketStatus` (OPEN | CLOSED | CANCELLED) enums. New `Ticket` and `TicketMessage` tables. `Friendship.localNicknames` JSONB column shipped now (used by the upcoming Phase UI-5 Chat Profile Detail screen).
  - **`Ticket` model:** `id`, `friendshipId`, `creatorId`, `counterpartyId`, `name` (≤80 chars), `type`, `targetAmount` (`Decimal(20,8)`), `targetCurrency` (≤8 chars), `memo` (≤500 chars), `status`, `createdAt`, `updatedAt`, `closedAt`, `cancelledAt`, `lastActivityAt`. Composite index `(friendshipId, status, lastActivityAt DESC)` powers the dashboard query.
  - **`TicketMessage` model** reuses every Phase UI-3 media column (`mediaUrl`, `mediaType`, `mediaMimeType`, `mediaSize`, `mediaDuration`, `mediaWaveformPeaks`, `linkPreview`) so `chat_media_bubble.dart` renders identically in tickets and direct chat.
  - **Six REST endpoints** in `controllers/ticketController.js`:
    - `POST /api/tickets` — create. Type-specific validation, requires ACCEPTED friendship, injects TICKET_LINK event card into parent friendship chat.
    - `GET /api/tickets?friendshipId=&status=&cursor=&limit=` — paginated list (cursor, max 100/page).
    - `GET /api/tickets/:id` — full ticket + last 50 messages (chronological).
    - `POST /api/tickets/:id/messages` — send message; reuses media columns; forbidden on non-OPEN tickets (HTTP 409); opportunistic OG fetch for LINK type.
    - `PATCH /api/tickets/:id/status` — close / cancel / reopen with legal-transition guard. Sets `closedAt` / `cancelledAt` timestamps and re-injects an event card into the parent chat.
    - `POST /api/tickets/:id/presence` — `{viewing: bool}` REST presence ping for the counterparty banner.
  - **`services/ticketSocketService.js`** handles three client-emitted events: `join_ticket`, `leave_ticket`, `ticket_typing`. Joining/leaving a ticket room also fans out `ticket_presence_update` to the parent friendship room so the banner appears/clears in real time.
  - **Server-emitted socket events:** `ticket_created`, `ticket_message`, `ticket_status_changed`, `ticket_presence_update`. All fan out to both users' personal rooms so the inbox badge updates even if neither has the workspace open.
  - **Integration rules:** Tickets do NOT touch any wallet column. They are pure chat artifacts. Tickets do NOT trigger AZM rewards. Closing/cancelling is non-destructive — messages stay readable, posting locks, status badge updates.
  - Files (4 + 1 migration + 2 docs): `prisma/schema.prisma`, `prisma/migrations/20260526_phase_ui4_tickets_engine/migration.sql` (NEW), `controllers/ticketController.js` (NEW), `routes/ticketRoutes.js` (NEW), `services/ticketSocketService.js` (NEW), `server.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-26 — Phase UI-3: Chat Media Infrastructure (BE — schema + endpoints + service)
  - **Schema migration `20260526_phase_ui3_chat_media`.** Extends `MessageType` with `IMAGE`, `VIDEO`, `DOCUMENT`, `AUDIO`, `LINK`. Extends `DirectMessageType` with the same five values plus `TICKET_LINK` (reserved for Phase UI-4 — used to inject ticket event cards into the parent friendship chat). Adds seven media columns to both `Message` and `DirectMessage`: `mediaUrl`, `mediaType`, `mediaMimeType`, `mediaSize`, `mediaDuration`, `mediaWaveformPeaks` (JSONB int array, audio only), `linkPreview` (JSONB OG metadata). All nullable so legacy TEXT messages parse unchanged.
  - **New `LinkPreviewCache` table.** `urlHash` (sha256 of normalised URL, unique), `url`, `title`, `description`, `image`, `favicon`, `siteName`, `status` (OK | FAILED | TIMEOUT | BLOCKED), `fetchedAt`, `expiresAt`. Indexed on `urlHash` + `expiresAt` for fast lookups and cache-sweeping.
  - **New service `services/linkPreviewService.js`.** Server-side Open Graph fetcher with persistent caching. URL normalisation strips utm_*/gclid/fbclid/ref_src tracking params and lowercases the host so two paths differing only by analytics garbage hash to one cache row. 6s network budget per URL, 256KB HTML read cap, 24h success TTL, 1h failure TTL. Direct image URLs synthesise a minimal preview (`{ image: url, siteName: host }`).
  - **Four typed authenticated upload endpoints** added in `server.js`:
    - `POST /api/chat/upload/image` — 10MB, image/* mime types. Returns `{ url, mimeType, size, filename }`.
    - `POST /api/chat/upload/audio` — 5MB, m4a/mp4/webm/ogg/aac/wav. Optional `duration` and `waveformPeaks` body fields stored verbatim. Returns `{ url, mimeType, size, duration, waveformPeaks }`.
    - `POST /api/chat/upload/video` — 50MB, video/* mime types. Optional `duration` body field. Returns `{ url, mimeType, size, duration }`.
    - `POST /api/chat/upload/document` — 25MB, pdf/docx/xlsx/pptx/txt/csv. Returns `{ url, mimeType, size, filename }`.
    All four are gated by `protect` (JWT). Storage convention: `uploads/chat/<userId>/<kind>/<filename>` so we can audit and garbage-collect per-account.
  - **`POST /api/chat/link-preview`** — body `{ url }`, returns `{ success, preview }` where preview is the cached/freshly-fetched LinkPreviewCache row.
  - **Legacy `/api/chat/upload-media` retained** (image-only, 8MB, unauth) to avoid breaking older clients. New clients target the typed routes.
  - **`directMessageController.sendMessage` extended.** Accepts all seven media fields plus a `metadata.ticketId` for the future TICKET_LINK type. Validation: media-typed messages require `mediaUrl`; TICKET_LINK requires `metadata.ticketId`; TEXT requires a non-empty `content`. For LINK type, opportunistically fetches OG metadata server-side if the client didn't supply `linkPreview`. FCM push body adapts per media type (📷 Photo, 🎥 Video, 🎙️ Voice message, 📄 Document, 🔗 Shared a link, 🎟️ Created a ticket).
  - **No coordination required from older socket consumers.** Newer payloads carry the new fields; older clients ignore unknown fields and render the message via its `messageType` fallback (TEXT path).
  - Files (4 + 1 migration + 2 docs): `prisma/schema.prisma`, `prisma/migrations/20260526_phase_ui3_chat_media/migration.sql` (NEW), `services/linkPreviewService.js` (NEW), `controllers/directMessageController.js`, `server.js`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-26 — Phase UI-1: Sprint Framework Documented (BE — docs only)
  - **No code change.** Master soul §15 added to document the 5-task UI/UX sprint roadmap (UI-1 through UI-5). Tasks 1-2 are FE-only; Tasks 3-5 require BE collaboration (chat media uploads + link previews, Tickets engine schema/endpoints/sockets, Chat Profile vault aggregators + receipt generator extension).
  - **Task 1 (UI De-cluttering, FE PR in review):** zero backend touch.
  - **Tasks 3-5 backend deliverables sketched in §15.3-§15.5** as the contract for upcoming PRs (chat media columns + upload endpoints + linkPreviewService; Ticket + TicketMessage models + REST endpoints + socket events; Friendship.localNicknames + media/docs-links/tickets/receipts aggregator endpoints + transfer-receipt PDF extension).
  - Files (1 doc): `AZAMAN_MASTER_SOUL.md` — §15 framework block.
- 2026-05-25 — Phase V-3: Vendor Application Real-Time Notifications (merged, BE PR #81)
  - Socket event `vendor_application_new` emitted to `admin_spy_room` when new application submitted (admin War Room live updates without page refresh).
  - In-app notification sent to user via `notificationService` on approve/reject (shows in notification bell alongside email).
  - Both non-fatal: failures don't break the primary application/review flow.
- 2026-05-25 — Phase V-2: Vendor Document Upload + Email Notifications (merged, BE PR #80)
  - `POST /api/vendor/upload-docs` — multer endpoint for vendor KYC documents (5MB, image-only, `uploads/vendor/` directory). Accepts multipart fields: `idFront`, `idBack`, `selfie`, `addressProof`. Returns uploaded file URLs.
  - `submitApplication` controller updated to persist `idImageFront`/`idImageBack`/`selfieWithId`/`proofOfAddress` URL fields from the upload response.
  - `reviewApplication` now sends branded HTML email on approve/reject via existing emailService (approval: feature list + re-login reminder; rejection: reason + reapply invitation). Email failure doesn't break review.
- 2026-05-25 — Chore: Remove orphan dead code (merged, BE PR #82)
  - Deleted `services/serviceIntegrator.js` (639 LOC dead facade never imported by production code).
  - Deleted `test_services.js` (standalone script only exercising the dead facade).
  - `imageController.js` confirmed already deleted in prior phase.
- 2026-05-25 — Phase Q11: Transaction Receipt PDFs (in review, BE)
  - **DOWNLOADABLE PDF RECEIPTS.** Users can now download branded PDF receipts for completed trades and withdrawals. Each receipt includes: Azaman branding header, transaction reference ID, date, amounts (crypto + fiat), counterparty (masked username), payment method, status, timestamps, duration, and a QR code linking to a verification URL.
  - **New service:** `services/receiptService.js` — PDFKit-based PDF generation. Two public functions: `generateTradeReceipt(trade, user)` and `generateWithdrawalReceipt(withdrawal, user)`. Features: branded header with green accent divider, labeled key-value rows, masked counterparty names (first 3 chars + ***), masked withdrawal destinations (first 4 + **** + last 4), QR code generation via existing `qrcode` package, print-ready footer with disclaimer and generation timestamp. Vendor profit cut shown only to the vendor party.
  - **New controller:** `controllers/receiptController.js` — 2 endpoints: `getTradeReceipt` (GET /api/receipts/trade/:tradeId), `getWithdrawalReceipt` (GET /api/receipts/withdrawal/:id). Both: require authentication, verify requesting user is a party to the transaction, reject if status ≠ COMPLETED, return PDF binary with `Content-Disposition: attachment` and `Cache-Control: private, max-age=3600`.
  - **New routes:** `routes/receiptRoutes.js` — mounted at `/api/receipts` with `generalLimiter`.
  - **New dependency:** `pdfkit: ^0.16.0` added to package.json (pure-JS PDF generation, no native deps, no Chromium).
  - **Security:** Only transaction parties can download their own receipts. Trade receipts check both buyer and vendor; withdrawal receipts check owner. Non-COMPLETED transactions return 400 with explanatory message.
  - Files (5 + 2 docs): `services/receiptService.js` (NEW), `controllers/receiptController.js` (NEW), `routes/receiptRoutes.js` (NEW), `server.js` (import + mount), `package.json` (+pdfkit). Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase Q6: KYC Integration Prep — Dojah (in review, BE PR #70)
  - **AUTOMATED IDENTITY VERIFICATION.** Replaces the legacy manual-upload KYC flow with Dojah widget-based verification. Users complete identity checks inside the Dojah widget; results arrive via HMAC-secured webhook. Admin manual override preserved as fallback.
  - **New service:** `services/kycService.js` — full rewrite. Dojah API integration (`initializeSession` → POST to Dojah, returns widget URL), HMAC-SHA256 webhook verification (`processWebhook`), confidence-based auto-determination (≥70 → VERIFIED, <40 → REJECTED, between → PENDING for admin), admin override, enriched status with `canReinitialize` flag. MOCK mode (default) for dev/CI.
  - **Rewritten controller:** `controllers/kycController.js` — 4 endpoints: `initializeKyc` (auth), `handleDojahWebhook` (HMAC-only), `getKycStatus` (auth), `adminKycOverride` (admin). Webhook always returns 200 to prevent retry storms.
  - **Rewritten routes:** `routes/kycRoutes.js` — legacy file-upload `/submit` route removed (Dojah handles document capture). New: POST `/initialize`, POST `/webhook/dojah`, POST `/admin/override`.
  - **Service singleton:** KYCService instantiated in `server.js` after notificationService, registered via `app.set('kycService')`.
  - **Env vars (8):** `KYC_PROVIDER`, `DOJAH_APP_ID`, `DOJAH_PUBLIC_KEY`, `DOJAH_SECRET_KEY`, `DOJAH_WIDGET_ID`, `DOJAH_WEBHOOK_SECRET`, `KYC_AUTO_APPROVE_THRESHOLD`, `KYC_AUTO_REJECT_THRESHOLD`.
  - **No schema migration required.** Existing `KycStatus` enum + User fields sufficient.
  - Files (5 + 2 docs): `services/kycService.js`, `controllers/kycController.js`, `routes/kycRoutes.js`, `server.js`, `.env.example`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase Q (Master Plan): Full product decisions documented (in review, BE)
  - **PRODUCT ARCHITECTURE EXPANSION.** Persists all strategic decisions from the 2026-05-25 product session into the living documentation. Adds §8–§14 to the Master Soul covering: Admin Fee Profiles (dynamic margin/split control), Vendor Wallet Archiving (soft-delete + security), Ghana Vendor Fiat Payouts (local MoMo for vendors), KYC Integration Prep (Dojah), UI Premium Mandate (chat input redesign, polish requirements), and 6 additional feature specifications (receipt PDFs, rate alerts, vendor badges, dispute workflow, version gate, vendor analytics).
  - **Roadmap expanded from 6 items to 22.** Full Q-series (Q1–Q16) covering every remaining gap between current state and production-ready launch.
- 2026-05-25 — Phase J3: Float→Decimal Migration (merged 2026-05-25, BE PR #68)
  - **DATA INTEGRITY FIX.** All 63 `Float` (DOUBLE PRECISION) columns across 14 models converted to `Decimal`/NUMERIC with explicit precision/scale. Eliminates floating-point rounding errors in financial calculations at the database level.
  - **Precision tiers:** `Decimal(20,8)` for monetary amounts, `Decimal(18,8)` for exchange rates, `Decimal(10,4)` for percentages/margins, `Decimal(5,2)` for completionRate.
  - **Runtime transparency:** Global `Prisma.Decimal.prototype.valueOf()` and `.toJSON()` patches in `server.js` ensure all existing arithmetic operators and JSON serialization work identically to pre-migration Float behavior. Zero controller changes required.
  - **Critical discovery:** decimal.js default `valueOf()` returns a STRING (not a number), which would cause `+` to concatenate. The override to return `Number(this.toString())` fixes all arithmetic globally.
  - Files (4): `prisma/schema.prisma`, `prisma/migrations/20260525_phase_j3_float_to_decimal/migration.sql`, `server.js`, `utils/decimalHelper.js`.
- 2026-05-25 — Phase F2: P2P Architecture Correction — global fiat wallet bridge (in review, BE)
  - **CRITICAL BUSINESS LOGIC CORRECTION.** The P2P marketplace was incorrectly built as a GHS↔USDC exchange with oracle rate math (`liveRate`, `effectiveRate`, `adminMarginGhs`). That model is WRONG. The P2P marketplace is exclusively a **liquidity bridge for global fiat wallets** (Zelle, CashApp, Venmo, PayPal, Apple Pay, Gift Cards, etc.) that the platform cannot natively integrate. GHS/MoMo deposits and withdrawals are handled entirely by the internal Admin Liquidity Pool (Kotani Pay gateway).
  - **What this PR does:**
    1. Strips all GHS oracle math from P2P trade initiation and completion. Trades are evaluated in USDC directly (1 USDC ≈ 1 USD). No rate conversion.
    2. Implements type-specific validation for `TradeAccount.accountDetails` (11 supported methods: Zelle, CashApp, Venmo, PayPal, Apple Pay, Google Pay, Wise, Revolut, Gift Cards, Western Union, Wire Transfer). Each type has a defined schema of required fields.
    3. Replaces the legacy GHS margin model with a flat `P2P_FEE_PCT` (2%) applied to the USDC amount.
    4. Ads now link to a specific vendor `TradeAccount` via `tradeAccountId` FK.
    5. SELL-ad trade initiation now captures buyer's recipient payment details (validated against the ad's method type).
    6. Trade `currency` field for P2P trades set to `'USD'` (not GHS), `rate` is `1.0`.
  - **Escrow model (unchanged from Phase F, now corrected for math):**
    - BUY ad: vendor escrows `amountCrypto` USDC
    - SELL ad: user escrows `amountCrypto` USDC
  - **Full design documented in AZAMAN_MASTER_SOUL.md §4.1–§4.3.**
- 2026-05-25 — Phase F: Re-enable BUY ads with corrected settlement model (merged 2026-05-25, BE PR #65)
  - **~80 LOC delta across 5 files + .env.example.** Removes the Phase D-1 `BUY_ADS_ENABLED` env-flag gates and fixes the BUY-ad settlement model so it correctly handles escrow.
  - **Gate removal.** `adController.createAd` and `tradeController.initiateTrade` no longer return 503 for BUY ads. Both ad creation and trade initiation are now fully supported for both SELL and BUY types.
  - **BUY-ad escrow fix (tradeController.initiateTrade).** The previous code escrowed `amountCrypto * effectiveRate` (a GHS-denominated value inherited from the legacy AZM column) into the USDC-denominated `escrowLockedBalance`. Fixed to escrow `amountCrypto` (the raw USDC amount the user is selling to the vendor).
  - **BUY-ad completion fix (p2p.service.js completeTrade).** Previously credited the user (crypto seller) with USDC and never decremented their escrow. Fixed: user's `escrowLockedBalance` is decremented, vendor receives the net USDC (minus admin cut), user receives nothing in USDC (they received fiat off-platform).
  - **BUY-ad cancel/refund fix (tradeWorker + adminController).** Previously only credited `availableBalance` without decrementing `escrowLockedBalance`. Fixed: both the decrement and credit happen atomically, preventing ledger drift.
  - **BUY-ad underpayment fix (p2p.service.js markUnderpaid).** Now correctly identifies who escrowed what based on `trade.type`: SELL = vendor escrowed, BUY = user escrowed. Partial-release and refund paths adjusted accordingly.
  - **Notifications.** completeTrade now emits role-appropriate messages for BUY ads ("Crypto Released" to user, "USDC Received" to vendor) vs SELL ads (unchanged).
  - Files (5 + .env + 2 docs): `controllers/adController.js`, `controllers/tradeController.js`, `services/p2p.service.js`, `workers/tradeWorker.js`, `controllers/adminController.js`, `.env.example`. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase E2-FE: AZM Spend UI — fee discount + ad boost (in review, FE)
  - **Frontend companion to BE PR #63 (Phase E2).** Five files: new AZM spend service, new Riverpod spend provider, withdrawal screen fee-discount selector, vendor dashboard ad-boost sheet, socket `azm_spend` listener.
  - **Withdrawal fee discount.** "USE AZM TO REDUCE FEE" selector section in the MoMo withdrawal flow. Three tier chips with affordability. Fee preview updates live with strikethrough + green discount. AZM debited before withdrawal fires.
  - **Ad boost purchase.** "BOOST AD" button on active ad cards. Bottom sheet with 3 duration options. Boosted ads show green badge + countdown. Extend button for already-boosted.
  - **Real-time updates.** Socket `azm_spend` listener updates balance + spend provider affordability state.
- 2026-05-25 — Phase E2: AZM Spend Mechanics — fee discounts + ad boosts (in review, BE)
  - **~450 LOC across 9 files + 1 migration.** Implements the AZM spend pipeline declared in E1's roadmap. Users can now SPEND their earned AZM on premium features.
  - **New service:** `services/azmSpendService.js` — canonical AZM debit pipeline. Every AZM spend flows through `debitAzm()` which atomically: (1) checks balance sufficiency, (2) decrements `user.azmBalance`, (3) writes an `AzmSpendLog` audit row, (4) emits an `azm_spend` socket event. Throws on insufficient balance (caller handles 400).
  - **Two spend actions wired:**
    - `FEE_DISCOUNT` — spend AZM to reduce the 2% fiat withdrawal exit fee. Three tiers: 10 AZM → 25% off, 25 AZM → 50% off, 50 AZM → free withdrawal. Wired into `withdrawalController.fiatWithdrawal` via optional `feeDiscountTierId` body param. Also available standalone via `POST /api/azm/spend/fee-discount`.
    - `AD_BOOST` — spend AZM for temporary featured ad placement in the marketplace. Three durations: 15 AZM → 24h, 35 AZM → 72h, 80 AZM → 7 days. Boosted ads sort first in the marketplace query. Expired boosts are lazily cleaned up on marketplace reads. Stackable (extending while active adds to the remaining time).
  - **New schema:** `AzmSpendLog` model (mirrors AzmRewardLog structure for debits). `Ad.isBoosted` Boolean + `Ad.boostExpiresAt` DateTime added. New composite index on `(isBoosted DESC, status, createdAt DESC)` for marketplace boost sorting.
  - **Four new API endpoints:**
    - `GET /api/azm/spend/options` — returns spend tiers + affordability based on user's balance
    - `POST /api/azm/spend/fee-discount` — standalone fee discount purchase
    - `POST /api/azm/spend/ad-boost` — boost an owned active ad
    - `GET /api/azm/spend/history` — paginated spend history (cursor-based)
  - **Marketplace modification:** `adController.getMarketplaceAds` now orders by `isBoosted DESC` first so boosted ads appear at the top. Expired boosts are lazily un-flagged on read via `setImmediate` DB cleanup.
  - Files (9 + 1 migration): `services/azmSpendService.js` (NEW), `controllers/azmSpendController.js` (NEW), `routes/azmRoutes.js` (updated), `controllers/withdrawalController.js`, `controllers/adController.js`, `services/finance.service.js`, `server.js`, `prisma/schema.prisma`, migration SQL. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase E1: AZM Earn Mechanics — full loyalty-point reward pipeline (merged 2026-05-25, BE PR #62)
  - **~400 LOC across 10 files + 1 migration.** Implements the AZM earn pipeline declared in the D-3 architecture correction. Users now ACTUALLY earn AZM through platform activity. Previously the azmBalance column existed but was never credited.
  - **New service:** `services/azmRewardService.js` — canonical AZM credit pipeline. Every AZM credit flows through `creditAzm()` which atomically: (1) increments `user.azmBalance`, (2) writes an `AzmRewardLog` audit row, (3) emits an `azm_reward` socket event for real-time FE updates. Idempotent via dedup keys.
  - **Five earn sources wired:**
    - `TRADE_COMPLETE` — buyer earns 5.0 AZM per completed trade (via p2p.controller.js, fire-and-forget post-response)
    - `LOGIN_STREAK` — 1.0 AZM per consecutive login day + milestone bonuses (5.0 at 7-day, 20.0 at 30-day, 50.0 at 90-day) (via authController.js login flow)
    - `REFERRAL_BONUS` — referrer earns 10.0 AZM when their referred user completes first trade (via p2p.controller.js, checks TransactionHistory count)
    - `ACHIEVEMENT_UNLOCK` — 2.0–25.0 AZM per achievement tier (COMMON/RARE/EPIC/LEGENDARY) (via vendorGamificationService.js + p2p.service.js)
    - `MILESTONE` — 50.0–500.0 AZM at volume milestones ($1k/$10k/$50k/$100k) (via p2p.controller.js)
  - **New schema:** `AzmRewardLog` model with userId, amount, reason, source, metadata (JSON), balanceAfter. Indexed for fast user-scoped queries. `AZM_REWARD` added to TransactionType enum.
  - **Three new API endpoints:** `GET /api/azm/history` (paginated, cursor-based), `GET /api/azm/summary` (aggregate stats by source), `GET /api/azm/rates` (public — current earn rate schedule).
  - **Wiring pattern:** all earn calls are fire-and-forget via `setImmediate`. AZM reward failures cannot fail trades, logins, or gamification. Errors logged with stable prefixes for ops monitoring.
  - Files (10 + 1 migration + 2 docs): `services/azmRewardService.js` (NEW), `controllers/azmRewardController.js` (NEW), `routes/azmRoutes.js` (NEW), `controllers/authController.js`, `controllers/p2p.controller.js`, `services/p2p.service.js`, `services/vendorGamificationService.js`, `server.js`, `prisma/schema.prisma`, migration SQL. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase D-3: Restore azmBalance as independent loyalty-point ledger (merged 2026-05-25, BE PR #61)
  - **CRITICAL ARCHITECTURE CORRECTION.** Phase D-2 incorrectly interpreted "AZM is not a blockchain token" as "AZM should be deleted." The correct interpretation: AZM is an independent platform reward point (like Binance BNB or airline miles) that users earn and spend separately from their USDC cash balance. It is NOT a derived UI label.
  - **What this PR does.** Restores the `azmBalance` column on the User table via a new migration. Re-adds `azmBalance` to all API response payloads (auth, profile, socket balance_update). Re-adds the CHECK constraint (>= 0). Updates architecture docs.
  - **What stays from D-2.** Trade settlement remains in USDC (to `availableBalance`). The BUY-ad escrow fix (availableBalance → escrowLockedBalance) stays. The single-rail withdrawal model (debit availableBalance) stays. These were correct changes.
  - **AZM design (corrected).** AZM is an independent loyalty ledger. Users earn AZM through: trade completions, referrals, login streaks, achievements. Users spend AZM on: fee discounts, premium ad-tier unlocks, boosted visibility. AZM is NEVER derived from availableBalance × rate. It has its own earn/spend mechanics controlled entirely by the backend.
  - **Migration.** `ALTER TABLE "User" ADD COLUMN "azmBalance" ... DEFAULT 0.0` + CHECK constraint. Users start fresh at 0.0 (D-2's conversion of old AZM → USDC remains in availableBalance — that USDC is theirs to keep).
  - Files (7 + 1 migration + 2 docs): `prisma/schema.prisma`, `controllers/authController.js`, `controllers/profileController.js`, `controllers/ssoController.js`, `controllers/adminController.js`, `server.js`, migration SQL. Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase D-2: Eliminate azmBalance — settle in availableBalance (merged 2026-05-25, BE PR #59) **⚠️ PARTIALLY REVERTED by D-3**
  - **What D-2 did correctly (kept):** Trade settlement unified on availableBalance (USDC). BUY-ad escrow uses availableBalance → escrowLockedBalance. Single-rail withdrawal model. completeTrade credits buyerNetUsdc to availableBalance.
  - **What D-2 did incorrectly (reverted by D-3):** Dropped the azmBalance column entirely. Treated AZM as a cosmetic UI label derived from availableBalance × rate. This destroyed AZM's utility as an independent loyalty-point system.
  - ~~**Decision.** User confirmed: AZM is a loyalty-point label, not a blockchain token. Option C from the design doc is the correct path.~~ **CORRECTED:** User meant AZM is not a blockchain token but IS an independent loyalty-point ledger (database column). It should NOT be deleted or derived.
- 2026-05-25 — Phase N2: Notification consistency — migrate ALL remaining raw creates (in review, BE)
  - **Ten-file ~200 LOC delta. Fully closes the audit's §5 P0.** Zero raw `prisma.notification.create` / `tx.notification.create` / `createMany` sites remain outside the canonical `notificationService.js` pipeline (verified via grep). The only file that still does manual 3-step is `chatSocketService.js` — by design, for high-frequency trade-chat batching.
  - **11 call sites migrated:** adminChatController (admin intervention → constructor-injected service), queueController (queue slot-open → post-commit setImmediate), securityController (password change → inline NotificationService), withdrawalController (liquidity alert → inline NotificationService), p2p.service.js ×2 (gamification level-up + achievements → post-commit setImmediate), cfoWorker (AI CFO report → sendNotification), savingsWorker (savings reminder → sendNotification), milestoneMiddleware (badge unlock → post-commit setImmediate), tradeSocketService (timer extension → Promise.all), vendorGamificationService (review achievements → post-commit setImmediate).
  - **After this merge, the §5 P0 is fully retired.** Every notification in the system now flows through one pipeline with uniform DB + socket + FCM delivery.
- 2026-05-25 — Phase N: Notification consistency — migrate raw creates to notificationService pipeline (merged 2026-05-25, BE PR #56)
  - **Eight-file ~350 LOC delta. Closes the audit's §5 P0 "notifications are inconsistently persisted" for all high-traffic user-facing paths.** 21 raw `prisma.notification.create` / `tx.notification.create` / `createMany` sites migrated to `notificationService.sendNotification()` (DB + socket + FCM in one pipeline). The "vendor bell is empty after app reopen" bug is fixed.
  - **Pattern for transaction-internal notifications.** Sites inside `prisma.$transaction` blocks can't call `notificationService` (uses top-level client). Fix: remove `tx.notification.create` from transaction, fire `notificationService.sendNotification()` post-commit via `setImmediate`. For `p2p.service.js` (pure business logic, no `req`), notification metadata returned in `_notifications` field; controller fires them via shared `_firePostCommitNotifications` helper.
  - **initiateTrade bug fix.** The normal trade path previously emitted a socket event + raw FCM push but NEVER persisted a notification row. Vendor's bell was empty on app reopen. Now uses `notificationService.sendNotification()` for all three channels.
  - **Redundant socket emits removed.** 6 stale `io.emit('new_notification')` calls with incomplete payloads (just `{ title }`) deleted — the notificationService's built-in `_emitSocketEvent` now handles socket delivery with the full record shape.
  - **Deferred to Phase N2.** 8 remaining raw-create sites in low-traffic admin/worker/gamification paths.
  - **Stale `IN REVIEW` markers cleaned up.** Phase L2 → merged 2026-05-25, BE PR #55.
  - Files (8 + 2 docs): `controllers/adminController.js` (7 sites), `controllers/p2p.controller.js` (5 sites via helper), `controllers/finance.controller.js` (3 sites), `controllers/depositController.js` (2 sites), `controllers/tradeController.js` (3 sites), `controllers/savingsController.js` (1 site), `services/p2p.service.js` (5 removed from txns), `workers/tradeWorker.js` (2 sites). Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase L2: Wire smsService for phone OTP + large-withdrawal SMS (merged 2026-05-25, BE PR #55)
  - **Nine-file + 1 migration ~300 LOC delta. Fully closes the audit's TL;DR §8 "three services are dead code" cluster.** Combined with L1: `emailService` + `smsService` are both live. `serviceIntegrator` remains orphan facade — no new capability if wired; can be safely deleted.
  - **Phone OTP verification.** Two new endpoints on `/api/security/phone/*` (mirrors existing PIN/2FA pattern): `send-otp` dispatches a 6-digit OTP via `smsService.sendOTP` (E.164 validation, 5-min TTL, 3 attempts); `verify-otp` confirms the code and persists `phoneNumber + phoneVerified = true` on the User row. Changing phone via `profileController.updateProfile` leaves `phoneVerified = false` (must re-verify).
  - **Large-withdrawal SMS confirmations.** New `smsService.sendWithdrawalConfirmation(phone, opts)` dispatcher with 5 kinds (`fiat_dispatched`, `fiat_settled`, `fiat_refunded`, `crypto_sent`, `crypto_refunded`). Wired at 7 hook points (5 in withdrawalController, 2 in withdrawalReconciliationWorker). All fire-and-forget via `setImmediate`, gated on: `phoneVerified === true` + `amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD` (env-configurable, default $100) + reversal/refund success flags.
  - **Schema.** `phoneVerified Boolean @default(false)` added to User model. Migration: `ALTER TABLE "User" ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false`.
  - **Provider mode.** `SMS_PROVIDER` defaults to `mock`; OTP codes surfaced in responses in non-production for easy testing.
  - **Static re-trace: 13 scenarios** (9 withdrawal + 2 OTP + 2 negative-gate). SMS fires exactly when all three gates pass; never on CRITICAL admin-alert branches or unverified phones.
  - **Stale `IN REVIEW` markers cleaned up:** Phase L1 → merged 2026-05-25, BE PR #54.
  - Files (9 + 1 migration + 2 docs): `services/smsService.js`, `controllers/securityController.js`, `routes/securityRoutes.js`, `controllers/withdrawalController.js`, `workers/withdrawalReconciliationWorker.js`, `server.js`, `prisma/schema.prisma`, `.env.example`, migration SQL. Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase L1: Wire emailService for transactional withdrawal receipts (merged 2026-05-25, BE PR #54)
  - **Four-file + 1 env ~250 LOC delta.** Closes the audit's TL;DR §8 "three services are dead code" line — partially: `emailService` is now live for the withdrawal-completion surface; `smsService` and `serviceIntegrator` remain orphan and are filed for a follow-up pass. Until now `emailService.js` had complete HTML templates for welcome / verify / trade-alert / password-reset emails plus four provider stubs (SendGrid / SES / Mailgun / Nodemailer), but nothing in the running app required it — `test_services.js` was the only consumer. Withdrawals delivered no durable email artifact for users to file or chase their bank with.
  - **Four hook points.** (1) Fiat success — `withdrawalReconciliationWorker._reconcileOne` after the PENDING → COMPLETED status flip from MTN MoMo's async settlement webhook. (2) Fiat failure + auto-reverse — same worker, after `reverseFiatWithdrawal` succeeds; gated on reversal success so the user never gets a "you've been refunded" email when the reversal itself failed (admin alert covers that branch). (3) Fiat sync 503 / 502 reversal — `withdrawalController.fiatWithdrawal` after `mtn_service_unavailable` or `mtn_dispatch_failed` triggers a synchronous `reverseFiatWithdrawal`; same reversal-success gating via a new `reversalSucceeded` flag. (4) Crypto success / refund — `withdrawalController.cryptoWithdrawal` after Tatum broadcast succeeds (success kind) or after the inner refund `$transaction` succeeds (refund kind); `refundSucceeded` flag gates the refund email so a refund-failed CRITICAL path emits an admin alert instead.
  - **Fire-and-forget contract enforced four ways.** `setImmediate(...)` detaches every send from the request / worker context so the response flushes (or the reconcile tick continues) without waiting on email delivery. The new `emailService.sendWithdrawalReceipt(user, opts)` dispatcher catches every error internally and returns `{ success: false, ... }` — it cannot throw. Each call site adds a defensive `.catch()` for belt-and-braces. Three gating flags ensure no false "you've been refunded" emails on inconsistent-state branches.
  - **Four kinds, four renderers.** `_renderFiatSuccess` (green header, amount + destination + reference + settled-at), `_renderFiatFailure` (red header, refunded amount + reason + reference + when), `_renderCryptoSuccess` (green header, amount + gas fee + net payout + network + destination + tx hash + PolygonScan deep link), `_renderCryptoRefund` (red header, refunded amount + intended destination + network + reason + when). Each returns `{ subject, html, text }` matching the existing welcome/verify layout (Arial 600px container, colored header, white "info card" with row labels). Plain-text twin alongside every HTML body.
  - **Provider mode.** `EMAIL_PROVIDER` defaults to `mock`; in MOCK mode the server logs each receipt to stdout. The four provider stubs (`_sendViaSendGrid` / `_sendViaAWS` / `_sendViaMailgun` / `_sendViaNodemailer`) remain placeholder — flipping `EMAIL_PROVIDER` today routes through the same "placeholder log + return success" path until a real integration is wired. `.env.example` documents the activation path.
  - **Singleton pattern.** Mirrors `mtnDisbursementService` / `notificationService`: instantiated once in `server.js`, attached to app context via `app.set('emailService', emailService)`, passed as the 4th constructor arg to `WithdrawalReconciliationWorker`. The class export shape on `services/emailService.js` is unchanged so `serviceIntegrator.js` + `test_services.js` (both still using `new EmailService()`) keep working.
  - **Static end-to-end re-trace done across 9 scenarios.** Fiat happy / fiat sync 503 / fiat sync 502 / fiat reversal-failed CRITICAL / fiat async success-via-worker / fiat async failure-and-reverse-via-worker / fiat async reversal-failed CRITICAL / crypto happy / crypto refund-OK / crypto refund-FAILED CRITICAL. Email fires exactly when balance was actually restored or when withdrawal actually settled; never on the three admin-alert-CRITICAL branches.
  - **Stale `IN REVIEW` markers cleaned up.** Phase I5 → merged 2026-05-25, BE PR #53.
  - Files (4 + 1 env + 2 docs): `services/emailService.js`, `workers/withdrawalReconciliationWorker.js`, `controllers/withdrawalController.js`, `server.js`, `.env.example`. Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase I5: Pagination on the four still-unpaginated admin list endpoints (BE PR #53, merged 2026-05-25)
  - **Single-file ~150 LOC delta** in `controllers/adminController.js`. Closes the audit's §13 P2 line "list endpoints return all rows, no pagination" — for the admin tier specifically (the user-facing tier was paginated in Phase I, BE PR #40). Four `findMany` calls migrated to the existing shared `utils/pagination.js` helpers.
  - **The four endpoints.** `getAllDisputes` (was unbounded), `getLiveTrades` (had hardcoded `take: 100` ceiling — trade #101+ was silently invisible to war-room admins at peak), `getPendingKyc` (was unbounded), `getPendingWithdrawals` (was unbounded on the `pending` array; `frozen` was already capped at 20).
  - **Both pagination modes supported.** `?cursor=ID&limit=N` (append-stable, O(limit)) and `?page=N&limit=M` (classic page chips). Total count fetched once on page-1 of offset mode only — Promise.all'd with the rows so the cost lands once per UI session.
  - **Backwards-compat preserved.** The existing FE consumer is `lib/screens/admin_war_room_screen.dart`, which reads bare top-level `disputes` / `trades` / `applications` keys with `?? []` fallback. Those keys remain at the top level alongside a new `pagination` envelope. Cold-load (no params) raises the default take to 100 so the admin UI never sees fewer rows than before. Opt-in callers (`cursor`, `limit`, `page`) get the standard 20-row default unless they specify.
  - **`/admin/withdrawals/pending` shape extension.** No FE consumer today, free to evolve. `data: { pending, frozen, counts, pagination }`. `counts.pending` keeps its original page-length semantic (consistent across pages); the real backlog total surfaces on `pagination.total` (only populated on page-1 of offset mode for cost reasons). UIs that want a "X queued" chip should prefer `pagination.total ?? counts.pending`.
  - **Stale `IN REVIEW` markers cleaned up.** Phase I4 → merged 2026-05-25, BE PR #52.
  - Files (1 + 2 docs): `controllers/adminController.js`. Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase I4: Defer review gamification off the submitReview request path (BE PR #52, merged 2026-05-25)
  - **Two-file ~110 LOC delta.** Closes the explicit follow-up flagged in Phase I3's PR body: *"`submitReview` flow in `tradeController.js` has its own gamification block that's INLINE; not refactored here. Filed as a potential I4 follow-up."* Completes the I-series gamification deferral pair started by I3.
  - **What moved.** The vendor XP + achievement scan in `controllers/tradeController.js submitReview` (gamification.awardXp + user.findUnique stats re-fetch + checkAndUnlockAchievements + achievement-unlock notification.createMany — ~6-8 round-trips) used to run INSIDE the same `prisma.$transaction` as the review row create + reviewee's positiveReviews/negativeReviews counter increment. Phase I4 moves the gamification block out of the txn entirely. Atomic part shrinks to 2 writes — `tx.review.create` + `tx.user.update` — which is what the FE actually waits for to render the "Thanks for reviewing!" snackbar (verified — `lib/screens/trade_summary_screen.dart` only checks `response.statusCode == 201`).
  - **How.** New exported helper `processReviewGamification(prisma, { revieweeId, isPositive, tradeId })` in `services/vendorGamificationService.js` runs `awardXp` + post-XP-award user stats re-fetch + `checkAndUnlockAchievements` + achievement-unlock `notification.createMany` in its OWN `prisma.$transaction`. The controller (`submitReview`) schedules it via `setImmediate(...)` AFTER `res.status(201).json(...)`. The existing `gamification_update` socket event with `type: 'REVIEW_RECEIVED'` is emitted from inside the deferred block when a result lands. Gated to only run when `revieweeId === trade.vendorId` (XP rewards are vendor-only by design — same gate the inline block had). Top-level safety try/catch in the deferred block guards against unhandled rejections.
  - **Trade-off.** Same shape as I3: a server crash between the response flush and the setImmediate firing leaves XP un-awarded for one review. Acceptable — `positiveReviews` / `negativeReviews` counters DO update inside the atomic transaction so the review is permanently visible; only the derived XP / achievement scan is deferred. The next review or completed trade re-syncs.
  - **No FE coordination required.** The single FE callsite (`lib/screens/trade_summary_screen.dart`) only checks the response status code; does not parse the response body's `gamification` field. Field is kept in the immediate response as `null` for forward-compat (Phase I3 set the same precedent on the trade-complete path). The `gamification_update` socket event was already wired in I3 and is purely additive on the FE side.
  - **Stale `IN REVIEW` markers cleaned up.** Phase I3 → merged 2026-05-25, BE PR #51.
  - Files (2 + 2 docs): `services/vendorGamificationService.js`, `controllers/tradeController.js`. Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase I3: Defer vendor gamification off the trade-complete request path (BE PR #51, merged 2026-05-25)
  - **Two-file ~140 LOC delta.** Closes the explicit follow-up flagged in Phase I2's changelog ("Move `vendorGamificationService.processTradeCompletion` off the `completeTrade` request path") and §15 of the original audit ("`vendorGamificationService.evaluateBadges` runs synchronously inside trade completion. Adds 100–200ms to every trade complete request").
  - **What moved.** `vendorGamificationService.processTradeCompletion` (XP / streak / level / achievement scan, ~6 sequential Prisma writes) used to run inside the `prisma.$transaction` block in `services/p2p.service.js completeTrade`. The HTTP response could not return until every gamification write committed. Phase I3 moves the call out of the txn entirely. The trade-settlement transaction still holds the buyer credit + vendor balance update + admin profit log + buyer/vendor notifications atomically; gamification runs in its OWN transaction a few ms later.
  - **How.** New exported helper `processPostCompletionGamification(prisma, { tradeId, vendorId, tradeVolumeUsdc, vendorProfitUsdc })` runs the gamification engine + level-up notification + achievement notifications in a fresh `prisma.$transaction`. The controller (`controllers/p2p.controller.js completeTrade`) schedules it via `setImmediate(...)` AFTER the `res.json(...)` response builder. setImmediate yields to the event loop, lets Express flush the response, then runs gamification. The `gamification_update` socket event (already in the FE-facing surface) emits when gamification finishes.
  - **Trade-off.** A server crash between response flush and the setImmediate firing leaves XP/streak un-applied for one trade. Acceptable: the gamification engine moves forward from current state on its next call (no replay), so the next completed trade re-syncs the vendor's stats. Vendor stats `tradesCompleted`, `totalVolumeUsdc`, `totalProfitUsdc` DO update inside the trade transaction — only the derived XP/level/achievement scan is deferred. An ops alert can fire on `[p2p.processPostCompletionGamification] non-fatal error:` log spike.
  - **No FE coordination required.** Verified by grep that the FE codebase does not reference `gamification`, `gamification_update`, `vendorXp`, `vendorLevel`, or `/vendor/stats` — the FE doesn't consume vendor gamification data anywhere today (the `leaderboard_screen.dart` uses hardcoded sample data). When the FE wires up gamification surfacing in a future phase, the deferred-via-socket path is already in place.
  - **Audit hygiene bundled in this PR.** Three audit findings re-walked while locating I3's scope and confirmed STALE: (a) §3 P1 "withdrawals stuck at PENDING forever" — `services/withdrawalReconciliationWorker.js` IS wired and `start()`-ed in `server.js`, scans every 60s. (b) §8 P1 "createAd does not emit market_update" — `controllers/adController.js createAd` already emits to `marketplace_room`. (c) §8 P1 "admin can adjust balance via `adminController.adjustBalance`" — function does not exist; admin balance changes go through standard ledger paths.
  - **Stale `IN REVIEW` markers cleaned up.** Phase B2 → merged BE PR #50. Phase B2-FE → merged FE PR #45 (was missing from the unified roadmap; FE companion to B2). Phase D-1 → merged BE PR #44. Phase D (design) → merged BE PR #43. Phase J → merged BE PR #41 + FE PR #43. Phase J2 → merged BE PR #45. Phase K → merged BE PR #39. Phase L → merged BE PR #42. Phase H4 (FE) → merged FE PR #46. Phase M (FE) → flipped from `BACKLOG` to merged FE PR #44 (was actually shipped earlier and the BE roadmap had not been updated). Suggested-merge-order block also updated to remove stale "IN REVIEW (D, M)" references.
  - Files (2 + 2 docs): `services/p2p.service.js`, `controllers/p2p.controller.js`. Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase H4: Connectivity banner (FE PR #46, merged 2026-05-25)
  - **Frontend-only ~220 LOC across 3 files.** Closes the audit's H/H2 deferred line: *"`connectivity_plus` banner — needs adding the package + native config."* Phase H shipped haptics + page transitions + skeleton loaders; H2/H3 wired slide-to-confirm + biometric pre-gates; H4 closes the offline-aware-UI gap.
  - **What ships.** `connectivity_plus: ^6.1.0` added to `pubspec.yaml`. New `connectivityProvider` Riverpod `StreamProvider<bool>` in `lib/services/connectivity_service.dart`. New `AzamanConnectivityBanner` widget in `lib/widgets/azaman_connectivity_banner.dart`: slide-down danger card on disconnect, green "Reconnected" flash on recovery, integrated with `AzamanHaptics.warn()` / `confirm()` vocabulary. Wired via `MaterialApp.router(builder:)` in `lib/main.dart` so the banner overlays every screen with no per-screen migration.
  - **Re-test sweep.** Verified the existing socket reconnect path (Phase G + J) and Phase B2-FE notification handler still work unchanged.
- 2026-05-25 — Phase B2: admin + notification correctness (BE PR #50, merged 2026-05-25)
  - **Two-file ~55 LOC bundle** of two unrelated-but-small audit P1 fixes (§5 + §8). Bundled because each individually would be a trivial PR; together they're one focused review.
  - **`adminController.banUser` force-disconnects open sockets** (audit §8 P1). Pre-Phase-B2, a banned user's open WebSocket kept receiving server pushes (and could keep emitting events the socket auth middleware admitted at connect time) until they manually refreshed. Phase K's `protect` middleware closes the gap on every NEW HTTP/WS request; this closes the gap on EXISTING connections via `io.in('user_<id>').disconnectSockets()`. Wrapped in try/catch so socket failure can't fail the ban itself — DB row is already flipped. Scope: ban actions only, not UNBAN.
  - **`notificationController.markAsRead` + `markAllAsRead` multi-device sync** (audit §5 P1). Pre-Phase-B2, marking a notification read on one device left the badge counter stale on every other open session of the same user. Now both endpoints emit a `notifications_updated` socket event to `user_<id>` after the DB write so other sessions invalidate their unread count. Best-effort (try/catch) so socket failure never breaks the DB write. Two event subtypes: `MARKED_READ` + `MARKED_ALL_READ`.
  - **No FE coordination required** — the new socket event is purely additive. Clients that don't listen for it stay on the current pull-to-refresh model.
  - Files (2): `controllers/adminController.js` (~20 lines), `controllers/notificationController.js` (~35 lines). Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase I2: vendorStatsController parallel queries (BE PR #49, merged 2026-05-25)
  - **Single-file ~100 LOC follow-up** to Phase I (BE PR #40, merged). Phase I deferred this with the line "Parallelise vendorStatsController.getStats (currently serial Prisma calls; small per-vendor optimisation)" — Phase I2 closes the TODO across all four endpoints in the controller. Originally PR #46; replaced by PR #49 after a sandbox gateway issue blocked the in-place rebase force-push.
  - **`getVendorStats`:** was 5 sequential Prisma calls before reaching the existing 3-way Promise.all on adInteraction. Now: user findUnique (must come first for existence) → 3-way Promise.all (vendorAchievement.count + ad.groupBy(status) + ad.findMany for IDs). Two `ad.count` calls (total + active) collapse into one `ad.groupBy({ by: ['status'] })`. Saves ~3 round-trips.
  - **`getAchievements`:** 2 sequential calls → 1 Promise.all (earned + vendor stats).
  - **`getLeaderboard`:** 3 sequential → 2 with totalVendors count Promise.all'd against the rank-fallback lookup. Saves 1 round-trip in the common case.
  - **`getVendorStatsQuick`:** 3 sequential → 1 sequential (vendor) + 2-way Promise.all (active trades + last achievement).
  - **No schema change, no migration, no contract change, no FE coordination.** Same data, same shapes, same response envelopes — purely a DB-round-trip count reduction on read paths the FE hits on every dashboard load.
  - **Deferred separately (still TODO):** move `vendorGamificationService.processTradeCompletion` off the `completeTrade` request path via `setImmediate`. More invasive (changes the `gamification` response field timing — would become null in immediate response, populated later via socket event), needs FE coordination on whether clients rely on the response body vs. the `gamification_update` socket event.
  - Files (1): `controllers/vendorStatsController.js` (+98/-71). Plus this entry in `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.
- 2026-05-25 — Phase J2: DB-level CHECK constraints on money columns (BE PR #45, merged 2026-05-25)
  - **Pure additive defensive migration. No application code change.** ~50 `CHECK` constraints across 18 tables: non-negativity on every balance/amount/fee/volume column, positivity on prices/rates/limits, bounded ranges on ratios and percentages. The audit's §14 finding "no DB-level guard against negative balances" is closed at the database level — Postgres rejects any controller-bug INSERT/UPDATE that would corrupt the ledger.
  - **What this catches.** Today every controller, worker, and admin tool individually checks `if (user.availableBalance < amount)` before subtracting. If a future regression / code-review oversight / new worker forgets the check, the row goes negative and `runDoubleCheck` doesn't fire automatically. CHECK constraints close that gap: a forgotten check now produces a Prisma exception at transaction time, not silent corruption.
  - **Constraint policy.** balance/amount/fee → `>= 0`; price/rate/limit → `> 0` (zero would be nonsense); ratio → `BETWEEN 0 AND 1`; percentage → `BETWEEN 0 AND 100`. Compound invariant `Ad.minLimit <= Ad.maxLimit` also encoded.
  - **NOT in scope (filed as Phase J3):** the Float → Decimal column-type rewrite. Splitting from J2 because it changes the JSON wire format (Prisma serializes Decimal as a string by default) and needs FE coordination + a maintenance window for the row rewrite. CHECK constraints alone are pure additive.
  - **Validation policy.** Migration validates against existing rows. If any row currently violates a constraint, the migration FAILS and rolls back as a single transaction — surfacing ledger corruption is the desired outcome, not a bug. Operator runbook in `docs/PHASE_J2_CHECK_CONSTRAINTS.md` covers the recovery flow + soft-deploy `NOT VALID` alternative for very large tables.
  - Files (3): `prisma/migrations/20260525_phase_j2_balance_check_constraints/migration.sql`, `docs/PHASE_J2_CHECK_CONSTRAINTS.md`, `AUDIT.md` + this entry.
- 2026-05-25 — Phase D-1: Defensive gate — disable BUY ads until D-2 ships (BE PR #44, merged 2026-05-25)
  - **Backend-only ~30 LOC hotfix.** Refuses BUY-ad creation (`controllers/adController.js`) and BUY-ad trade initiation (`controllers/tradeController.js`) behind a default-off `BUY_ADS_ENABLED` env flag. The BUY-ad code path mints ~`amountCrypto` USDC per completion (vendor + SystemProfitFees both gain USDC out of thin air; user's AZM debit-then-credit nets to zero). Until Phase D-2 redirects settlement onto `availableBalance`/`escrowLockedBalance`, the safe move is to refuse the path entirely at entry points.
  - **Math correction vs. design doc.** Re-reading live code while preparing the hotfix surfaced that `userAzmAmount` (initiate) and `buyerAzmCredit` (complete) are computed with the *same* formula (`amountCrypto × effectiveRate`). Net AZM change is exactly zero, not `−amountCrypto × adminMarginGhs` as the design doc estimated. The vendor-side USDC mint is the real bug; the AZM cycle was just masking it.
  - **Why a stricter gate than design doc's Option A.** Skipping just the AZM increment at completion (the design doc's proposal) leaves the user paying `userAzmAmount` AZM for nothing while the vendor still gets minted USDC — strictly worse for the user. Block the path entirely instead.
  - **Operator action.** Run `SELECT COUNT(*) FROM "Trade" WHERE type='BUY' AND status='COMPLETED'`; any non-zero result means the platform has already minted USDC equal to `SUM(amountCrypto)` of those rows. Reconciliation is a Phase D-2 sub-step.
  - **Escape hatch.** `BUY_ADS_ENABLED=1` re-enables the path for staging / integration testing only. **Must never be set in production until D-2 lands.**
  - Files (4): `controllers/adController.js`, `controllers/tradeController.js`, `.env.example`, `AUDIT.md` + this entry.
- 2026-05-25 — Phase D: AZM trap + BUY-ad ledger redesign — DESIGN PASS (BE PR #43, merged 2026-05-25)
  - **Design-doc PR. No code change.** Branch `phase-d-azm-ledger-design`. Delivers `docs/PHASE_D_AZM_LEDGER_DESIGN.md` (~580 LOC of analysis), the design pass the audit explicitly required before any code change to the AZM ledger.
  - **Maps every AZM read/write site** in the BE (15 sites across 8 files). `azmBalance` does have a working withdraw path (`walletController.processWithdrawal`) — the audit's "one-way trap" framing was partially wrong — but the column IS stranded liquidity for V2 features (savings, peer transfer, chat/transfer, ad collateral all read `availableBalance` only).
  - **Confirms the BUY-ad bug.** A BUY-ad trade decrements user's `azmBalance` on initiate (`tradeController.js:226`) AND increments it again on complete (`p2p.service.js:536`). Net AZM change = `−amountCrypto × adminMarginGhs`. The vendor gets crypto for free. Money-correctness P0 if BUY ads are live in production.
  - **Three implementation options** with diff-size + tradeoff analysis: Option A (minimal hotfix, ~30 LOC), Option B (mirror SELL-ad escrow on BUY ads with new `azmEscrowBalance` column, ~150 LOC), Option C (eliminate `azmBalance` entirely, settle in `availableBalance`, ~1500-2000 LOC across ~25 files + migration). Recommended: **A as urgent hotfix if BUY ads are live; C as strategic cleanup post-Phase-K.** Skip B — same surface-area cost as C with worse long-term outcome.
  - **Five sub-PRs (D-2a..D-2e) sequenced** for the Option C path, including the migration script and FE coordination (drop `azmBalanceProvider` from `lib/providers/hologram_provider.dart`, same pattern as Phase J's `ghsBalanceProvider` removal).
  - **Five open questions** for product/design review gate the recommendation: the BUY-ad-live-in-prod SQL probe, the AZM-as-distinct-asset-class strategic question, the `walletController.processWithdrawal` deprecation question, the migration-rate-policy question, and the FE coordination window.
- 2026-05-25 — Phase L: API contract docs sweep (BE PR #42, merged 2026-05-25)
  - **Closes the "Coverage gaps" placeholder.** Phase B's audit flagged 9 route trees that existed in `routes/` and were reachable, but had no spec in `api_contract.md`. Phase L writes the spec for all of them in one PR — 64 new endpoint sections + 1 new socket cross-reference.
  - Trees documented: `/api/friends/*` (9 + 5 DM + 7 peer transfer), `/api/savings/*` (8), `/api/security/*` (6), `/api/users/*` (13), `/api/auth/sso` (1), `/api/ai/*` (6 incl. Smart Queue), `/api/kyc/*` (2), `/api/vendor/*` (5), `/api/oracle/*` (2).
  - **Methodology.** Every section was written by reading the live route file + each handler in the matching controller end-to-end. Request shapes, validation rules, refusal codes, response envelopes, and side effects (notifications, socket emits, audit-log rows) were lifted directly from source. Phase I's cursor-pagination wire shape is documented inline on the two endpoints that adopted it (`GET /friends`, `GET /friends/chat/:friendshipId/messages`).
  - **Going-forward convention.** The "Coverage gaps" placeholder is replaced with a "**closed in Phase L**" marker plus a one-line policy: when a route signature changes in any future PR, the contract change ships in the same PR. Code that disagrees with the contract is by definition wrong.
  - Doc-only PR. No code change. No schema change. The frontend benefits indirectly — all 64 endpoints now have authoritative request/response shapes the FE can reference without grep-walking the BE.
- 2026-05-25 — Phase K: Auth + security hardening (BE PR #39, merged 2026-05-25)
  - **Refresh-token model.** New `RefreshToken` table (uuid id, userId, expiresAt, revokedAt, userAgent, ipAddress) plus `User.tokenVersion` counter. Access JWT shrinks to 15min and now embeds `tokenVersion` + `typ:'access'` claims. Refresh tokens are 30-day, opaque uuids, stored server-side. New `services/authTokenService.js` is the single token source of truth: `signAccessToken` (throws on missing tokenVersion to fail-fast), `issueTokenPair`, `rotateRefreshToken` (atomic compare-and-swap on revokedAt to defend the rotation race), `revokeAllForUser` (transactional bump+revoke). Migration `20260525_phase_k_refresh_tokens` is metadata-only on Postgres ≥11.
  - **New endpoints.** `POST /api/auth/refresh` (rotates the pair, one-time-use enforced), `POST /api/auth/logout` (revokes the supplied refresh token, idempotent so double-logout 200s twice).
  - **Live-user gate in `protect`.** Every authenticated request now does one PK-indexed Prisma findUnique selecting tokenVersion/banStatus/isDeleted. Rejects with `code:'TOKEN_STALE'` on stale claim (with `AUTH_SKIP_TOKEN_VERSION_CHECK=1` cutover sentinel for the migration window — narrow scope, only the tokenVersion comparison is gated; USER_GONE and BANNED branches always run). Pre-Phase-K tokens (no tokenVersion claim) keep working until they expire on day 7 — the missing claim is coerced to 0, which equals the default tokenVersion of 0 for unmodified users.
  - **Privilege-change cascade.** Both role-flip endpoints now run their write atomically with a tokenVersion bump and revoke-all-refresh-tokens: `adminController.approveKyc` (KYC approved -> USER becomes VENDOR) AND `adminController.changeUserRole` (admin manually flips role; gated on `isActualChange` so a no-op re-save doesn't bump). Both emit a new `session_refresh_required` socket event so the client refreshes its session with the new role exactly once.
  - **Password change cascade.** `securityController.changePassword` (Phase F endpoint) now runs four writes in one $transaction: password.update + tokenVersion bump + revoke-all-refresh + create-new-refresh-for-this-device. Issues a fresh access+refresh pair on the success response so the change-of-password device stays logged in seamlessly. Other devices get TOKEN_STALE on their next request and are forced to re-authenticate.
  - **SSO `aud` verification.** Production path was already covered by `firebase-admin.verifyIdToken` (project-scoped aud check baked in); added an optional belt-and-braces compare against `FIREBASE_PROJECT_ID`/`SSO_EXPECTED_AUD` env vars for multi-tenant configs. Dev fallback path (when Firebase Admin isn't initialised) now requires both `SSO_DEV_FALLBACK=1` AND a configured `SSO_EXPECTED_AUD`/`FIREBASE_PROJECT_ID`; without one, the path returns 503 instead of accepting any unsigned JWT with a valid email.
  - **Avatar directory split.** New `middleware/avatarUploadMiddleware.js` + `POST /api/users/profile/avatar` route. Avatars now land in `/uploads/avatars/` instead of sharing `/uploads/proofs/` with KYC documents (audit §6 P1 finding). 2MB cap (was 5MB for proofs), random-suffix filenames (no user-controlled originalname), AND-not-OR mimetype+extension validation. Existing rows pointing at `/uploads/proofs/<filename>` continue to serve via the existing static mount; only NEW uploads land in the avatars directory.
  - **profileController.updateProfile whitelist.** Verified — only `displayName, bio, phoneNumber, country, profilePictureUrl, fcmToken` accepted. Already correctly tight in the audit's eyes; no code change required this PR.
  - Two rounds of semantic review folded in (refresh rotation race, changeUserRole missing cascade, AUTH_SKIP flag over-scoped, dev-fallback aud-check optional, avatar fileFilter OR, tokenVersion silently coerced, changePassword response missing legacy token field, no-op role change leaking notifications).
- 2026-05-25 — Phase J: schema cleanup — drop dead V1 columns (BE PR #41 + FE PR #43, merged 2026-05-25)
  - **Dropped `User.ghsBalance` and `User.lockedBalance`** — both confirmed write-dead in Phase B (findings C and D). `ghsBalance` had zero writes anywhere in the codebase; `lockedBalance` was only initialized to `0.0` on user creation and never mutated thereafter. The "vendor escrow" semantics moved to `escrowLockedBalance` when V2 split the account model; the "GHS bucket" semantics moved to the hologram model (`availableBalance × yellowCardRate`, computed on read).
  - **Migration `20260525_phase_j_drop_dead_columns/migration.sql`** — single SQL with `ALTER TABLE "User" DROP COLUMN IF EXISTS` for each. Idempotent across replicas + dev resets. No backup needed: both columns held `0.0` for every row in every environment by construction.
  - **BE controller cleanup (5 files):** `authController.js` (drops 3 init sites + 4 select/response sites), `profileController.js` (drops both fields from 4 sites — full-profile, balance, dashboard select + envelope), `ssoController.js` (drops SSO-create init + SSO response), `server.js` (drops both fields from `emitBalanceUpdate` + the socket envelope), `prisma/seed.ts` (drops the legacy `lockedBalance: 1000.0` from the vendor seed; the "Pass the $500 collateral check" comment was itself stale — that gate was fixed in Phase B to read `availableBalance`).
  - **FE coordinated update (separate PR):** `lib/models/user_model.dart`, `lib/providers/{auth,hologram,trade}_provider.dart`, `lib/services/socket_service.dart`, `lib/screens/auth/{login,signup}_screen.dart`, `lib/screens/{user,vendor}_dashboard.dart`, `lib/screens/vendor_deposit_screen.dart` all stop reading the dropped JSON keys. The orphan `ghsBalanceProvider` is removed (was always `0.0`). The vendor dashboard "in escrow" label, which was bound to the write-dead `lockedBalance`, is rewired to read `escrowLockedBalance` (the V2 field) so vendors see correct active-trade lock figures for the first time.
  - **Contract update:** `api_contract.md` gets two new "DROPPED (Phase J)" rows in the Phase A reconciliation table, the `/auth/me/:id` description loses `ghsBalance` and gains a Phase-J migration note, and the compliance footnote about "retained for migration audit only" is replaced with the actual drop history.
  - **Backwards compatibility.** Pre-Phase-J FE clients (older app builds in the wild) that POST to `/auth/login` will receive responses missing the two keys. They read JSON values defensively (`u['lockedBalance'] ?? 0.0`), so the worst-case effect is the legacy "$0 in escrow" label staying $0 — which is what it always showed anyway because the column was write-dead. There is no money-correctness risk. Same applies to the WebSocket `balance_update` envelope.
  - **Deferred to Phase J2 (backlog):** Float → Decimal column-type rewrite for every money column + `CHECK (col >= 0)` constraints on the balance buckets. Both require a maintenance window because column-type rewrites take a heavy lock.
- 2026-05-25 — Phase I: Performance + mobile payload (BE PR #40, merged 2026-05-25)
  - **Cursor pagination** on five list endpoints: `GET /api/notifications`, `GET /api/chat/:tradeId`, `GET /api/friends`, `GET /api/ads`, `GET /api/trades/history`. Single source of truth: `utils/pagination.js` (`parsePagination` auto-detects UUID vs Int cursor, `buildPageEnvelope` emits a uniform `{ nextCursor, hasMore, limit, page?, total? }` wire shape).
  - **Ten composite indexes** added via migration `20260525_phase_i_pagination_indexes`: `Notification(userId, createdAt DESC)`, `Notification(userId, isRead, createdAt DESC)`, `Message(conversationId, createdAt DESC)`, `DirectMessage(friendshipId, createdAt DESC)`, `Ad(status, createdAt DESC)`, `Ad(vendorId, createdAt DESC)`, `Trade(userId, createdAt DESC)`, `Trade(vendorId, createdAt DESC)`, `Friendship(requesterId, status, updatedAt DESC)`, `Friendship(addresseeId, status, updatedAt DESC)`. Each cursor query uses `cursor: { id }` + `skip: 1` and `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` for stable pagination across same-millisecond rows.
  - **`/api/friends` 2N→2 query collapse.** Old code looped `friendships.map(async f => { latestMessage; unreadCount })`. New code does ONE `findMany distinct: ['friendshipId']` (Postgres DISTINCT ON) plus ONE `groupBy` for unread counts. Two queries total, regardless of friend count.
  - **Backwards-compat preserved.** `/ads`, `/trades/history`, and `/chat/:tradeId` keep their pre-Phase-I response shape and ordering (chat ASC) when called with no pagination param. Opted-in callers (any of `cursor`, `limit`, `page`, `status`) get the cursor envelope and DESC ordering.
  - **AI marketplace declared single-page.** Scorer re-ranks every request, so `aiOn` forces `nextCursor=null` / `hasMore=false`; pagination would re-shuffle the deck.
  - **Friendship cursor caveat documented inline.** `Friendship.updatedAt` is mutated by direct messages and peer transfers, so a friend whose updatedAt bumps mid-pagination can skip/duplicate. Friend-list scale (rarely > 1 page) makes this a non-issue in practice.
  - Migration uses plain `CREATE INDEX IF NOT EXISTS` (no `CONCURRENTLY` — Prisma migrate runs inside an implicit transaction). On large prod tables swap to a manual ops runbook.
  - Two rounds of semantic review folded in (AI cursor no-op, missing id tiebreaker, missing Friendship index, kycStatus-dropping projection regression, misleading inline comment, unused Trade_status_idx — all addressed).
- 2026-05-25 — Phase H3: Biometric pre-gate + slide-to-confirm completion (FE PR #42, merged)
  - Closes the H2 deferred item: vendor `Release-crypto` `AlertDialog` -> slide-to-confirm bottom sheet. Adds opt-in `AzamanBiometricGate` wrapped around every existing `SlideToConfirm.onConfirmed` (vendor release, withdrawal, savings, friends transfer, buyer mark-paid). New "Biometric Lock on financial actions" toggle in Security Settings, itself biometric-gated in BOTH directions so a pickpocket with an unlocked phone can't disable the lock and drain.
  - Three rounds of semantic review folded in: Navigator.pop chain corrected, socket-fed dashboard entry no longer shows 0.00 USDT, `BiometricService.authenticate({reason})` actually pipes the reason to `local_auth.localizedReason`, `SlideToConfirm` hardened with an `enabled` prop + public `SlideToConfirmState` so callsites can `reset()` via `GlobalKey`, `commit()` haptic moved inside the gated action, `BiometricService.isAvailable` tightened to AND so passcode-only devices can't enable the toggle.
  - No backend code change. Frontend-only — ~700 LOC across 9 production files + 2 docs.
- 2026-05-25 — Phase J: schema cleanup — drop dead V1 columns (BE PR #41 + FE PR #43, merged 2026-05-25)
  - **Dropped `User.ghsBalance` and `User.lockedBalance`** — both confirmed write-dead in Phase B (findings C and D). `ghsBalance` had zero writes anywhere in the codebase; `lockedBalance` was only initialized to `0.0` on user creation and never mutated thereafter. The "vendor escrow" semantics moved to `escrowLockedBalance` when V2 split the account model; the "GHS bucket" semantics moved to the hologram model (`availableBalance × yellowCardRate`, computed on read).
  - **Migration `20260525_phase_j_drop_dead_columns/migration.sql`** — single SQL with `ALTER TABLE "User" DROP COLUMN IF EXISTS` for each. Idempotent across replicas + dev resets. No backup needed: both columns held `0.0` for every row in every environment by construction.
  - **BE controller cleanup (5 files):** `authController.js` (drops 3 init sites + 4 select/response sites), `profileController.js` (drops both fields from 4 sites — full-profile, balance, dashboard select + envelope), `ssoController.js` (drops SSO-create init + SSO response), `server.js` (drops both fields from `emitBalanceUpdate` + the socket envelope), `prisma/seed.ts` (drops the legacy `lockedBalance: 1000.0` from the vendor seed; the "Pass the $500 collateral check" comment was itself stale — that gate was fixed in Phase B to read `availableBalance`).
  - **FE coordinated update (separate PR):** `lib/models/user_model.dart`, `lib/providers/{auth,hologram,trade}_provider.dart`, `lib/services/socket_service.dart`, `lib/screens/auth/{login,signup}_screen.dart`, `lib/screens/{user,vendor}_dashboard.dart`, `lib/screens/vendor_deposit_screen.dart` all stop reading the dropped JSON keys. The orphan `ghsBalanceProvider` is removed (was always `0.0`). The vendor dashboard "in escrow" label, which was bound to the write-dead `lockedBalance`, is rewired to read `escrowLockedBalance` (the V2 field) so vendors see correct active-trade lock figures for the first time.
  - **Contract update:** `api_contract.md` gets two new "DROPPED (Phase J)" rows in the Phase A reconciliation table, the `/auth/me/:id` description loses `ghsBalance` and gains a Phase-J migration note, and the compliance footnote about "retained for migration audit only" is replaced with the actual drop history.
  - **Backwards compatibility.** Pre-Phase-J FE clients (older app builds in the wild) that POST to `/auth/login` will receive responses missing the two keys. They read JSON values defensively (`u['lockedBalance'] ?? 0.0`), so the worst-case effect is the legacy "$0 in escrow" label staying $0 — which is what it always showed anyway because the column was write-dead. There is no money-correctness risk. Same applies to the WebSocket `balance_update` envelope.
  - **Deferred to Phase J2 (backlog):** Float → Decimal column-type rewrite for every money column + `CHECK (col >= 0)` constraints on the balance buckets. Both require a maintenance window because column-type rewrites take a heavy lock.
- 2026-05-25 — Phase I: Performance + mobile payload (BE PR #40, merged 2026-05-25)
  - **Cursor pagination** on five list endpoints: `GET /api/notifications`, `GET /api/chat/:tradeId`, `GET /api/friends`, `GET /api/ads`, `GET /api/trades/history`. Single source of truth: `utils/pagination.js` (`parsePagination` auto-detects UUID vs Int cursor, `buildPageEnvelope` emits a uniform `{ nextCursor, hasMore, limit, page?, total? }` wire shape).
  - **Ten composite indexes** added via migration `20260525_phase_i_pagination_indexes`: `Notification(userId, createdAt DESC)`, `Notification(userId, isRead, createdAt DESC)`, `Message(conversationId, createdAt DESC)`, `DirectMessage(friendshipId, createdAt DESC)`, `Ad(status, createdAt DESC)`, `Ad(vendorId, createdAt DESC)`, `Trade(userId, createdAt DESC)`, `Trade(vendorId, createdAt DESC)`, `Friendship(requesterId, status, updatedAt DESC)`, `Friendship(addresseeId, status, updatedAt DESC)`. Each cursor query uses `cursor: { id }` + `skip: 1` and `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` for stable pagination across same-millisecond rows.
  - **`/api/friends` 2N→2 query collapse.** Old code looped `friendships.map(async f => { latestMessage; unreadCount })`. New code does ONE `findMany distinct: ['friendshipId']` (Postgres DISTINCT ON) plus ONE `groupBy` for unread counts. Two queries total, regardless of friend count.
  - **Backwards-compat preserved.** `/ads`, `/trades/history`, and `/chat/:tradeId` keep their pre-Phase-I response shape and ordering (chat ASC) when called with no pagination param. Opted-in callers (any of `cursor`, `limit`, `page`, `status`) get the cursor envelope and DESC ordering.
  - **AI marketplace declared single-page.** Scorer re-ranks every request, so `aiOn` forces `nextCursor=null` / `hasMore=false`; pagination would re-shuffle the deck.
  - **Friendship cursor caveat documented inline.** `Friendship.updatedAt` is mutated by direct messages and peer transfers, so a friend whose updatedAt bumps mid-pagination can skip/duplicate. Friend-list scale (rarely > 1 page) makes this a non-issue in practice.
  - Migration uses plain `CREATE INDEX IF NOT EXISTS` (no `CONCURRENTLY` — Prisma migrate runs inside an implicit transaction). On large prod tables swap to a manual ops runbook.
  - Two rounds of semantic review folded in (AI cursor no-op, missing id tiebreaker, missing Friendship index, kycStatus-dropping projection regression, misleading inline comment, unused Trade_status_idx — all addressed).
- 2026-05-24 — Phase H2: Slide-to-confirm on financial actions (FE PR #41, merged)
  - The PR #41 merge brought the full F → G → H → H2 stack onto FE main as a single chain. After this merge, FE PRs #38 / #39 / #40 became content-empty and were closed.
  - Wires the existing SlideToConfirm widget into the highest-risk financial confirms. Withdrawal screen ElevatedButton → SlideToConfirm. Savings goal sheet (_AmountPromptSheet for fund/withdraw) same swap with parent-driven CTA color + label. Friends transfer modal verified intact. Out of scope, deferred to Phase H3: active_trade_screen "Release crypto" button + biometric prompt before slide fires.
  - No backend code change.
- 2026-05-24 — Phase H: Premium polish pass (FE PR #40, merged via PR #41 stack)
  - Frontend-only — no backend change. Cross-cutting visual + tactile polish across every existing surface. Stacked on Phase G.
  - **Review-pass fixes folded in same commit (post-first-push):** ThemeProvider no longer clobbers the framework's onPlatformBrightnessChanged setter (now a WidgetsBindingObserver), SSO success snackbar fires AFTER pushReplacement, home summary reads the correct trade fields (amountFiat/amountCrypto, not the non-existent amountGhs/amountUsdc), TradeStatus active set matches the Prisma enum (was including non-existent AWAITING_RELEASE; now correctly includes PENDING), rate-history append moved out of LiveMarketSection.build into HomeSummaryNotifier.refresh, Withdrawal payload reads payoutMethod/network instead of a non-existent currency column. Dropped orphan flutter/services.dart imports across three files, fixed theme-picker hairline divider collapse, updated stale 4-tab comment in main.dart.
  - Custom page transitions (slide+fade, 240ms, easeOutCubic) wired globally via ThemeData.pageTransitionsTheme — every existing Navigator.push picks it up automatically.
  - Status bar + system nav bar styles flip with the theme (AnnotatedRegion<SystemUiOverlayStyle> wrapping MaterialApp.router). Closes the audit's §11 bug where switching to a Light theme left a white status bar with white icons.
  - Haptic vocabulary: AzamanHaptics.nav/toggle/confirm/commit/warn replaces ad-hoc HapticFeedback.lightImpact() calls across home/settings/theme-picker.
  - SkeletonBlock (was orphan) wired into TodayWidget cold-load + LiveMarketSection rate/sparkline cold-load. Subsequent refreshes keep the previous snapshot stable so the UI never blinks.
  - AzamanConfirmSheet replaces the AlertDialog sign-out in settings_screen. Same return contract as showDialog<bool>, so future sweeps swap one line.
- 2026-05-24 — Phase G: Home overhaul (FE PR #39, merged via PR #41 stack)
  - Frontend-only — no backend code changes. Pure consumer of existing endpoints (/api/oracle/rates, /api/trades/history, /api/wallet/history, /api/friends/requests, /api/notifications/unread-count).
  - Replaced the static "brochure" home screen with a dynamic dashboard. New TodayWidget (4 stat tiles: Active Trades / Pending Withdrawals / Friend Requests / Unread Notifications). New LiveMarketSection with live USD->GHS rate + fl_chart sparkline (24-sample in-memory rolling window). Removed hardcoded Platform News.
  - Pull-to-refresh actually re-fetches now via a single Future.wait fan-out aggregator (HomeSummaryService).
  - Backend-relevant contract notes (so future BE changes don't break the home dashboard): /api/oracle/rates must continue to return liveUsdToGhs / liveRetailRate / liveCorporateRate / rateSource / lastSync. /api/trades/history consumer reads amountFiat + amountCrypto (V2 names) and filters status ∈ {PENDING, PENDING_PAYMENT, PAID, DISPUTED}.
- 2026-05-24 — Phase F: Settings overhaul + change-password endpoint (BE PR #36 merged, FE PR #38 merged via PR #41 stack)
  - Frontend (branch phase-f-settings-overhaul, see azaman-frontend-main/FRONTEND_AUDIT.md): Settings rewrite to Apple/Binance row layout, dedicated ThemePickerScreen with live home preview, AzamanTheme.system (12th option, auto-follows OS brightness), SSO buttons wired on login + signup (typed SsoNotConfiguredException until Phase K adds firebase_auth + native config), Change Password tile, Account Activity tile, SecuritySettings (2FA + PIN) orphan wired in.
  - Backend (branch phase-f-change-password-endpoint, this repo): One new endpoint POST /api/security/change-password (protect). Body { currentPassword, newPassword }. bcrypt verify current → bcrypt hash new → write SECURITY_ACCOUNT audit notification (best-effort). Refuses on SSO-only accounts (password === '') and on identical-password attempts. Mounted under the existing /api/security tier with generalLimiter — no schema migration needed, audit row reuses the Notification table.
  - Roadmap mirrored across both repos: Phase F is now DONE.
- 2026-05-24 — Phase E: Savings completion (FE PR #37, merged)
  - Goal cards in SavingsScreen are now tappable. Tap opens a bottom sheet (lib/widgets/savings_goal_sheet.dart) with goal summary, Fund / Withdraw action tiles, and a Pause/Resume toggle.
  - Wires four backend endpoints the frontend was previously not calling: POST /savings/goals/:id/deposit, POST /savings/goals/:id/withdraw, PUT /savings/goals/:id/pause, PUT /savings/goals/:id/resume.
  - Withdraw on locked + not-matured goals shows a 2% early-penalty preview before submission.
  - Roadmap (mirrored in AUDIT.md and FRONTEND_AUDIT.md) updated: Phase E is DONE (FE PR #37 merged); Phase C is DONE (FE PR #36 merged).
- 2026-05-24 — Phase C: Crypto deposit wiring + unified roadmap (PR #36, merged)
  - Wired the orphan CryptoDepositScreen via a new DepositChooserSheet from the Home Quick Action. Users can now actually deposit Polygon USDC.
  - Verified WithdrawalScreen, TransferModal, FiatDepositFlowScreen, and SavingsScreen (create) are already correctly wired to live backend endpoints — the audit's "P0 not wired" claims for these were stale.
  - Confirmed real gap (deferred to Phase E): SavingsScreen uses 2 of 8 backend savings endpoints — fund/withdraw/pause/resume not yet on the frontend.
  - Wrote a UNIFIED ROADMAP block now mirrored in both AUDIT.md and FRONTEND_AUDIT.md as the single source of truth for "what's next."
- 2026-05-24 — Phase B: Backend money correctness re-verification (PR #33, merged)
  - Verified the audit's six headline money P0s against live code. Five are already fixed (idempotent peer transfers, MTN-wired withdrawals, PAID-only completeTrade, atomic vendor balance lock, full notification persistence). One ("dual ledger / GHS rail") was misdiagnosed — availableBalance is the unified V2 ledger.
  - Real P0 found and fixed: adController.createAd collateral gate read the dead lockedBalance field and was effectively absent. Now reads availableBalance (≥500 USDC). Proper bond-locking model deferred to a schema-migration PR.
  - Open architectural questions flagged for a future PR: azmBalance is a one-way trap (no withdraw/transfer/savings path) and the BUY-ad ledger flow is internally inconsistent. Need a design pass before patching.
  - AUDIT.md rewritten with a top-of-file post-audit verification block. Each TL;DR finding now has a verified status + evidence pointer; the original narrative is preserved as historical record.
  - api_contract.md got a Coverage gaps section listing route trees that exist in code but are not yet documented (/friends, /savings, /security, /users, /sso, /ai, /kyc, /vendor, /oracle).
- 2026-05-24 — Phase 1: Firebase credential rotation (PR #32, merged)
  - Removed leaked service-account.json from backend repo, hardened .gitignore, updated .env.example with setup instructions, downgraded the missing-file log to a warning.
- 2026-05-24 — Phase 0: Frontend visible wins (PR #35, merged in frontend repo)
  - Inverted vendor pull tab role gating, wired Home Quick Actions, rebuilt settings theme picker grid, removed dead lib/theme/app_theme.dart and orphan actual_settings_screen.dart, removed the leaked service-account.json.json. See azaman-frontend-main/FRONTEND_AUDIT.md.

1. THE HOLOGRAM LEDGER & TREASURY
The 1:1 Rule: User balances are NEVER stored as local fiat (GHS). They are stored strictly as USDC.

The Hologram: Displayed fiat values are a dynamic UI calculation: User USDC Balance × Live Yellow Card Rate = Displayed GHS.

AZM Loyalty Points: AZM is a **separate, independent** platform reward currency.
It is NOT a blockchain token. It is NOT derived from USDC × rate. It is its own
database column (`azmBalance`) with its own earn/spend mechanics. Think Binance BNB
rewards or airline frequent-flyer miles. Users cannot buy AZM directly — they earn
it through platform engagement. Users can spend AZM on premium features but cannot
withdraw it as fiat or crypto.

Tri-Wallet Treasury: Platform liquidity is divided into SYSTEM_MASTER_CRYPTO (cold/warm), SYSTEM_HOT_WALLET (automated withdrawals/gas), and SYSTEM_FIAT_POOL (corporate local payouts).

2. THE GREAT ACCOUNT SPLIT (DATABASE SCHEMA)
A user's funds are strictly partitioned. The legacy `lockedBalance` and
`ghsBalance` columns were dropped in Phase J (2026-05-25); do not re-introduce
them. The hologram model derives GHS dynamically from `availableBalance ×
yellowCardRate` on read.

availableBalance: Total liquid USDC funds (trading, spending, withdrawals).

vendorUnallocatedBalance: USDC isolated by a vendor to back active ads.

escrowLockedBalance: USDC currently frozen in an active P2P trade.

disputeEscrowBalance: USDC quarantined during an active dispute.

azmBalance: **Independent loyalty-point ledger (AZM).** NOT derived from any
other column. NOT a blockchain token. Users earn AZM through platform
activities (trade completions, referrals, login streaks, achievements) and
spend AZM on premium features (fee discounts, ad-tier unlocks, boosted ad
visibility, etc.). Backend-controlled; never directly purchasable or
withdrawable as fiat/crypto. Think airline miles or Binance BNB rewards.

  AZM EARN RATES (Phase E1):
  - Trade completion (buyer): 5.0 AZM per trade
  - Login streak: 1.0 AZM/day + bonuses (5.0 at 7-day, 20.0 at 30-day, 50.0 at 90-day)
  - Referral: 10.0 AZM when your referred user completes their first trade
  - Achievement unlock: 2.0 (Common), 5.0 (Rare), 10.0 (Epic), 25.0 (Legendary)
  - Volume milestones: 50.0 ($1k), 100.0 ($10k), 200.0 ($50k), 500.0 ($100k)

  AZM SPEND MECHANICS (Phase E2 — IN REVIEW):
  - Fee discounts: spend 10/25/50 AZM for 25%/50%/100% off the 2% exit fee on fiat withdrawals
  - Ad boost: spend 15/35/80 AZM for 24h/72h/7-day featured placement in the marketplace
  - Boosted ads sort first in marketplace results (isBoosted DESC ordering)
  - NOT withdrawable as fiat/crypto. NOT tradeable between users.

  AUDIT TRAIL: Every AZM credit writes to the `AzmRewardLog` table with
  source, reason, metadata, and balanceAfter. Queryable via `GET /api/azm/history`
  (cursor-paginated) and `GET /api/azm/summary` (aggregate stats by source).

3. FRONTEND IMMUTABILITY & UI STANDARDS
The frontend UI is carefully designed. It must not regress.

Dashboard UI: The user balance card must remain slender, dark/glassmorphic, and alive (animations). The top balance view and API refresh timer are permanently locked components.

Riverpod Granularity: Streams (like live Yellow Card rates) must only repaint their specific text widgets using ref.watch(provider.select(...)). They must NEVER trigger a rebuild of the layout/card components.

Apple Wallet Ads: The P2P marketplace utilizes a CustomScrollView and SliverPersistentHeader to stack ad cards at the top of the viewport when scrolled.

Trade Chat UI: Must feature a draggable countdown timer pill overlay. Extending time (+15m) triggers a visual bubble that merges into the pill with a haptic ripple.

4. BACKEND EXECUTION & REVENUE
Single Source of Truth: Trade releases happen ONLY through p2p.service.completeTrade. No alternative socket or controller paths are permitted.

The Arbitrage Shield (2% Exit Fee): Fiat withdrawals (MoMo off-ramp) incur a 2% fee. This is split: 1% to SYSTEM_PROFIT_FEES, and 1% to the user matching the referredByCode (Influencer).

External Gas: 100% of the MATIC network gas fee is deducted from the user's transfer amount on external crypto withdrawals.

4.1 THE P2P MARKETPLACE — GLOBAL FIAT WALLET BRIDGE (Phase F2, 2026-05-25)

**CRITICAL ARCHITECTURAL CORRECTION.**

Azaman's P2P marketplace is NOT a GHS↔USDC exchange. GHS/MoMo
deposits and withdrawals are handled entirely by the platform's internal
Admin Liquidity Pool (Kotani Pay gateway). Users buy USDC from the
platform using MoMo, or they deposit USDC externally via Polygon.

The P2P marketplace is exclusively a **liquidity bridge for 3rd-party
global wallets** that the platform cannot natively integrate as a payment
rail. Vendors act as intermediaries between users and global fiat methods.

**Supported Global Fiat Methods (expandable):**
- Zelle (US bank transfers)
- CashApp ($cashtag payments)
- Venmo (@username payments)
- PayPal (email payments)
- Apple Pay (phone number)
- Google Pay (email/phone)
- Wise (email transfers)
- Revolut (@username/phone)
- Gift Cards (various types + denominations)
- Western Union (MTCN reference)
- Wire Transfer (SWIFT/bank details)

**The Two Ad Types:**

VENDOR BUY AD — "I (vendor) will buy your [Zelle/PayPal/etc.] for USDC"
  - Vendor escrows `amountCrypto` USDC from `availableBalance` →
    `escrowLockedBalance`
  - User sends USD-equivalent fiat (e.g., $100 via Zelle) to the
    vendor's registered account
  - Vendor confirms receipt → releases escrowed USDC to user
  - Net: User converted their Zelle/PayPal balance into USDC

VENDOR SELL AD — "I (vendor) will send you [Zelle/PayPal/etc.] for USDC"
  - User escrows `amountCrypto` USDC from `availableBalance` →
    `escrowLockedBalance`
  - User provides their recipient details (their Zelle email, CashApp
    $cashtag, etc.) during trade initiation
  - Vendor sends fiat to the user's provided address and uploads proof
  - User confirms receipt → releases escrowed USDC to vendor
  - Net: User converted their USDC into a Zelle/PayPal balance

**Fee Model (replaces the legacy GHS margin math):**
  - Platform fee: `P2P_FEE_PCT` (default 2%) applied to `amountCrypto`
  - Fee split: tiered as before (trades < $1000: 60% admin / 40% vendor;
    trades >= $1000: 50% admin / 50% vendor)
  - The GHS oracle rate (`liveUsdToGhs`, `effectiveRate`, `adminMarginGhs`)
    is NOT involved in P2P trades. Those remain only for the internal
    MoMo deposit/withdrawal rail.
  - `amountFiat` on a P2P trade = the USD face value of the fiat transfer
    (e.g., $100 Zelle = $100 = ~100 USDC before fees)

**No GHS conversion in P2P.** The `rate` field stored on a Trade row for
P2P trades is `1.0` (USDC:USD parity). The `currency` field is `'USD'`
(not GHS). The `amountCrypto` IS the trade's USDC value. The
`amountFiat` is the USD equivalent the counterparty sends/receives.

4.2 VENDOR PAYMENT ACCOUNTS — TYPE-SPECIFIC VALIDATION

Vendors register payment accounts via `TradeAccount` (existing model).
Each account has a `methodType` enum and a `accountDetails` JSON blob
whose shape is validated server-side against a type-specific schema.

**Account Type Schemas:**

| methodType        | Required Fields in `accountDetails`                      |
|-------------------|----------------------------------------------------------|
| `ZELLE`           | `{ email?: string, phone?: string }` (at least one)      |
| `CASHAPP`         | `{ cashtag: string }` (must start with $)                |
| `VENMO`           | `{ username?: string, phone?: string }` (at least one)   |
| `PAYPAL`          | `{ email: string }`                                      |
| `APPLE_PAY`       | `{ phone: string }`                                      |
| `GOOGLE_PAY`      | `{ email?: string, phone?: string }` (at least one)      |
| `WISE`            | `{ email: string }`                                      |
| `REVOLUT`         | `{ username?: string, phone?: string }` (at least one)   |
| `GIFT_CARD`       | `{ cardType: string, denomination?: string }`            |
| `WESTERN_UNION`   | `{ fullName: string, country: string }`                  |
| `WIRE_TRANSFER`   | `{ bankName, routingNumber?, accountNumber, swift? }`    |

**Validation rules:**
- `phone` fields must be E.164 format
- `email` fields must be valid email format
- `cashtag` must start with `$` and be 1-20 chars alphanumeric
- `username` must be alphanumeric + underscores (Venmo/Revolut style)
- At least ONE of the "at least one" fields must be present

**Ad creation links to a specific account:** When posting an ad, the
vendor selects one of their APPROVED `TradeAccount` entries. The ad
stores a `tradeAccountId` FK. The marketplace displays the account
type (e.g., "Zelle") but NOT the sensitive details (email/phone).
Details are revealed only to the counterparty once a trade is initiated.

**Trade initiation captures buyer recipient details (SELL ads only):**
When a user responds to a SELL ad, they must provide their own payment
details matching the ad's method type. These are stored on the Trade row
as `buyerPaymentDetails` (JSON) and shown to the vendor so they know
where to send the fiat. Validated against the same type schema above.

4.3 P2P FEE ARITHMETIC (Phase F2 — replaces legacy GHS margin model)

```
Given: amountCrypto (the USDC amount being traded)
       P2P_FEE_PCT = 0.02 (2%, env-configurable)

totalFeeUsdc    = amountCrypto × P2P_FEE_PCT
adminPct        = amountCrypto >= 1000 ? 0.50 : 0.60
vendorPct       = 1 - adminPct
adminCutUsdc    = totalFeeUsdc × adminPct
vendorCutUsdc   = totalFeeUsdc × vendorPct
netUsdc         = amountCrypto - totalFeeUsdc

BUY ad settlement:
  - Vendor escrowed amountCrypto
  - On completion: user gets netUsdc, vendor gets vendorCutUsdc back,
    admin gets adminCutUsdc
  - Vendor net cost = amountCrypto - vendorCutUsdc

SELL ad settlement:
  - User escrowed amountCrypto
  - On completion: vendor gets netUsdc + vendorCutUsdc (= amountCrypto - adminCutUsdc),
    admin gets adminCutUsdc
  - User net cost = amountCrypto (they received fiat externally)
```

Note: When Kotani Pay rates are integrated (pending approval), the
`amountFiat` field may use Kotani's live USD rate for display purposes
only. The escrow and fee math remain purely in USDC.

5. DUAL-CHAT SYSTEM
Trade Chats (Escrow): Temporary, tied to a tradeId, equipped with the draggable timer pill and direct payee widget.

Personal P2P Chats (Social): Permanent, located in the Messages Hub. Includes a "+" button to instantly send/request crypto inside the chat, guarded by biometric authentication (FaceID/PIN).

6. AI COMMAND & SMART AFFORDANCES
Smart Ad Matchmaking: When toggled, the AI re-ranks the marketplace to prioritize ads using the user's historically preferred fiat payment methods.

AI CFO: A background worker monitoring the SYSTEM_HOT_WALLET. If MATIC gas or fiat reserves drop below thresholds, it fires natural-language alerts to the Admin.

AI Dispute Memory: Suggests dispute resolutions to the Admin by referencing historical actions in the DisputeResolutionLog.


7. UNIFIED ROADMAP (EARN/SPEND/INFRASTRUCTURE)

| Phase | Status | Description |
|-------|--------|-------------|
| J3 — Float → Decimal | DONE (BE PR #68) | All 63 Float columns → Decimal with explicit precision. Global valueOf/toJSON patches. |
| F2 — P2P Architecture Correction | IN REVIEW | Strip GHS oracle math from P2P, flat USDC fee model, trade account linking. |
| E2 — AZM Spend Mechanics | IN REVIEW | Fee discounts (3 tiers) + ad boosts (3 durations). |
| N2 — Notification Consistency | IN REVIEW | Last 11 raw notification creates → pipeline. |
| P1 — Queue Socket Events | IN REVIEW | queue_promoted + queue_position_update emissions. |
| E2-FE — AZM Spend UI | IN REVIEW | FE: fee discount selector + ad boost sheet. |
| P3-FE — Unified Socket | IN REVIEW | Eliminate dual socket, single authenticated connection. |
| Q1 — Admin Fee Profiles | PLANNED | Dynamic margin/split control (see §8). |
| Q2 — Vendor Wallet Archiving | PLANNED | Soft-delete + cloud backup for trade accounts. |
| Q3 — Notification Navigation Fix | PLANNED | Wire all notification types to correct screens (FE). |
| Q4 — Ad Soft-Delete | PLANNED | Archive endpoint for vendors. |
| Q5 — Premium Chat Input | PLANNED | Fintech-grade chat UI redesign. |
| Q6 — KYC Integration (Dojah) | ✅ DONE (BE PR #70) | Automated identity verification via Dojah webhook. |
| Q7 — Kotani Pay Payment Initiation | PLANNED | User MoMo prompts for deposits. |
| Q8 — Admin Autonomous Payouts | ✅ DONE (BE PR #71) | Batch payout worker + manual review queue. |
| Q9 — Real Email/SMS Providers | PLANNED | SendGrid + Arkesel/Hubtel wiring. |
| Q10 — Leaderboard Real Data | PLANNED | Wire FE leaderboard to BE worker. |
| Q11 — Transaction Receipt PDFs | ✅ DONE | Downloadable receipts for trades/withdrawals. |
| Q12 — Rate Alert System | PLANNED | "Notify me when USD/GHS hits X". |
| Q13 — Vendor Verification Badges | PLANNED | Trust signals on marketplace. |
| Q14 — Admin Dispute Resolution Workflow | PLANNED | Assign, review, rule, auto-execute. |
| Q15 — App Version Gate | PLANNED | Force-update on breaking API changes. |
| Q16 — Vendor Analytics Dashboard | PLANNED | Volume/revenue/speed charts. |
| E1 — AZM Earn Mechanics | DONE (BE PR #62) | Full earn pipeline. |
| E1-FE — AZM Earn UI | DONE (FE PR #50) | FE screens: AZM history + socket listener. |

---

8. ADMIN FEE PROFILE SYSTEM (Phase Q1)

**Product Decision (2026-05-25).** The admin must have granular, dynamic
control over ALL fee parameters in the system. This replaces hardcoded
constants with a profile-based system.

8.1 WHAT THE ADMIN CAN CONTROL

- **Platform fee percentage** (`platformFeePct`) — the total % taken from
  each trade (currently hardcoded at 2%). Admin can raise/lower this.
- **Admin-vendor split** (`adminSplitPct` / `vendorSplitPct`) — how the
  platform fee is divided. Currently 60/40 under $1k, 50/50 over $1k.
  Admin can override for specific vendor tiers or time periods.
- **Withdrawal exit fee** (`exitFeePct`) — currently 2% on fiat
  withdrawals. Admin can modify globally or per-profile.
- **Influencer referral bonus share** — referrers whose users trade
  actively can receive a larger share of fees. Admin sets this per
  influencer or per referral code.

8.2 FEE PROFILE MODEL

```
AdminFeeProfile {
  id              UUID PK
  name            String        // "Holiday Promo", "Top Vendor Tier", "Influencer: @KofiCrypto"
  targetScope     Enum          // ALL | VENDOR_TIER | USER_TIER | INFLUENCER_REFERRAL | HOLIDAY
  targetValue     String?       // e.g., "GOLD", referral code, vendor user ID
  platformFeePct  Decimal(5,4)  // 0.0200 = 2%
  adminSplitPct   Decimal(5,4)  // 0.6000 = 60%
  vendorSplitPct  Decimal(5,4)  // 0.4000 = 40%
  exitFeePct      Decimal(5,4)  // 0.0200 = 2%
  priority        Int           // Higher = overrides lower. Default profile = priority 0.
  isActive        Boolean       // Admin can deactivate without deleting
  validFrom       DateTime?     // Null = immediate
  validUntil      DateTime?     // Null = permanent
  createdAt       DateTime
  updatedAt       DateTime
}
```

8.3 PROFILE RESOLUTION LOGIC

When a trade completes or a withdrawal fires, the system resolves the
active fee profile:
1. Find all active profiles where `validFrom <= now <= validUntil` (or
   null for permanent).
2. Filter to those matching the trade context: user's referral source,
   vendor tier, or universal (ALL).
3. Pick the highest-priority match.
4. Fall back to the system default (priority 0, scope ALL) if none match.

This means:
- Admin creates a "Holiday Promo" profile (scope: ALL, validFrom: Dec 20,
  validUntil: Jan 5, platformFeePct: 0.01) → everyone pays 1% fees
  during Christmas.
- Admin creates an "Influencer: @KofiCrypto" profile (scope:
  INFLUENCER_REFERRAL, targetValue: referralCode) → users who joined
  through KofiCrypto get reduced fees (their trades resolve this profile).
- Admin creates a "Gold Vendors" profile (scope: VENDOR_TIER, targetValue:
  "GOLD") → gold-tier vendors get a better split (70% vendor / 30% admin).

8.4 ADMIN API ENDPOINTS

- `GET /api/admin/fee-profiles` — list all profiles (paginated)
- `POST /api/admin/fee-profiles` — create a new profile
- `PUT /api/admin/fee-profiles/:id` — update a profile
- `DELETE /api/admin/fee-profiles/:id` — soft-deactivate (never hard-delete)
- `GET /api/admin/fee-profiles/active` — get the currently active resolved
  profile for a given trade context (test endpoint for admin verification)

---

9. VENDOR WALLET ARCHIVING & SECURITY (Phase Q2)

**Product Decision (2026-05-25).** Vendor trade accounts (payment wallets)
must NEVER be permanently deleted from the system. This is a security and
compliance requirement.

9.1 RULES

- When a vendor "deletes" a trade account, it is **soft-deleted**: an
  `archivedAt` timestamp is set, and the record becomes invisible in the
  vendor's UI and ad-creation picker.
- Archived accounts remain in the database indefinitely for:
  - Audit trail (tied to completed trades via `tradeAccountId` FK)
  - Fraud investigation (admin can view archived accounts)
  - Compliance / dispute resolution
- Admin has a dedicated endpoint to view all archived trade accounts for
  any user: `GET /api/admin/users/:id/trade-accounts?includeArchived=true`
- Future: cloud backup (S3/GCS) of archived account snapshots with
  encryption at rest. Triggered by a scheduled worker that exports newly
  archived accounts weekly.

9.2 SCHEMA CHANGE

```prisma
model TradeAccount {
  // ... existing fields ...
  archivedAt    DateTime?   // null = active, set = archived (soft-deleted)
  archiveReason String?     // "USER_DELETED" | "ADMIN_SUSPENDED" | "COMPLIANCE_HOLD"
}
```

All existing `TradeAccount` queries add `WHERE archivedAt IS NULL` unless
the caller explicitly requests archived records (admin endpoints only).

---

10. GHANA-BASED VENDOR PAYOUTS (LOCAL FIAT)

**Product Decision (2026-05-25).** Some vendors operate in Ghana and need
local MoMo payouts (not just global fiat methods like Zelle/PayPal).

10.1 HOW THIS WORKS

- Vendors in Ghana can add a LOCAL payout destination (MTN MoMo, Telecel
  Cash, AirtelTigo Money, Bank Transfer) via the existing
  `UserLocalPaymentMethods` screen or a new dedicated "Payout Wallets"
  section in their settings.
- When a vendor requests a withdrawal, the system checks the destination
  type:
  - **Local MoMo** → routes through the existing MTN MoMo disbursement
    service (same as user fiat withdrawals).
  - **Crypto wallet** → routes through the Tatum/Polygon path.
  - **Global fiat** → informational only (vendor manages off-platform).
- The GHS conversion rate (oracle) applies to vendor MoMo payouts:
  `USDC amount × liveUsdToGhs = GHS payout amount`.
- Admin controls the payout pool. When the local fiat pool (MTN account)
  has insufficient liquidity for a payout, the withdrawal is flagged as
  `NEEDS_MANUAL_REVIEW` for the admin to manually process or fund.

10.2 AUTONOMOUS VS. MANUAL PAYOUTS

**Implementation Status: ✅ DONE (Phase Q8, BE PR #71, 2026-05-25).**

- **Autonomous (balances align):** The `PayoutBatchWorker` (scheduled,
  interval configurable via `GlobalSettings.autoPayoutIntervalMs`) scans
  PENDING fiat withdrawals. When `autoPayoutEnabled=true` AND
  `SystemFiatPool.balance >= autoPayoutThresholdUsdc` AND the individual
  `withdrawal.amount <= autoPayoutMaxAmountUsdc`, the worker dispatches
  via `mtnDisbursementService.initiateTransfer()` and marks PROCESSING.
  The existing `withdrawalReconciliationWorker` polls MTN for final status.
- **Manual (balances don't align):** When the pool is dry, the amount
  exceeds the threshold, or the recipient phone is missing, the withdrawal
  is flagged `NEEDS_MANUAL_REVIEW`. Admin reviews in the War Room via
  `GET /api/admin/payouts/needs-review` and can:
  (a) Fund the pool and re-trigger via `POST /api/admin/payouts/batch-process`,
  (b) Manually approve individual withdrawals via existing `/withdrawals/:id/approve`,
  (c) Reject with reason via existing `/withdrawals/:id/reject`.
- **Admin controls (live, no restart needed):**
  - `GET /api/admin/payouts/settings` — view current config + pool balance
  - `PUT /api/admin/payouts/settings` — toggle enabled, adjust thresholds
  - `POST /api/admin/payouts/batch-process` — manual one-shot trigger

---

11. KYC INTEGRATION PREPARATION (Dojah)

**Product Decision (2026-05-25).** KYC will be handled by Dojah (or
similar provider TBD). The current manual admin-approval flow is a
placeholder.

**Implementation Status: ✅ DONE (Phase Q6, BE PR #70, 2026-05-25).**

11.1 TARGET FLOW

1. User taps "Verify Identity" in settings or is prompted after first
   trade.
2. Frontend calls `POST /api/kyc/initialize` → receives widget URL.
3. Frontend opens the Dojah widget URL in a WebView.
4. User completes: selfie capture + ID document upload + liveness check.
5. Dojah processes and fires a webhook to:
   `POST /api/kyc/webhook/dojah` (HMAC-SHA256 secured).
6. Backend receives verification result and applies confidence thresholds:
   - Confidence >= 70 (configurable) → auto `kycStatus = 'VERIFIED'`.
   - Confidence < 40 (configurable) → auto `kycStatus = 'REJECTED'`.
   - Between thresholds or provider says `manual_review` →
     `kycStatus = 'PENDING'` for admin.
7. Notification sent to user with result (SECURITY_ACCOUNT category).

11.2 INTEGRATION POINTS

- `POST /api/kyc/initialize` (auth-protected) → creates a Dojah session,
  returns widget URL + reference ID. Sets user to PENDING.
- `POST /api/kyc/webhook/dojah` (HMAC-only, no auth) → receives result,
  updates user record. Always returns 200 to prevent retry storms.
- `GET /api/kyc/status` (auth-protected) → returns current status +
  `canReinitialize` flag (true when UNVERIFIED or REJECTED).
- `POST /api/kyc/admin/override` (admin-only) → manual approve/reject
  with required audit reason. Works regardless of Dojah result.
- Frontend: Dojah Flutter SDK or WebView with the widget URL.

11.3 PROVIDER MODES (env: KYC_PROVIDER)

- `mock` (default) — no external calls. Returns fake widget URL.
  Webhook accepts `mock_signature`. Response includes `_mockHint` with
  a sample webhook payload for dev/CI testing.
- `dojah` — real Dojah API. Requires `DOJAH_APP_ID`, `DOJAH_PUBLIC_KEY`,
  `DOJAH_SECRET_KEY`, `DOJAH_WIDGET_ID`, `DOJAH_WEBHOOK_SECRET`.

11.4 CONFIDENCE THRESHOLDS

Configurable via env vars:
- `KYC_AUTO_APPROVE_THRESHOLD` (default 70) — at or above → VERIFIED.
- `KYC_AUTO_REJECT_THRESHOLD` (default 40) — below → REJECTED.
- Between → PENDING for admin manual review in War Room.

11.5 REMAINING FRONTEND WORK

- `KycVerificationScreen` must open a WebView with the widget URL from
  `/api/kyc/initialize` response.
- Handle `canReinitialize` flag to show/hide "Try Again" button.
- Listen for KYC_UPDATE notification to refresh status.

---

12. UI/UX PREMIUM MANDATE

**Product Decision (2026-05-25).** Every pixel of this app must feel
premium. This is a fintech startup targeting millions of users. The
following areas need explicit attention:

12.1 CHAT INPUT (TRADE CHAT + DM)

The current text input field is basic and "ugly." Requirements:
- Glassmorphism container with subtle blur + gradient border
- Rounded, floating input field with proper padding
- Send button: circular, accent-colored, subtle pulse animation on ready
- Attachment icon: camera + file picker affordance
- Typing indicator: animated dots in the correct position
- Message bubbles: rounded with soft shadows, sender alignment, timestamp
- Read receipts: single tick (sent), double tick (delivered), blue (read)

12.2 GENERAL UI POLISH REQUIREMENTS

- All screens must use the theme system (no hardcoded colors remaining)
- Skeleton loaders on EVERY screen that fetches data
- Smooth page transitions (already implemented via Phase H)
- Haptic feedback on all interactive elements (already implemented)
- Empty states: illustrated, with helpful CTAs (not just "No data")
- Error states: retry buttons, not dead-end "Something went wrong"
- Loading states: shimmer/skeleton, NEVER blank white screens
- Animations: balance changes animate, list items slide in, cards flip

---

13. ADDITIONAL FEATURES (Full Product Plan)

13.1 TRANSACTION RECEIPT PDFs
- Generate downloadable PDF receipts for completed trades and withdrawals.
- Include: date, amount, counterparty (masked), reference ID, platform
  branding, QR code linking to the transaction.
- Accessible from trade history and withdrawal history screens.

13.2 RATE ALERT SYSTEM
- Users can set price alerts: "Notify me when USD/GHS crosses X".
- Backend: new `RateAlert` model with userId, targetRate, direction (ABOVE/BELOW), isTriggered.
- Oracle service checks alerts on each rate update, fires notification
  when threshold crossed.
- Frontend: "Set Alert" button on the Live Market section of the home screen.

13.3 VENDOR VERIFICATION BADGES
- Trust signals displayed on marketplace ad cards and vendor profiles.
- Badge types: "Verified Vendor" (KYC passed), "Top Trader" (>100 trades),
  "Fast Release" (avg release time < 5min), "Zero Disputes" (0 dispute rate).
- Computed by the existing gamification/stats engine.
- Frontend: badge row below vendor name on ad cards.

13.4 ADMIN DISPUTE RESOLUTION WORKFLOW
- Current: disputes are flagged but have no structured resolution flow.
- Target:
  1. Admin assigns dispute to themselves (or auto-assigned by round-robin).
  2. Admin reviews: trade chat history, proof uploads, user/vendor history.
  3. Admin rules: "In favor of buyer" or "In favor of vendor".
  4. System auto-executes: releases escrow to winner, logs resolution in
     `DisputeResolutionLog`, notifies both parties, updates stats.
  5. Optional: partial resolution (split the escrow).

13.5 APP VERSION GATE
- On app startup, check minimum supported version via `GET /api/health`.
- If client version < minimum, show a force-update screen blocking all
  navigation until the user updates from App Store / Play Store.
- Admin controls minimum version via GlobalSettings.

13.6 VENDOR ANALYTICS DASHBOARD
- Charts: trade volume over time (7d/30d/90d), revenue by payment method,
  average trade completion time, dispute rate trend.
- Data: all exists in TransactionHistory + Trade + Review tables.
- Frontend: new screen reachable from vendor dashboard → "Analytics" button.

---

14. KOTANI PAY INTEGRATION STATUS

**Current state:** Kotani Pay gateway service exists in MOCK mode for rate
syncing only. The deposit flow uses a generic webhook pattern (user pays
externally → webhook confirms → balance credited).

**Target state:** When the local fiat pool (MTN account) is approved:
1. `gatewayService.initiateCollect()` fires a USSD/MoMo prompt to the
   user's phone number (Kotani's collection API).
2. User approves on their phone → Kotani settlement webhook fires.
3. Backend credits USDC at the live oracle rate.

**Admin controls:**
- Minimum/maximum deposit amounts (per provider)
- Collection fee (if any) — currently 0 (platform absorbs)
- Auto-credit threshold (amounts above X need manual approval)

---


15. UI/UX SPRINT FRAMEWORK (Phase UI-1 → UI-5, 2026-05-26)

**Product Decision (2026-05-26).** A coordinated 5-task sprint to declutter the
visual surface, realign payout/deposit logic in the settings drawer, and
introduce a unique transactional-tickets workspace inside chat. Tasks 3-5
require backend collaboration; Task 1-2 are pure frontend. Each task is
shipped as its own PR pair where backend work is involved.

15.1 TASK 1 — UI DE-CLUTTERING (FE-only — Phase UI-1)

Status: IN REVIEW (FE PR).

No backend impact. Pure frontend cosmetic strips:
- Header chat icon removed (bottom nav already carries Chat).
- Vendor pull-tab "Start Application" button replaced with website-CTA text.
- Vendor ad cards "Trade Now" button removed (card-tap → flip overlay is the
  only interaction gateway).
- Settings drawer payment tiles replaced with slender list-tile pattern.

15.2 TASK 2 — DRAWER PAYOUT/DEPOSIT REALIGNMENT (FE-only — Phase UI-2)

Status: IN REVIEW (FE PR).

No backend impact. Three cleanups landed:
- Drawer "PAYMENT ADDRESSES" section pairs Deposit + Withdrawal Address
  tiles in a single bordered card.
- Settings → Payment "Trade Accounts" tile REMOVED — global fiat handles
  belong exclusively in the vendor dashboard.
- `saved_wallets_screen.dart` filter hardened with an explicit blocklist
  of all 11 global-fiat method types so legacy conflated rows can't leak.

15.3 TASK 3 — CHAT MEDIA INFRASTRUCTURE (FE + BE — Phase UI-3)

Status: IN REVIEW (BE + FE PR pair).

**Backend deliverables (shipped this phase):**
- Schema migration `20260526_phase_ui3_chat_media` extends `MessageType` and
  `DirectMessageType` enums with IMAGE / VIDEO / DOCUMENT / AUDIO / LINK
  (plus TICKET_LINK reserved for UI-4). Both `Message` and `DirectMessage`
  models gain seven nullable media columns. New `LinkPreviewCache` table.
- `services/linkPreviewService.js` (NEW) — server-side OG metadata fetcher
  with URL normalisation, 6s network budget, 256KB HTML read cap. 24h
  success TTL / 1h failure TTL.
- Four typed authenticated upload endpoints in `server.js`:
  - `POST /api/chat/upload/image` (10MB, image/*)
  - `POST /api/chat/upload/audio` (5MB; accepts duration + 50-bucket
    waveformPeaks)
  - `POST /api/chat/upload/video` (50MB; accepts duration)
  - `POST /api/chat/upload/document` (25MB; pdf/docx/xlsx/pptx/txt/csv)
- `POST /api/chat/link-preview` returns cached/freshly-fetched OG metadata.
- `directMessageController.sendMessage` accepts all seven media fields plus
  `metadata.ticketId` (for the future TICKET_LINK type). Validation:
  media-typed messages require `mediaUrl`; ticket-link messages require
  `metadata.ticketId`; TEXT requires non-empty content. LINK type
  opportunistically server-fetches OG metadata if the client didn't supply
  `linkPreview`. FCM push body adapts per media type.
- Storage path convention: `uploads/chat/<userId>/<kind>/<filename>`.
- Legacy `/api/chat/upload-media` retained (unauth, 8MB, image-only) so
  older builds in the wild keep working.

**Frontend deliverables (shipped this phase, FE PR):**
- `lib/services/chat_media_service.dart` — typed wrappers around the four
  uploads + link preview.
- `lib/widgets/chat_media_bubble.dart` — single canonical renderer for
  IMAGE / VIDEO / AUDIO / DOCUMENT / LINK bubbles. Drop-in for direct chat,
  trade chat, ticket workspace, vault grids.
- `pubspec.yaml` — added `file_picker: ^8.1.4`.

**Deferred to a polish PR:** in-bubble inline audio playback with scrubber
and an in-app hold-to-record audio recorder. The upload endpoint already
accepts pre-computed waveform peaks so the recorder can drop in without
any backend changes.

15.4 TASK 4 — TICKETS ENGINE (FE + BE — Phase UI-4)

Status: IN REVIEW (BE + FE PR pair). **Highest-impact feature in the sprint.**

Tickets are isolated, trackable chat workspaces generated inside an existing
peer-to-peer friendship to record a specific business deal, transaction, or
agreement. They are NOT escrow-backed P2P trades — those remain the formal
`Trade` flow. Tickets are lightweight social-transactional records.

**Backend deliverables (shipped this phase):**
- Schema migration `20260526_phase_ui4_tickets_engine` adds `TicketType` +
  `TicketStatus` enums, `Ticket` + `TicketMessage` tables, and
  `Friendship.localNicknames` JSONB (used by Phase UI-5).
- `controllers/ticketController.js` — six REST endpoints (create, list,
  detail, send-message, status-change, presence-ping) with full validation,
  type-safe transitions, parent-chat event-card injection.
- `services/ticketSocketService.js` — three client-emitted handlers
  (`join_ticket`, `leave_ticket`, `ticket_typing`). Server-emitted events
  (`ticket_created`, `ticket_message`, `ticket_status_changed`,
  `ticket_presence_update`) fanned out by the controller.
- `routes/ticketRoutes.js` mounted at `/api/tickets` with `generalLimiter`
  + `protect` everywhere.

**Frontend deliverables (shipped this phase, FE PR):**
- `lib/services/ticket_service.dart` — typed REST client.
- `lib/providers/ticket_provider.dart` — two Riverpod families
  (`ticketDashboardProvider` + `ticketWorkspaceProvider`).
- Three new screens under `lib/screens/tickets/`: dashboard, create-sheet,
  workspace.
- `friend_chat_screen.dart`: AppBar Transfer icon REPLACED with the
  Ticket button; new `TICKET_LINK` event card renderer; new presence
  banner socket listener.

15.4.1 DATA MODEL (Prisma — shipped)

```prisma
enum TicketType {
  BUY
  SELL
  ESCROW
  SERVICE_SWAP
}

enum TicketStatus {
  OPEN
  CLOSED
  CANCELLED
}

model Ticket {
  id              String        @id @default(cuid())
  friendshipId    String
  friendship      Friendship    @relation(fields: [friendshipId], references: [id])
  creatorId       Int
  creator         User          @relation("TicketCreator", fields: [creatorId], references: [id])
  counterpartyId  Int
  counterparty    User          @relation("TicketCounterparty", fields: [counterpartyId], references: [id])
  name            String        @db.VarChar(80)
  type            TicketType
  targetAmount    Decimal       @db.Decimal(20, 8)
  targetCurrency  String        @db.VarChar(8)
  memo            String?       @db.VarChar(500)
  status          TicketStatus  @default(OPEN)
  messages        TicketMessage[]
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  closedAt        DateTime?
  cancelledAt     DateTime?
  lastActivityAt  DateTime      @default(now())

  @@index([friendshipId, status, lastActivityAt(sort: Desc)])
}

model TicketMessage {
  id             String   @id @default(cuid())
  ticketId       String
  ticket         Ticket   @relation(fields: [ticketId], references: [id])
  senderId       Int
  type           String   // TEXT | IMAGE | VIDEO | DOCUMENT | AUDIO | LINK | TRANSFER | SYSTEM
  content        String?
  mediaUrl       String?
  mediaType      String?
  mediaMimeType  String?
  mediaSize      Int?
  mediaDuration  Int?
  mediaWaveformPeaks Json?
  linkPreview    Json?
  createdAt      DateTime @default(now())

  @@index([ticketId, createdAt(sort: Desc)])
}
```

15.4.2 ENDPOINTS

- `POST /api/tickets` → create ticket; injects `TICKET_CREATED` event card
  into the parent chat stream as a regular `PersonalChatMessage` with
  `type: 'TICKET_LINK'` and `metadata.ticketId`.
- `GET /api/tickets?friendshipId=&status=&cursor=` → paginated list.
- `GET /api/tickets/:id` → ticket detail + last 50 messages.
- `POST /api/tickets/:id/messages` → send message in workspace. Reuses
  Task 3's media upload helpers.
- `PATCH /api/tickets/:id/status` → close / cancel / reopen.
- `POST /api/tickets/:id/presence` → emit "I'm viewing" presence ping.

15.4.3 SOCKET EVENTS

- `ticket_created` — room `friendship_${friendshipId}`. Dashboard refresh +
  parent chat injection.
- `ticket_message` — room `ticket_${ticketId}`. New message in workspace.
- `ticket_presence_update` — room `friendship_${friendshipId}`. Banner
  toggle for "the other party is viewing the ticket".
- `ticket_status_changed` — room `friendship_${friendshipId}`. Closed/
  cancelled/reopened.

15.4.4 INTEGRATION RULES

- Tickets are NOT P2P trades. They do not touch `escrowLockedBalance`,
  `availableBalance`, or any wallet column. They are pure chat artifacts.
- Tickets do NOT auto-trigger AZM rewards. AZM is reserved for completed
  P2P trades, login streaks, referrals, achievements, and milestones.
- Closing a ticket is non-destructive: messages stay readable, presence
  stops broadcasting, status badge becomes "CLOSED".
- Cancelling a ticket is similar but visually distinct: red status badge.
- A new event card is injected into the parent chat for every status
  change (created → closed → cancelled → reopened).

15.5 TASK 5 — CHAT PROFILE + TRANSACTION VAULT (FE + BE — Phase UI-5)

Status: IN REVIEW (BE + FE PR pair).

**Backend deliverables (shipped this phase):**
- No new schema migration — `Friendship.localNicknames` JSONB shipped
  with Phase UI-4's migration.
- New `controllers/chatProfileController.js` with five participant-gated
  endpoints (profile, nickname PATCH, media, docs+links, receipts).
- `services/receiptService.js` extended with `generateTransferReceipt`
  for immutable peer-transfer PDF receipts.
- `routes/friendRoutes.js` mounts the five chat-profile routes;
  `routes/receiptRoutes.js` mounts the new transfer-receipt route.

**Frontend deliverables (shipped this phase):**
- `lib/services/chat_profile_service.dart` — typed REST client.
- `lib/providers/chat_profile_provider.dart` — Riverpod family with
  `primeAll()` parallel fetch + per-tab refresh + optimistic-with-
  rollback nickname updates.
- `lib/screens/chat_profile_screen.dart` — full screen with identity
  tier card + tabbed Media / Docs & Links / Tickets / Receipts vault.
- `friend_chat_screen.dart` AppBar title (avatar + name) wrapped in
  a tappable region that routes to the new screen.

15.5.1 IDENTITY MANAGEMENT

- New column on `Friendship`: `localNicknames Json @default("{}")`. Map of
  `{ "<userId>": "<nickname>" }`. Each side of the friendship can set their
  own nickname for the other; both are stored in the same JSON map keyed by
  the OBSERVER's userId (so user A's nickname for B is stored under A's id).
- New endpoint: `PATCH /api/friends/:friendshipId/nickname` body
  `{ nickname: string|null }`. Server stores under the authenticated user's
  id slot in the JSON map.

15.5.2 MEDIA & LEDGER VAULT

Aggregator endpoints (all paginated cursor-based, scoped to authenticated
user's friendship):

- `GET /api/friends/:friendshipId/media?type=image|video&cursor=`
  Returns chronologically sorted images/videos from `PersonalChatMessage` +
  `TicketMessage` where `type IN (IMAGE, VIDEO)`.

- `GET /api/friends/:friendshipId/docs-links?cursor=`
  Returns docs (`type = DOCUMENT`) and link-preview cards (`type = LINK`)
  from both message tables.

- `GET /api/friends/:friendshipId/tickets?status=&cursor=`
  Returns all tickets between the two friendship parties, sorted by
  `lastActivityAt DESC`.

- `GET /api/friends/:friendshipId/receipts?cursor=`
  Returns immutable P2P direct-transfer records (the existing
  `friend_message` events of `type = 'TRANSFER_COMPLETED'`). Each row:
  `{ id, amount, currency, reference (memo/reason), direction (SENT|RECEIVED),
  status, createdAt, downloadUrl }`. The downloadUrl points at a new
  `GET /api/receipts/transfer/:id` endpoint that reuses Phase Q11's
  `receiptService.js` PDF generator.

15.5.3 RECEIPT DEFINITION

A **Receipt** is an automated immutable record of a direct P2P off-ticket money
transfer between two friends. It is generated by the existing "send money with
a tracking reason" flow in personal chats. Receipts cleanly differentiate
casual balance transfers from structured ticket deals.

- Source: existing `PersonalChatTransfer` records that completed (status =
  `COMPLETED`). No schema change required — receipts are a query view, not a
  new table.
- Receipt PDF: reuses `services/receiptService.js`. New function
  `generateTransferReceipt(transfer, observer)`. Same branded layout, masked
  counterparty, QR verification code.
- Authorization: requesting user must be one of the two transfer parties.

15.6 EXECUTION ORDER

| Task | Phase | Repos | Status |
|------|-------|-------|--------|
| 1 — UI De-cluttering | UI-1 | FE | IN REVIEW (FE PR) |
| 2 — Drawer Payout/Deposit Realignment | UI-2 | FE | IN REVIEW (FE PR) |
| 3 — Chat Media Infrastructure | UI-3 | FE + BE | IN REVIEW (BE + FE PR pair) |
| 4 — Tickets Engine | UI-4 | FE + BE | IN REVIEW (BE + FE PR pair) |
| 5 — Chat Profile + Transaction Vault | UI-5 | FE + BE | IN REVIEW (BE + FE PR pair) |

Tasks 4 and 5 share Task 3's media infrastructure so Task 3 is a hard
prerequisite for Task 4's full scope (text-only Tickets MVP could ship in
parallel).
