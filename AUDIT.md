# Azaman Backend — Full Audit (May 2026)

> Read-only audit. **No code has been changed.** This document is the result
> of a feature-by-feature walk of every controller, route, service, worker,
> and middleware in the backend, mapped against the Prisma schema, the API
> contract (`api_contract.md`), and the design doc (`AZAMAN_MASTER_SOUL.md`).
>
> The goal is one document you can read end-to-end and decide which fixes
> get applied, in what order. Each finding is scored:
>
> - **P0 — Broken / unsafe.** App-level functionality fails, money can be lost, or a
>   security check is missing. Must fix before frontend work.
> - **P1 — Half-wired.** Code exists but is never called, or is called but
>   doesn't do what its name implies. The "why isn't this on screen?" class.
> - **P2 — Polish.** Naming, dead code, mobile-friendliness of payloads, missing
>   pagination, error-message clarity.
>
> When this audit becomes a fix PR, every item below will get a checkbox and
> a corresponding commit. Items you don't want fixed get crossed out — your call.

---

## CHANGELOG & POST-AUDIT VERIFICATION

### Phase ADMIN-CONTROL-2 — Backend Critical Fixes + Missing Indexes (2026-06-06, implemented, BE)

Seven targeted fixes closing the gaps identified in the full three-codebase audit:

1. **GET /api/auth/platform/config** — new public (no-auth) endpoint exposing all user-facing fee rates from GlobalSettings. Flutter PlatformConfigProvider calls this on app start. Falls back to hardcoded defaults if DB is offline so the app is never broken by a missing row. Rate-limited to 60 req/min per IP via generalLimiter to prevent scraper abuse.

2. **cryptoPlatformFeePct now applied in walletController.requestWithdrawal** — After reading GlobalSettings, a platform fee (default 0%) is calculated, deducted from the withdrawal, credited to SystemProfitFees, and logged in AdminProfitLog with source CRYPTO_WITHDRAWAL_FEE. The admin portal's cryptoPlatformFeePct control now has real effect. Added platformFeeUsdc field to withdrawal records.

3. **Server-side KYC gate added in tradeController.initiateTrade** — Checks buyer.kycStatus === 'VERIFIED' before any trade row is created. Returns code: KYC_REQUIRED (HTTP 403) to the client. Prevents bypassed KYC via modified APK or direct API calls. Gate runs immediately after userId extraction and before any other business logic.

4. **feeProfileService N+1 eliminated** — vendor and buyer records are now fetched once before the profile resolution loop. The async _matchesContext replaced with synchronous _matchesContextSync that uses the pre-fetched objects. Reduces DB round-trips from O(n_profiles) to O(1) per trade.

5. **Fiat pool pre-flight check in finance.service.processFiatWithdrawal** — Before the ACID transaction begins, SystemFiatPool.balance is checked against the required payoutGhs. If insufficient, throws FIAT_POOL_INSUFFICIENT with a user-friendly message. User's USDC is never debited when the pool can't cover the payout. Returns HTTP 503 in finance.controller.js.

6. **Trade initiation response enriched with earnings preview object** — expectedVendorEarningsUsdc, vendorSplitPct, platformFeePct, appliedProfileName. Calculated using resolveFeeProfile at initiation time. Informational only — does not affect the actual fee split at trade completion. Allows Flutter to show vendors their expected earnings without client-side estimation.

7. **Dispute resolution buyerPercent safety guard** — values outside 5–95% range return HTTP 422 with code EXTREME_RULING_REQUIRES_OVERRIDE. Caller must resend with override: true to proceed. Prevents accidental 0% or 100% rulings in adminRoutes.js. Does not block valid edge cases — just requires explicit confirmation.

8. **Database Index Migration (20260606120000_add_missing_indexes)** — Comprehensive index audit across all 40+ models. 16 models had zero or insufficient indexes. Added 55 new indexes using CREATE INDEX CONCURRENTLY (zero downtime). Critical fixes: Withdrawal (was zero indexes → 3 composites for admin queue, user history, reconciliation), TransactionHistory (userId only → 4 composites for pagination and filtering), AdminProfitLog (zero → 3 for revenue dashboard), SavedWallet (zero → 2 for withdrawal screen), Review (only unique → 3 for vendor profile), plus Susu, SmartRoute, Group, TradeQueue, ColdStorage, VendorApplication, and Savings models. Every index targets a traced query pattern from controllers/services/workers.

### Phase UI-5 — Chat Profile + Transaction Vault (2026-05-26, in review, BE)

**Backend half of the Chat Profile + Vault.** Five aggregator endpoints
plus a new transfer-receipt PDF generator. No schema migration —
`Friendship.localNicknames` JSONB shipped with Phase UI-4 and is
consumed here.

- **`controllers/chatProfileController.js` (NEW)** with five
  participant-gated endpoints:
  - `GET   /api/friends/:friendshipId/profile` — identity tier
    (friend's username, avatar, KYC status, completion rate, loyalty
    tier, account age) + caller's local nickname for the friend +
    mutual P2P trade count (from `Trade` aggregation).
  - `PATCH /api/friends/:friendshipId/nickname` — body
    `{nickname: string|null}`. Stores under observer's userId in
    `Friendship.localNicknames`. Empty string or null clears the
    nickname. 40-char cap.
  - `GET   /api/friends/:friendshipId/media?type=IMAGE|VIDEO&limit=`
    — chronological union of DirectMessage + TicketMessage rows for
    the friendship where `messageType IN (IMAGE, VIDEO)`. Each row
    carries a `source: 'DIRECT'|'TICKET'` discriminator so the FE
    can route taps correctly.
  - `GET   /api/friends/:friendshipId/docs-links?limit=` — same
    union pattern for DOCUMENT + LINK types. LINK rows include the
    `linkPreview` JSONB so the FE renders OG cards without re-
    fetching.
  - `GET   /api/friends/:friendshipId/receipts?status=&cursor=&limit=`
    — paginated PeerTransfer history projected into receipt-shaped
    rows with direction relative to the caller. COMPLETED rows
    include a `downloadUrl` pointing at the transfer-receipt PDF
    endpoint.

- **`services/receiptService.js`** extended with a third public
  function: `generateTransferReceipt(transfer, observer)`. Returns
  a branded PDF Buffer with:
  - Reference (TRF-{first 12 of uuid})
  - Date, status badge (colour-coded), amount + currency
  - Direction relative to observer (SENT vs RECEIVED), masked
    counterparty username
  - Optional memo / reason field
  - Type (SEND vs REQUEST)
  - QR verification code linking to `azaman.app/verify/transfer/:id`
  - Standard branded header + footer disclaimer

- **`controllers/receiptController.getTransferReceipt`** added and
  mounted at `GET /api/receipts/transfer/:id`. Authorization: caller
  must be sender or receiver. Status must be COMPLETED. Returns
  `application/pdf` with `Content-Disposition: attachment`.

- **Tickets vault tab (tab 3) is NOT a new endpoint.** It reuses the
  existing `GET /api/tickets?friendshipId=` from Phase UI-4.

- **Receipt definition** documented in `AZAMAN_MASTER_SOUL.md`
  §15.5.3: receipts are immutable records of direct P2P off-ticket
  money transfers (the existing "send money with reason" PeerTransfer
  flow). They cleanly differentiate casual balance transfers from
  structured ticket deals or formal P2P trade settlements.

Files (3 + 2 routes + 2 docs): `controllers/chatProfileController.js`
(NEW), `controllers/receiptController.js` (+ getTransferReceipt),
`services/receiptService.js` (+ generateTransferReceipt),
`routes/friendRoutes.js` (+ 5 chat-profile routes),
`routes/receiptRoutes.js` (+ transfer route). Plus `AUDIT.md` +
`AZAMAN_MASTER_SOUL.md`.

---

### Phase UI-4 — Tickets Engine (2026-05-26, in review, BE)

**Backend half of the Tickets Engine.** New isolated chat workspaces
generated inside an existing peer-to-peer friendship to record a specific
business deal, transaction, or agreement. Tickets are NOT escrow-backed
P2P trades — they are lightweight social-transactional records.

- **Schema** (`prisma/schema.prisma` + migration
  `20260526_phase_ui4_tickets_engine`):
  - New enums `TicketType` (BUY | SELL | ESCROW | SERVICE_SWAP) and
    `TicketStatus` (OPEN | CLOSED | CANCELLED).
  - New `Ticket` model: `id`, `friendshipId`, `creatorId`,
    `counterpartyId`, `name` (≤80), `type`, `targetAmount`
    (`Decimal(20,8)`), `targetCurrency` (≤8), `memo` (≤500),
    `status`, `createdAt`, `updatedAt`, `closedAt`, `cancelledAt`,
    `lastActivityAt`. Composite index
    `(friendshipId, status, lastActivityAt DESC)` powers the dashboard
    query.
  - New `TicketMessage` model with the same Phase UI-3 media columns
    (`mediaUrl`, `mediaType`, `mediaMimeType`, `mediaSize`,
    `mediaDuration`, `mediaWaveformPeaks`, `linkPreview`) so
    `chat_media_bubble.dart` renders identically in tickets and direct chat.
  - `Friendship.localNicknames` JSONB column (default `{}`) — used by
    Phase UI-5 Chat Profile Detail screen for per-friendship nickname
    overrides. Shipping the column now keeps Phase UI-5 a pure FE PR.

- **Controller** (`controllers/ticketController.js`) with six endpoints:
  - `POST /api/tickets` — create. Validates name length (1–80), type
    enum, positive amount, currency length (1–8), memo length (≤500).
    Verifies caller is a participant of an ACCEPTED friendship.
  - `GET /api/tickets?friendshipId=&status=&cursor=&limit=` — paginated
    list (cursor-based, max 100 per page).
  - `GET /api/tickets/:id` — full ticket + last 50 messages
    (chronologically reversed for client convenience).
  - `POST /api/tickets/:id/messages` — send message. Reuses Phase UI-3
    media fields. Forbids posting to non-OPEN tickets (HTTP 409).
    Opportunistically server-fetches OG metadata for LINK type.
  - `PATCH /api/tickets/:id/status` — close / cancel / reopen. Forbids
    illegal transitions (e.g. CLOSED → CANCELLED without reopening
    first). Sets `closedAt` / `cancelledAt` timestamps appropriately.
  - `POST /api/tickets/:id/presence` — broadcast presence ping
    (`viewing: true | false`) so the counterparty's main chat surface
    can render the "currently viewing the ticket" banner.

- **Routes** (`routes/ticketRoutes.js`) mounted at `/api/tickets` with
  `generalLimiter` + `protect` (JWT) on every endpoint.

- **Socket service** (`services/ticketSocketService.js`) handles three
  client-emitted events:
  - `join_ticket` (`{ticketId}`) — verifies participation, joins the
    `ticket_${id}` room, broadcasts `ticket_presence_update` with
    `viewing: true` to the parent friendship room so the other side's
    banner appears immediately.
  - `leave_ticket` (`{ticketId}`) — leaves the room and broadcasts
    `viewing: false`.
  - `ticket_typing` (`{ticketId, isTyping}`) — typing indicator
    inside the workspace.

- **Server-emitted socket events** (fanned out by the controller):
  - `ticket_created` → both users' `user_${id}` rooms.
  - `ticket_message` → `ticket_${id}` room + both users' rooms (so the
    inbox badge updates even if neither has the workspace open).
  - `ticket_status_changed` → both users' rooms + a `friend_message`
    event card injected into the parent friendship chat room.
  - `ticket_presence_update` → broadcast on REST presence ping AND on
    socket `join_ticket` / `leave_ticket`.

- **Parent chat injection.** On every status transition (created /
  closed / cancelled / reopened) the controller writes a TICKET_LINK
  `DirectMessage` into the parent friendship chat with metadata
  `{ ticketId, ticketName, ticketType, ticketStatus, eventType,
  targetAmount, targetCurrency }`. This drives the deep-link card in
  the FE chat feed.

- **Integration rules** (documented in `AZAMAN_MASTER_SOUL.md` §15.4):
  - Tickets do NOT touch any wallet column. They are pure chat artifacts.
  - Tickets do NOT trigger AZM rewards.
  - Closing a ticket is non-destructive — messages stay readable, posting
    is locked, status badge becomes CLOSED. Reopening is supported.

Files (4 + 1 migration + 2 docs):
`prisma/schema.prisma`,
`prisma/migrations/20260526_phase_ui4_tickets_engine/migration.sql` (NEW),
`controllers/ticketController.js` (NEW),
`routes/ticketRoutes.js` (NEW),
`services/ticketSocketService.js` (NEW),
`server.js` (mount + socket service registration). Plus `AUDIT.md` +
`AZAMAN_MASTER_SOUL.md`.

---

### Phase UI-3 — Chat Media Infrastructure (2026-05-26, in review, BE)

**Backend half of the chat-media expansion.** Schema, migration, link-preview
service, four typed upload endpoints, and `directMessageController.sendMessage`
extension. Frontend companion ships the service layer + bubble renderer.

- **Schema** (`prisma/schema.prisma` + migration
  `20260526_phase_ui3_chat_media`):
  - `MessageType` enum: + IMAGE, VIDEO, DOCUMENT, AUDIO, LINK
  - `DirectMessageType` enum: + IMAGE, VIDEO, DOCUMENT, AUDIO, LINK,
    TICKET_LINK (reserved for Phase UI-4 — event card injected into parent
    friendship chat when a ticket is created/closed/cancelled)
  - Seven new nullable columns on both `Message` and `DirectMessage`:
    `mediaUrl`, `mediaType`, `mediaMimeType`, `mediaSize` (int, bytes),
    `mediaDuration` (int, seconds), `mediaWaveformPeaks` (JSONB int array,
    audio only), `linkPreview` (JSONB OG metadata).
  - New `LinkPreviewCache` model: `urlHash` (sha256, unique), `url`,
    `title`, `description`, `image`, `favicon`, `siteName`, `status` (OK |
    FAILED | TIMEOUT | BLOCKED), `fetchedAt`, `expiresAt`. Indexed on
    `urlHash` + `expiresAt`.

- **`services/linkPreviewService.js`** — server-side Open Graph fetcher:
  - URL normalisation strips utm_*/gclid/fbclid/ref/ref_src/referrer
    tracking params, lowercases the host, drops fragment, sorts search
    params for stable hashing.
  - sha256(normalised URL) is the cache key.
  - 6s network budget per fetch, 256KB HTML read cap, custom UA
    (`AzamanLinkPreviewBot/1.0`).
  - Parses OG/Twitter/document title + description, OG/Twitter image,
    OG site name, favicon. Resolves relative URLs against the base URL.
  - 24h success TTL, 1h failure TTL (so dead URLs don't get hammered on
    every chat scroll but recover quickly when they come back online).
  - Direct image URLs (Content-Type starts with `image/`) synthesise a
    minimal preview `{ image: url, siteName: host }`.

