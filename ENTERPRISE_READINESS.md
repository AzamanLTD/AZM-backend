# AZM Business Portal — Enterprise Production-Readiness Checklist

This is a living document. Items marked ✅ are implemented; items marked 🔲 are
remaining work. Treat this as an ongoing standing checklist, not a one-time pass.

## Reliability & Observability

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Request ID logging | `middleware/requestId.js` — assigns `req.id` + `X-Request-Id` header on every request |
| ✅ | Structured logging | Pino with request ID, business ID, user ID on every log line |
| ✅ | Health endpoint | `/health` returns DB + Redis status |
| ✅ | Centralized error tracking | `instrument.js` initializes `@sentry/node` when `SENTRY_DSN` is set; `src/middleware/errorHandler.js` mounts Sentry's Express error handler in production |
| 🔲 | Uptime/health monitoring | External ping monitor on `/health` with alerting |
| 🔲 | Public status page | Simple page for businesses to check during incidents |

## Security

| Status | Item | Notes |
|--------|------|-------|
| ✅ | `requirePermission` middleware | Applied on all sensitive mutating routes; audit completed July 2026 |
| ✅ | Rate limiting | `authLimiter` on `/api/auth`, `financialLimiter` on trades, `generalLimiter` on public routes |
| ✅ | JWT auth with refresh tokens | `protect` + `protectActive` middleware on all business routes |
| ✅ | Two-factor authentication | `securityController.js` — TOTP via speakeasy, QR code provisioning, integrated into saved MoMo + wallet transfers. Routes: `/api/security/2fa/setup`, `/verify`, `/disable` |
| ✅ | Session management | `sessionController.js` — list active sessions (device+IP), revoke single, sign out everywhere (revoke-all bumps tokenVersion). 13 tests. Routes: `/api/security/sessions`, `/sessions/revoke-all`, `/sessions/:id/revoke` |
| ✅ | Dependency & secret scanning | GitHub Actions CI: `npm audit` job (fails on high/critical) + hardcoded secret pattern grep on every push |
| ✅ | Secret encryption | API keys encrypted with SHA-256 + base64 in `BusinessMessagingConfig` |

## Data Integrity & Compliance

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Soft-delete consistency | `BusinessPromotion` converted to soft-delete (isActive=false); hours exceptions + tax presets are safe to hard-delete (no FK references) |
| ✅ | Row-level security | Prisma queries always filter by `businessProfileId` |
| 🔲 | Automated DB backups | Need tested restore procedure (not just "backups exist") |
| ✅ | Data-export flow | `dataExportController.js` — `/api/security/data-export` returns structured JSON of all user PII (profile, sessions, contacts, transactions, trades, deposits, withdrawals, savings, MoMo, escrow, feedback, badges, login history). 5 tests. |
| ✅ | Audit log | `ActivityLog` entity tracks all mutating actions with actor + diff |

## Testing

| Status | Item | Notes |
|--------|------|-------|
| ✅ | API foundation tests | `__tests__/api-foundation.test.js` — request ID, error handling, pagination |
| ✅ | Business OS tests | `__tests__/business-os.test.js` — employees, scheduling, time-off, EWA |
| ✅ | Financial calculation tests | `__tests__/financial-calculations.test.js` — 46 tests covering invoice tax math, payroll (hourly/salary/OT/EWA), withdrawal exit fee + influencer split, escrow fee, fee discount tiers. Pure-math, no DB |
| ✅ | E2E smoke tests | `__tests__/e2e-smoke.test.js` — 10 verticals: auth (register/login/refresh/logout), business (profile/products/orders/invoices), reservations (create/confirm), security (2FA/sessions/data-export), wallet (balance/deposit), savings (goals/deposits), orders (create/fetch), notifications (list), health endpoint. Runs in CI with PostgreSQL container. |

## Performance

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Route-level code splitting | All 41 pages lazy-loaded via `React.lazy` + `Suspense` — 109 chunks, main bundle is shared vendor only |
| ✅ | Query caching | TanStack Query with staleTime + retry on all data fetches |
| 🔲 | List virtualization | Orders, employees, inventory, notifications need virtualization at real volume (400+ rooms, 6+ months of orders) |

## Polish (Enterprise Tier)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | In-app "What's New" / changelog | `changelogController.js` — Changelog + ChangelogView models, 8 endpoints (user list/unread-count/dismiss/dismiss-all + admin CRUD), per-user seen tracking, 22 tests |
| 🔲 | Guided product tour | `react-joyride` for first-time users of major sections |
| ✅ | Sandbox/demo mode (realistic seeded data) | `prisma/seed-demo.js` — 529 lines, 3 business verticals (hotel/restaurant/transit), 20 rooms, 6 menu items, 4 transit routes, 5 employees, 5 customers, reviews, notifications, changelog. Run with `npm run seed:demo` |
| ✅ | Dark/light theme consistency | Pre-paint script, CSS vars throughout, toast theme wired |
| ✅ | Onboarding checklist | `OnboardingChecklist.jsx` component with progress tracking |

## Messaging Channels (Section 5)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | WhatsApp connect/disconnect | Real API endpoint with encrypted credential storage |
| ✅ | SMS connect/disconnect | Real API endpoint with provider config |
| ✅ | Test message send | Logs to `BusinessMessageLog` with cost tracking |
| ✅ | Notification routing preferences | Per-event channel selection, persisted to DB |
| ✅ | Messaging cost stats | Real `BusinessMessageLog` data instead of estimates |
| 🔲 | Real WhatsApp Cloud API | Replace placeholder in `messagingChannels/index.js` |
| 🔲 | Real SMS gateway (Africa's Talking / Twilio) | Replace placeholder in `messagingChannels/index.js` |

## Webhook Reliability (Section 4)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | WebhookDelivery model | Tracks each delivery attempt with status, retry count, next retry time |
| ✅ | Delivery stats endpoint | Success rate, avg latency, failure breakdown |
| ✅ | Manual retry endpoint | Force retry of failed deliveries |
| ✅ | Cron retry queue | Every 2 min, picks up RETRYING/FAILED deliveries with backoff |
| ✅ | Webhook secret signing | HMAC-SHA256 signature on every payload |
| ✅ | Webhook delivery wired into business events | `webhookEmitter.js` — fire-and-forget emitter wired into `businessOrderService.createOrder` (order.created), `businessInvoiceService.createInvoice` (invoice.created), `reservationController.createReservation` (reservation.created) + `confirmReservation` (reservation.confirmed). 5 tests. |

## Phase 2: Scalability & Security (In Progress)

| Status | Item | Notes |
|--------|------|-------|
| ✅ | Payment provider failover | `src/services/paymentFailoverService.js` — wraps Moolre (primary) + MTN (secondary) with automatic failover, health tracking (3 failures in 10min → unhealthy), recovery probing, admin health endpoint `/api/admin/payment-providers/health`. 11 tests. |
| ✅ | Account lockout after failed logins | Implemented in auth middleware |
| ✅ | Idempotency keys on financial endpoints | Implemented on all financial mutations |
| ✅ | Session management | `sessionController.js` — list, revoke, sign out everywhere |
| ✅ | Data export / GDPR | `dataExportController.js` — structured PII export |
| ✅ | 2FA enforcement | TOTP via speakeasy, integrated into MoMo + wallet transfers |
| 🔲 | BullMQ for workers | Multi-instance safe worker scheduling |
| 🔲 | Read replica for analytics | Separate DB connection for list/analytics queries |
| 🔲 | Table partitioning | TransactionHistory by month |
| 🔲 | On-chain sweep worker | Automated USDC liquidity management |
| 🔲 | WebAuthn/passkey support | Passwordless authentication |
| ✅ | OpenAPI spec generation | `src/config/openapiGenerator.js` — auto-discovers routes from Express 5.x stack, produces OpenAPI 3.0.3 spec. Served at `/api/docs/openapi.json`. 16 tests. |
| ✅ | VirtualizedList + VirtualizedGrid | Business portal — `@tanstack/react-virtual` based. Wired into Employees page (grid) and Messages conversations list. Handles 1000+ rows without DOM bottleneck. |
| 🔲 | Disappearing messages | Mobile + backend support |