- **Four typed authenticated upload endpoints** (`server.js`):
  - `POST /api/chat/upload/image` — 10MB, image/* mimes. Returns
    `{ url, mimeType, size, filename }`.
  - `POST /api/chat/upload/audio` — 5MB, m4a/mp4/webm/ogg/aac/wav.
    Optional `duration` + `waveformPeaks` (50-bucket int array) body
    fields stored verbatim. Returns
    `{ url, mimeType, size, duration, waveformPeaks }`.
  - `POST /api/chat/upload/video` — 50MB, video/* mimes. Optional
    `duration` body field. Returns
    `{ url, mimeType, size, duration }`.
  - `POST /api/chat/upload/document` — 25MB, pdf/docx/xlsx/pptx/txt/csv.
    Returns `{ url, mimeType, size, filename }`.
  - All four gated by `protect` (JWT). Storage:
    `uploads/chat/<userId>/<kind>/<filename>` — per-user subdirectory for
    audit trails + garbage collection.

- **`POST /api/chat/link-preview`** — body `{ url }`, returns
  `{ success, preview }`. Cached/freshly fetched.

- **Legacy `/api/chat/upload-media`** retained (image-only, 8MB, unauth)
  to avoid breaking older clients in the wild. New clients target the
  four typed routes.

- **`directMessageController.sendMessage`** extended:
  - Accepts all seven media fields plus `metadata.ticketId` (reserved
    for Phase UI-4).
  - Validation: media-typed messages require `mediaUrl`; TICKET_LINK
    requires `metadata.ticketId`; TEXT requires non-empty `content`.
  - For LINK type, opportunistically fetches OG metadata server-side if
    the client didn't supply `linkPreview`.
  - FCM push body adapts per media type (📷 Photo, 🎥 Video, 🎙️ Voice
    message, 📄 Document, 🔗 Shared a link, 🎟️ Created a ticket).

- **Backwards-compat:** existing TEXT messages, transfer messages, and
  socket consumers are unchanged. Older clients reading new payloads
  ignore unknown fields and render via their existing TEXT path.

Files (4 + 1 migration + 2 docs): `prisma/schema.prisma`,
`prisma/migrations/20260526_phase_ui3_chat_media/migration.sql` (NEW),
`services/linkPreviewService.js` (NEW),
`controllers/directMessageController.js`, `server.js`. Plus `AUDIT.md` +
`AZAMAN_MASTER_SOUL.md`.

---

### Phase UI-1 — Sprint Framework Documented (2026-05-26, docs only, BE)

**No backend code change.** Master soul `§15` added to document the
coordinated 5-task UI/UX sprint:

- **Task 1 (UI De-cluttering)** — FE-only, in review on the FE PR.
  Strips redundant header chat icon, vendor pull-tab "Start Application"
  button, vendor ad card "Trade Now" button, and slims drawer payment tiles.
- **Task 2 (Drawer Payout/Deposit Realignment)** — FE-only, planned.
  Mirrors deposit address into drawer; locks withdrawal addresses to MoMo +
  Crypto only; strips global-fiat trade accounts from user surface.
- **Task 3 (Chat Media Infrastructure)** — FE + BE, planned. New
  `MessageType` enum entries (AUDIO, IMAGE, VIDEO, DOCUMENT, LINK), new
  media columns on `PersonalChatMessage` + future `TicketMessage`, four
  upload endpoints, new `linkPreviewService` for server-side Open Graph
  fetching with 24h cache.
- **Task 4 (Tickets Engine)** — FE + BE, planned. **Highest-impact feature
  in the sprint.** New `Ticket` + `TicketMessage` Prisma models, full REST
  CRUD + sockets, header Ticket button replaces "Send Money" in chat
  AppBar, tabbed Open/Closed/Cancelled dashboard with FAB, structured
  creation form, presence indicator broadcast when one side opens a
  ticket workspace, parent-chat event card injection on creation that
  deep-links both parties into the isolated ticket.
- **Task 5 (Chat Profile + Transaction Vault)** — FE + BE, planned.
  `Friendship.localNicknames` JSON column, four aggregator endpoints
  (media, docs+links, tickets, receipts), receipt PDF generator extended
  with `generateTransferReceipt(transfer, observer)`. Receipts defined as
  immutable records of P2P direct transfers (the existing "send money with
  reason" flow becomes a first-class receipt artifact).

Files (1 doc): `AZAMAN_MASTER_SOUL.md` — §15 framework block.

---

### Phase Q11 — Transaction Receipt PDFs (2026-05-25, in review, BE)

**DOWNLOADABLE PDF RECEIPTS.** New receipt generation system that produces
branded, print-ready PDF documents for completed trades and withdrawals.

- **New `services/receiptService.js`** — PDFKit-based PDF builder:
  - `generateTradeReceipt(trade, user)` — A4 PDF with: branded header
    (AZAMAN green accent), transaction reference (TRD-0000001 format),
    completion date, crypto amount + fiat equivalent, exchange rate,
    counterparty (masked: first 3 chars + ***), payment method, timing
    (initiated/completed/duration), vendor profit cut (vendor-only view),
    QR code linking to verification URL, disclaimer footer.
  - `generateWithdrawalReceipt(withdrawal, user)` — Same branded layout
    with: reference (WDR-0000001), amount, network fee, net received,
    payout method (human-readable), network, masked destination (first 4
    + **** + last 4), status-colored badge, QR verification code.
  - Both functions return a `Buffer` (no temp files, no filesystem writes).

- **New `controllers/receiptController.js`** — 2 endpoints:
  - `GET /api/receipts/trade/:tradeId` — downloads trade receipt PDF
  - `GET /api/receipts/withdrawal/:id` — downloads withdrawal receipt PDF
  - Both: authenticate via `protect`, verify user is a party to the
    transaction, reject non-COMPLETED with explanatory 400, stream PDF
    with `Content-Disposition: attachment`, cache for 1 hour (private).

- **New `routes/receiptRoutes.js`** — mounted at `/api/receipts` with
  `generalLimiter` in `server.js`.

- **New dependency:** `pdfkit: ^0.16.0` — pure-JS PDF generation. No
  native binaries, no Chromium, no puppeteer. Works in any Node.js env.

**Files (5 + 2 docs):**
`services/receiptService.js` (NEW), `controllers/receiptController.js` (NEW),
`routes/receiptRoutes.js` (NEW), `server.js` (import + mount),
`package.json` (+pdfkit dep). Plus `AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.

---

### Phase Q8 — Admin Autonomous Payouts (2026-05-25, in review, BE PR #71)

**AUTOMATED PAYOUT PROCESSING.** New scheduled worker that scans PENDING
fiat withdrawals and auto-dispatches them via MTN MoMo when pool liquidity
is sufficient and the withdrawal amount is below a configurable threshold.
Withdrawals that fail any gate are flagged as NEEDS_MANUAL_REVIEW for the
admin War Room.

- **New `workers/payoutBatchWorker.js`** — scheduled batch processor:
  - Reads configuration from `GlobalSettings` on every tick (admin can
    change settings live without restart).
  - Three gates per withdrawal:
    1. Amount <= `autoPayoutMaxAmountUsdc` (default $200)
    2. `SystemFiatPool.balance` >= `autoPayoutThresholdUsdc` (default $500)
    3. Recipient phone number present on the withdrawal record
  - **Pass all gates** → dispatches via `mtnDisbursementService.initiateTransfer()`,
    marks withdrawal `PROCESSING`. Reconciliation worker polls for final status.
  - **Fail any gate** → marks `NEEDS_MANUAL_REVIEW`, notifies user ("under
    review"), emits `admin_alert` socket event with batch summary.
  - Processes up to 25 withdrawals per tick. Uses setTimeout-based scheduling
    so interval is re-read from DB each cycle.

- **Four new admin API endpoints:**
  - `POST /api/admin/payouts/batch-process` — manual trigger. Body:
    `{ force?: boolean }`. When `force=true`, runs even if
    `autoPayoutEnabled` is false. Returns full processing summary.
  - `GET /api/admin/payouts/settings` — returns current auto-payout config
    + fiat pool balance.
  - `PUT /api/admin/payouts/settings` — update any/all of the four config
    fields. Validates ranges (threshold >= 0, interval >= 10s).
  - `GET /api/admin/payouts/needs-review` — paginated list of withdrawals
    with status `NEEDS_MANUAL_REVIEW` (cursor + offset pagination, same
    pattern as Phase I).

- **Schema migration** (`20260525_phase_q8_autonomous_payouts`):
  - `GlobalSettings.autoPayoutEnabled` (Boolean, default false)
  - `GlobalSettings.autoPayoutThresholdUsdc` (Decimal(20,8), default 500)
  - `GlobalSettings.autoPayoutMaxAmountUsdc` (Decimal(20,8), default 200)
  - `GlobalSettings.autoPayoutIntervalMs` (Int, default 120000)
  - CHECK constraints on all three numeric fields.

- **`server.js`** — PayoutBatchWorker singleton instantiated after
  withdrawalReconciliationWorker, registered via `app.set('payoutBatchWorker')`.

- **`.env.example`** — documents the four settings (noted as DB-controlled
  after first boot; env vars are reference only).

- **No changes to the user-facing withdrawal flow.** The existing
  `withdrawalController.fiatWithdrawal` path is unchanged — it still
  creates PENDING rows. The batch worker picks them up on its next tick.

Files (7 + 2 docs): `workers/payoutBatchWorker.js` (NEW),
`controllers/adminController.js`, `routes/adminRoutes.js`, `server.js`,
`prisma/schema.prisma`, migration SQL, `.env.example`. Plus `AUDIT.md` +
`AZAMAN_MASTER_SOUL.md`.

---

### Phase Q6 — KYC Integration Prep (Dojah) (2026-05-25, merged 2026-05-25, BE PR #70)

**AUTOMATED IDENTITY VERIFICATION.** Replaces the legacy manual-upload KYC
flow (user uploads ID images → admin reviews) with Dojah widget-based
verification. Users complete identity checks (selfie + liveness + document)
inside the Dojah widget; results arrive via HMAC-secured webhook. Admin
manual override preserved as fallback.

- **Rewritten `services/kycService.js`** — full Dojah integration class.
  - `initializeSession()` → calls Dojah `/api/v1/kyc/widget/initialize`,
    returns widget URL + reference ID for FE WebView.
  - `processWebhook()` → HMAC-SHA256 signature verification, payload
    normalization (handles both event-based and direct Dojah formats),
    confidence-based auto-determination of KYC status.
  - `adminOverride()` → manual approve/reject regardless of provider.
  - `getStatus()` → enriched status with re-initialization eligibility.
  - **MOCK mode** (default): returns fake widget URL, accepts
    `mock_signature`, surfaces sample webhook payload in response for
    easy dev/CI testing.
  - **Confidence thresholds**: `>= 70` → auto VERIFIED, `< 40` → auto
    REJECTED, between → stays PENDING for admin review (configurable via
    `KYC_AUTO_APPROVE_THRESHOLD` / `KYC_AUTO_REJECT_THRESHOLD` env vars).
  - Notification dispatch on every status change via notificationService.

- **Rewritten `controllers/kycController.js`** — 4 endpoints:
  - `POST /api/kyc/initialize` (auth-protected) — create Dojah session.
  - `POST /api/kyc/webhook/dojah` (NO auth — HMAC-only) — webhook receiver.
    Always returns HTTP 200 to prevent Dojah retry storms.
  - `GET /api/kyc/status` (auth-protected) — current status + can-reinitialize flag.
  - `POST /api/kyc/admin/override` (admin-only) — manual approve/reject
    with required audit reason.

- **Rewritten `routes/kycRoutes.js`** — replaces legacy `/submit` (Multer
  file upload) route with the webhook-based flow. Old file-upload path
  removed (Dojah handles document capture inside their widget).

- **`server.js`** — KYCService singleton instantiated after
  notificationService, registered via `app.set('kycService', ...)`.

- **`.env.example`** — 8 new KYC env vars documented: `KYC_PROVIDER`,
  `DOJAH_APP_ID`, `DOJAH_PUBLIC_KEY`, `DOJAH_SECRET_KEY`, `DOJAH_WIDGET_ID`,
  `DOJAH_WEBHOOK_SECRET`, `KYC_AUTO_APPROVE_THRESHOLD`, `KYC_AUTO_REJECT_THRESHOLD`.

- **No schema migration required.** Existing `KycStatus` enum (UNVERIFIED,
  PENDING, VERIFIED, REJECTED) and User fields (kycStatus, legalName,
  idType, idNumber) are sufficient for the new flow.

Files (5 + 2 docs): `services/kycService.js`, `controllers/kycController.js`,
`routes/kycRoutes.js`, `server.js`, `.env.example`. Plus this entry in
`AUDIT.md` + `AZAMAN_MASTER_SOUL.md`.

---

### Phase Q — Platform Sprint: Fee Profiles + Wallet Archives + Notification Nav + Chat UI (2026-05-25, in review, BE + FE)

**MULTI-FEATURE SPRINT.** Five distinct sub-phases shipped in one PR pair
(one BE + one FE) to bring the platform closer to production-ready launch.

**Phase Q1 — Admin Fee Profiles (BE):**
Dynamic margin/split control system. Admin can create fee profiles targeting
specific scopes (ALL, VENDOR_TIER, USER_TIER, INFLUENCER_REFERRAL, HOLIDAY,
CUSTOM) with priority-based resolution. Replaces hardcoded 2%/60-40 constants.

- New `AdminFeeProfile` Prisma model with CHECK constraints (0–1 ranges,
  split sum = 1.0). Migration seeds a system default profile (priority 0).
- New `services/feeProfileService.js` — resolution logic: finds all active
  profiles within their validity window, matches against trade context
  (vendor tier, buyer referral source, custom user IDs), picks highest
  priority. Falls back to hardcoded defaults if DB is empty.
- New `controllers/adminFeeProfileController.js` — full CRUD + resolve
  test endpoint for admin verification.
- Admin routes: GET/POST/PUT/DELETE on `/api/admin/fee-profiles` + GET
  `/api/admin/fee-profiles/resolve?vendorId=&buyerId=&amountCrypto=`.
- **Integration:** `services/p2p.service.js completeTrade` now calls
  `resolveFeeProfile()` to dynamically determine `platformFeePct` and
  `adminSplitPct`/`vendorSplitPct` for each trade.

**Phase Q2 — Vendor Wallet Soft-Delete (BE):**
Trade accounts are NEVER permanently deleted. Security/compliance requirement.

- `TradeAccount` model: added `archivedAt DateTime?` + `archiveReason String?`.
- Migration adds columns + composite index `(userId, archivedAt)`.
- `tradeAccountController.deleteTradeAccount` → soft-delete (sets
  `archivedAt` + `archiveReason='USER_DELETED'`). Never `prisma.delete()`.
- `getTradeAccounts` excludes archived by default (`archivedAt: null`).
  Opt-in via `?includeArchived=true`.
- `getApprovedTradeAccounts` (ad-creation picker) also filters archived.

**Phase Q3 — Notification Tap Navigation Fix (FE):**
`_navigateFromNotification` in `notification_hub_screen.dart` rewritten
to handle ALL 11 action types the backend emits: OPEN_TRADE, PING_TOPUP,
OPEN_DISPUTE, OPEN_FRIEND_REQUEST, OPEN_FRIEND_CHAT,
OPEN_FRIEND_TRANSFER_REQUEST, OPEN_QUEUE, OPEN_WALLET, KYC_STATUS,
ACCOUNT_STATUS, VIEW_SAVINGS, OPEN_AD/OPEN_MARKETPLACE, OPEN_WAR_ROOM.
Backwards-compat fallback for legacy flat `tradeId`/`disputeId` keys +
`route` field last-resort. Previously only `tradeId` and `disputeId`
were handled — all other notification types dead-ended on tap.

**Phase Q4 — Ad Archive / Soft-Delete (BE):**
Vendors can "delete" ads that are no longer functional. Never hard-deleted.

- New `DELETE /api/ads/:id` → `archiveAd` controller. Sets `status='ARCHIVED'`
  + `archivedAt` timestamp. Guards: can't archive ACTIVE ads, can't archive
  if in-progress trades exist.
- `Ad` model: added `archivedAt DateTime?`. Migration adds column.
- `getMyAds` excludes ARCHIVED by default (opt-in `?includeArchived=true`).

**Phase Q5 — Premium Chat Input Redesign (FE):**
Complete rewrite of the trade chat input bar for fintech-grade polish.

- New `_PremiumChatInput` widget replaces the old flat Container+TextField.
- Features: animated focus glow (accent border on focus), multi-line support
  (maxLines: 4), animated send button (scale/opacity based on text), rounded
  attachment buttons with opacity transitions, safe-area handling, 200ms
  smooth animations throughout.
- Applies to both trade chat and DM interfaces (shared widget).

**Phase Q (Master Plan) — Product Decisions Documented:**
All strategic decisions from this session persisted into
`AZAMAN_MASTER_SOUL.md` §8–§14: Admin Fee Profiles, Vendor Wallet
Archiving, Ghana Vendor Fiat Payouts, KYC/Dojah Prep, UI Premium
Mandate, Additional Features (receipt PDFs, rate alerts, vendor badges,
dispute workflow, version gate, vendor analytics), Kotani Pay status.
Unified roadmap expanded from 6 items to 22 (Q1–Q16 series).

**Files (BE — 12):**
- `prisma/schema.prisma` — AdminFeeProfile model, TradeAccount archive fields, Ad archivedAt
- `prisma/migrations/20260525_phase_q1_admin_fee_profiles/migration.sql`
- `prisma/migrations/20260525_phase_q2_vendor_wallet_archive/migration.sql`
- `prisma/migrations/20260525_phase_q4_ad_archive/migration.sql`
- `services/feeProfileService.js` (NEW)
- `controllers/adminFeeProfileController.js` (NEW)
- `controllers/adController.js` — archiveAd + getMyAds filter
- `controllers/tradeAccountController.js` — rewritten for soft-delete
- `routes/adminRoutes.js` — fee profile CRUD routes
- `routes/adRoutes.js` — DELETE /:id route
- `services/p2p.service.js` — fee profile integration in completeTrade
- `AZAMAN_MASTER_SOUL.md` — §8–§14 + expanded roadmap

**Files (FE — 2):**
- `lib/screens/notification_hub_screen.dart` — full navigation rewrite
- `lib/widgets/chat_interface.dart` — premium input bar

---

### Phase J3 — Float→Decimal Migration (2026-05-25, merged 2026-05-25, BE PR #68)

**DATA INTEGRITY FIX.** All 63 Float (DOUBLE PRECISION) columns across 14
models have been converted to DECIMAL/NUMERIC with explicit precision and
scale. This eliminates floating-point rounding errors in financial
calculations (e.g., `0.1 + 0.2 !== 0.3` at the DB level).

Branch: `phase-j3-float-to-decimal`. Backend-only. Four files.

**What this PR does:**

1. **`prisma/schema.prisma`** — All `Float` fields → `Decimal` with `@db.Decimal(p,s)`:
   - `Decimal(20,8)` for monetary amounts (balances, trade amounts, fees, volumes)
   - `Decimal(18,8)` for exchange rates (USD→GHS, crypto→USD)
   - `Decimal(10,4)` for percentages/margins/shares
   - `Decimal(5,2)` for completionRate (bounded 0–100)

2. **`prisma/migrations/20260525_phase_j3_float_to_decimal/migration.sql`** —
   Non-destructive `ALTER COLUMN TYPE` migration. PostgreSQL casts DOUBLE
   PRECISION → NUMERIC without data loss (all float64 values are representable).

3. **`server.js`** — Global `Prisma.Decimal.prototype` patches:
   - `valueOf()` → returns `Number(this.toString())` so all JS arithmetic
     operators (`+`, `-`, `*`, `/`, `<`, `>`) work transparently.
   - `toJSON()` → returns `Number(this.toString())` so `JSON.stringify()`
     and `res.json()` serialize Decimals as numbers (not strings).
   - **Critical discovery:** decimal.js's default `valueOf()` returns a
     STRING, which causes `+` to concatenate instead of add. The override
     fixes all arithmetic globally with zero controller changes.

4. **`utils/decimalHelper.js`** — Utility module for edge cases (raw queries,
   test contexts, workers that don't initialize via server.js).

**Zero controller changes required.** The prototype patches ensure all
existing arithmetic, comparisons, JSON responses, and socket emissions
work identically to the pre-migration Float behavior.

---

### Phase P1 — Queue Socket Events & Auto-Processing (2026-05-25, in review, BE)

**CRITICAL FLOW FIX.** The FE WaitingRoomScreen listens for `queue_promoted`
and `queue_position_update` socket events, but the backend NEVER emitted
them. Additionally, `processNextInQueue` used broken `global.*` references
and was only callable via an admin endpoint — queued buyers were never
auto-promoted when a trade completed or timed out.

Branch: `phase-p1-queue-socket-events`. Backend-only. Four files.

**What this PR does:**

1. **`controllers/queueController.js`** — Full rewrite of queue socket emissions:
   - `processNextInQueue` now emits `queue_promoted` (the primary event FE listens for)
     with `{ queueId, adId, status: 'PROMOTED' }`.
   - Also emits `queue_update` for legacy compat.
   - New `_emitPositionUpdates()` helper: when a buyer leaves or is promoted,
     all remaining WAITING buyers in that ad's queue receive `queue_position_update`
     with their updated `{ queueId, position }`.
   - `leaveQueue` now triggers `_emitPositionUpdates` so remaining buyers see
     their position decrement in real time.
   - `processNextInQueue` accepts `{ prisma, io }` parameters (fixes the
     broken `global.prismaInstance` / `global.socketIoInstance` references that
     were never wired — the function would have crashed on invocation).
   - Notification text corrected from "GHS/USD" to "Tap to start your trade now."

2. **`routes/aiRoutes.js`** — Admin `POST /api/ai/queue/process/:adId` now
   passes `{ prisma, io }` to `processNextInQueue`.

3. **`controllers/p2p.controller.js`** — `completeTrade` now auto-triggers
   `processNextInQueue` in its `setImmediate` block after AZM rewards. When
   a trade completes, the next queued buyer is automatically promoted.

4. **`workers/tradeWorker.js`** — Auto-cancel (`_autoCancelTrade`) now triggers
   `processNextInQueue` via `setImmediate` after returning escrow. A timed-out
   trade also opens a slot for the next queued buyer.

**Socket event contract (all events targeted at `user_${buyerId}`):**
- `queue_joined` — emitted when buyer enters queue (already existed)
- `queue_promoted` — **NEW** — slot opened, buyer should navigate to marketplace
- `queue_position_update` — **NEW** — position changed (someone ahead left/promoted)
- `queue_update` — legacy compat (kept for older FE builds)

**Files (4 + 1 doc):**
- `controllers/queueController.js` — rewrite
- `routes/aiRoutes.js` — pass prisma/io
- `controllers/p2p.controller.js` — auto-trigger on trade complete
- `workers/tradeWorker.js` — auto-trigger on auto-cancel
- `AUDIT.md` — this entry

---

> **Read this first.** When this audit was written, several of its P0 findings
> reflected a snapshot of the codebase that was repaired before the audit was
> committed to git. Phase B (2026-05-24) re-walked every TL;DR finding against
> live code and reconciled the audit against reality. The original audit body
> below remains as a historical narrative — the *truth* is in this section
> and in the unified ROADMAP that follows.

### Phase F2 — P2P Architecture Correction (2026-05-25, in review, BE)

**CRITICAL BUSINESS LOGIC CORRECTION.** ~500 LOC delta across 9 files +
1 migration. The P2P marketplace was incorrectly built as a GHS↔USDC
exchange with oracle rate math. The correct model: P2P is a **global fiat
wallet liquidity bridge** (Zelle, CashApp, Venmo, PayPal, Apple Pay, etc.).
GHS/MoMo is handled internally by the Admin Liquidity Pool (Kotani Pay).

Branch: `phase-f2-p2p-architecture-correction`. Backend-only.

**What this PR does:**

1. **Strips GHS oracle math from P2P** (`tradeController.js`,
   `adController.js`, `p2p.service.js`, `p2p.controller.js`): Removed
   `liveRate`, `effectiveRate`, `adminMarginGhs`, `baseRate` from all
   P2P trade paths. Trades are evaluated in USDC directly (1:1 USD
   parity). Trade `currency` set to `'USD'`, `rate` to `1.0`.

2. **Flat USDC fee model** (`p2p.service.js completeTrade`): Replaces
   the legacy `totalMarginGhs / liveRate` calculation with
   `amountCrypto × p2pFeePct` (default 2%, stored on GlobalSettings).
   Tiered admin/vendor split unchanged (60/40 under $1k, 50/50 over).

3. **Structured vendor payment accounts** (`services/tradeAccountValidation.js`,
   `controllers/tradeAccountController.js`): 11 supported method types
   (Zelle, CashApp, Venmo, PayPal, Apple Pay, Google Pay, Wise, Revolut,
   Gift Cards, Western Union, Wire Transfer) with per-type field
   validation schemas. E.164 phone, email format, $cashtag format, etc.

4. **Ads link to specific accounts** (`adController.js createAd`,
   `prisma/schema.prisma`): New `tradeAccountId` FK on Ad. Vendor
   selects an APPROVED TradeAccount when posting. Marketplace shows the
   method type; sensitive details revealed only after trade initiation.

5. **Buyer recipient details for SELL ads** (`tradeController.js
   initiateTrade`): SELL ads require the buyer to provide their payment
   details (where the vendor should send fiat). Validated against the
   ad's method type schema. Stored on `Trade.buyerPaymentDetails`.

6. **Schema changes** (migration + schema.prisma):
   - `Ad.tradeAccountId` (FK to TradeAccount, nullable)
   - `Trade.buyerPaymentDetails` (JSONB)
   - `GlobalSettings.p2pFeePct` (Float, default 0.02, CHECK 0..1)

7. **Corrected settlement model** (`p2p.service.js`):
   - SELL ad: user escrows → vendor sends fiat → user releases →
     vendor gets `amountCrypto - adminCutUsdc`, user's escrow cleared
   - BUY ad: vendor escrows → user sends fiat → vendor releases →
     user gets `amountCrypto - totalFeeUsdc`, vendor's escrow cleared

**Stale markers updated:**
- Phase F → flipped to `merged 2026-05-25, BE PR #65`.

**Files (9 + 1 migration + 2 docs):**
- `controllers/adController.js` — GHS math removed, tradeAccountId wiring
- `controllers/tradeController.js` — GHS math removed, buyerPaymentDetails
- `controllers/p2p.controller.js` — buyerNetUsdc → netUsdc references
- `controllers/tradeAccountController.js` — rewritten with validation
- `services/p2p.service.js` — flat fee model, corrected settlement
- `services/tradeAccountValidation.js` — NEW (11 method schemas)
- `prisma/schema.prisma` — Ad.tradeAccountId, Trade.buyerPaymentDetails, GlobalSettings.p2pFeePct
- `prisma/migrations/20260525_phase_f2_.../migration.sql` — NEW
- `AZAMAN_MASTER_SOUL.md` — §4.1–4.3 rewritten
- `AUDIT.md` — this entry

---

### Phase F — Re-enable BUY Ads (2026-05-25, merged 2026-05-25, BE PR #65)

**BUY ads fully re-enabled with corrected settlement model.** ~80 LOC
delta across 5 files + .env.example. Removes the Phase D-1 env-flag
gates (`BUY_ADS_ENABLED`) and fixes four settlement bugs that would
have caused ledger drift if BUY ads were enabled with the old code.

Branch: `phase-f-reenable-buy-ads`. Backend-only.

**What this PR does:**

1. **Gate removal** (`adController.js` + `tradeController.js`): The
   `BUY_ADS_ENABLED !== '1'` guards that returned 503 are removed.
   BUY and SELL ads are now treated identically at the gate level.

2. **Escrow amount fix** (`tradeController.js initiateTrade`): BUY-ad
   escrow previously locked `amountCrypto * effectiveRate` (a GHS-
   denominated value from the legacy AZM-column era) into the USDC-
   denominated `escrowLockedBalance`. Fixed to lock `amountCrypto`
   (the raw USDC the user is selling).

3. **Completion fix** (`services/p2p.service.js completeTrade`): For BUY
   ads, the user (crypto seller) now has their `escrowLockedBalance`
   decremented, and the vendor (crypto buyer) receives the net USDC.
   The user receives no USDC credit (they received fiat off-platform).
   Previously the code credited USDC to the user AND never released
   their escrow — a double-counting + ledger-leak bug.

4. **Cancel/refund fix** (`workers/tradeWorker.js` + `adminController.js`):
   Auto-cancel and admin-cancel now properly decrement
   `escrowLockedBalance` AND credit `availableBalance` for BUY ad
   refunds. Previously only the credit happened (escrow leaked).

5. **Underpayment fix** (`services/p2p.service.js markUnderpaid`): Now
   correctly routes partial-release and refund based on `trade.type`.
   SELL ads: vendor escrowed → paid portion to buyer, unpaid back to
   vendor. BUY ads: user escrowed → paid portion to vendor, unpaid
   back to user.

6. **Notifications** (`services/p2p.service.js`): completeTrade
   notifications are now role-aware for BUY ads.

**Files (5 + .env + 2 docs):**
- `controllers/adController.js` — gate removed
- `controllers/tradeController.js` — gate removed + escrow fix
- `services/p2p.service.js` — completeTrade + markUnderpaid fixes
- `workers/tradeWorker.js` — auto-cancel escrow fix
- `controllers/adminController.js` — admin-cancel escrow fix
- `.env.example` — `BUY_ADS_ENABLED` deprecated

---

### Phase E2 — AZM Spend Mechanics (2026-05-25, in review, BE)

**Full AZM loyalty-point spend pipeline.** ~450 LOC across 9 files + 1
migration. Phase E1 made AZM earnable; Phase E2 makes it spendable.
Users can now trade their earned AZM for premium platform features.

Branch: `phase-e2-azm-spend-mechanics`. Backend-only.

**What this PR does:**

1. **New service** (`services/azmSpendService.js`): Canonical AZM debit
   pipeline. `debitAzm()` atomically: (a) checks balance sufficiency,
   (b) decrements `user.azmBalance`, (c) writes `AzmSpendLog` audit row,
   (d) emits `azm_spend` socket event. Throws on insufficient balance.

2. **Two spend actions:**
   - `FEE_DISCOUNT` — 3 tiers (10 AZM → 25% off exit fee, 25 AZM → 50%
     off, 50 AZM → free withdrawal). Wired into `withdrawalController`
     via optional `feeDiscountTierId` body param AND standalone via
     `POST /api/azm/spend/fee-discount`.
   - `AD_BOOST` — 3 durations (15 AZM → 24h, 35 AZM → 72h, 80 AZM → 7d).
     Sets `isBoosted=true` + `boostExpiresAt` on the ad. Marketplace
     query sorts boosted ads first. Expired boosts lazily cleaned on read.
     Stackable (boosts while active extend from current expiry).

3. **Schema** (`prisma/schema.prisma` + migration):
   - `AzmSpendLog` model (id, userId, amount, reason, source, metadata
     JSON, balanceAfter). Indexed on (userId, createdAt DESC), (source).
   - `Ad.isBoosted Boolean @default(false)` + `Ad.boostExpiresAt DateTime?`
   - Composite index `(isBoosted DESC, status, createdAt DESC)`.

4. **Four new API endpoints** (`routes/azmRoutes.js` + `controllers/azmSpendController.js`):
   - `GET /api/azm/spend/options` — spend tiers + affordability
   - `POST /api/azm/spend/fee-discount` — purchase fee discount
   - `POST /api/azm/spend/ad-boost` — boost an owned ad
   - `GET /api/azm/spend/history` — paginated spend history

5. **Marketplace modification** (`controllers/adController.js`):
   - `orderBy` now includes `isBoosted: 'desc'` so boosted ads sort first.
   - Lazy expiry: boosted ads past their `boostExpiresAt` are marked
     `isBoosted=false` on read via `setImmediate` DB update.

6. **Withdrawal integration** (`controllers/withdrawalController.js` +
   `services/finance.service.js`):
   - `processFiatWithdrawal` now accepts `opts.feeDiscountMultiplier`
     (0.0–1.0) to reduce the exit fee.
   - Controller reads optional `req.body.feeDiscountTierId`, calls
     `azmSpendService.applyFeeDiscount()` before the withdrawal. If AZM
     spend fails (insufficient balance), returns 400 without proceeding.

**Stale `IN REVIEW` markers cleaned up in this PR:**
- Phase E1 → flipped to `merged 2026-05-25, BE PR #62`.
- Phase E1-FE → flipped to `merged 2026-05-25, FE PR #50`.

---

### Phase E2-FE — AZM Spend UI (2026-05-25, in review, FE)

**Frontend companion to BE PR #63 (Phase E2).** Five files: new AZM spend
service, new Riverpod spend provider, withdrawal screen fee-discount selector,
vendor dashboard ad-boost sheet, socket `azm_spend` listener. See
`FRONTEND_AUDIT.md` in the FE repo for full breakdown.

---

### Phase E1 — AZM Earn Mechanics (2026-05-25, merged 2026-05-25, BE PR #62)

**Full AZM loyalty-point earn pipeline.** ~400 LOC across 10 files + 1
migration. Phase D-3 restored the `azmBalance` column; Phase E1 makes it
ACTUALLY earn. Previously the column existed at 0.0 forever — now every
trade, login streak, referral, achievement, and volume milestone credits
AZM with a transparent audit trail.

Branch: `phase-e1-azm-earn-mechanics`. Backend-only.

**What this PR does:**

1. **New service** (`services/azmRewardService.js`): Canonical AZM credit
   pipeline. Every credit atomically: (a) increments `user.azmBalance`,
   (b) writes an `AzmRewardLog` row, (c) emits `azm_reward` socket event.
   Idempotent via source + dedupKey (won't double-credit on retry).

2. **Five earn sources wired:**
   - `TRADE_COMPLETE` — buyer earns 5.0 AZM per completed trade
   - `LOGIN_STREAK` — 1.0 AZM/day + milestones (5.0 at 7d, 20.0 at 30d, 50.0 at 90d)
   - `REFERRAL_BONUS` — referrer earns 10.0 AZM when referred user's first trade completes
   - `ACHIEVEMENT_UNLOCK` — 2.0–25.0 AZM by tier (COMMON/RARE/EPIC/LEGENDARY)
   - `MILESTONE` — 50.0–500.0 AZM at volume thresholds ($1k/$10k/$50k/$100k)

3. **Schema** (`prisma/schema.prisma` + migration):
   - `AzmRewardLog` table (id, userId, amount, reason, source, metadata JSON,
     balanceAfter, createdAt). Indexed on (userId, createdAt DESC), (source),
     (userId, source). CHECK constraint: amount > 0.
   - `AZM_REWARD` added to `TransactionType` enum.

4. **Three new API endpoints** (`routes/azmRoutes.js` + `controllers/azmRewardController.js`):
   - `GET /api/azm/history` — cursor-paginated earn history, optional source filter
   - `GET /api/azm/summary` — aggregate: totalEarned, currentBalance, bySource breakdown
   - `GET /api/azm/rates` — public: current earn rate schedule (no auth)

5. **Wiring sites:**
   - `controllers/authController.js` — login streak detection → `rewardLoginStreak()` via setImmediate
   - `controllers/p2p.controller.js` — trade complete → `rewardTradeComplete()` + referral check + volume milestones
   - `services/vendorGamificationService.js` — review achievement unlock → `rewardAchievementUnlock()`
   - `services/p2p.service.js` — trade-completion achievement unlock → `rewardAchievementUnlock()`
   - `server.js` — singleton instantiation + route mount

**Fire-and-forget pattern.** All earn calls use `setImmediate` + try/catch.
AZM reward failures never propagate to the triggering action (trade,
login, gamification). Errors logged with `[AzmRewardService.*]` prefix.

**Stale `IN REVIEW` markers cleaned up in this PR:**
- Phase D-3 → flipped to `merged 2026-05-25, BE PR #61`.

---

### Phase D-3 — Restore azmBalance as independent loyalty-point ledger (2026-05-25, merged 2026-05-25, BE PR #61)

**CRITICAL ARCHITECTURE CORRECTION.** Phase D-2 incorrectly interpreted
the product decision "AZM is not a blockchain token" as "delete the azmBalance
column." The correct interpretation: AZM is an independent platform reward
point (like Binance BNB or airline miles) backed by its own database column.
It is NOT a derived UI label.

Branch: `fix/restore-azm-loyalty-ledger`. Backend-only. Seven files + 1 migration.

**What this PR does:**
1. **Migration SQL** (`prisma/migrations/20260525_phase_d3_restore_azm_loyalty_ledger/`):
   Re-adds `azmBalance DOUBLE PRECISION NOT NULL DEFAULT 0.0` + CHECK >= 0.
   Users start at 0.0 (D-2's USDC conversion remains in availableBalance).
2. **prisma/schema.prisma:** Restores `azmBalance Float @default(0.0)` with
   corrected documentation (independent loyalty ledger, not derived).
3. **controllers/authController.js:** Re-adds `azmBalance` to register/login
   response payloads and `getUserDetails` select.
4. **controllers/ssoController.js:** Re-adds `azmBalance` to SSO response.
5. **controllers/profileController.js:** Re-adds `azmBalance` to all 3 select
   sites (full profile, balance endpoint, dashboard).
6. **controllers/adminController.js:** Re-adds `azmBalance` to admin user select.
7. **server.js:** Re-adds `azmBalance` to `emitBalanceUpdate` socket emission.

**What stays from D-2 (correct changes NOT reverted):**
- Trade settlement in USDC (completeTrade credits availableBalance)
- BUY-ad escrow (availableBalance → escrowLockedBalance)
- Single-rail withdrawal model (debit availableBalance)
- walletController reads availableBalance for withdrawal checks

**AZM design (corrected in AZAMAN_MASTER_SOUL.md §1 + §2):**
- AZM = independent loyalty-point ledger, NOT derived from USDC × rate
- Earn mechanics: trade completions, referrals, login streaks, achievements
- Spend mechanics: fee discounts, premium ad-tier unlocks, boosted visibility
- NOT purchasable directly, NOT withdrawable as fiat/crypto
- Backend-controlled; frontend displays the value as received from API

---

### Phase D-2 — Eliminate azmBalance; settle in availableBalance (2026-05-25, merged 2026-05-25, BE PR #59) ⚠️ PARTIALLY REVERTED by D-3

Branch: `phase-d2-eliminate-azm-balance`. Backend-only. Twelve files
(`services/p2p.service.js`, `controllers/p2p.controller.js`,
`controllers/tradeController.js`, `controllers/adminController.js`,
`controllers/walletController.js`, `controllers/authController.js`,
`controllers/ssoController.js`, `controllers/profileController.js`,
`controllers/adController.js`, `workers/tradeWorker.js`, `server.js`,
`prisma/schema.prisma`) + 1 migration + 1 FE coordination doc, ~400 LOC delta.
**Fully closes** the audit's **Phase B finding B** ("azmBalance is a
one-way trap / stranded liquidity") and the **BUY-ad mint bug** (Phase D
design doc §1.5). The `azmBalance` column is dropped. All settlement
is unified on `availableBalance` (USDC).

**Decision context.** User confirmed AZM is purely a loyalty-point label
in the UI — not a blockchain token. Option C from the Phase D design doc
is the correct path: eliminate the column, settle everything in USDC.

**What this PR does:**

1. **Migration SQL** (`prisma/migrations/20260525_phase_d2_eliminate_azm_balance/`):
   converts every user's `azmBalance` (GHS) to USDC at the live
   `liveUsdToGhs` rate from GlobalSettings (fallback 15.0), adds the
   converted amount to `availableBalance`, writes a `TransactionHistory`
   audit row per user (`type=INTERNAL_TRANSFER`, `txHash=AZM_MIGRATION_<id>`),
   then drops the column + its CHECK constraint.

2. **`services/p2p.service.js` — completeTrade:**
   Buyer credit changed from `azmBalance += buyerAzmCredit` (GHS) to
   `availableBalance += buyerNetUsdc` where `buyerNetUsdc = amountCrypto -
   totalMarginUsdc` (pure USDC, no GHS rate conversion). The buyer now
   receives the net USDC principal directly into their spendable balance.

3. **`services/p2p.service.js` — markUnderpaid:**
   Buyer partial-release changed from `azmBalance += paidAmountFiat` (GHS)
   to `availableBalance += paidFractionUsdc` (the USDC equivalent, already
   computed in the function).

4. **`controllers/tradeController.js` — BUY-ad initiate:**
   Changed from `azmBalance -= userAzmAmount` (no escrow) to
   `availableBalance -= userAzmAmount` + `escrowLockedBalance += userAzmAmount`
   (mirrors the SELL-ad escrow pattern). BUY ads remain disabled by the
   Phase D-1 env flag; this code is forward-compatible for when they re-enable.

5. **`workers/tradeWorker.js` + `controllers/adminController.js` — BUY-ad cancel/refund:**
   Changed from `azmBalance += trade.amountFiat` to `availableBalance +=
   trade.amountCrypto` (refunds the escrowed USDC).

6. **`controllers/adminController.js` — rejectWithdrawal:**
   Refund changed from `azmBalance` to `availableBalance`.

7. **`controllers/walletController.js` — processWithdrawal:**
   Check + debit changed from `azmBalance` to `availableBalance`. This
   collapses the two separate withdrawal rails (AZM-specific via
   walletController + V2 USDC via withdrawalController) into one backing
   column. The walletController rail remains functional for Binance/TRC20/
   BEP20/MoMo payouts; it just reads from the unified balance now.

8. **Auth/SSO/Profile/server.js — read sites:**
   `azmBalance: 0.0` removed from user creation. `azmBalance: true`
   removed from all Prisma selects. `azmBalance` removed from all
   response payloads and socket events. The `balances.azm` dashboard
   key is removed.

9. **`prisma/schema.prisma`:**
   `azmBalance Float @default(0.0)` line replaced with a Phase D-2
   drop comment documenting the removal and pointing readers at the
   design doc.

10. **FE coordination doc** (`docs/PHASE_D2_FE_COORDINATION.md`):
    Documents what the FE needs to change — drop `azmBalanceProvider`,
    handle missing JSON key with `?? 0.0` fallback (same Phase J pattern),
    optionally derive AZM display as `availableBalance * rate`.

**Backwards compatibility.** FE clients that still read `azmBalance` from
JSON will get `null` / missing key. The `?? 0.0` fallback pattern
established in Phase J handles this gracefully — no crash, just shows 0.

**Stale `IN REVIEW` markers cleaned up in this PR:**
- Phase N → flipped to `merged 2026-05-25, BE PR #56`.
- Phase N2 → flipped to `merged 2026-05-25, BE PR #57`.

### Phase N2 — Notification consistency: migrate ALL remaining raw creates to notificationService pipeline (2026-05-25, in review, BE)

Branch: `phase-n2-notification-consistency-remaining`. Backend-only. Ten files
(`controllers/adminChatController.js`, `controllers/queueController.js`,
`controllers/securityController.js`, `controllers/withdrawalController.js`,
`services/p2p.service.js`, `services/tradeSocketService.js`,
`services/vendorGamificationService.js`, `middleware/milestoneMiddleware.js`,
`workers/cfoWorker.js`, `workers/savingsWorker.js`), ~200 LOC delta.
**Fully closes** the audit's **§5 P0** "notifications are inconsistently
persisted" finding. Zero raw `prisma.notification.create` / `tx.notification.create`
/ `createMany` sites remain outside the canonical `notificationService.js` pipeline
(verified via grep). The only file that still does its own manual 3-step
(DB + socket + FCM) is `chatSocketService.js` — by design, because it
handles high-frequency trade-chat messages with its own batching logic.

**Sites migrated (11 call sites across 10 files):**
- `adminChatController.js` — admin-to-user chat intervention (was `createMany` + manual socket + `pushIfOffline`) → `notificationService.sendNotification()` in constructor-injected service
- `queueController.js` — queue slot-open (was `tx.notification.create` inside `$transaction`) → post-commit `setImmediate` via `NotificationService`
- `securityController.js` — password change audit trail (was raw `prisma.notification.create`) → inline `NotificationService`
- `withdrawalController.js` — CRITICAL admin liquidity alert (was raw `prisma.notification.create`) → inline `NotificationService`
- `p2p.service.js` ×2 — gamification level-up + achievement notifications (were `tx.notification.create/Many` inside `$transaction`) → post-commit `setImmediate`
- `cfoWorker.js` — AI CFO report notification (already imported `NotificationService` but didn't use it for the report) → `notifSvc.sendNotification()`
- `savingsWorker.js` — savings reminder (was raw create + manual socket) → `NotificationService`
- `milestoneMiddleware.js` — badge unlock (was `tx.notification.createMany` inside `$transaction`) → post-commit `setImmediate`
- `tradeSocketService.js` — timer extension (was raw `createMany`, no socket/FCM for the notification) → `NotificationService`
- `vendorGamificationService.js` — review-triggered achievement (was `tx.notification.createMany` inside `$transaction`) → post-commit `setImmediate`

**Pattern consistency.** Same four patterns as Phase N:
1. Non-transaction sites → direct `notificationService.sendNotification()`
2. Transaction-internal sites → remove from `tx`, fire post-commit via `setImmediate`
3. Worker/service contexts (no `req`) → construct `new NotificationService(prisma, io)` locally
4. Fire-and-forget enforcement: `setImmediate` detach + `.catch()` at call site + service-level try/catch

**What this PR resolves.** After this merge, the entire notification
surface is channeled through one canonical pipeline
(`notificationService.sendNotification()`) with uniform DB persist +
socket emit + FCM push behavior. The §5 P0 is fully retired.

### Phase N — Notification consistency: migrate raw creates to notificationService pipeline (2026-05-25, merged 2026-05-25, BE PR #56)

Branch: `phase-n-notification-consistency`. Backend-only. Eight files
(`controllers/adminController.js`, `controllers/p2p.controller.js`,
`controllers/finance.controller.js`, `controllers/depositController.js`,
`controllers/tradeController.js`, `controllers/savingsController.js`,
`services/p2p.service.js`, `workers/tradeWorker.js`), ~350 LOC delta.
**Closes** the audit's **§5 P0** "notifications are inconsistently
persisted" finding for all high-traffic user-facing paths. The
remaining 8 raw sites are low-traffic admin/worker/gamification
paths filed for a follow-up.

**What this PR is.** Until now, 21 notification call sites across the
codebase used raw `prisma.notification.create` / `tx.notification.create`
/ `createMany` — which persisted to the DB but NEVER emitted a socket
event or fired FCM push. Users only saw these notifications when they
reopened the app and the bell refetched from the server. Phase N routes
all 21 sites through `notificationService.sendNotification()` which
handles the full three-way pipeline: DB persist + socket emit + FCM push.

**The specific user-facing bug fixed.** A vendor receiving a new trade
request (`tradeController.initiateTrade`) previously got a raw
`io.emit('new_trade_request')` socket event + direct
`sendPushNotification()` — but **no DB row** was ever created. When
the vendor reopened the app, their notification bell was empty. Phase N
replaces this with `notificationService.sendNotification()` which
persists + emits + pushes in one call. Same fix for 20 other paths.

**Pattern for transaction-internal notifications.** Sites that were
inside `prisma.$transaction` blocks cannot call `notificationService`
(which uses the top-level prisma instance, not `tx`). The fix pattern:
remove the `tx.notification.create` from inside the transaction, and
fire `notificationService.sendNotification()` post-commit via
`setImmediate`. For `p2p.service.js` (pure business logic, no `req`),
the notification metadata is returned in a `_notifications` array
field; the controller fires them post-commit via a shared
`_firePostCommitNotifications` helper.

**What this PR does NOT fix (deferred to Phase N2).**
8 remaining raw-create sites in low-traffic paths — **now fully addressed
in Phase N2 (see above).**

**Fire-and-forget contract.** Same four-way enforcement as L1/L2:
`setImmediate` detach, service-level try/catch, call-site `.catch()`,
and the notification pipeline itself catching all errors internally.

**Redundant socket emits removed.** 6 stale `io.emit('new_notification')`
calls that duplicated the service's built-in socket emit (but with
incomplete payloads — just `{ title }` without id/body/actionPayload)
have been deleted. The notificationService's `_emitSocketEvent` now
handles all socket delivery with the full notification record.

**Files (8 + 2 docs):**
- `controllers/adminController.js` — 7 sites migrated (+helper)
- `controllers/p2p.controller.js` — 5 sites via `_firePostCommitNotifications`
- `controllers/finance.controller.js` — 3 sites migrated (+helper)
- `controllers/depositController.js` — 2 sites migrated (+helper)
- `controllers/tradeController.js` — 3 sites migrated (+helper)
- `controllers/savingsController.js` — 1 site migrated (+helper)
- `services/p2p.service.js` — 5 `tx.notification.create/Many` removed,
  `_notifications` field added to return values
- `workers/tradeWorker.js` — 2 sites migrated, `NotificationService`
  constructed in worker constructor

**Stale `IN REVIEW` markers cleaned up in this PR:**
- Phase L2 → flipped to `merged 2026-05-25, BE PR #55`.

### Phase L2 — Wire smsService for phone OTP + large-withdrawal SMS (2026-05-25, merged 2026-05-25, BE PR #55)

Branch: `phase-l2-sms-service-wiring`. Backend-only. Nine files
(`services/smsService.js`, `controllers/securityController.js`,
`routes/securityRoutes.js`, `controllers/withdrawalController.js`,
`workers/withdrawalReconciliationWorker.js`, `server.js`,
`prisma/schema.prisma`, migration, `.env.example`), ~300 LOC delta.
**Fully closes** the audit's **TL;DR §8** "three services are dead
code" line — the **smsService** half is now live. Combined with
Phase L1 (emailService), 2 of the 3 dead services are now wired
into production surfaces. `serviceIntegrator.js` remains the sole
orphan (it's an orchestration facade over the now-live SMS + email
services; wiring it adds no new capability, so it can be deleted or
kept as a future convenience).

**What this PR is.** Until now `smsService.js` had complete OTP
generation/verification, trade notification templates, and four
provider stubs (Twilio, AWS SNS, Hubtel, Arkesel), but was only
referenced by the dead `serviceIntegrator.js`. A user verifying
their phone number had no OTP mechanism, and large withdrawals
produced no SMS confirmation — only socket events + push + email.

Phase L2 wires `smsService` for two bounded surfaces:

1. **Phone OTP verification** — new `POST /api/security/phone/send-otp`
   and `POST /api/security/phone/verify-otp` endpoints on the
   security router (mirrors the existing PIN/2FA pattern). E.164
   validation. On successful verification writes `phoneNumber` +
   `phoneVerified = true` to the User row. Changing phone via
   `profileController.updateProfile` leaves `phoneVerified = false`
   (must re-verify), which is the correct gating behavior.

2. **Large-withdrawal SMS confirmation** — fire-and-forget SMS
   via `smsService.sendWithdrawalConfirmation(phone, opts)` at 7
   hook points (5 in the controller, 2 in the worker), gated on:
   - `user.phoneVerified === true`
   - `amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD` (env-configurable,
     default $100 USDC)
   - reversal/refund success (same flag-gating pattern from L1)

   Five SMS kinds: `fiat_dispatched`, `fiat_settled`,
   `fiat_refunded`, `crypto_sent`, `crypto_refunded`.

**Schema change.** New `phoneVerified Boolean @default(false)` on
the User model. Migration is a simple `ALTER TABLE ADD COLUMN` with
default — no existing column touched, no data migration needed.

**Fire-and-forget contract** (same four-way enforcement as L1):
`setImmediate` detach + service-level try/catch + call-site
`.catch()` + reversal/refund-success gating flags.

**Provider mode.** `SMS_PROVIDER` defaults to `mock`; in MOCK mode
the server logs each SMS to stdout and OTP codes are surfaced in
API responses in non-production for easy testing. The four provider
stubs (`_sendViaTwilio` / `_sendViaAWS` / `_sendViaHubtel` /
`_sendViaArkesel`) remain placeholder.

**Static re-trace across 13 scenarios** (9 withdrawal + 2 OTP + 2
negative-gate). SMS fires exactly when all three gates pass; never
on CRITICAL admin-alert branches or unverified phones.

**Stale `IN REVIEW` markers cleaned up in this PR:**
- Phase L1 → flipped to `merged 2026-05-25, BE PR #54`.

### Phase L1 — Wire emailService for transactional withdrawal receipts (2026-05-25, merged 2026-05-25, BE PR #54)

Branch: `phase-l1-withdrawal-email-receipts`. Backend-only. Four
files (`services/emailService.js`,
`workers/withdrawalReconciliationWorker.js`,
`controllers/withdrawalController.js`, `server.js`) + `.env.example`,
~250 LOC delta. Closes the audit's **TL;DR §8** "three services
are dead code" line — partially: the **emailService** half of
the cluster is now live for the withdrawal-completion surface.
The **smsService** half and the **serviceIntegrator** orchestrator
remain orphan and are filed for a follow-up pass.

**What this PR is.** Until now `emailService.js` had complete
HTML templates for welcome / verification / trade-alert /
password-reset emails plus four provider stubs (SendGrid / SES /
Mailgun / Nodemailer), but nothing in the running app required
it — `test_services.js` was the only consumer. A user requesting
a USDC or fiat withdrawal got a socket event and (offline) a
push notification, but no durable email artifact to file in
their records / chase their bank with.

Phase L1 wires `emailService` for transactional withdrawal
receipts on a bounded, audit-flagged surface. Four hook points:

1. **Fiat success** (async, MTN MoMo settlement) — from
   `withdrawalReconciliationWorker._reconcileOne` after the
   PENDING → COMPLETED status flip.
2. **Fiat failure + auto-reverse** (async, MTN MoMo settlement) —
   from the worker after `reverseFiatWithdrawal` completes
   successfully. Gated on reversal success: if the reversal
   itself fails, the existing `WITHDRAWAL_REVERSAL_FAILED` admin
   alert takes over and the user does NOT receive a "you've been
   refunded" email.
3. **Fiat sync 503 / 502** (mtn service unavailable / mtn
   dispatch rejected) — from `withdrawalController.fiatWithdrawal`
   after the synchronous reversal succeeds. Same reversal-success
   gating via a new `reversalSucceeded` flag (the existing
   "comment claimed gating, code didn't enforce it" bug was
   caught during the static re-trace).
4. **Crypto success / refund** — from
   `withdrawalController.cryptoWithdrawal` after Tatum broadcast
   succeeds (success kind) or after the inner refund
   `$transaction` succeeds (refund kind). Same gating via a new
   `refundSucceeded` flag: refund-failed CRITICAL path emits an
   admin alert, no user email.

**Fire-and-forget contract enforced four ways:**

- `setImmediate(() => ...)` detaches every send from the request
  / worker context so the response flushes (or the reconcile
  tick continues) without waiting on email delivery.
- The new `emailService.sendWithdrawalReceipt(user, opts)`
  dispatcher catches every error internally and returns
  `{ success: false, ... }` — it cannot throw.
- Each call site adds a defensive `.catch()` for belt-and-braces.
- Three gating flags (`reversalSucceeded`, `refundSucceeded`,
  plus worker-side "inside reversal-success try block") ensure
  no false "you've been refunded" emails on inconsistent-state
  branches.

**The four kinds and their renderers.** Each kind has a
purpose-built `_render*` helper that returns
`{ subject, html, text }` matching the existing layout used by
`sendWelcomeEmail` / `sendEmailVerification` (Arial 600px
container, colored header, white "info card" with row labels):

| Kind             | Header | Includes                                                                        |
|------------------|--------|---------------------------------------------------------------------------------|
| `fiat_success`   | green  | amount, destination, reference, settled-at                                      |
| `fiat_failure`   | red    | refunded amount, reason, reference, when                                        |
| `crypto_success` | green  | amount, gas fee, net payout, network, destination, tx hash, **PolygonScan link** |
| `crypto_refund`  | red    | refunded amount, intended destination, network, reason, when                    |

Plain-text twin alongside every HTML body for clients that
prefer text.

**Provider mode.** `EMAIL_PROVIDER` defaults to `mock`; in MOCK
mode the server logs each receipt to stdout (subject + message
id + first 100 chars of HTML preview). The four provider stubs
(`_sendViaSendGrid` / `_sendViaAWS` / `_sendViaMailgun` /
`_sendViaNodemailer`) remain placeholder — flipping
`EMAIL_PROVIDER` to one of them today routes through the same
"placeholder log + return success" path until a real integration
is wired. `.env.example` documents the activation path.

**Singleton pattern.** Mirrors the existing
`mtnDisbursementService` / `notificationService` shape:
instantiated once in `server.js`, attached to app context via
`app.set('emailService', emailService)`, and passed as a 4th
constructor arg to `WithdrawalReconciliationWorker`. The class
export shape on `services/emailService.js` is unchanged so the
existing `serviceIntegrator.js` + `test_services.js` callers
(both still using `new EmailService()`) keep working.

**Files (4 + 1 env + 2 docs):**

- `services/emailService.js` — new `sendWithdrawalReceipt`
  dispatcher, 4 `_render*` helpers, 3 format helpers
  (`_formatAmount`, `_shortHash`, `_polygonScanUrl`). +185 LOC.
- `workers/withdrawalReconciliationWorker.js` — `emailService`
  4th constructor arg, `include: { user }` on the
  stale-pending findMany so the receipt renders without a 2nd
  DB hit, fire-and-forget `setImmediate` from both settlement
  branches. ~40 LOC delta.
- `controllers/withdrawalController.js` — `emailService` from
  app context in both handlers, recipient pre-fetch in the
  fiat path, `setImmediate` from 4 hook points (crypto success,
  crypto refund, fiat 503, fiat 502), `reversalSucceeded` and
  `refundSucceeded` gating flags. ~70 LOC delta.
- `server.js` — instantiate `emailService` singleton, pass to
  worker, stash on app context. +5 LOC.
- `.env.example` — new `EMAIL_PROVIDER` block with MOCK-default
  doc pattern matching `TATUM_PROVIDER` and `MTN_MOMO_PROVIDER`.
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry + Phase I5
  status flip + new L1 roadmap row.

**Stale `IN REVIEW` markers cleaned up in this PR:**

- Phase I5 → flipped to `merged 2026-05-25, BE PR #53`.

**Static end-to-end re-trace done across 9 scenarios** (fiat
happy / fiat sync 503 / fiat sync 502 / fiat reversal-failed
CRITICAL / fiat async success-via-worker / fiat async
failure-and-reverse-via-worker / fiat async reversal-failed
CRITICAL / crypto happy / crypto refund-OK / crypto
refund-FAILED CRITICAL). Email fires exactly when balance was
actually restored or when withdrawal actually settled; never on
the three admin-alert-CRITICAL branches.

### Phase I5 — Pagination on the four still-unpaginated admin list endpoints (2026-05-25, merged 2026-05-25, BE PR #53)

Branch: `phase-i5-admin-pagination`. Backend-only. Single file
(`controllers/adminController.js`), ~150 LOC delta. Closes the
audit's §13 P2 line: *"List endpoints return all rows, no
pagination"* — for the admin tier specifically. The user-facing
tier was paginated in Phase I (BE PR #40); the admin tier was
deferred. Phase I5 closes that gap.

**The four endpoints.** Each existed without pagination, returning
either the full set or a hardcoded `take: 100` ceiling:

1. **`GET /admin/disputes` (`getAllDisputes`)** — was unbounded. A
   high-dispute day pushed every row on every dashboard refresh.
2. **`GET /admin/trades/live` (`getLiveTrades`)** — had a hardcoded
   `take: 100` cap. Trade #101+ was silently invisible to the
   war-room admin during peak hours.
3. **`GET /admin/kyc/pending` (`getPendingKyc`)** — was unbounded. A
   KYC backlog pushed every applicant on every load.
4. **`GET /admin/withdrawals/pending` (`getPendingWithdrawals`)** —
   was unbounded on the `pending` array (`frozen` was already capped
   at 20).

**What ships.** All four endpoints now use the existing shared
`utils/pagination.js` helpers (`parsePagination` / `buildPageEnvelope`)
that the user-facing endpoints adopted in Phase I. Both modes
supported:

- **Cursor mode** (`?cursor=ID&limit=N`) — append-stable, O(limit)
  on the existing `id`-tiebreaker `orderBy`.
- **Offset mode** (`?page=N&limit=M`) — classic page chips for
  admin UI. Total count fetched once on page 1 only (Promise.all'd
  with the rows) so admin dashboards can show "Page 3 of 17"
  without recounting on every page navigation.

**Backwards-compat preserved.** The existing FE consumer is
`lib/screens/admin_war_room_screen.dart`, which reads the bare
top-level keys `disputes` / `trades` / `applications` defensively
with `?? []`. Those keys remain at the top level alongside a new
`pagination` envelope. Cold-load (no params) raises the default
take to 100 so the admin UI never sees fewer rows than before.
Opt-in callers passing any of `cursor`, `limit`, `page` get the
standard 20-row default unless they specify.

**`/admin/withdrawals/pending` shape extension.** Has no FE
consumer today, so the `data: { pending, frozen, counts, pagination }`
shape is free to evolve. `counts.pending` keeps its original
page-length semantic (consistent across pages); the real backlog
total surfaces on `pagination.total` (only populated on page-1 of
offset mode for cost reasons). UIs that want a "X queued" chip
should prefer `pagination.total ?? counts.pending`.

**No FE coordination required.** The single existing FE caller
keeps working; future admin-FE work can opt into the pagination
envelope at its own pace.

**Files (1 + 2 docs):**

- `controllers/adminController.js` — 4 endpoints paginated, +1 import,
  ~150 LOC delta.
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry + Phase I4 status
  flip + new I5 roadmap row.

**Stale `IN REVIEW` markers cleaned up in this PR:**

- Phase I4 → flipped to `merged 2026-05-25, BE PR #52`.

### Phase I4 — Defer review gamification off the submitReview request path (2026-05-25, merged 2026-05-25, BE PR #52)

Branch: `phase-i4-defer-review-gamification`. Backend-only. Two
files, ~110 LOC delta. Closes the explicit follow-up flagged in
Phase I3's PR body ("`submitReview` flow in `tradeController.js`
has its own gamification block that's INLINE
(`gamification.awardXp` + `checkAndUnlockAchievements`); not
refactored here. Filed as a potential I4 follow-up.").

**What this PR is.** The second of the two gamification-in-request-path
callsites identified during the I3 trace. After I3 moved
trade-complete gamification off the request path, `submitReview`
remained the only path that still ran the XP + achievement scan
INSIDE its `prisma.$transaction`. Phase I4 applies the same
deferral pattern: the review row + reviewee review-count counter
still update atomically (this is what the FE waits to render the
"Thank you" snackbar — verified, `trade_summary_screen.dart` only
checks status code 201). The vendor XP / achievement scan now runs
post-flush via `setImmediate`.

**Concretely, what ships:**

1. **`services/vendorGamificationService.js`** — NEW exported
   function `processReviewGamification(prisma, { revieweeId,
   isPositive, tradeId })`:
   - Wraps `awardXp` + `user.findUnique` (post-XP-award stats
     re-fetch) + `checkAndUnlockAchievements` + achievement-unlock
     `notification.createMany` in its own `prisma.$transaction`
     so the XP / achievement writes remain atomic with each other.
   - Catches all errors at the function boundary, logs them with
     a stable prefix (`[gamification.processReviewGamification]`),
     and returns null. Review row is already committed at this
     point — gamification failures are non-fatal and forward-only
     on the next review or trade.
   - Mirrors `processPostCompletionGamification`'s shape from the
     I3 PR for consistency.

2. **`controllers/tradeController.js`** — `submitReview`:
   - Atomic `prisma.$transaction` shrinks to two writes:
     `tx.review.create` + reviewee `tx.user.update` for the
     `positiveReviews` / `negativeReviews` counter. The 60-line
     gamification block (XP award + stats re-fetch + achievement
     scan) is REMOVED from inside the transaction.
   - Response sends with `gamification: null` for forward-compat
     (Phase I3 set the same precedent on the trade-complete path).
   - After `res.json(201)`, `setImmediate(async () => { ... })`
     schedules `processReviewGamification` and emits the existing
     `gamification_update` socket event with `type: 'REVIEW_RECEIVED'`
     when a result lands. Top-level safety try/catch in the
     deferred block guards against unhandled rejections.
   - Gated to only run when `revieweeId === trade.vendorId` (XP is
     vendor-only by design — buyers do not have an XP/level
     surface). Same gate the inline block had.

**Trade-off.** Same as I3: a server crash between the HTTP response
flush and the setImmediate firing leaves XP un-awarded for one
review. Acceptable — `positiveReviews` / `negativeReviews` counters
DO update inside the atomic transaction, so the review is
permanently visible; only the derived XP / achievement scan is
deferred. The next review or completed trade re-syncs.

**FE coordination.** None required. Confirmed via grep that the FE
codebase reads only the response status code at the only callsite
(`lib/screens/trade_summary_screen.dart` checks
`response.statusCode == 201` and flips a local `_hasReviewed`
boolean — does not parse the response body's `gamification`
field). The `gamification_update` socket event was already wired
in I3 and is purely additive on the FE side.

**Follow-up flipped to merged in this PR's docs:**

- **Phase I3:** flipped from `in review` to `merged 2026-05-25, BE
  PR #51` in both the changelog header and the roadmap row.

### Phase I3 — Defer vendor gamification off the trade-complete request path (2026-05-25, merged 2026-05-25, BE PR #51)

Branch: `phase-i3-defer-gamification`. Backend-only. Two files,
~140 LOC delta. Closes the explicit follow-up flagged in Phase I2's
changelog ("Move `vendorGamificationService.processTradeCompletion`
off the `completeTrade` request path") and in §15 of the original
audit ("`vendorGamificationService.evaluateBadges` runs synchronously
inside trade completion. Adds 100–200ms to every trade complete
request").

**What this PR is.** The vendor gamification engine (XP, streak,
level, achievement scan, ~6 sequential Prisma writes) used to run
INSIDE the `prisma.$transaction` block in `services/p2p.service.js`
`completeTrade`, blocking the HTTP response until every gamification
write committed. Phase I3 moves the gamification call out of the
request path entirely. The trade-settlement transaction returns
immediately; the controller schedules the gamification work via
`setImmediate` so it runs AFTER the HTTP response has been flushed
to the client.

**Concretely, what ships:**

1. **`services/p2p.service.js`** — `completeTrade`:
   - The 60-line gamification block (gamification call + level-up
     notification + achievement notifications) is REMOVED from the
     transaction's step 8.
   - The function now returns `gamification: null` in the immediate
     response (forward-compat for any FE that destructured it) plus
     a private `_gamificationInputs` field carrying `vendorId`,
     `tradeVolumeUsdc`, and `vendorProfitUsdc` for the controller's
     deferred call.
2. **`services/p2p.service.js`** — NEW exported function
   `processPostCompletionGamification(prisma, { tradeId, vendorId,
   tradeVolumeUsdc, vendorProfitUsdc })`:
   - Wraps the gamification engine + level-up notification +
     achievement notifications in a NEW `prisma.$transaction` (so
     XP/streak/level writes remain atomic with each other on the
     User row).
   - Catches all errors at the function boundary, logs them, and
     returns null. The trade is already settled at this point —
     gamification failures cannot retroactively fail it.
3. **`controllers/p2p.controller.js`** — `completeTrade`:
   - Removes the in-line `if (data.gamification) io.emit('gamification_update', ...)`
     block (it's always null now).
   - Adds a `setImmediate(async () => { ... })` block after the
     response-prep (Express buffers the response when `res.json` is
     called; setImmediate yields to the event loop, lets the response
     flush, then runs the gamification engine + emits
     `gamification_update` socket event with the same shape the FE
     used to expect). Top-level safety try/catch guards against
     unhandled rejections.

**Trade-off.** A server crash between the HTTP response flush and the
setImmediate firing leaves XP/streak un-applied for one trade. This
is acceptable: the gamification engine moves forward from current
state on its next call (no replay), so the next completed trade
re-syncs the vendor's stats. Vendor stats are also recomputed from
the underlying counters (`tradesCompleted`, `totalVolumeUsdc`,
`totalProfitUsdc`) which DO update inside the trade transaction —
only the derived XP/level/achievement scan is deferred. We keep the
log line intentional so an ops alert can fire if deferred-gam errors
spike.

**FE coordination.** None required. Confirmed via grep that the FE
codebase does not reference `gamification`, `gamification_update`,
`vendorXp`, `vendorLevel`, or `/vendor/stats` — the FE doesn't
consume vendor gamification data anywhere today (the
`leaderboard_screen.dart` uses hardcoded sample data; vendor
dashboard reads basic stats but not XP). When the FE is wired up to
the `gamification_update` socket event in a future phase, the
deferred path is already in place to deliver real-time updates.

**Audit hygiene notes** (re-walking earlier audit findings while
locating this PR's scope, three findings turned out to be already
addressed and are now reconciled):

- **Audit §3 P1 ("withdrawals can sit at PENDING forever if MTN's
  final webhook is lost"):** STALE. `services/withdrawalReconciliationWorker.js`
  exists, is wired in `server.js`, and `start()` is called on server
  boot. The worker scans stuck rows on a 60s interval and calls MTN
  for the actual status. Audit finding closed.
- **Audit §8 P1 ("ad creation does not emit `market_update` socket
  event"):** STALE. `controllers/adController.js` `createAd` already
  emits `market_update` to the `marketplace_room` after a successful
  insert. Audit finding closed.
- **Audit §8 P1 ("admin can adjust a user's balance directly via
  `adminController.adjustBalance`"):** STALE — the function does not
  exist in `controllers/adminController.js`. Whatever admin tooling
  the audit referenced was either renamed or never landed; admin
  balance adjustments today go through the standard ledger paths
  (deposit credit, refund flow, profit-log withdrawal). Audit
  finding closed.

**Stale `IN REVIEW` markers cleaned up in this PR:**

- Phase B2 → flipped to `merged 2026-05-25, BE PR #50`.
- Phase B2-FE → added new row, `merged 2026-05-25, FE PR #45` (was missing
  from the unified table; FE companion to B2).
- Phase D-1 → flipped to `merged 2026-05-25, BE PR #44` (already
  reflected in the changelog header; the roadmap table row is
  flipped to match).
- Phase D (design pass) → flipped to `merged 2026-05-25, BE PR #43`.
- Phase J → flipped to `merged 2026-05-25, BE PR #41 + FE PR #43`.
- Phase J2 → flipped to `merged 2026-05-25, BE PR #45` (already
  reflected in the changelog header; roadmap row flipped to match).
- Phase K → flipped to `merged 2026-05-25, BE PR #39`.
- Phase L → flipped to `merged 2026-05-25, BE PR #42`.
- Phase H4 (FE) → flipped to `merged 2026-05-25, FE PR #46`.
- Phase M (FE) → flipped from `BACKLOG` to `merged 2026-05-25, FE PR #44`
  (was actually shipped earlier and the BE roadmap had not been
  updated to reflect it).
- Suggested-merge-order block updated to remove stale "IN REVIEW"
  references (D, M).

**Files (2 + 2 docs):**

- `services/p2p.service.js` — gamification block removed from txn,
  new `processPostCompletionGamification` function (~140 lines added,
  ~50 lines removed).
- `controllers/p2p.controller.js` — in-line emit removed, deferred
  setImmediate block added (~50 lines added, ~16 lines removed).
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry + the status
  flips listed above.

### Phase B2 — Admin + notification correctness (2026-05-25, merged 2026-05-25, BE PR #50)

Branch: `phase-b2-admin-notif-correctness` (replaced by `phase-b2-rebased-v2`
after the gateway force-push pattern). Backend-only. Two files,
~55 LOC total. Closes two P1 audit findings the original audit flagged
in §5 and §8.

**What this PR is.** Two unrelated-but-small admin/notification quality
fixes bundled into one PR because they each individually wouldn't
warrant their own:

1. **`adminController.banUser`** force-disconnects the banned user's
   open WebSocket connections (audit §8 P1). Pre-Phase-B2, a banned
   user's open socket kept receiving server pushes (and could keep
   emitting events the socket auth middleware admitted at connect
   time) until they manually refreshed. Phase K's `protect`
   middleware closes the gap on every NEW HTTP/WS request; this
   closes the gap on EXISTING connections. Wrapped in try/catch so
   socket disconnect failure can't fail the ban itself — the DB row
   is already flipped. Scope: ban actions only, not UNBAN (we don't
   want to disturb a user we're un-banning).

2. **`notificationController.markAsRead` + `markAllAsRead`** emit a
   `notifications_updated` socket event to the user's room after
   the DB write (audit §5 P1). Pre-Phase-B2, marking a notification
   read on one device left the badge counter stale on every other
   open session of the same user (web + phone) until they
   pull-to-refresh. Best-effort emit (try/catch) so a socket failure
   never breaks the DB write. Two event subtypes:
   - `MARKED_READ` with `notificationId` — single-mark
   - `MARKED_ALL_READ` with `affected` count — bulk-mark

**Why bundled.** Both are small (~25 LOC each), both read-then-emit
patterns, both fix a "should have been there from day one" gap
flagged in the original audit. Shipping separately would be 2 trivial
PRs to review; bundled it's one ~55 LOC PR to review.

**FE coordination.** Optional. The `notifications_updated` socket
event is additive — clients that don't listen for it stay on the
current pull-to-refresh model. Whenever the FE picks it up (a few
lines in `lib/services/socket_service.dart` to invalidate the
unread-count provider), multi-device sync starts working
automatically.

**Files (2 + changelog):**

- `controllers/adminController.js` — banUser socket disconnect (~20 lines).
- `controllers/notificationController.js` — markAsRead/markAllAsRead socket emit (~35 lines).
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry.

### Phase I2 — vendorStatsController parallel queries (2026-05-25, merged 2026-05-25, BE PR #49)

Branch: `phase-i2-vendor-stats-parallel` (originally PR #46, replaced
by PR #49 after gateway force-push issue blocked the in-place rebase).
Backend-only. Single file (`controllers/vendorStatsController.js`),
~100 LOC delta. **No schema change, no migration, no contract change,
no FE coordination.**

**What this PR is.** The Phase-I follow-up the merged PR #40 explicitly
deferred ("Parallelise `vendorStatsController.getStats` (currently
serial Prisma calls; small per-vendor optimisation)"). This closes that
TODO across all four endpoints in the controller.

**What ships:**

1. **`getVendorStats` (`GET /api/vendor/stats`)** — was 5 sequential
   Prisma calls (user findUnique → vendorAchievement count → ad count
   total → ad count active → ad findMany for IDs) before the existing
   3-way Promise.all on adInteraction. Now: user findUnique (must
   come first for existence check) → 3-way Promise.all
   (vendorAchievement.count + ad.groupBy(status) + ad.findMany).
   The two `ad.count` calls (total + active-only) collapse into one
   `ad.groupBy({ by: ['status'] })`. Saves ~3 DB round-trips.

2. **`getAchievements` (`GET /api/vendor/achievements`)** — was 2
   sequential calls (vendorAchievement.findMany + user.findUnique).
   Now one Promise.all. Saves 1 round-trip.

3. **`getLeaderboard` (`GET /api/vendor/leaderboard`)** — was 3
   sequential calls (user.findMany topVendors → user.findUnique
   myVendor → user.count totalVendors), with the rank-fallback path
   adding a fourth (user.count aboveMe). Now: topVendors first
   (must come first to check myIndex), then myVendor (only when not
   in top N) Promise.all'd with totalVendors. Saves 1 round-trip
   in the common case (caller is in top N), 1 round-trip in the
   fallback case.

4. **`getVendorStatsQuick` (`GET /api/vendor/stats/quick`)** — was 3
   sequential calls (user.findUnique → trade.count → vendorAchievement
   .findFirst). Now: user.findUnique first → 2-way Promise.all
   (trade.count + vendorAchievement.findFirst). Saves 1 round-trip.

**Why this is a real win.** Vendor dashboards on the frontend hit
`/stats` and `/stats/quick` on every load and every pull-to-refresh.
On a hot path with a slow connection, ~3-4 saved round-trips × 50ms
per round-trip = noticeable. No semantic change — same data, same
shape, same response envelope.

**What this PR does NOT ship (separately deferred):**

- **Move `vendorGamificationService.processTradeCompletion` off the
  `completeTrade` request path.** The audit recommended `setImmediate`
  to defer XP/streak/achievement processing until after the trade
  response goes out. This is more invasive than the parallel-query
  cleanup: it changes the response shape (`gamification` field
  becomes null in the immediate response, populated later via the
  `gamification_update` socket event), which needs FE coordination
  to confirm clients rely on the socket event rather than the response
  body. Tracked separately as a follow-up.

**Files (1 + changelog):**

- `controllers/vendorStatsController.js` — 4 endpoints parallelised, +98/-71 lines.
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry.

### Phase J2 — DB-level CHECK constraints on money columns (2026-05-25, merged 2026-05-25, BE PR #45)

Branch: `phase-j2-check-constraints`. Backend-only. SQL migration +
ops runbook + changelog. **No application code change.**

**What this PR is.** A defense-in-depth pass against the audit's §14
finding "no DB-level constraints on balances being non-negative." Every
money column — every balance, amount, fee, volume, rate, limit, ratio —
gets a `CHECK` constraint that Postgres enforces on every INSERT and
UPDATE. If a future controller-bug, worker race, or admin-tool slip-up
ever tries to write a value that would corrupt the ledger (negative
balance, zero price, ratio outside `[0, 1]`), the database rejects the
write at transaction time. The bug surfaces as a Prisma exception in
the request that caused it, not as a silent corrupt row that
`runDoubleCheck` finds days later.

The audit recommended bundling Float→Decimal AND CHECK constraints
into one phase. Splitting them is the right call:

- CHECK constraints are pure additive — no application code change,
  no JSON wire-format change, no FE coordination, no row rewrite.
  Migration is fast (sequential scan per table, no ACCESS EXCLUSIVE
  hold beyond constraint registration).
- Float→Decimal IS a wire-format change (Prisma serializes Decimal
  as a string, not a number). It needs FE coordination and a
  maintenance window for the column rewrite. Filed as Phase J3.

**The full constraint set (~50 constraints across 18 tables):**

| Table | Constraints |
|---|---|
| `User` | 8 balance buckets ≥ 0, completionRate ∈ [0..100] |
| `SystemMasterCrypto` / `SystemHotWallet` / `SystemFiatPool` / `SystemProfitFees` | balance ≥ 0 (4 tables) |
| `Ad` | pricePerUSD/minLimit/maxLimit > 0, minLimit ≤ maxLimit, baseMargin/vendorMargin ≥ 0 |
| `Trade` | amountCrypto/amountFiat/rate/adminBonusAmount/vendorProfitCut ≥ 0 |
| `Withdrawal` | amount/totalGasFee/vendorGasShare/adminGasShare ≥ 0 |
| `GlobalSettings` | margins/gasFees ≥ 0, vendorShare ratios ∈ [0..1], 6 live rates > 0 |
| `TransactionHistory` | amountUsdc/feeUsdc ≥ 0 (sign is in `type`) |
| `AdminProfitLog` / `ColdStorageLog` / `ProfitWithdrawalLog` / `OperationalExpense` | amount columns ≥ 0 |
| `CorporatePurchaseLog` | usdcAmount/fiatSentTotal ≥ 0, discountRate ∈ [0..1], actualMarketRate > 0 |
| `Badge` / `LeaderboardRecord` / `DailySnapshot` | volume/profit columns ≥ 0 |
| `PeerTransfer` | amount ≥ 0 |
| `SavingsGoal` | targetAmountGhs/frequencyAmount > 0, currentAmountGhs ≥ 0, earlyWithdrawalPenalty ∈ [0..1] |
| `SavingsDeposit` | amountGhs/amountUsdc ≥ 0 |

**One column NOT constrained:** `Ad.margin` (nullable Float?). Vendor
markup percentage that can be null, zero, or positive in practice.
Operator-driven; left unconstrained out of caution.

**Validation policy.** Constraints are added with full validation
(no `NOT VALID`). If any existing row violates a constraint, the
migration FAILS and rolls back as a single transaction. That is the
desired outcome: a constraint failure surfaces ledger corruption that
must be repaired before Phase J3 (the column-type rewrite) goes near
the data. The ops runbook covers the failure-recovery flow.

For environments that prefer a soft-deploy (constraint added with
`NOT VALID`, validation deferred to a maintenance window), the runbook
has the alternative SQL.

**Why this is genuinely useful.** Today the codebase relies on every
controller, every worker, every admin tool, and every future PR
remembering to gate its own writes. The CHECK constraints are a single
defensive layer that catches the misses without imposing any cost on
the correct-but-defensive code paths.

**Files (3 + changelog):**

- `prisma/migrations/20260525_phase_j2_balance_check_constraints/migration.sql` — NEW (~190 LOC).
- `docs/PHASE_J2_CHECK_CONSTRAINTS.md` — operator runbook (NEW, ~140 LOC).
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry + roadmap update splitting J2/J3.

### Phase D-1 — Defensive gate: disable BUY ads until D-2 ships (2026-05-25, merged 2026-05-25, BE PR #44)

Branch: `phase-d-1-disable-buy-ads`. Backend-only. ~30 LOC across
2 controllers + .env.example + this changelog.

**What this PR is.** A defensive guard that refuses BUY-ad creation
and BUY-ad trade initiation while the broken settlement code path
remains in the codebase. **Not** the actual ledger fix — that is
Phase D-2 (Option C in the design doc).

**Why a stricter gate than the design doc proposed.** Re-reading the
live code while preparing the hotfix surfaced a math discrepancy
with the design doc. The doc claims net AZM change on a BUY-ad
trade is `−amountCrypto × adminMarginGhs` (a small loss for the
user). The actual code computes `userAzmAmount = amountCrypto ×
effectiveRate` at initiate (`tradeController.js`) and
`buyerAzmCredit = amountCrypto × effectiveRate` at complete
(`p2p.service.js`) — **the same formula on both sides**. So net AZM
change for the user is **exactly zero**.

The vendor still receives `amountCrypto - adminCutUsdc` USDC and
`SystemProfitFees` still receives `adminCutUsdc` USDC at completion.
**Both come out of thin air.** A BUY-ad completion mints
~`amountCrypto` USDC of platform liability with no offsetting debit
anywhere. This is a pure-mint money-correctness P0 — worse than the
design doc's framing.

The doc's Option A (skip just the AZM increment at completion)
doesn't fix the mint either — the user's AZM debit still nets to
−`userAzmAmount`, the vendor still gains USDC, and the user is now
paying for a bug that doesn't help them. Half-fix is worse than the
full disable.

So the right minimal hotfix is **block the path entirely**:

1. **`controllers/adController.js`** — `createAd` refuses
   `type === 'BUY'` with `503 BUY_ADS_DISABLED` unless
   `process.env.BUY_ADS_ENABLED === '1'`. Default disabled.
2. **`controllers/tradeController.js`** — `initiateTrade` refuses
   to create a trade against any pre-existing BUY ad with the same
   `503 BUY_ADS_DISABLED`. Belt-and-braces in case a stale BUY ad
   was created in a previous deploy and the operator now turns the
   flag off.

The env-flag escape hatch (`BUY_ADS_ENABLED=1`) lets staging /
integration environments still exercise the BUY-ad code path for
test purposes. It must NEVER be set in production until Phase D-2
ships.

**What this PR does NOT change.** No schema migration. No write to
`azmBalance`. No change to SELL ads. No change to the
`completeTrade` settlement engine itself. The bug surface is closed
by entry-point gating, not by editing the broken code.

**Operator action required.** Run the SQL probe from the design doc
once this deploys to confirm the impact:

```sql
SELECT COUNT(*) FROM "Ad" WHERE type = 'BUY' AND status = 'ACTIVE';
SELECT COUNT(*) FROM "Trade" WHERE type = 'BUY' AND status = 'COMPLETED';
```

If the second number is greater than zero, the platform has already
minted USDC on those completed BUY-ad trades. The total can be
estimated as `SUM(amountCrypto)` of those rows. Reconciliation
(burning the minted USDC against `SystemProfitFees` + vendor
`availableBalance`) is out of scope for D-1 and tracked as a D-2
sub-step.

**Files in this PR (4 total):**

- `controllers/adController.js` — `createAd` BUY gate (~15 lines).
- `controllers/tradeController.js` — `initiateTrade` BUY gate (~15 lines).
- `.env.example` — new `BUY_ADS_ENABLED=0` line + explanatory comment.
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` — this entry.

### Phase L — API contract docs sweep (2026-05-25, merged 2026-05-25, BE PR #42)

Branch: `phase-l-api-contract-sweep`. Doc-only PR. Closes the audit's
"Coverage gaps" gap by writing the spec for all 9 route trees Phase B
flagged as undocumented:

| Tree | Endpoints documented |
|---|---|
| `/api/friends/*` | 9 (search, profile, request × 4, list × 2, remove) + 5 DM (`/chat/*`) + 7 peer transfer (`/transfer/*`) |
| `/api/savings/*` | 8 (overview, list, get, create, deposit, withdraw, pause, resume) |
| `/api/security/*` | 6 (2FA setup/verify/disable, PIN set/verify, change-password) |
| `/api/users/*` | 13 (profile × 2, balance, dashboard, onboarding × 3, preferences × 4, milestones, security-logs, delete) |
| `/api/auth/sso` | 1 (federated Google + Apple sign-in via Firebase ID token) |
| `/api/ai/*` | 6 (capabilities, CFO analyze, queue initiate/status/leave/process) |
| `/api/kyc/*` | 2 (status, submit) |
| `/api/vendor/*` | 5 (stats, stats/quick, achievements, leaderboard, xp/review) |
| `/api/oracle/*` | 2 (yellowcard-rate, rates) |

Total: 64 new endpoint specs + 1 new "Personal P2P chat" socket
cross-reference.

**Methodology.** Every section was written by reading the live route
file + each handler in the matching controller end-to-end. Request
shapes, validation rules, refusal codes, response envelopes, and side
effects (notifications, socket emits, audit-log rows) were lifted
directly from the source. Phase I's cursor-pagination wire shape is
documented inline on the two endpoints that adopted it
(`GET /friends`, `GET /friends/chat/:friendshipId/messages`).

**Going-forward convention.** The "Coverage gaps" placeholder is
replaced with a "**closed in Phase L**" marker plus a one-line policy:
when a route signature changes in any future PR, the contract change
ships in the same PR. Code that disagrees with the contract is by
definition wrong.

**Files (1):**
- `api_contract.md` — coverage-gaps section rewritten + 9 new tree
  sections, ~600 LOC added.

No code change. No schema change. The frontend benefits indirectly:
all 64 endpoints now have authoritative request/response shapes the
FE can reference without grep-walking the BE.

### Phase J — Schema cleanup: drop dead V1 columns (2026-05-25, merged 2026-05-25, BE PR #41 + FE PR #43)

Branch: `phase-j-schema-cleanup` on backend, `phase-j-schema-cleanup` on
frontend. Coordinated migration that finally removes the two write-dead
columns flagged in Phase B findings C and D: `User.ghsBalance` and
`User.lockedBalance`.

**Why now.** Phase B (2026-05-24) verified both columns are write-dead:
no code path in any controller, service, or worker writes to either.
`ghsBalance` is read in four display selects (`profileController` ×3,
`authController` ×2, `ssoController` ×1, `server.js` ×2) and always
returns `0.0`. `lockedBalance` is initialized to `0.0` on every user
create (`authController` ×3, `ssoController` ×1, `seed.ts` ×1) and read
in the same display selects. The previous "vendor escrow" semantics
moved to `escrowLockedBalance` when V2 split the account model; the
"GHS bucket" semantics moved to the hologram model
(`availableBalance × yellowCardRate`, computed on read).

**What ships (BE).**

1. **Schema drop:** `prisma/schema.prisma` removes both `Float` columns
   from `User`. New comment block above `azmBalance` documents the
   removal and points readers at the audit findings.
2. **Migration:** `prisma/migrations/20260525_phase_j_drop_dead_columns/`
   contains a single SQL with `ALTER TABLE "User" DROP COLUMN IF EXISTS`
   for each. `IF EXISTS` keeps the migration idempotent across replicas
   and dev resets. No backup needed — both columns hold `0.0` for every
   row in every environment by construction.
3. **Controller cleanup (5 files):**
   - `controllers/authController.js` — drops 3 init sites
     (register, normal-login admin elevation, admin-seed first-create)
     and 4 select-or-response sites
     (admin-seed response, normal-login response, register response,
     `getUserDetails` select).
   - `controllers/profileController.js` — drops both fields from 4 sites
     (full-profile select + balance-only select + dashboard select +
     dashboard `balances` envelope).
   - `controllers/ssoController.js` — drops the SSO-create init and the
     SSO response.
   - `server.js` — drops both fields from `emitBalanceUpdate`'s select
     and from the socket envelope it pushes to `balance_room_<userId>`.
   - `prisma/seed.ts` — drops the `lockedBalance: 1000.0` from the
     vendor seed (the comment "Pass the $500 collateral check" was
     itself stale; that gate was fixed in Phase B to read
     `availableBalance`).
4. **Contract update:** `api_contract.md` is rewritten in three spots —
   the `Phase A reconciliation` table gains two new "DROPPED (Phase J)"
   rows, the `/auth/me/:id` description loses `ghsBalance` and gains
   a Phase-J migration note, and the compliance footnote about
   "retained for migration audit only" is replaced with the actual
   drop history.

**What ships (FE, separate PR).** `lib/models/user_model.dart`,
`lib/providers/{auth,hologram,trade}_provider.dart`,
`lib/services/socket_service.dart`,
`lib/screens/auth/{login,signup}_screen.dart`,
`lib/screens/{user,vendor}_dashboard.dart`, and
`lib/screens/vendor_deposit_screen.dart` all stop reading the two
JSON keys. The `ghsBalanceProvider` is removed (was always `0.0`).
The vendor dashboard "in escrow" label, which was bound to the
write-dead `lockedBalance`, is rewired to read `escrowLockedBalance`
(the V2 field) so vendors see a correct active-trade lock figure for
the first time.

**Backwards compatibility.** Pre-Phase-J FE clients (older app builds
in the wild) that POST to `/auth/login` will receive responses missing
the two keys; they read JSON values defensively (`u['lockedBalance'] ?? 0.0`)
so the worst-case effect is the legacy "$0 in escrow" label staying
$0 — which is what it always showed anyway because the column was
write-dead. There is no money-correctness risk. The same applies to
the WebSocket `balance_update` envelope.

**Deferred (to a follow-up "Phase J2").** Float → Decimal column-type
rewrite for every money column, plus `CHECK (col >= 0)` on the
balance buckets. Both require a maintenance window because column-type
rewrites take a heavy lock. Filed as Phase J2 in the unified roadmap.

**Files in this PR (BE: 6 + 1 migration; FE: 8).**

BE:
- `prisma/schema.prisma` (-2 lines)
- `prisma/migrations/20260525_phase_j_drop_dead_columns/migration.sql` (NEW)
- `prisma/seed.ts` (-1 line)
- `controllers/authController.js` (~-12 lines)
- `controllers/profileController.js` (~-10 lines)
- `controllers/ssoController.js` (~-3 lines)
- `server.js` (~-4 lines)
- `api_contract.md` (+10 / -3 lines)
- `AUDIT.md` + `AZAMAN_MASTER_SOUL.md` (this entry)

### Phase D — AZM trap + BUY-ad ledger redesign — DESIGN PASS (2026-05-25, merged 2026-05-25, BE PR #43)

Branch: `phase-d-azm-ledger-design`. **Design-doc PR. No code change.**

The audit explicitly required a design pass before code on this phase
("`Needs a design pass mapping the full P2P ledger flow before code
change.`"). This PR delivers that pass as
`docs/PHASE_D_AZM_LEDGER_DESIGN.md` (~580 LOC).

**What the design doc establishes:**

1. **Maps every AZM read/write site** in the BE (15 sites across 8
   files). The `azmBalance` column has a working withdrawal path
   (`walletController.processWithdrawal`) that the audit missed —
   AZM is not a "one-way trap" in the strict sense, but it IS
   stranded liquidity for V2 features (savings, peer transfer,
   chat/transfer all read `availableBalance`, not `azmBalance`).

2. **Confirms the BUY-ad bug.** A BUY-ad trade decrements user's
   `azmBalance` on initiate AND increments it again on complete.
   Net AZM change = `−amountCrypto × adminMarginGhs` (a small loss
   for the user equal to the platform margin in GHS). The vendor
   gets the crypto for free. This is a money-correctness P0 if BUY
   ads are live in production.

3. **Three implementation options** with full diff-size and tradeoff
   analysis:
   - **Option A (minimal):** ~30 LOC hotfix. Skip the spurious
     `azmBalance` increment on BUY-ad complete. Keeps AZM/USDC
     dual-currency confusion.
   - **Option B (mirror SELL escrow):** ~150 LOC + new column.
     Adds `azmEscrowBalance` to mirror the V2 escrow pattern. Doesn't
     fix stranded liquidity.
   - **Option C (eliminate azmBalance):** ~1500-2000 LOC across
     ~25 files + migration. Settles everything in `availableBalance`,
     drops the AZM column. Aligns with V2 master-soul §2 and the
     direction Phase J already shipped (drop dead V1 columns).

4. **Recommended path:** Option A as urgent hotfix IF BUY ads are
   live in production today; Option C as the strategic cleanup once
   Phase K (auth hardening) lands. Skip Option B — same surface-area
   cost as C with worse long-term outcome.

5. **Five sub-PRs (D-2a..D-2e) sequenced** for the Option C path,
   with explicit migration script and FE coordination plan.

6. **Five open questions for product/design review** that gate the
   recommendation, including the "is BUY ad live?" SQL probe and
   the "should AZM remain a distinct asset class long-term?"
   strategic question.

The implementation work (Phase D-1 / D-1.5 / D-2) is filed as
follow-on PRs once the recommendation is signed off.

### Phase E — Savings completion (FE PR #37, merged 2026-05-24)

Frontend-only PR (`phase-e-savings-completion` on azaman-frontend-main).
Wires the four savings backend endpoints the frontend was previously not
calling — `POST /savings/goals/:id/deposit`, `POST /savings/goals/:id/withdraw`,
`PUT /savings/goals/:id/pause`, `PUT /savings/goals/:id/resume`. Goal cards
in SavingsScreen are now tappable; tap opens a management sheet
(`lib/widgets/savings_goal_sheet.dart`) with goal summary, Fund / Withdraw
action tiles, and a Pause/Resume toggle. Withdraw on locked + not-matured
goals shows a 2% early-penalty preview before submission.

No backend code change in this PR. Backend roadmap status: Phase E now
listed as `DONE (FE PR #37)` in the unified table above.

### Phase C — Crypto deposit wiring + unified roadmap (2026-05-24, merged PR #36)

Branch: `phase-c-deposit-and-roadmap`. Deeper-than-expected verification of
the frontend financial screens revealed that **most of what the audit
flagged as "P0 — not wired" is actually fully wired and working**:

- `WithdrawalScreen` posts correctly to `/finance/withdraw/fiat` (mobile money path)
  and `/wallet/withdraw` (saved-wallet crypto path). Has the fiat-pool low-liquidity
  banner, network selection, recipient phone, optional account name, MAX button.
- `TransferModal` calls `friendService.sendFunds(...)` / `friendService.requestFunds(...)`
  via the slide-to-confirm widget. Both methods exist on `FriendService` (the
  audit's "calls a method that doesn't exist" claim was stale).
- `FiatDepositFlowScreen` posts to `/deposit/fiat/initiate` and shows the
  reference + instructions correctly.
- `SavingsScreen` posts to `/savings/goals` for goal creation.

**One real gap found and fixed this PR:** `CryptoDepositScreen` is a
high-quality, fully-built screen that fetches the user's Polygon USDC
deposit address from `GET /wallet/deposit-address/polygon` and renders a QR
code — but it had **zero inbound imports**. Users had no path to it from
anywhere in the app, meaning **nobody could deposit USDC on Polygon**. Phase
C wires it via a new `DepositChooserSheet` so the Home "Deposit" Quick
Action now opens a chooser between Crypto (Polygon USDC) and Fiat (MoMo).

**One bigger gap noted, deferred to Phase E:** `SavingsScreen` only uses 2
of the 8 backend savings endpoints. Backend exposes `deposit`, `withdraw`,
`pauseGoal`, `resumeGoal`, `getGoal` — frontend doesn't call any of them.
Users can create a goal but cannot fund or draw from it.

### Phase B — Backend money correctness re-verification (2026-05-24)

Branch: `phase-b-money-correctness`. PR scope is small (one P0 fix, two doc
reconciliations) because the audit's headline P0s turned out to be already-fixed
or misdiagnosed. The valuable work in this PR is the verification record itself,
which prevents future contributors from chasing ghosts.

**Method.** For each TL;DR P0 I (a) opened the file the audit pointed to,
(b) traced the actual control flow, and (c) recorded the verifying line(s)
inline. I did not run the code (no Prisma DB to seed against in the sandbox)
but the static evidence is unambiguous.

| # | Audit's claim | Verified status | Evidence |
| --- | --- | --- | --- |
| TL;DR §1 | Two competing ledger systems; deposits invisible to GHS rail | ⚠️ **Misdiagnosed.** `availableBalance` is the unified V2 USDC ledger across all hot paths. `ghsBalance` is genuinely write-dead. See "New finding C" below. | `controllers/{deposit,withdrawal,savings,peerTransfer}Controller.js` and `services/{p2p,finance}.service.js` all read/write `availableBalance` exclusively. `ghsBalance` is read only in profile/auth display selects. |
| TL;DR §2 | Withdrawals silently disconnected from MTN MoMo | ✅ **Already fixed.** Wired in code. | `controllers/withdrawalController.js:117` calls `mtnDisbursementService.initiateTransfer({...})` inside the post-debit transaction. |
| TL;DR §3 | Kotani deposits credit only `availableBalance`; rail features read other fields | ⚠️ **Misdiagnosed.** Same as §1 — `availableBalance` is what every rail feature reads. The "GHS rail" the audit imagined doesn't exist; the unified-USDC + hologram-display model is what's implemented. | Confirmed by full-file read of `savingsController` (line 225 `user.availableBalance < amountUsdc`), `peerTransferController` (line 121, 502), `finance.service` (line 130). |
| TL;DR §4 | Internal transfer has no idempotency key; retries can double-charge | ✅ **Already fixed.** Idempotency is implemented at three layers. | `controllers/peerTransferController.js:36-43` accepts `clientRequestId` from body or `X-Idempotency-Key` header; `54-67` does a pre-check by `txHash`; `225-228` handles the P2002 unique-constraint conflict for concurrent retries. Both sender AND receiver get TransactionHistory rows (lines 154-180). |
| TL;DR §5 | Notifications double-written; bell empty on app reopen | ✅ **Already fixed.** Every call site I sampled persists. | All callers go through either `services/notificationService.sendNotification` (which always does DB+socket+push) or direct `prisma.notification.create` / `tx.notification.create`. Zero bare-socket-emit-without-persist found. The "60% of call sites also write" concern from the audit no longer applies. |
| TL;DR §6 | `directMessageController` has no route file (orphan) | ⚠️ **Stale — wired now.** | Mounted in `routes/friendRoutes.js:43-47` as `/api/friends/chat/*`. Note: the audit's claim that `api_contract.md` documents these as `/api/messages/*` is also stale — `api_contract.md` does not contain `/messages` at all. The contract is silent on `/friends/*`, which is now flagged in api_contract's new "Coverage gaps" section. |
| TL;DR §7 | Nine controllers exist that have no route or are partially wired | 🟡 **Partially relevant.** `imageController.js` is genuinely orphan; `userPreferencesController` and `milestoneController` concerns deserve a separate look. Did not re-verify in detail this PR. | Future PR. |
| TL;DR §8 | Three services dead (`serviceIntegrator`, `emailService`, `smsService`) | ✅ **Resolved (L1 + L2).** | `emailService` wired in L1 (BE PR #54); `smsService` wired in L2 (in review). `serviceIntegrator` remains orphan facade — no new capability; can be deleted. |
| TL;DR §9 | `service-account.json` is committed to repo | ✅ **Resolved in PR #32** — file removed, `.gitignore` patterns added, key rotated. | See `security/firebase-credential-cleanup`. |
| TL;DR §10 | List endpoints return all rows, no pagination | 🟡 **Still true.** Performance work, deferred to its own PR. | `notificationController`, `chatController`, `friendController` list endpoints have no `take/skip`. |

**Summary:** of 10 TL;DR findings, **5 are already fixed**, **2 are misdiagnosed** (the "dual ledger" concern is real-but-different — see new findings), **3 remain valid** for future PRs.

### New findings (introduced in Phase B verification)

| # | Finding | Severity | Code reference |
| --- | --- | --- | --- |
| **A** | **`adController.createAd` collateral gate is dead.** The check `if (vendor.lockedBalance < 500) reject` reads `lockedBalance` — a V1 legacy field that no current code path writes to. Every user has `lockedBalance = 0` at all times, so the gate `< 500` always passes and ad creation is effectively unguarded. Anyone with an account can post an ad with $0 USDC. | **P0 (security/business)** | `controllers/adController.js:17`. **Fixed in this PR** by switching to `availableBalance < 500`. The proper "collateral bond" model (lock 500 USDC into a separate `vendorBondBalance` field on ad creation, refund on ad deletion) is a follow-up PR — would require schema migration. |
| **B** | **`azmBalance` is a one-way trap.** Credited on P2P trade completion (buyer side, `services/p2p.service.js:521`). No spend path: cannot be withdrawn (`withdrawalController` reads `availableBalance`), transferred (`peerTransferController` reads `availableBalance`), or used to fund savings (`savingsController` reads `availableBalance`). Only escape is selling AZM back via a P2P BUY ad. **Also note:** the BUY ad path in `tradeController.initiateTrade:217` debits the user's `azmBalance` on lock, but `services/p2p.service.completeTrade` credits the buyer's `azmBalance` again on completion (line 521) — meaning a "BUY ad" trade decrements the user's AZM on initiate and increments it again on complete, which is internally inconsistent with the SELL-ad semantics. The full P2P ledger flow needs to be mapped before changing this. | **P1 (UX + architectural)** | `prisma/schema.prisma:193`, `services/p2p.service.js:518-521`, `controllers/tradeController.js:217-228`. **Deferred to a future PR** — design conversation needed. |
| **C** | **`ghsBalance` is dead schema bloat.** No flow writes it. Only read in `profileController.js:523`, `authController.js:269,338`, `ssoController.js:194` — all display selects. Returns `0` forever. Confuses the frontend by suggesting a "GHS balance" exists when none does. | **P2 (hygiene)** | grep `ghsBalance:\s*\{` returns zero matches. **Deferred** — removing the field requires a Prisma migration plus a coordinated frontend update. Track for next schema migration PR. |
| **D** | **`lockedBalance` is dead schema bloat** (separate from finding A — A was the gate logic; D is the field itself). Only initialized to `0.0` on user creation. Read in `adController:17` (the dead gate, now patched in A), `profileController` (display), `authController`/`ssoController` (auth response). | **P2 (hygiene)** | Same migration as C. **Deferred.** |
| **E** | **`api_contract.md` is silent on entire route trees.** `/api/friends/*`, `/api/savings/*`, `/api/security/*`, `/api/users/*`, `/api/sso/*`, `/api/ai/*`, `/api/kyc/*`, `/api/vendor/*`, `/api/oracle/*` all exist in `routes/` but are not documented. | **P1 (contract gap)** | **Partially addressed in this PR** — added a "Coverage gaps" section to `api_contract.md` listing the missing trees so future contributors know what's not covered. Writing the actual sections is a separate, larger PR. |
| **F** | **This audit (`AUDIT.md`) was misleading future contributors** by listing five resolved/misdiagnosed P0s in its TL;DR without reconciliation notes. | **P1 (doc rot)** | **Resolved in this PR** — the table above is the reconciliation. The original audit body is preserved below as historical record. |

### Phase K — Auth + security hardening (2026-05-25, merged 2026-05-25, BE PR #39)

Branch: `phase-k-auth-hardening`. Backend-only PR. Closes the §2 P0/P1
findings the original audit raised: 7-day JWT with no refresh, JWT
staleness on isVendor flip, SSO aud claim check, profile updateProfile
whitelist, avatars sharing the proofs directory.

**What ships:**

1. **Refresh-token model.** New Prisma migration
   `20260525_phase_k_refresh_tokens` adds `User.tokenVersion INT @default(0)`
   and a fresh `RefreshToken` table (uuid id, userId, expiresAt, revokedAt,
   userAgent, ipAddress, createdAt + indexes on userId & expiresAt + cascade
   FK on user delete). Access JWTs now include `tokenVersion` + `typ:'access'`
   claims, expire in 15 min. Refresh tokens are 30-day, opaque uuids, stored
   server-side. `services/authTokenService.js` is the single source of truth
   for `signAccessToken` / `issueTokenPair` / `rotateRefreshToken` /
   `revokeAllForUser`. `signAccessToken` throws on missing tokenVersion to
   fail-fast on programmer error.

2. **`POST /api/auth/refresh` and `POST /api/auth/logout`.** The refresh
   endpoint validates and ROTATES the inbound token via an atomic
   compare-and-swap on `revokedAt IS NULL` — under concurrency only one
   call succeeds, the other gets count=0 and 401. The logout endpoint is
   idempotent (P2025 caught, double-logout still 200s).

3. **Live-user gate in `protect` middleware.** Every authenticated request
   now does one PK-indexed Prisma findUnique selecting tokenVersion,
   banStatus, isDeleted. USER_GONE / BANNED branches are unconditional.
   Only the `tokenVersion > claimVersion` comparison is gated by the
   `AUTH_SKIP_TOKEN_VERSION_CHECK=1` cutover sentinel (narrow scope per
   the round-2 review). Pre-Phase-K tokens with no claim are coerced to 0
   and pass through until they expire on day 7.

4. **Privilege-change cascade.** Both role-flip endpoints
   (`adminController.approveKyc`, `adminController.changeUserRole`) now
   run role-flip + tokenVersion bump + refresh-token revocation in one
   `$transaction`, gated on `isActualChange` to avoid bumping on no-op
   re-saves. Both emit a `session_refresh_required` socket event so the
   client switches to the new role exactly once.

5. **Password-change cascade.** `securityController.changePassword`
   (Phase F endpoint) now runs four writes in one `$transaction`:
   password write + tokenVersion bump + revoke-all-refresh +
   create-new-refresh-for-this-device. The change-of-password device
   stays logged in seamlessly via the freshly-issued pair returned in
   the response (both `token` and `accessToken` keys for legacy FE).
   Other devices get TOKEN_STALE on their next request.

6. **SSO `aud` verification.** Production path: the SDK already enforces
   project-scoped aud; added an optional belt-and-braces compare against
   `FIREBASE_PROJECT_ID`/`SSO_EXPECTED_AUD` for multi-tenant configs.
   Dev fallback: previously decoded JWT without verification (huge hole
   if the env-flag landed in production); now gated by
   `SSO_DEV_FALLBACK=1` AND requires a configured aud env var. Without
   one, the dev path returns 503 instead of accepting any unsigned token
   with a valid email.

7. **Avatar directory split.** New `middleware/avatarUploadMiddleware.js`
   + `POST /api/users/profile/avatar` route. Avatars land in
   `/uploads/avatars/` (was de-facto sharing `/uploads/proofs/` with KYC
   docs — §6 P1 finding). 2 MB cap (was 5 MB for proofs), random-suffix
   filenames (no user-controlled originalname), AND-not-OR mimetype +
   extension validation. Existing rows pointing at `/uploads/proofs/`
   continue to serve via the existing static mount.

8. **profileController.updateProfile whitelist verified.** Only
   `displayName, bio, phoneNumber, country, profilePictureUrl, fcmToken`
   accepted — already tight per the original audit. No code change
   required this PR; documented for closure.

**Files in this PR:**

- `prisma/migrations/20260525_phase_k_refresh_tokens/migration.sql` — NEW
- `prisma/schema.prisma` — `tokenVersion`, `RefreshToken` model
- `services/authTokenService.js` — NEW
- `controllers/refreshController.js` — NEW
- `middleware/avatarUploadMiddleware.js` — NEW
- `middleware/authMiddleware.js` — async protect, live-user gate, scoped flag
- `controllers/authController.js` — register/login emit token pair
- `controllers/ssoController.js` — aud verification + dev-fallback hardening
- `controllers/adminController.js` — approveKyc + changeUserRole cascade
- `controllers/securityController.js` — changePassword cascade + fresh pair
- `controllers/profileController.js` — uploadAvatar
- `routes/authRoutes.js` — wires /refresh, /logout
- `routes/userRoutes.js` — wires /profile/avatar

Two rounds of `semantic_reviewer` folded in (8 round-1 findings + 2
round-2 regressions all addressed).

### Phase I — Performance + mobile payload (2026-05-25, BE PR #40, merged)

Branch: `phase-i-pagination`. Backend-only PR. Migrates five list endpoints
from unbounded or offset-paginated reads to cursor pagination, and ships
ten composite indexes that make those reads index-only seeks.

**Why this matters.** Pre-Phase-I, `GET /api/trades/history` did
`prisma.trade.findMany({ where: { OR: [{userId},{vendorId}] }, orderBy: { createdAt: 'desc' } })`
— no `take`, no index — so a vendor with 5,000 trades got 5,000 rows on
every fetch. Same shape on `/api/chat/:tradeId` (full conversation, no
limit), `/api/notifications` (offset pagination on a single-column index),
`/api/ads` (full ACTIVE-ad set returned), `/api/friends` (no pagination
+ N+1 latest-message + N+1 unread-count loop = 2N round-trips per render).

**What ships:**

1. **`utils/pagination.js`** — single source of truth for cursor handling:
   `parsePagination(req.query)` decodes `cursor` (UUID or Int auto-detected
   via `/^-?\d+$/`), `limit` (capped at 100, default 20), and `page`
   (legacy offset path). `buildPageEnvelope(rows, take, mode, page, total)`
   emits `{ nextCursor, hasMore, limit, page?, total? }` so all five
   endpoints speak the same wire shape.

2. **Composite indexes** (Prisma + raw SQL migration
   `20260525_phase_i_pagination_indexes`). Ten `(filter_col, createdAt DESC)`
   shapes plus the special `Notification(userId, isRead, createdAt DESC)`
   for the unread-only path and two `Friendship` shapes for the
   OR-predicate filter. SQL uses `CREATE INDEX IF NOT EXISTS` (no
   `CONCURRENTLY` — Prisma migrate runs each statement inside an implicit
   transaction; on any large prod table swap to a manual ops runbook).

3. **Cursor pagination on five endpoints.** All use `cursor: { id }` +
   `skip: 1` to avoid repeating the cursor row. `orderBy` everywhere is
   `[{ createdAt: 'desc' }, { id: 'desc' }]` (or ASC on the chat legacy
   path) — the `id` tiebreaker prevents skip/duplicate when two rows
   share `createdAt` to the millisecond.

4. **Backwards-compat preserved on `/ads`, `/trades/history`, and
   `/chat/:tradeId`.** Legacy callers that don't pass any pagination
   param keep getting the pre-Phase-I response shape. Opted-in callers
   (any of `cursor`, `limit`, `page`, `status`) get the envelope.

5. **`/api/friends` 2N→2 query collapse.** Old code did
   `friendships.map(async f => { latestMessage; unreadCount })` —
   2N round-trips. New code does ONE `findMany distinct: ['friendshipId']`
   for latest messages (Postgres `DISTINCT ON`, served by the new
   `DirectMessage(friendshipId, createdAt DESC)` index) plus ONE
   `groupBy` for unread counts. Two queries total, regardless of
   friend count.

6. **AI marketplace declared single-page.** AI mode pulls a 3x window
   for the scorer to re-rank. Trying to paginate that would mean the
   same ad could appear on multiple pages (or vanish) as the scorer
   re-runs. `aiOn` forces `nextCursor=null` and `hasMore=false` so the
   contract is honest — clients wanting "more matches" should refine
   the filter, not paginate.

7. **Friendship cursor caveat.** The query orders by `Friendship.updatedAt
   DESC`, which is bumped by every direct message and peer transfer.
   A friend whose `updatedAt` bumps mid-pagination can skip or duplicate
   across pages. Friend-list scale (rarely > 1 page) makes this a
   non-issue in practice; flagged inline for future readers.

**Files in this PR (7 + 1 migration):**

- `utils/pagination.js` — NEW
- `prisma/schema.prisma` — 10 new `@@index` entries
- `prisma/migrations/20260525_phase_i_pagination_indexes/migration.sql` — NEW
- `services/notificationService.js` — cursor branch + page-1-only count
- `controllers/notificationController.js` — pagination wiring
- `controllers/chatController.js` — cursor mode (DESC + envelope) + legacy ASC bare path
- `controllers/friendController.js` — cursor + N+1 collapse + explicit projection
- `controllers/adController.js` — cursor (non-AI), AI single-page, bare-array legacy
- `controllers/tradeController.js` — cursor + status filter, bare legacy

Two rounds of `semantic_reviewer` folded in (5 round-1 + 1 round-2
runtime issue all addressed).

**Out of scope (deferred to a follow-up):**

- Parallelise `vendorStatsController.getStats` (currently serial Prisma
  calls; small per-vendor optimisation).
- Move `vendorGamificationService.processTradeCompletion` off the
  `completeTrade` request path (currently inside the $transaction;
  could be deferred via `setImmediate` to land XP / streak / achievement
  updates after the trade response goes out).

Branch: `phase-i-pagination`. Backend-only PR. Migrates five list endpoints
from unbounded or offset-paginated reads to cursor pagination, and ships
ten composite indexes that make those reads index-only seeks.

**Why this matters.** Pre-Phase-I, `GET /api/trades/history` did
`prisma.trade.findMany({ where: { OR: [{userId},{vendorId}] }, orderBy: { createdAt: 'desc' } })`
— no `take`, no index — so a vendor with 5,000 trades got 5,000 rows on
every fetch. Same shape on `/api/chat/:tradeId` (full conversation, no
limit), `/api/notifications` (offset pagination on a single-column index),
`/api/ads` (full ACTIVE-ad set returned), `/api/friends` (no pagination
+ N+1 latest-message + N+1 unread-count loop = 2N round-trips per render).

**What ships:**

1. **`utils/pagination.js`** — single source of truth for cursor handling:
   `parsePagination(req.query)` decodes `cursor` (UUID or Int auto-detected
   via `/^-?\d+$/`), `limit` (capped at 100, default 20), and `page`
   (legacy offset path). `buildPageEnvelope(rows, take, mode, page, total)`
   emits `{ nextCursor, hasMore, limit, page?, total? }` so all five
   endpoints speak the same wire shape.

2. **Composite indexes** (Prisma + raw SQL migration
   `20260525_phase_i_pagination_indexes`). Ten `(filter_col, createdAt DESC)`
   shapes plus the special `Notification(userId, isRead, createdAt DESC)`
   for the unread-only path and two `Friendship` shapes for the
   OR-predicate filter. SQL uses `CREATE INDEX IF NOT EXISTS` (no
   `CONCURRENTLY` — Prisma migrate runs each statement inside an implicit
   transaction; on any large prod table swap to a manual ops runbook).

3. **Cursor pagination on five endpoints.** All use `cursor: { id }` +
   `skip: 1` to avoid repeating the cursor row. `orderBy` everywhere is
   `[{ createdAt: 'desc' }, { id: 'desc' }]` (or ASC on the chat legacy
   path) — the `id` tiebreaker prevents skip/duplicate when two rows
   share `createdAt` to the millisecond.

4. **Backwards-compat preserved on `/ads`, `/trades/history`, and
   `/chat/:tradeId`.** Legacy callers that don't pass any pagination
   param keep getting the pre-Phase-I response shape. Opted-in callers
   (any of `cursor`, `limit`, `page`, `status`) get the envelope.

5. **`/api/friends` 2N→2 query collapse.** Old code did
   `friendships.map(async f => { latestMessage; unreadCount })` —
   2N round-trips. New code does ONE `findMany distinct: ['friendshipId']`
   for latest messages (Postgres `DISTINCT ON`, served by the new
   `DirectMessage(friendshipId, createdAt DESC)` index) plus ONE
   `groupBy` for unread counts. Two queries total, regardless of
   friend count.

6. **AI marketplace declared single-page.** AI mode pulls a 3x window
   for the scorer to re-rank. Trying to paginate that would mean the
   same ad could appear on multiple pages (or vanish) as the scorer
   re-runs. `aiOn` forces `nextCursor=null` and `hasMore=false` so the
   contract is honest — clients wanting "more matches" should refine
   the filter, not paginate.

7. **Friendship cursor caveat.** The query orders by `Friendship.updatedAt
   DESC`, which is bumped by every direct message and peer transfer.
   A friend whose `updatedAt` bumps mid-pagination can skip or duplicate
   across pages. Friend-list scale (rarely > 1 page) makes this a
   non-issue in practice; flagged inline for future readers.

**Files in this PR (7 + 1 migration):**

- `utils/pagination.js` — NEW
- `prisma/schema.prisma` — 10 new `@@index` entries
- `prisma/migrations/20260525_phase_i_pagination_indexes/migration.sql` — NEW
- `services/notificationService.js` — cursor branch + page-1-only count
- `controllers/notificationController.js` — pagination wiring
- `controllers/chatController.js` — cursor mode (DESC + envelope) + legacy ASC bare path
- `controllers/friendController.js` — cursor + N+1 collapse + explicit projection
- `controllers/adController.js` — cursor (non-AI), AI single-page, bare-array legacy
- `controllers/tradeController.js` — cursor + status filter, bare legacy

Two rounds of `semantic_reviewer` folded in (5 round-1 + 1 round-2
runtime issue all addressed).

**Out of scope (deferred to a follow-up):**

- Parallelise `vendorStatsController.getStats` (currently serial Prisma
  calls; small per-vendor optimisation).
- Move `vendorGamificationService.processTradeCompletion` off the
  `completeTrade` request path (currently inside the $transaction;
  could be deferred via `setImmediate` to land XP / streak / achievement
  updates after the trade response goes out).

### Phase F — Settings overhaul: change-password endpoint (PR #36, merged 2026-05-24, BE half)

Branch: `phase-f-change-password-endpoint`. Companion to the frontend
Phase F branch (`phase-f-settings-overhaul`, FE PR #38, merged via the
phase-h2 stack PR #41). The full feature documentation lives in
`azaman-frontend-main/FRONTEND_AUDIT.md` — this section covers only the
backend additions.

**New endpoint:** `POST /api/security/change-password` (protected).

- Body: `{ currentPassword, newPassword }`.
- Verifies the user's current password via `bcrypt.compare`.
- Refuses on SSO-only accounts (where `password === ''`) — those users
  must claim a password through a future set-password flow first.
- Validates `newPassword.length >= 8` and refuses if it equals the current
  password (so the bcrypt-equality bypass on identical hashes doesn't
  silently succeed without changing anything).
- On success, hashes with `bcrypt.genSalt(12)` + `bcrypt.hash`, updates the
  user row, then writes a best-effort audit notification:
  `category = SECURITY_ACCOUNT, title = 'Password changed'`. The audit
  insert is wrapped in try/catch so a logging failure never blocks the
  password change itself.

The new entry surfaces immediately in the frontend's "Account Activity"
list (which reads from the same `Notification` table filtered to
`SECURITY_ACCOUNT`), so the change-password event is its own audit trail.

**Files in this PR:**

- `controllers/securityController.js` — `exports.changePassword`.
- `routes/securityRoutes.js` — `router.post('/change-password', protect, …)`.

The endpoint is mounted under the existing `/api/security` tier with the
`generalLimiter` in `server.js`, inheriting the standard rate limit. No
schema migration needed — uses the existing `Notification` table.

### Phase G — Home overhaul (FE PR #39, merged via phase-h2 stack PR #41, 2026-05-24)

Frontend-only PR (`phase-g-home-overhaul` on azaman-frontend-main). No
backend code change — pure consumer of existing endpoints
(`/api/oracle/rates`, `/api/trades/history`, `/api/wallet/history`,
`/api/friends/requests`, `/api/notifications/unread-count`).

Replaced the static "brochure" home screen with a dynamic dashboard:
new `TodayWidget` (4 stat tiles), new `LiveMarketSection` (live
USD→GHS rate + 24-sample fl_chart sparkline), removed hardcoded
Platform News, pull-to-refresh actually re-fetches now via a single
`Future.wait` fan-out (`HomeSummaryService`).

Documented for the backend reader so when an `/api/oracle/rates`
contract change is proposed, you know the home dashboard depends on
`liveUsdToGhs`, `liveRetailRate`, `liveCorporateRate`, `rateSource`,
`lastSync` JSON keys. The `/api/trades/history` consumer reads
`amountFiat` + `amountCrypto` (V2 names, not the legacy `amountGhs` /
`amountUsdc`) and filters on `status ∈ {PENDING, PENDING_PAYMENT,
PAID, DISPUTED}` for the active set.

### Phase H — Premium polish pass (FE PR #40, merged via phase-h2 stack PR #41, 2026-05-24)

Frontend-only PR (`phase-h-premium-polish`). No backend code change.
Cross-cutting visual + tactile polish across every existing surface.
Custom page transitions, status-bar / nav-bar styles flipping with
the theme, `AzamanHaptics` vocabulary, `SkeletonBlock` cold-load
states, `AzamanConfirmSheet` replacing `AlertDialog`. Six review-pass
bugs in F+G+H were fixed in the same commit.

Backend-relevant fix folded into Phase H: the home summary's
trade-active filter now reads the correct enum members against
`prisma/schema.prisma:TradeStatus`, so a trade in `PENDING` (initial
state) is now visible on the home dashboard. No backend change
required — this was a frontend bug.

### Phase H2 — Slide-to-confirm on financial actions (FE PR #41, merged 2026-05-24)

Frontend-only PR (`phase-h2-slide-to-confirm`). No backend code change.
The PR #41 merge commit (`c2d5f73` on FE main) is the merge that
brought the full F → G → H → H2 stack onto FE main as a single
fast-forward chain. After this merge, FE PRs #38, #39, #40 became
content-empty (their commits already on main) and were closed.

### Phase 1 — Security cleanup (PR #32, merged 2026-05-24)

- Removed leaked `service-account.json` (Firebase admin key, project `azaman-app`, key id `16aa630a…`) from working tree.
- Hardened `.gitignore`: `service-account*.json`, `service-account*.json.json`, `firebase-adminsdk-*.json`, `google-services.json`, `GoogleService-Info.plist`, `*.pem`, `*.key`, `*.p12`, `secrets/`, `.env.*` (with `!.env.example` whitelist).
- Updated `.env.example` with explicit Firebase setup steps and a "never paste credentials in chat" protocol note.
- `utils/firebaseService.js` ERROR → WARNING for missing key file (push notifications becoming a no-op is by design when the key isn't present).
- **Operator follow-up (manual):** revoked compromised keys (`16aa630a…`, `36e0e494…`) in Google Cloud IAM. Live key id ends `…954e9`.

### Phase 0 — Frontend visible wins (PR #35, merged 2026-05-24, frontend repo)

Documented in `azaman-frontend-main/FRONTEND_AUDIT.md` changelog. Inverted vendor pull tab role gating, wired Home Quick Actions, rebuilt settings theme picker grid, removed `lib/theme/app_theme.dart` and `actual_settings_screen.dart`. Plus the frontend half of the Firebase key removal.

---

## UNIFIED ROADMAP (canonical, mirrored across both repos)

> This block is the single source of truth for "what's next." It is mirrored
> verbatim in `azaman-frontend-main/FRONTEND_AUDIT.md`. When you change one,
> change the other in the same PR. Don't fork the plan.

**Phase letter convention.** Phases are letter-tagged. A phase is **a single
focused PR** (≤ ~1500 LOC) that ships one coherent unit of value. The order
matters: later phases assume earlier ones merged.

### Status legend
- `DONE` — merged to main.
- `IN REVIEW` — PR open, awaiting review/merge.
- `NEXT` — first thing to pick up after current PRs land.
- `PLANNED` — committed scope, scheduled for later.
- `BACKLOG` — known need, not yet scheduled.

### Repo legend
- `BE` — backend (azaman-backend-main).
- `FE` — frontend (azaman-frontend-main).
- `both` — coordinated change spanning both repos.

### The roadmap

| Phase | Status | Repo | Title | Scope |
|---|---|---|---|---|
| **0** | `DONE` (PR #35 FE) | FE | Visible wins | Vendor pull tab gating fix, Home Quick Actions wired, settings theme grid rebuilt, dead theme/screens deleted, Firebase key removed from FE. |
| **1** | `DONE` (PR #32 BE) | BE | Firebase credential rotation | Removed leaked `service-account.json`, hardened `.gitignore`, updated `.env.example`, downgraded missing-key error to warning. |
| **B** | `DONE` (PR #33 BE) | BE | Money correctness re-verification | Verified 5 of 6 audit P0s already fixed; misdiagnosis on dual-ledger; one real fix shipped (`adController` collateral gate, was reading dead `lockedBalance` field — now reads `availableBalance`). |
| **C** | `DONE` (PR #36 FE) | FE | Crypto deposit wiring + unified roadmap | Wired orphan `CryptoDepositScreen` via new `DepositChooserSheet` from Home Quick Action. Verified WithdrawalScreen + TransferModal + FiatDepositFlow are already correctly wired. Wrote this canonical roadmap. |
| **D** | `DONE` (BE PR #43, design doc only) | BE | AZM trap + BUY-ad ledger redesign — DESIGN PASS | Design-doc PR. `docs/PHASE_D_AZM_LEDGER_DESIGN.md` mapped the full AZM/USDC ledger flow, surfaced the BUY-ad mint bug. Implementation split into D-1 (defensive gate, merged BE PR #44) and D-2 (Option C ledger rewrite, backlog). |
| **D-1** | `DONE` (BE PR #44) | BE | Disable BUY ads until D-2 ships | Refuses BUY-ad creation and BUY-ad trade initiation behind a default-off `BUY_ADS_ENABLED` env flag. ~30 LOC across `adController.createAd` + `tradeController.initiateTrade`. Stops the BUY-ad mint bug at entry points. Does not touch the `completeTrade` engine — D-2 owns that. |
| **D-2** | `IN REVIEW` (BE PR) | BE | Eliminate `azmBalance`; settle in `availableBalance` | Option C from design doc. Drops the column, migrates existing balances at live rate, rewrites completeTrade/markUnderpaid/BUY-ad-initiate/cancel/refund/withdrawal to use availableBalance. ~400 LOC across 12 files + migration. FE coordination doc included. |
| **E** | `DONE` (PR #37 FE) | FE | Savings completion | Wired `deposit`, `withdraw`, `pauseGoal`, `resumeGoal` from `SavingsScreen` (backend had them; FE only used overview + create). Tap on a goal card → bottom sheet with Fund / Withdraw / Pause-Resume actions. New widget: `lib/widgets/savings_goal_sheet.dart`. |
| **F** | `DONE` (PR #36 BE + PR #38 FE) | FE+BE | Settings overhaul (the original user pain point) | Apple/Binance row layout, dedicated `ThemePickerScreen` with live home preview, `AzamanTheme.system` (12th option, auto-follows OS brightness), SSO buttons wired on login + signup (typed `SsoNotConfiguredException` until Phase K adds firebase_auth + native config), Change Password tile (new backend endpoint `POST /api/security/change-password`), Account Activity tile (existing `GET /api/users/me/security-logs`), `SecuritySettings` orphan wired in. ~2.4k LOC across 8 frontend files + 2 backend files. |
| **G** | `DONE` (PR #39 FE) | FE | Home overhaul | Replaced hardcoded "Core Assets" with live `/api/oracle/rates` data + 24-sample in-memory sparkline (fl_chart). New `TodayWidget` with 4 stat tiles (Active Trades, Pending Withdrawals, Friend Requests, Unread Notifications), each navigating to the right destination. Removed hardcoded Platform News (no real backend endpoint yet). Pull-to-refresh now actually re-fetches via `homeSummaryProvider.refresh()` (5 endpoints in parallel) + `authProvider.fetchUserDetails()`. Animated balance counter was already in `HologramBalanceCard` via TweenAnimationBuilder — verified, no extra dep needed. ~1,365 LOC across 5 frontend files. |
| **H** | `DONE` (PR #40 FE) | FE | Premium polish pass | Custom page transitions (slide+fade, 240ms, easeOutCubic) wired globally via `ThemeData.pageTransitionsTheme`. Status bar + system nav bar styles flip with the theme via `AnnotatedRegion<SystemUiOverlayStyle>` wrapping `MaterialApp.router`. `AzamanHaptics.nav/toggle/confirm/commit/warn` vocabulary replaces ad-hoc `HapticFeedback` calls across home/settings/theme-picker/login. `SkeletonBlock` (was orphan) wired into `TodayWidget` cold-load + `LiveMarketSection` cold-load. `AzamanConfirmSheet` replaces the AlertDialog sign-out in settings. Six review-pass bugs fixed in same commit (ThemeProvider WidgetsBindingObserver refactor, SSO snackbar order, trade JSON keys, TradeStatus enum set, rate-history append moved out of build, withdrawal payload columns). ~820 LOC across ~12 files. |
| **H2** | `DONE` (PR #41 FE) | FE | Slide-to-confirm on financial actions | Wired the existing `SlideToConfirm` widget into the highest-risk financial confirms. Withdrawal screen `ElevatedButton` → `SlideToConfirm`. Savings goal sheet `_AmountPromptSheet` (fund/withdraw) same swap with parent-driven CTA color + label. Friends transfer modal verified intact. Out of scope (Phase H3): `active_trade_screen` Release-crypto button + biometric prompt before slide fires. ~130 LOC across 2 files. |
| **H3** | `DONE` (PR #42 FE) | FE | Biometric pre-gate + slide-to-confirm completion | Vendor `Release-crypto` `AlertDialog` → slide-to-confirm bottom sheet. New `AzamanBiometricGate` opt-in pre-gate wraps every existing `SlideToConfirm.onConfirmed` (vendor release, withdrawal, savings, friends transfer, buyer mark-paid). New "Biometric Lock on financial actions" toggle in Security Settings, itself biometric-gated in BOTH directions so a pickpocket with an unlocked phone can't disable the lock and drain. Three rounds of semantic review folded in. ~700 LOC across 9 production files + 2 docs. |
| **I** | `DONE` (BE PR #40) | BE | Performance + mobile payload | Cursor pagination on `/notifications`, `/chat/:tradeId`, `/friends`, `/ads`, `/trades/history` via shared `utils/pagination.js` (`parsePagination` / `buildPageEnvelope`). Ten composite indexes added: `Notification(userId, createdAt DESC)`, `Notification(userId, isRead, createdAt DESC)`, `Message(conversationId, createdAt DESC)`, `DirectMessage(friendshipId, createdAt DESC)`, `Ad(status, createdAt DESC)`, `Ad(vendorId, createdAt DESC)`, `Trade(userId, createdAt DESC)`, `Trade(vendorId, createdAt DESC)`, `Friendship(requesterId, status, updatedAt DESC)`, `Friendship(addresseeId, status, updatedAt DESC)`. `getFriends` 2N→2 query collapse via `findMany distinct: ['friendshipId']` + `groupBy` for unread counts. `id` tiebreaker added to every cursor `orderBy` to defend against same-millisecond skip/duplicate. Backwards-compat: `/ads` keeps bare-array shape and `/chat/:tradeId` keeps ASC ordering when no pagination param is passed. AI marketplace mode declared single-page (the scorer re-ranks every request, so cursor windows would be unstable). ~570 LOC across 7 files + 1 migration. |
| **J** | `DONE` (BE PR #41 + FE PR #43) | both | Schema cleanup migration | **Drops dead `ghsBalance` + `lockedBalance` columns** (both write-dead per Phase B findings C+D). Coordinated FE + BE PRs strip every read site. Vendor dashboard "in escrow" label rewired from the dead `lockedBalance` to the V2 `escrowLockedBalance` so it shows real numbers for the first time. ~150 LOC across 14 files + 1 migration. **DEFERRED** to Phase J2 (CHECK constraints) and Phase J3 (Float→Decimal). |
| **J2** | `DONE` (BE PR #45) | BE | DB-level CHECK constraints on balance/amount/rate columns | ~50 `CHECK` constraints added across 18 tables: non-negativity on every balance/amount/fee/volume column, positivity on prices/rates/limits, bounded ranges on ratios and percentages. Pure additive defense-in-depth — no application code change required. Postgres rejects any controller-bug INSERT/UPDATE that would corrupt the ledger (e.g. a regression that subtracts more than the user has). Migration validates against existing rows; if any current row is corrupt, migration fails and surfaces it. Operator runbook in `docs/PHASE_J2_CHECK_CONSTRAINTS.md` covers pre-deploy audit queries, recovery, and the soft-deploy `NOT VALID` alternative for very large tables. ~190 LOC migration + ~140 LOC runbook + changelog. |
| **J3** | `BACKLOG` | both | Float → Decimal column-type rewrite | Migrate every money column from `Float` (PostgreSQL `DOUBLE PRECISION`) to `Decimal(18,8)`. Closes the audit's §14 finding on rounding drift (`runDoubleCheck`'s `TOLERANCE = 0.000001` is essentially conceding floating-point error). Requires FE coordination because Prisma serializes `Decimal` as a string in JSON, not a number — every `double.tryParse(...)` site on the frontend already handles strings, but the change should be reviewed end-to-end. The `ALTER TABLE ... ALTER COLUMN ... TYPE` rewrite takes an `ACCESS EXCLUSIVE` lock and rewrites every row, which is heavy on big tables; deploy via maintenance window or Postgres logical-replica cutover. ~500 LOC BE + ~50 LOC FE + ops runbook. |
| **K** | `DONE` (BE PR #39) | BE | Auth + security hardening | Refresh-token flow (15-min access + 30-day refresh + `/auth/refresh` endpoint, atomic rotation, /logout). `User.tokenVersion` counter embedded in access JWT; live `protect` check rejects stale claims with `TOKEN_STALE`. Privilege-change cascade on both `approveKyc` AND `changeUserRole` (role flip + tokenVersion bump + refresh-token revoke in one `$transaction`, emits `session_refresh_required`). Password-change cascade on `securityController.changePassword`. SSO aud claim verification (production via firebase-admin SDK; dev fallback gated by `SSO_DEV_FALLBACK=1` + `SSO_EXPECTED_AUD`). `profileController.updateProfile` whitelist already correct (no code change; documented for closure). Avatars moved out of `/uploads/proofs/` into dedicated `/uploads/avatars/` with 2MB cap, AND mimetype+extension check, random-suffix filenames. Migration `20260525_phase_k_refresh_tokens` is metadata-only on Postgres ≥11. ~700 LOC across 13 files. |
| **L** | `DONE` (BE PR #42) | BE | API contract docs sweep | **Closes the "Coverage gaps" placeholder** by documenting all 9 route trees Phase B flagged: `/friends`, `/savings`, `/security`, `/users`, `/auth/sso`, `/ai`, `/kyc`, `/vendor`, `/oracle`. 64 new endpoint specs + 1 new socket cross-reference. Doc-only — no code change. ~600 LOC added to `api_contract.md`. Going-forward convention: when a route signature changes in any future PR, the contract change ships in the same PR. |
| **B2** | `DONE` (BE PR #50) | BE | Admin + notification correctness | `adminController.banUser` force-disconnects the banned user's open WebSocket connections (audit §8 P1). `notificationController.markAsRead` + `markAllAsRead` emit a `notifications_updated` socket event for cross-device unread-count sync (audit §5 P1). ~55 LOC across 2 files. |
| **B2-FE** | `DONE` (FE PR #45) | FE | Multi-device notification sync (FE half of B2) | Wires the `notifications_updated` socket event the BE half emits. New `markAllAsRead()` method on `notification_provider.dart` (optimistic + server echo). New "Mark all read" AppBar action in `notification_hub_screen.dart` (visible only when `unreadCount > 0`). RefreshIndicator wrapping every tab + `AzamanHaptics` vocabulary on tab/tap. ~160 LOC across 2 files. |
| **H4** | `DONE` (FE PR #46) | FE | Connectivity banner | `connectivity_plus: ^6.1.0` added; new `connectivityProvider` Riverpod `StreamProvider<bool>`; new `AzamanConnectivityBanner` widget (slide-down danger card on disconnect, green "Reconnected" flash on recovery, integrated with `AzamanHaptics.warn/confirm` vocabulary). Wired via `MaterialApp.router(builder:)` so it overlays every screen with no per-screen migration. Closes the H/H2 deferred line. ~220 LOC across 3 files. |
| **E1** | `DONE` (BE PR #62) | BE | AZM Earn Mechanics | Full earn pipeline. Every trade, login streak, referral, achievement, and volume milestone credits AZM with transparent audit trail. Socket `azm_reward` event, public rates endpoint, paginated history + summary. ~400 LOC across 10 files. |
| **E1-FE** | `DONE` (FE PR #50) | FE | AZM Earn UI | Rewards screen + real-time socket listener + tappable AZM chip on hologram card. ~350 LOC across 5 files. |
| **E2** | `IN REVIEW` (BE PR #63) | BE | AZM Spend Mechanics | Fee discount (3 tiers) + ad boost (3 durations). AzmSpendLog audit table, marketplace boost sorting, withdrawal fee integration, socket `azm_spend` event. ~450 LOC across 9 files. |
| **E2-FE** | `IN REVIEW` (FE) | FE | AZM Spend UI | Fee discount selector on withdrawal screen, ad-boost purchase sheet on vendor dashboard, `azm_spend` socket listener. ~400 LOC across 5 files. |
| **I3** | `DONE` (BE PR #51) | BE | Defer vendor gamification off the trade-complete request path | `vendorGamificationService.processTradeCompletion` (XP/streak/level/achievement scan, ~6 sequential Prisma writes) was inside the `prisma.$transaction` in `services/p2p.service.js completeTrade`, blocking the HTTP response by 100-200ms. Moved out of the txn entirely, scheduled via `setImmediate` from `controllers/p2p.controller.js completeTrade` so it runs AFTER the response flushes. New exported helper `processPostCompletionGamification` runs gamification + level-up notification + achievement notifications in its own `prisma.$transaction`. Existing `gamification_update` socket event keeps the FE consumer surface (none today) ready for live updates. ~140 LOC delta across 2 files. Bundled with audit-hygiene status flips. |
| **I4** | `DONE` (BE PR #52) | BE | Defer review gamification off the submitReview request path | The second of the two gamification-in-request-path callsites identified during the I3 trace. Vendor XP + achievement scan in `tradeController.js submitReview` was inside its `prisma.$transaction`. Moved out via `setImmediate` after `res.json(201)` flushes. New exported helper `vendorGamificationService.processReviewGamification` runs `awardXp` + stats re-fetch + `checkAndUnlockAchievements` + achievement-unlock `notification.createMany` in its own `prisma.$transaction`. Atomic part shrinks to `review.create` + reviewee review-count counter increment (what the FE waits on for the 201). Existing `gamification_update` socket event with `type: 'REVIEW_RECEIVED'` is emitted from the deferred block. Gated to only run when reviewee is the vendor (XP is vendor-only). ~110 LOC delta across 2 files. |
| **I5** | `DONE` (BE PR #53) | BE | Pagination on the four still-unpaginated admin list endpoints | Closes the audit's §13 P2 line "list endpoints return all rows, no pagination" for the admin tier. Four `findMany` calls in `controllers/adminController.js` migrated to the existing shared `utils/pagination.js` helpers (`parsePagination` / `buildPageEnvelope`): `getAllDisputes` (was unbounded), `getLiveTrades` (was hardcoded `take: 100` ceiling — trade #101+ was silently invisible at peak), `getPendingKyc` (was unbounded), `getPendingWithdrawals` (was unbounded on `pending`). All accept both cursor mode (`?cursor=ID&limit=N`) and offset mode (`?page=N&limit=M`); total count fetched once on page-1 only via Promise.all. Backwards-compat preserved: existing `lib/screens/admin_war_room_screen.dart` consumer keeps reading bare top-level `disputes` / `trades` / `applications` keys; cold-load with no params raises the default take to 100 so admins never see fewer rows than before. ~150 LOC delta in 1 file. |
| **L1** | `DONE` (BE PR #54) | BE | Wire emailService for transactional withdrawal receipts | Closes the audit's TL;DR §8 "three services are dead code" line — partially: the `emailService` half is now live for the withdrawal-completion surface; `smsService` and `serviceIntegrator` remain orphan and are filed for follow-up. Four hook points: fiat-success-via-worker, fiat-failure-via-worker (after `reverseFiatWithdrawal` succeeds), fiat-sync-reversal-via-controller (503 + 502 paths, `reversalSucceeded` flag-gated), crypto-success-and-refund-via-controller (`refundSucceeded` flag-gated). Fire-and-forget enforced four ways. Static re-trace covered 9 scenarios. ~250 LOC across 4 files + 1 env + 2 docs. |
| **L2** | `DONE` (BE PR #55) | BE | Wire smsService for phone OTP + large-withdrawal SMS | **Fully closes** TL;DR §8 dead-services cluster (2 of 3 now live; `serviceIntegrator` remains orphan facade). Phone OTP verification (2 new endpoints on /api/security/phone/*), large-withdrawal SMS confirmations at 7 hook points (5 controller + 2 worker), `phoneVerified` schema gate, `SMS_LARGE_WITHDRAWAL_THRESHOLD` env. Static re-trace: 13 scenarios. ~300 LOC across 9 files + 1 migration. |
| **N** | `DONE` (BE PR #56) | BE | Notification consistency: migrate raw creates to notificationService pipeline | **Closes** §5 P0 "notifications are inconsistently persisted" for all high-traffic user-facing paths. 21 raw `prisma.notification.create` / `tx.notification.create` sites migrated to `notificationService.sendNotification()` (DB + socket + FCM). Transaction-internal sites use post-commit `setImmediate`. Fixes the "vendor bell is empty after app reopen" bug on `initiateTrade`. 8 low-traffic admin/worker/gamification sites deferred to Phase N2. ~350 LOC across 8 files. |
| **N2** | `DONE` (BE PR #57) | BE | Notification consistency: migrate ALL remaining raw creates | **Fully closes** §5 P0. Zero raw notification sites remain. 11 call sites across 10 files migrated to `notificationService.sendNotification()` (admin chat, queue, security, withdrawal, gamification, CFO worker, savings worker, milestones, trade socket, vendor gamification). ~200 LOC across 10 files. |
| **M** | `DONE` (FE PR #44) | FE | Wiring + orphan sweep | **Closed audit §13 orphan inventory.** GoRouter from 4 → 13 routes (every FCM-deep-linkable surface now named); 5 orphan screens wired (`ProfileDetailsScreen`, `ReferralScreen`, `AccountDeactivationScreen` into settings; `MessagesHubScreen`, `LeaderboardScreen` reachable via `/messages` + `/leaderboard` deep-links); 11 confirmed-dead orphans deleted. `handleNotificationTap` action vocabulary expanded to handle the full BE-emitted set. ~280 LOC across 4 changes + 11 deletions. **Out of scope (deferred):** promoting all 67 imperative `Navigator.push` callsites; wiring leaderboard/messages-hub into existing UI surfaces; removing AppBar chat icon. |

### Suggested merge order

**Updated 2026-05-25 (post-Phase-N merged as PR #56, Phase N2 merged as PR #57, Phase D-2 in review).**
Phases C, E, F, G, H, H2, H3, H4, I, I2, I3, I4, I5, J, J2, K, L, L1, L2, B2, B2-FE, D-1, D, M, N, N2 are `DONE`.
Phase D-2 is `IN REVIEW (BE PR — eliminate azmBalance, settle in
availableBalance, fully closes audit finding B + BUY-ad mint bug)`.
Phase E2 is `IN REVIEW (BE PR #63 — AZM spend mechanics)`.
Phase E2-FE is `IN REVIEW (FE — AZM spend UI, companion to E2)`.
Remaining open work is **Phase J3** (Float→Decimal column-type rewrite,
requires a maintenance window).

The original sequence was **C → D → E → F → G → H → K → I → J → L/M**.
What actually happened was the more aggressive sequence
**C → E → F → G → H → H2 → (D, K, I, J, L) → (D-1, J2, B2, I2, H3, H4, I3)** —
the user-visible "premium feel" wave shipped first, ahead of the AZM
ledger redesign and the destructive-schema cleanup.

The reasoning for the remaining order:
- D-2 resolves the AZM trap so money correctness is fully sound (BE only),
  but is gated on the design-doc questions.
- J3 (Float→Decimal) needs a maintenance window because column-type
  rewrites take an `ACCESS EXCLUSIVE` lock.
- M is FE infrastructure (router promotion + orphan cleanup) — shipped as FE PR #44.

A near-term "Phase H3" follow-up was scoped on the FE during Phase H2:
slide-to-confirm on `active_trade_screen` complete-trade button +
biometric prompt before slide-to-confirm fires. **Shipped FE PR #42,
merged 2026-05-25.** Tracked in FRONTEND_AUDIT.md, no BE work.

### What is explicitly NOT on this roadmap (yet)

- A web build. The `web/` folder exists but no one has tested it. Will need its own discovery phase.
- Multi-currency beyond GHS/USDC. The hologram model assumes a single local fiat. Adding a second region (e.g., NGN for Nigeria) is a separate platform-level project.
- A native admin app. Admin lives inside the same Flutter codebase today.
- Internationalization (i18n). All copy is hardcoded English.

---

## TL;DR — what's actually wrong

1. **Two competing ledger systems.** The codebase has both an `availableBalance`
   single-balance model and a multi-balance model (`vendorUnallocatedBalance`,
   `escrowLockedBalance`, `disputeEscrowBalance`, `azmBalance`, `ghsBalance`,
   `lockedBalance`). Different controllers read and write to different fields.
   This is the root cause of "the deposit went through but the balance didn't
   update" / "the withdrawal showed but the balance didn't drop." Detail in §3.

2. **Withdrawals are silently disconnected from MTN MoMo.** `withdrawalController.processWithdrawal`
   debits the user's balance and creates a `WithdrawalRequest` row, but it never
   actually calls `mtnDisbursementService` to send the money. The user sees
   "withdrawal initiated" forever and admins have to manually push it. Detail in §3.

3. **Deposits via Kotani Pay webhook only credit `availableBalance`** but the
   peer-transfer controller, the savings controller, and the trade engine all
   read from a mix of `azmBalance`/`ghsBalance`/`lockedBalance`. So a fresh
   deposit can't be used to fund a savings goal or an internal transfer in
   GHS. Detail in §3.

4. **Internal transfer (peer transfer) has no idempotency key.** A flaky network
   that retries a `POST /api/finance/transfer` will charge the sender twice.
   Detail in §4.

5. **Notifications are double-written.** Both `notificationService.create()` and
   raw `prisma.notification.create({...})` calls exist across controllers. The
   "persistent notification" you mentioned not working — I traced it: the
   socket emits fine, but only ~60% of notification call sites also write to
   the DB, so when the user reopens the app the bell looks empty. Detail in §5.
   **(Resolved 2026-05-25 by Phase N — 21 high-traffic raw
   `prisma.notification.create` sites migrated to `notificationService.sendNotification()`
   which handles DB persist + socket emit + FCM push in one pipeline. The
   "bell is empty" bug is fixed for all user-facing trade, deposit, transfer,
   savings, and admin-action paths. 8 low-traffic admin/worker/gamification
   sites remain on raw creates — filed as Phase N2.)**

6. **Chat — three parallel chat systems exist.** `chatController` (trade chat),
   `directMessageController` (1:1 user DMs), `adminChatController` (user↔support).
   `directMessageController` is fully written but **its routes are never
   registered in `server.js`** — it's an orphan controller. The frontend
   probably tries to hit `/api/messages/...` and gets 404s. Detail in §5.

7. **Nine controllers exist that have no route or are partially wired:**
   - `imageController.js` — orphan (requires `models/Message` which doesn't exist; would crash on import)
   - `directMessageController.js` — no route file
   - 7 others have routes but rely on schema fields the migrations didn't create
   - Detail in §10.

8. **Three services are dead code:** `serviceIntegrator.js`, `emailService.js`,
   `smsService.js`. They're sophisticated (retries, queues, fallbacks) but
   nothing in the running app imports them — only `test_services.js` does.
   Either wire them in (recommended for transactional emails / SMS OTP) or
   delete them. Detail in §11.
   **(Partially resolved 2026-05-25 by Phase L1 — `emailService` is now
   wired for transactional withdrawal receipts on the fiat + crypto
   success/failure surface. `smsService` and `serviceIntegrator` remain
   orphan and are filed for a follow-up pass.)**
   **(Fully resolved 2026-05-25 by Phase L2 — `smsService` is now wired
   for phone OTP verification + large-withdrawal SMS confirmations.
   Combined with L1: 2 of 3 dead services are live. `serviceIntegrator`
   remains orphan but is merely a facade over the now-live email + SMS
   services — no new capability if wired; can be safely deleted.)**

9. **`service-account.json` is committed to the repo** and contains Firebase
   admin credentials. P0 security issue regardless of anything else.
   Detail in §12.

10. **Mobile-relevant payload issues:** several list endpoints return all rows
    with no pagination (`/api/notifications`, `/api/chat/...`, `/api/friends/list`).
    On a phone over slow data, this is the difference between an instant app and
    one that hangs for 8 seconds on cold start. Detail in §13.

---

## §1 — Wiring map (what's actually live)

The server registers 23 route files. All 23 exist on disk. Of the 31
controller files, **27 are reachable** through one of those route files.
The 4 unreachable controllers:

| Controller                       | Status                                        |
|----------------------------------|-----------------------------------------------|
| `imageController.js`             | Orphan — never required, would crash if it was |
| `directMessageController.js`     | Orphan — fully written, no route file         |
| `userPreferencesController.js`   | Reachable via `userRoutes.js`, but two of its endpoints reference fields not in the schema (see §7) |
| `milestoneController.js`         | Reachable via `userRoutes.js`, but it duplicates logic in `milestoneMiddleware.js` and they disagree (see §9) |

So strictly speaking there are **2 fully orphan controllers** and **2 half-wired** ones.

Routes registered in `server.js`:

```
auth          financial    general       webhook
─────         ─────────    ───────       ───────
authRoutes    tradeRoutes  adRoutes      depositRoutes
              walletRoutes chatRoutes
              withdrawal   adminRoutes
              financeRoutes kycRoutes
              p2pRoutes    notificationRoutes
                           tradeAccountRoutes
                           payoutDestinationRoutes
                           adminChatRoutes
                           securityRoutes
                           userRoutes
                           warRoomRoutes
                           aiRoutes
                           friendRoutes
                           vendorStatsRoutes
                           savingsRoutes
                           oracleRoutes
```

Rate-limit tier assignment **looks correct** — financial endpoints get the
strict limiter, auth gets its own, the rest get a generic limiter. One nit:
`oracleRoutes` is on the generic limiter but it's mostly read-only price
queries; this is fine but worth noting if rate-limit complaints come up.

---

## §2 — Auth, KYC, security

### Findings

**P0 — `authController.login` does not return user role correctly for vendors who upgraded.**
Line ~140 hard-codes `role: user.isVendor ? 'VENDOR' : 'USER'` into the JWT. But
`isVendor` is set in two places (signup form + admin-approved KYC upgrade) and
the second path doesn't issue a fresh token, so a user who becomes a vendor
mid-session keeps their old `'USER'` JWT until they log out. The frontend
trade provider then reads `currentRole` and decides what to show — including
the vendor pull tab gate you mentioned. *This is one of the reasons you
weren't seeing vendor-only UI even when you should have.*

**P0 — JWT expiry is 7 days with no refresh token flow.** Line ~152 of `authController.js`
uses `expiresIn: '7d'`. There is no refresh-token endpoint, so on day 8 the
user is silently logged out mid-action. Mobile users will hate this. Standard
fix is a 15-minute access token + 30-day refresh token + `/api/auth/refresh` endpoint.

**P1 — `ssoController` (Google + Apple sign-in) only verifies the ID token's
signature against Google's certs. It does not verify `aud` (audience).** If
someone steals a Google ID token issued for a different client ID, the login
succeeds. One-line fix.

**P1 — KYC submission accepts any string for `idType`.** No enum check. The
schema defines `IdType` as `('GHANA_CARD', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_ID')` —
the controller doesn't validate against it, so the frontend can send `"foo"`
and Prisma will reject with a 500. Should 400 with a clear error.

**P1 — `securityController.changePassword` doesn't invalidate other sessions.**
A leaked JWT remains valid for its full 7 days even after the password is
changed. Combined with no refresh-token rotation, this is a real risk.

**P2 — `banGuardMiddleware.protectActive` queries the user table on every request.**
On a hot path (chat sends, balance queries), this is a DB round-trip per
request. A 30-second in-memory cache of `user.status` per userId would cut
this significantly without changing semantics for ban detection.

**P2 — `securityLogController` only writes; no read endpoint.** Admin can't
see security events without going to the DB directly. Schema has the data,
the read endpoint just doesn't exist.

### Already-correct bits (don't break these)

- Helmet-equivalent headers in server.js
- Socket.IO JWT auth middleware (CRITICAL-4 fix)
- `vendor_accept` socket authorization check (CRITICAL-5 fix)
- `mark_messages_read` no longer references non-existent fields (HIGH-5 fix)
- Multer file-type + 5MB size validation
- `JWT_SECRET` and `DATABASE_URL` startup validation

---

## §3 — Money flow: deposits, withdrawals, balances

This is the section you care about most. I traced one USDC end-to-end through
every entry point.

### The core problem: two ledger models exist simultaneously

The Prisma schema defines a User with all of these balance columns:

```
availableBalance        Float  @default(0)   // single-balance USDC view
vendorUnallocatedBalance Float @default(0)
escrowLockedBalance     Float  @default(0)
disputeEscrowBalance    Float  @default(0)
azmBalance              Float  @default(0)   // AZM token (multi-balance view)
ghsBalance              Float  @default(0)   // local fiat
lockedBalance           Float  @default(0)
```

Different controllers reach into different fields:

| Controller                       | Reads                       | Writes                                  |
|----------------------------------|-----------------------------|-----------------------------------------|
| `depositController` (Kotani webhook) | —                       | `availableBalance` += amount             |
| `depositController` (crypto webhook) | —                       | `availableBalance` += amount             |
| `withdrawalController.processWithdrawal` | `availableBalance`     | `availableBalance` -= amount             |
| `walletController.getBalance`    | All seven                   | —                                        |
| `peerTransferController.transferUSDC` | `availableBalance`    | `availableBalance` -= / += amount        |
| `peerTransferController.transferGHS`  | `ghsBalance`          | `ghsBalance` -= / += amount              |
| `savingsController.fundGoal`     | `availableBalance` and `ghsBalance` (currency-dependent) | `lockedBalance` += amount, `availableBalance` -= amount |
| `tradeController` / `tradeWorker` | `escrowLockedBalance`      | escrow movements                         |
| `finance.controller`             | `vendorUnallocatedBalance` (vendor cash-out) | various |

**What this means in practice:**

- A user deposits 100 GHS via MTN MoMo → Kotani webhook fires → backend
  converts to USDC at oracle rate → credits `availableBalance` only.
- The user opens "Internal Transfer (GHS)" → frontend calls
  `peerTransferController.transferGHS` → it reads `ghsBalance` which is **still 0**.
  Transfer fails with "insufficient balance."
- The user is staring at a 100 GHS balance on the home screen (which reads
  the converted USDC display) but the GHS-rail transfer can't see it.

**Same story for savings, partially for P2P, and for vendor cashouts.**

### Findings

**P0 — Deposit webhook (`depositController.handleKotaniWebhook`) does not credit the right balance bucket.**
Around line 280, after HMAC verification and idempotency-key check, the code does:

```js
await prisma.user.update({
  where: { id: userId },
  data: { availableBalance: { increment: usdcAmount } }
});
```

It should also (or instead) credit `ghsBalance` for GHS deposits, so downstream
GHS-rail features can see them. Recommend a single source of truth: every
deposit credits a single balance bucket per currency, and the home screen
sums them at display time.

**P0 — `withdrawalController.processWithdrawal` debits the user but never calls the disbursement service.**
The full chain that should happen:
1. Validate user has sufficient balance ✓
2. Create a `WithdrawalRequest` row with status=PENDING ✓
3. Decrement `availableBalance` ✓
4. **Call `mtnDisbursementService.transfer(...)` to actually send money** ✗ (missing)
5. Update WithdrawalRequest status based on result ✗ (depends on step 4)
6. Emit notification + balance socket event ⚠️ (notification yes, balance event missing)

Step 4 is just not there. The function returns success after step 3 and
trusts that *someone, somewhere* will pick up the PENDING row and process
it. Nobody does — there is no worker that polls `WithdrawalRequest` with
status=PENDING. The admin panel has a "process withdrawal" button which
does call the disbursement service, but a normal user-initiated withdrawal
sits in PENDING forever waiting on manual admin action. **This is exactly
what you described as "withdrawal not working."**

**P0 — No idempotency key on `peerTransferController.transferUSDC` / `.transferGHS`.**
Lines ~240 and ~410. The frontend POSTs `{recipientUsername, amount, note}`.
A flaky 4G connection that retries the request will produce two debits.
Schema already has a `clientRequestId` field on `Transfer` — the controller
just doesn't check it. Standard idempotency: client sends a UUID per attempt;
server ignores duplicates within a 24h window. ~10 lines of code.

**P0 — `peerTransferController.transferUSDC` does not write a TransactionHistory row for the recipient.**
Line ~290. It updates both balances correctly, but only inserts a `TransactionHistory`
row for the sender (type=`TRANSFER_OUT`). The recipient's `availableBalance`
goes up but their transaction history is silent. Two consequences:
- The recipient sees their balance jump but doesn't know why.
- `runDoubleCheck(prisma, recipientId)` fails — because the ledger says
  "balance moved without a corresponding transaction." If anyone calls
  the double-check on the recipient after a transfer, the whole transaction
  rolls back. (See §3.5 below — double-check is wired in some places, not others.)

**P1 — `runDoubleCheck` is called inconsistently.**
- `withdrawalController.processWithdrawal` calls it ✓
- `peerTransferController.transferUSDC` calls it for sender, **not for recipient** ✗
- `depositController.handleKotaniWebhook` does **not** call it ✗
- `savingsController.fundGoal` does **not** call it ✗
- `tradeController.markPaid` calls it ✓
- The trade worker's auto-cancel path calls it ✓

Best practice: every function that mutates `availableBalance` should call
`runDoubleCheck` inside the same `prisma.$transaction`. Otherwise the
ledger gets out of sync silently and you only find out weeks later.

**P1 — `tatumService` and `mtnDisbursementService` are instantiated but never reconciled.**
Both services are created in `server.js` and bound to the app context, but
neither has a "scan for stuck transactions" routine. If MTN times out and the
final webhook gets lost, the WithdrawalRequest stays PENDING forever. A simple
periodic worker (every 60s, scan PENDING requests older than 5 minutes,
query MTN for status) would close this.

**P1 — `gatewayService.startRateSync()` runs every 5 minutes and stores the rate
in memory only.** If the server restarts during a deposit, the rate snapshot
used for conversion is lost. Recommend writing each rate sync to a
`MarketRate` table (schema already has it from the `oracleService` migration)
so deposits can attach the rate ID they used and admins can audit conversions.

**P1 — `oracleService` and `gatewayService` overlap.** Both fetch USDC/GHS rates,
from different sources, on different intervals, into different in-memory caches.
They should be merged into one canonical price source with a single update path.

**P2 — `walletController.getBalance` returns 7 separate balance fields and the
frontend has to know how to sum them.** Mobile-friendlier: return the seven raw
fields **and** a computed `displayBalance` (the USDC-equivalent of all
liquidity the user can actually spend). Saves duplicate logic on every
device.

**P2 — `withdrawalController` has no daily limit check.** Admin can configure
a daily withdrawal cap per user, but the controller never reads it.

**P2 — Deposit reference codes (the string the user puts in the MoMo memo) are
generated as `AZ${userId}${randomDigits}` in `depositController.createIntent`.
Predictable user IDs make this guessable. Switch to a UUID slice or HMAC.

### Already-correct bits

- HMAC verification on Kotani webhook (`req.rawBody` capture in server.js
  is set up correctly for this — verified the chain).
- Idempotency on the deposit side (Kotani webhook checks `processedReference`
  on the deposit row before crediting).
- Withdrawal request creation is wrapped in a `prisma.$transaction`.
- Currency conversion uses the snapshot rate, not the live rate, to prevent
  arbitrage (just needs to be persisted — see P1 above).

---

## §4 — Trading: P2P, trade accounts, escrow

The trading system is the most complete part of the codebase. End-to-end I
walked: marketplace browse → ad selection → trade creation → vendor accept →
payment proof upload → vendor confirm → asset release → leaderboard update.

### Findings

**P0 — `tradeController.createTrade` locks vendor's `vendorUnallocatedBalance`
without verifying the vendor still has it.**
Lines ~150–180. There's a check `if (vendor.vendorUnallocatedBalance >= amount)`
but it's outside the `prisma.$transaction`, so two concurrent trades against
the same vendor with insufficient combined liquidity can both pass the check
and both lock the same balance. Move the check inside the transaction with
`SELECT ... FOR UPDATE` (or use Prisma's `update with where: { vendorUnallocatedBalance: { gte: amount } }` pattern,
which atomically fails if the condition isn't met).

**P0 — `p2p.controller.completeTrade` releases asset to buyer without verifying
that the trade was previously marked PAID.**
Line ~310 reads:

```js
if (trade.status !== 'PENDING_PAYMENT' && trade.status !== 'PAID') { ... }
```

The OR is too permissive. Vendor calling complete on a `PENDING_PAYMENT` trade
(without buyer ever marking paid) releases the asset for free. Should require
`status === 'PAID'`.

**P1 — Trade auto-cancel timer in `tradeWorker` is hardcoded to 30 minutes.**
Schema has `Settings.tradeCancelMinutes` (default 30). Worker should read
from settings, not constant. Admin already has a UI for this; it just isn't
wired through.

**P1 — `tradeAccountController` has `addTradeAccount` and `listTradeAccounts`
but no delete/edit endpoints.** Frontend trade-account screen probably has
delete buttons that don't do anything. Schema supports the operation; just
not exposed.

**P1 — `marginCalculatorService.calcMargin` is called only from `p2p.service`,
not from `tradeController.createTrade`.** So margin computation runs for the
P2P "ping" flow but not for the standard trade flow. The two flows compute
vendor profit differently as a result. Standardize on `marginCalculatorService`.

**P2 — `chatTransferController` (the "transfer money inside a chat thread"
feature) is fully wired, but doesn't emit a balance update event over socket
to the recipient.** Recipient sees the chat message announcing the transfer
but their balance doesn't refresh until they pull-to-refresh. Add an
`io.to('balance_room_${recipientId}').emit('balance_update', ...)` call.

---

## §5 — Notifications & chat

### Notifications

**P0 — Notifications are inconsistently persisted.** `notificationService.create()`
both writes to DB and emits socket. But many controllers skip the service and
do raw `socket.emit('new_notification', {...})` without a DB write. Affected
call sites I counted:

- `peerTransferController` — emits but does not persist (recipient won't see
  it on app reopen)
- `tradeController.createTrade` — same
- `friendController.acceptRequest` — same
- `savingsController.fundGoal` — same
- Socket handler `vendor_accept` in `server.js` — same

**This is exactly your "persistent notifications" complaint.** Centralize on
`notificationService.create()` everywhere.

**P1 — `notificationController.markAllRead` updates rows in batch but doesn't
emit a socket event, so other open sessions of the same user (web + phone)
keep showing the badge.**

**P1 — No notification grouping.** A vendor receiving 20 trade pings in 5
minutes gets 20 separate push notifications. Schema supports a `groupKey`
field; nothing reads or writes it.

**P2 — Push notifications go through Firebase only.** No fallback for users
who haven't granted notification permission (which is most users, on iOS).
Could store an in-app "missed events" digest server-side and surface it on
next open.

### Chat

**P0 — `directMessageController.js` has no route file.**
Endpoints implemented:
- `POST /messages/send`
- `GET  /messages/conversations`
- `GET  /messages/:userId`
- `POST /messages/:userId/typing`
- `POST /messages/:messageId/read`

Frontend that hits these gets 404. Add `routes/directMessageRoutes.js` and
wire it in `server.js`.

**P1 — `chatController` (trade chat) and `chatSocketService` partially overlap.**
`chatController.sendMessage` writes to DB and emits over socket. The socket
handler `send_chat_message` in `chatSocketService` also writes to DB. If a
client uses both paths, the message gets duplicated. Pick one path (recommend
socket-only) and remove the HTTP variant, OR have HTTP delegate to socket.

**P1 — Admin chat (`adminChatController`) has no read receipts.** Schema's
`Message.readAt` field is set in user-to-user chat, never in user-to-admin.
Support tickets show "unread" forever from the admin's perspective.

**P1 — Chat media upload route in `server.js` (`POST /api/chat/upload-media`)
is reachable without rate limiting** because it's defined after the route
group registrations. Should be in the `generalLimiter` group.

**P2 — Chat history is unpaginated.** A trade with 500 messages will return
500 messages on every open. Add cursor pagination.

---

## §6 — Friends, profile, savings, preferences

### Friends

**P1 — `friendController.sendRequest` doesn't check if the target user has
blocked the sender.** Schema has `BlockedUser`; controller ignores it.

**P1 — `friendController.listFriends` returns the full user object for each
friend** (including phone, email). Should return a public-friendly subset.
Privacy + payload-size win.

**P2 — Friend requests have no expiry.** Stale requests pile up forever.

### Profile

**P1 — `profileController.uploadAvatar` writes the file path as `/uploads/proofs/...`**
(the KYC proofs directory!). Avatars and KYC docs share a folder, so a public
endpoint serving avatars would expose KYC files if listing is ever turned
on. Move avatars to `/uploads/avatars/`.

**P1 — `profileController.updateProfile` accepts arbitrary fields and passes
them straight to `prisma.user.update`.** A malicious client can set
`isVendor: true` or `availableBalance: 999999` from a normal profile-edit
request. Whitelist the editable fields.

### Savings

**P0 — `savingsController.fundGoal` decrements `availableBalance` and increments
`lockedBalance`** but doesn't write the corresponding TransactionHistory pair
(`SAVINGS_LOCK_OUT` / `SAVINGS_LOCK_IN`). Ledger drifts. `runDoubleCheck`
will fail.

**P1 — `savingsWorker` runs daily and applies interest accrual, but the
interest rate is hardcoded.** Should read from `Settings.savingsApr`.

**P2 — Goal completion doesn't fire a notification.** Worker should emit a
`SAVINGS_GOAL_COMPLETE` notification.

### Preferences

**P1 — `userPreferencesController.updatePreferences` writes to a `selectedTheme`
field that exists in the schema** (added by migration `20260523_user_preferences_vendor_enhancements`)
**but the controller's whitelist also accepts `notificationCategoryPrefs` and
`vendorAvailability` which aren't in the schema.** Those updates fail
silently with the way the code is written (`{ ...validatedFields }` — Prisma
just ignores unknown keys without erroring). Either add the columns or
remove from the controller.

---

## §7 — Ads, vendor stats, gamification

**P1 — `adController.createAd` doesn't emit to a marketplace room.**
The marketplace screen on the frontend listens for `ad_created` socket events
to push new ads into the list live. Backend never emits. So the marketplace
feels stale until the user pulls to refresh.

**P1 — `adInteractionController.trackImpression` writes to DB on every render.**
On a marketplace with 50 ads visible, this is 50 writes per scroll. Should
batch (debounce on backend, or aggregate every 10s).

**P2 — `vendorStatsController.getStats` runs 6 sequential queries.** Should
parallelize with `Promise.all`. ~300ms saved on cold load.

**P2 — `vendorGamificationService.evaluateBadges` runs synchronously inside
trade completion.** Adds 100–200ms to every trade complete request. Move
to `analyticsWorker` background processing.

---

## §8 — Admin tools, war room, AI

**P1 — `adminController.banUser` flips `user.status = 'BANNED'` but doesn't
disconnect their existing sockets.** Banned user can keep using the app via
their open WebSocket until they refresh. Should `io.to(\`user_${id}\`).disconnectSockets()`.

**P1 — `adminController.adjustBalance` (manual ledger adjustment) does not
write a TransactionHistory row.** Same ledger-drift issue. Even admin actions
need an audit trail.

**P1 — `warRoomController` is dashboard-only, no realtime.** It returns
snapshots; an admin watching it has to manually refresh. Wire up via the
`admin_spy_room` socket channel which already exists.

**P2 — `aiController` is a single endpoint that proxies to `llmProvider.js`.**
There's no rate limit beyond the generic one — could get expensive. Add
per-user daily AI request budget.

**P2 — `cfoWorker` runs every hour and emits to admin only.** The data it
computes (PnL, runway, etc.) could power a user-facing "platform health"
indicator at minimal extra cost.

---

## §9 — Middleware

**P1 — `milestoneMiddleware` and `milestoneController` partially duplicate
logic.** Middleware checks if a user has crossed a milestone threshold on
each request; controller does the same on a manual `GET /milestones/check`.
They evaluate slightly differently (middleware uses cached `user.milestoneLevel`,
controller recomputes from scratch). They drift. Pick one as canonical;
the other delegates.

**P1 — `adminMiddleware.js` exists but is not used anywhere.** Admin routes
use inline `if (req.user.role !== 'ADMIN')` checks instead. Either delete
the middleware or apply it consistently.

**P2 — `rateLimitMiddleware` uses in-memory store.** Multi-instance deploys
will have inconsistent limits. Switch to Redis-backed or accept the limitation
and document it.

---

## §10 — Orphan and half-wired controllers (consolidated)

| File                             | Status     | Suggested action                                                           |
|----------------------------------|------------|----------------------------------------------------------------------------|
| `imageController.js`             | Orphan + broken | Delete (would crash if required; references `models/Message` which doesn't exist) |
| `directMessageController.js`     | Orphan     | Add `routes/directMessageRoutes.js` and register in `server.js`             |
| `models/Ad.js`                   | Orphan     | Delete (Mongoose-style; project is Prisma. Confusing leftover.)            |
| `models/` directory              | Orphan     | Delete after the above (only file)                                         |
| `userPreferencesController.js`   | Half-wired | Trim to fields actually in schema, OR add the missing columns              |
| `milestoneController.js`         | Duplicates middleware | Make controller delegate to middleware's logic                  |
| `adminMiddleware.js`             | Unused     | Delete OR apply across admin routes                                        |

---

## §11 — Dead service code

**Status update (2026-05-25, Phase L2 in review):** The dead-services
cluster is now **fully resolved**:
- `emailService.js` — **LIVE** since Phase L1 (BE PR #54). Wired for
  transactional withdrawal receipts (4 kinds, 6 hook points).
- `smsService.js` — **LIVE** since Phase L2 (in review). Wired for
  phone OTP verification (2 endpoints) + large-withdrawal SMS
  confirmations (5 kinds, 7 hook points).
- `serviceIntegrator.js` — **remains orphan facade.** It instantiates
  `new SMSService()` + `new EmailService()` internally but adds no
  functionality beyond what direct singleton access provides. The
  running app now uses the singletons from `server.js` directly
  (matching the `mtnDisbursementService` / `notificationService`
  pattern). `serviceIntegrator` can be safely deleted or kept as a
  test convenience — it introduces no dead-code risk.

**`serviceIntegrator.js`, `emailService.js`, `smsService.js`** are a
sophisticated three-file cluster that nothing in production uses. They're
only required by `test_services.js`.

`emailService.js` has retry, queueing, template rendering. `smsService.js`
has the same for SMS via Twilio. `serviceIntegrator.js` orchestrates both
behind a single facade with health checks and circuit breakers.

**Decision needed:** wire them in (recommended — KYC OTP via SMS, password
reset email, withdrawal confirmation email all currently go nowhere) or
delete. **My recommendation:** wire them in for KYC OTP and password reset
in the same fix PR. Email/SMS templates already exist; they're not used.

---

## §12 — Security: committed secrets

`service-account.json` is committed to the repo and is a Firebase Admin SDK
service-account key. Even if the key in this file is dev-only, it should
not be in git history.

**Action:**
1. Rotate the key in Firebase console.
2. Add `service-account.json` to `.gitignore`.
3. Remove from git history (`git filter-repo` or BFG).
4. Switch loader (`utils/firebaseService.js`) to read from
   `FIREBASE_SERVICE_ACCOUNT_JSON` env var (already supported as fallback;
   make it the only path).

Also: `.env.example` is fine (placeholder values). Verify `.env` is in
`.gitignore` — `git ls-files | grep .env` should return only `.env.example`.

---

## §13 — Mobile-payload findings

The user is on a phone, possibly on slow data. List-returning endpoints with
no pagination and large per-row payloads are the worst offenders for "the app
hangs on cold start":

| Endpoint                              | Current        | Recommended                              |
|---------------------------------------|----------------|------------------------------------------|
| `GET /api/notifications`              | All rows       | Cursor pagination (50/page)              |
| `GET /api/chat/:tradeId`              | All messages   | Cursor pagination (50/page, newest first)|
| `GET /api/messages/:userId` (DM)      | All messages   | Cursor pagination                        |
| `GET /api/friends/list`               | All + full user | Subset fields, paginated                 |
| `GET /api/ads`                        | All active     | Cursor + filter                          |
| `GET /api/savings/goals`              | All            | Single user, fine for now                |
| `GET /api/trades/history`             | All            | Cursor pagination                        |

Per-row payload trims (low priority but easy):
- Avatar URLs are absolute on some endpoints, relative on others. Pick one (relative).
- Timestamps come back as both Unix epoch and ISO strings depending on
  endpoint. Standardize on ISO.
- `User` shape returned with friend list and chat list is the full user
  record including phone/email. Use a `PublicUser` shape.

---

## §14 — Schema-level observations

Read the full Prisma schema. Two notable issues:

**P1 — `Float` for money.** `availableBalance`, `azmBalance`, etc. are all
`Float`. Floating-point arithmetic on currency causes rounding drift over
time (the `runDoubleCheck` `TOLERANCE = 0.000001` is essentially conceding
this). Should be `Decimal` with explicit precision. Migration is invasive
but mechanical.

**P1 — No DB-level constraints on balances being non-negative.** Every controller
checks before subtracting; if any controller misses the check, you get a
negative balance with no DB-level safety net. Add `CHECK (availableBalance >= 0)`
constraints.

**P2 — No composite indexes.** A few queries do `WHERE userId = ? AND status = ? ORDER BY createdAt DESC`
(e.g. notifications, transaction history). Index `(userId, status, createdAt DESC)`
gives a meaningful speedup on a phone where every ms of API latency shows.

---

## §15 — Test artifacts in repo

`test_auth.js`, `test_services.js`, `test_client.html` are at repo root.
They look like development scratch — not part of any test framework. Either
move to `scripts/` (and rename to clarify they're manual smoke tests) or
delete.

`seed.js` (root, JS) and `prisma/seed.ts` are two seed files. The
`prisma.config.ts` references the `.ts` one. The root `seed.js` is dead.
Delete it.

---

## §16 — Suggested fix plan (ordered)

If you give the green light, here's the order I'd batch the fixes into a
single backend PR. Each phase is one or more commits in the PR. The order
matters because later phases depend on earlier ones.

**Phase A — Money correctness (P0, must land first)**
1. Unify the deposit balance bucket — every deposit credits `availableBalance` AND the per-currency bucket (`ghsBalance`, `azmBalance`).
2. Wire `withdrawalController.processWithdrawal` to actually call `mtnDisbursementService` and create a follow-up worker for stuck PENDING requests.
3. Add idempotency-key check on peer transfers (USDC + GHS).
4. Add TransactionHistory write for transfer recipient.
5. Add `runDoubleCheck` call to deposit, savings fund, savings withdraw, recipient side of transfers.
6. Fix `p2p.controller.completeTrade` status check (require `PAID`, not `PAID || PENDING_PAYMENT`).
7. Fix `tradeController.createTrade` race on vendor balance lock.

**Phase B — Notification correctness (P0)**
8. Centralize all notification emits through `notificationService.create()`.
9. Persist notifications for: peer transfers, trade creation, friend accepts, savings funding, vendor_accept socket event.
10. Emit balance update on the recipient side of `chatTransferController`.

**Phase C — Auth + security (P0/P1)**
11. Fix vendor JWT staleness (re-issue token on `isVendor` flip).
12. Add refresh-token endpoint + 15-min access token.
13. SSO: verify `aud` claim.
14. Whitelist `profileController.updateProfile` editable fields.
15. Move avatars out of `/uploads/proofs/`.
16. Rotate + remove `service-account.json` from git.

**Phase D — Wiring + cleanup (P1)**
17. Add `directMessageRoutes.js` + register it.
18. Delete `imageController.js`, `models/Ad.js`, `models/` dir.
19. Decide on dead-services cluster: wire in `emailService` + `smsService` for KYC OTP / password reset, delete `serviceIntegrator` if not used.
20. Delete or relocate `seed.js`, `test_auth.js`, `test_services.js`, `test_client.html`.

**Phase E — Performance + mobile (P2)**
21. Cursor pagination on the list endpoints in §13.
22. Composite indexes (§14).
23. Trim `friend.list`, `chat.list` payloads to public user shape.
24. Standardize ISO timestamps everywhere.
25. Parallelize `vendorStatsController.getStats`.
26. Move `vendorGamificationService.evaluateBadges` off the trade-complete request path.

**Phase F — Ledger upgrade (separate follow-up PR)**
27. `Float` → `Decimal` on all money columns.
28. DB CHECK constraints for non-negative balances.

Phases A–E are achievable in one PR (~1500 lines diff). Phase F should be
its own PR because it requires a careful migration and matching frontend
number-handling changes.

---

## §17 — What I am NOT doing in this audit

To keep this scoped:
- I have not run the test scripts (`test_auth.js`, `test_services.js`).
- I have not run database migrations against a fresh DB to verify they apply cleanly in order.
- I have not opened the frontend yet — that's Phase 3 of the user's plan.
- I have not verified each external API (Tatum, Kotani, MTN MoMo, Firebase) responds in this environment.
- I have not load-tested anything.

If you want any of the above before I fix, say so and I'll do that next.

---

*Audit complete. Awaiting your go-ahead on the fix plan in §16.*
